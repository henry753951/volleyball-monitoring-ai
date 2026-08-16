import { randomUUID } from 'node:crypto'
import {
  parseProviderWorkClientMessage,
  type ProviderActiveWork,
  type ProviderWorkCapabilities,
  type ProviderWorkCapability,
  type ProviderWorkClientMessage,
  type ProviderWorkEnvelope,
  type ProviderWorkKind as ContractProviderWorkKind,
  type ProviderWorkServerMessage,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  ArtifactState,
  JobStatus,
  Prisma,
  ProviderWorkKind,
} from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync } from 'fastify'
import { Client } from 'minio'
import type { RawData } from 'ws'
import { authenticateAiWorkerToken } from '../services/ai-worker-access.js'
import {
  acceptedProviderResultKinds,
  newProviderCallbackCredential,
  providerRequestSha256,
} from '../services/provider-jobs.js'

const leaseMs = 60_000
const tickMs = 1_000
const heartbeatIntervalSeconds = 10
const heartbeatTimeoutMs = heartbeatIntervalSeconds * 3 * 1_000
const artifactUrlLifetimeSeconds = 15 * 60

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function bearer(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/.exec(header ?? '')
  return match?.[1] ?? null
}

function createMinioSigner() {
  const endpoint = new URL(
    process.env.MINIO_PUBLIC_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  )
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey)
    throw new Error('MinIO credentials are required for provider work delivery')
  return new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey,
    secretKey,
    pathStyle: true,
    region: process.env.MINIO_REGION ?? 'us-east-1',
  })
}

function databaseWorkKind(value: ContractProviderWorkKind) {
  return ProviderWorkKind[value]
}

function capabilityFor(
  capabilities: ProviderWorkCapabilities,
  workKind: ContractProviderWorkKind,
): ProviderWorkCapability | null {
  return capabilities.work_capabilities.find(item => item.work_kind === workKind) ?? null
}

export function providerCapabilityMatchesJob(
  capability: ProviderWorkCapability,
  job: {
    requestSchemaVersion: string
    resultSchemaVersion: string
    artifacts: Array<{ direction: string; artifactKind: string; required: boolean }>
  },
) {
  if (
    !capability.request_schema_versions.includes(job.requestSchemaVersion) ||
    !capability.result_schema_versions.includes(job.resultSchemaVersion)
  )
    return false
  const accepted = new Set(capability.accepted_input_artifact_kinds)
  return job.artifacts.every(
    artifact =>
      artifact.direction !== 'INPUT' || !artifact.required || accepted.has(artifact.artifactKind),
  )
}

export interface ProviderWorkWebSocketDependencies {
  database: PrismaClient
  callbackBaseUrl?: string
  presign?: (bucket: string, objectKey: string, expiresSeconds: number) => Promise<string>
}

export async function recoverExpiredProviderJobs(database: PrismaClient, now: Date) {
  const expired = await database.providerJob.findMany({
    where: {
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
      leasedUntil: { lt: now },
    },
    select: { id: true, attemptCount: true, maxAttempts: true, status: true },
    take: 100,
  })
  for (const job of expired) {
    const terminal = job.attemptCount >= job.maxAttempts
    await database.providerJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        leasedUntil: { lt: now },
      },
      data: {
        status: terminal ? JobStatus.FAILED : JobStatus.QUEUED,
        providerInstanceId: null,
        deliveryId: null,
        providerExecutionId: null,
        leasedUntil: null,
        acceptedAt: null,
        startedAt: null,
        completedAt: terminal ? now : null,
        lastCallbackAt: null,
        progress: null,
        stage: terminal ? 'execution_lease_exhausted' : 'worker_lease_expired',
        errorCode: terminal ? 'PROVIDER_EXECUTION_LEASE_EXHAUSTED' : null,
        errorMessage: terminal
          ? 'Provider stopped renewing the execution lease before all attempts completed'
          : null,
        availableAt: now,
      },
    })
  }
}

async function releaseRevokedProviderJobs(
  database: PrismaClient,
  providerInstanceId: string,
  now: Date,
) {
  await database.providerJob.updateMany({
    where: {
      providerInstanceId,
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
    },
    data: {
      status: JobStatus.QUEUED,
      providerInstanceId: null,
      deliveryId: null,
      providerExecutionId: null,
      leasedUntil: null,
      acceptedAt: null,
      startedAt: null,
      progress: null,
      stage: 'worker_authorization_revoked',
      availableAt: now,
    },
  })
}

export const providerWorkWebSocketRoutes =
  (dependencies: ProviderWorkWebSocketDependencies): FastifyPluginAsync =>
  async app => {
    const database = dependencies.database
    const minio = dependencies.presign ? null : createMinioSigner()
    const presign =
      dependencies.presign ??
      ((bucket: string, objectKey: string, expiresSeconds: number) =>
        minio!.presignedGetObject(bucket, objectKey, expiresSeconds))
    const callbackBase = (
      dependencies.callbackBaseUrl ??
      process.env.CALLBACK_PUBLIC_BASE_URL ??
      'http://server:4000'
    ).replace(/\/+$/, '')

    app.get('/api/v2/ai/providers/ws', { websocket: true }, (socket, request) => {
      const presentedToken = bearer(request.headers.authorization) ?? undefined
      const pending: RawData[] = []
      let handleMessage: ((raw: RawData) => void) | null = null
      socket.on('message', raw => {
        if (handleMessage) handleMessage(raw)
        else if (pending.length < 16) pending.push(raw)
        else socket.close(1008, 'too many messages before provider authentication')
      })

      void (async () => {
        if (!(await authenticateAiWorkerToken(database, presentedToken))) {
          if (socket.readyState === 1) {
            socket.send(
              JSON.stringify({
                schema_version: '2.0.0',
                type: 'protocol_error',
                code: 'AUTHORIZATION_REVOKED',
                message: 'Worker token is missing, disabled, rotated, or deleted',
                retryable: false,
              } satisfies ProviderWorkServerMessage),
            )
          }
          socket.close(1008, 'authentication required')
          return
        }

        let instanceId: string | null = null
        let instanceKey: string | null = null
        let capabilities: ProviderWorkCapabilities | null = null
        let ticking = false
        let lastHeartbeatAt = Date.now()
        const committedSent = new Set<string>()
        const abortSent = new Set<string>()
        const send = (message: ProviderWorkServerMessage) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(message))
        }
        const protocolError = (code: string, message: string, retryable = false) =>
          send({ schema_version: '2.0.0', type: 'protocol_error', code, message, retryable })

        const activeMatches = async (active: ProviderActiveWork) => {
          if (!instanceId) return null
          return database.providerJob.findFirst({
            where: {
              id: active.provider_job_id,
              workKind: databaseWorkKind(active.work_kind),
              deliveryId: active.delivery_id,
              providerInstanceId: instanceId,
              status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
            },
          })
        }

        const reconcileActive = async (activeWork: ProviderActiveWork[], resume: boolean) => {
          if (!instanceId) return
          const now = new Date()
          const leasedUntil = new Date(now.getTime() + leaseMs)
          for (const active of activeWork) {
            const job = await activeMatches(active)
            if (!job) {
              send({
                schema_version: '2.0.0',
                type: 'discard_job',
                provider_job_id: active.provider_job_id,
                work_kind: active.work_kind,
                delivery_id: active.delivery_id,
                reason: 'Central has no matching active delivery',
              })
              continue
            }
            await database.providerJob.update({
              where: { id: job.id },
              data: {
                leasedUntil,
                progress: active.progress ?? job.progress,
                lastCallbackAt: now,
              },
            })
            if (resume) {
              send({
                schema_version: '2.0.0',
                type: 'resume_job',
                provider_job_id: job.id,
                work_kind: job.workKind,
                delivery_id: active.delivery_id,
                lease_expires_at: leasedUntil.toISOString(),
              })
            }
          }
        }

        const offerOne = async () => {
          if (!instanceId || !capabilities) return
          const activeCounts = await database.providerJob.groupBy({
            by: ['workKind'],
            where: {
              providerInstanceId: instanceId,
              status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
              deliveryId: { not: null },
              leasedUntil: { gt: new Date() },
            },
            _count: { _all: true },
          })
          const counts = new Map(activeCounts.map(item => [item.workKind, item._count._all]))
          const candidates = await database.providerJob.findMany({
            where: {
              status: JobStatus.QUEUED,
              providerInstanceId: null,
              availableAt: { lte: new Date() },
            },
            include: { artifacts: { include: { mediaAsset: true }, orderBy: { ordinal: 'asc' } } },
            orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
            take: 50,
          })
          const job = candidates.find(candidate => {
            const capability = capabilityFor(capabilities!, candidate.workKind)
            return (
              capability !== null &&
              (counts.get(candidate.workKind) ?? 0) < capability.max_concurrency &&
              providerCapabilityMatchesJob(capability, candidate) &&
              candidate.artifacts.every(
                artifact =>
                  artifact.direction !== 'INPUT' ||
                  !artifact.required ||
                  artifact.mediaAsset.state === ArtifactState.READY,
              )
            )
          })
          if (!job) return
          if (
            !isRecord(job.requestPayload) ||
            providerRequestSha256(job.requestPayload) !== job.requestPayloadHash
          ) {
            await database.providerJob.update({
              where: { id: job.id },
              data: {
                status: JobStatus.FAILED,
                errorCode: 'REQUEST_HASH_MISMATCH',
                errorMessage: 'Persisted provider request does not match its immutable hash',
                completedAt: new Date(),
              },
            })
            return
          }
          const now = new Date()
          const deliveryId = randomUUID()
          const leasedUntil = new Date(now.getTime() + leaseMs)
          const callback = newProviderCallbackCredential(now)
          const claimed = await database.providerJob.updateMany({
            where: { id: job.id, status: JobStatus.QUEUED, providerInstanceId: null },
            data: {
              providerInstanceId: instanceId,
              deliveryId,
              leasedUntil,
              callbackTokenHash: callback.tokenHash,
              callbackTokenExpiresAt: callback.expiresAt,
              attemptCount: { increment: 1 },
              stage: 'offered',
            },
          })
          if (claimed.count !== 1) return
          const urlExpiresAt = new Date(now.getTime() + artifactUrlLifetimeSeconds * 1_000)
          const inputArtifacts = await Promise.all(
            job.artifacts
              .filter(artifact => artifact.direction === 'INPUT')
              .map(async artifact => ({
                artifact_id: artifact.id,
                kind: artifact.artifactKind,
                schema_version: artifact.schemaVersion,
                download_url: await presign(
                  artifact.mediaAsset.bucket,
                  artifact.mediaAsset.objectKey,
                  artifactUrlLifetimeSeconds,
                ),
                download_url_expires_at: urlExpiresAt.toISOString(),
                sha256: artifact.sha256,
                byte_length: artifact.byteLength.toString(),
                content_type: artifact.contentType,
              })),
          )
          const workKind = job.workKind as ContractProviderWorkKind
          const work: ProviderWorkEnvelope = {
            schema_version: '1.0.0',
            provider_job_id: job.id,
            work_kind: workKind,
            request_schema_version: job.requestSchemaVersion,
            request_sha256: job.requestPayloadHash,
            idempotency_key: job.idempotencyKey,
            input_artifacts: inputArtifacts,
            request: job.requestPayload,
            callback: {
              url: `${callbackBase}/api/v1/provider-jobs/${job.id}/callback`,
              token: callback.token,
              expires_at: callback.expiresAt.toISOString(),
              accepted_result_kinds: acceptedProviderResultKinds(workKind),
            },
          }
          send({
            schema_version: '2.0.0',
            type: 'job_offer',
            provider_job_id: job.id,
            work_kind: workKind,
            delivery_id: deliveryId,
            lease_expires_at: leasedUntil.toISOString(),
            work,
          })
        }

        const reconcile = async () => {
          if (!instanceId || !capabilities || ticking || socket.readyState !== 1) return
          if (Date.now() - lastHeartbeatAt > heartbeatTimeoutMs) {
            socket.close(1011, 'provider heartbeat timeout')
            return
          }
          ticking = true
          try {
            await recoverExpiredProviderJobs(database, new Date())
            const assigned = await database.providerJob.findMany({
              where: { providerInstanceId: instanceId, deliveryId: { not: null } },
            })
            for (const job of assigned) {
              if (!job.deliveryId) continue
              const identity = {
                provider_job_id: job.id,
                work_kind: job.workKind as ContractProviderWorkKind,
                delivery_id: job.deliveryId,
              }
              if (
                (job.status === JobStatus.CANCELLED || job.cancelRequestedAt) &&
                !abortSent.has(job.id)
              ) {
                send({
                  schema_version: '2.0.0',
                  type: 'abort_job',
                  ...identity,
                  reason: 'Provider work was cancelled',
                })
                abortSent.add(job.id)
              } else if (job.status === JobStatus.COMPLETED && !committedSent.has(job.id)) {
                send({
                  schema_version: '2.0.0',
                  type: 'job_committed',
                  ...identity,
                  committed_at: (job.completedAt ?? job.updatedAt).toISOString(),
                })
                committedSent.add(job.id)
              }
            }
            await offerOne()
          } finally {
            ticking = false
          }
        }

        const handleIdentityMessage = async (
          message: Exclude<ProviderWorkClientMessage, { active_work: ProviderActiveWork[] }>,
        ) => {
          if (!instanceId) return
          const where = {
            id: message.provider_job_id,
            workKind: databaseWorkKind(message.work_kind),
            deliveryId: message.delivery_id,
            providerInstanceId: instanceId,
            status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
          }
          const job = await database.providerJob.findFirst({ where })
          if (!job) {
            protocolError('DELIVERY_MISMATCH', 'Provider message does not match an active delivery')
            return
          }
          const now = new Date()
          const leasedUntil = new Date(now.getTime() + leaseMs)
          switch (message.type) {
            case 'job_accepted':
              await database.providerJob.update({
                where: { id: job.id },
                data: {
                  status: JobStatus.RUNNING,
                  acceptedAt: new Date(message.accepted_at),
                  startedAt: job.startedAt ?? now,
                  leasedUntil,
                  stage: 'accepted',
                },
              })
              break
            case 'progress':
              await database.providerJob.update({
                where: { id: job.id },
                data: {
                  status: JobStatus.RUNNING,
                  progress: message.progress,
                  ...(message.stage !== undefined ? { stage: message.stage } : {}),
                  leasedUntil,
                },
              })
              send({
                schema_version: '2.0.0',
                type: 'lease_renewed',
                provider_job_id: job.id,
                work_kind: message.work_kind,
                delivery_id: message.delivery_id,
                lease_expires_at: leasedUntil.toISOString(),
              })
              break
            case 'job_rejected':
            case 'job_failed': {
              const retry = message.retryable && job.attemptCount < job.maxAttempts
              await database.providerJob.update({
                where: { id: job.id },
                data: {
                  status: retry ? JobStatus.QUEUED : JobStatus.FAILED,
                  providerInstanceId: null,
                  deliveryId: null,
                  leasedUntil: null,
                  availableAt: now,
                  completedAt: retry ? null : now,
                  stage: message.type,
                  errorCode: message.code.slice(0, 128),
                  errorMessage: message.message.slice(0, 1_000),
                },
              })
              break
            }
            case 'abort_ack':
              await database.providerJob.update({
                where: { id: job.id },
                data: {
                  status: JobStatus.CANCELLED,
                  cancelAcknowledgedAt: new Date(message.acknowledged_at),
                  completedAt: now,
                  leasedUntil: null,
                },
              })
              break
          }
        }

        const processMessage = async (raw: RawData) => {
          let message: ProviderWorkClientMessage
          try {
            message = parseProviderWorkClientMessage(JSON.parse(raw.toString()))
          } catch {
            protocolError('INVALID_MESSAGE', 'Provider message failed the Realtime 2.0.0 contract')
            return
          }
          if (!(await authenticateAiWorkerToken(database, presentedToken))) {
            if (instanceId) {
              await releaseRevokedProviderJobs(database, instanceId, new Date())
              await database.aiProviderInstance.updateMany({
                where: { id: instanceId },
                data: { disconnectedAt: new Date() },
              })
            }
            protocolError('AUTHORIZATION_REVOKED', 'Worker token is disabled, rotated, or deleted')
            socket.close(1008, 'worker authorization revoked')
            return
          }
          lastHeartbeatAt = Date.now()
          if (message.type === 'provider_hello') {
            if (instanceId) {
              protocolError('HELLO_ALREADY_RECEIVED', 'Provider hello may only be sent once')
              return
            }
            if (
              message.provider_build_id !== message.capabilities.provider_build_id ||
              message.provider_build_id.length === 0
            ) {
              protocolError('CAPABILITY_MISMATCH', 'Provider build ID does not match capabilities')
              return
            }
            instanceKey = `v2:${message.instance_id}`
            capabilities = message.capabilities
            const maxConcurrency = capabilities.work_capabilities.reduce(
              (total, item) => total + item.max_concurrency,
              0,
            )
            const instance = await database.aiProviderInstance.upsert({
              where: { instanceKey },
              create: {
                instanceKey,
                sdkVersion: message.sdk_version,
                providerBuildId: message.provider_build_id,
                capabilities: json(capabilities),
                maxConcurrency,
                lastSeenAt: new Date(),
              },
              update: {
                sdkVersion: message.sdk_version,
                providerBuildId: message.provider_build_id,
                capabilities: json(capabilities),
                maxConcurrency,
                lastSeenAt: new Date(),
                connectedAt: new Date(),
                disconnectedAt: null,
              },
            })
            instanceId = instance.id
            send({
              schema_version: '2.0.0',
              type: 'connection_ready',
              connection_id: randomUUID(),
              server_time: new Date().toISOString(),
              heartbeat_interval_seconds: heartbeatIntervalSeconds,
              lease_seconds: leaseMs / 1_000,
            })
            await reconcileActive(message.active_work, true)
            await reconcile()
            return
          }
          if (
            !instanceId ||
            !capabilities ||
            ('instance_id' in message && message.instance_id !== instanceKey?.slice(3))
          ) {
            protocolError('HELLO_REQUIRED', 'A matching provider hello is required first')
            return
          }
          await database.aiProviderInstance.update({
            where: { id: instanceId },
            data: { lastSeenAt: new Date(), disconnectedAt: null },
          })
          if ('active_work' in message) {
            await reconcileActive(message.active_work, message.type === 'resume_request')
          } else {
            await handleIdentityMessage(message)
          }
          await reconcile()
        }

        handleMessage = raw =>
          void processMessage(raw).catch(error => {
            app.log.error({ error }, 'Provider Work Realtime message failed')
            protocolError('INTERNAL_ERROR', 'Provider message could not be processed', true)
          })
        for (const raw of pending.splice(0)) handleMessage(raw)
        const timer = setInterval(
          () =>
            void reconcile().catch(error =>
              app.log.error({ error }, 'Provider Work reconcile failed'),
            ),
          tickMs,
        )
        socket.once('close', () => {
          clearInterval(timer)
          if (instanceId)
            void database.aiProviderInstance.updateMany({
              where: { id: instanceId },
              data: { disconnectedAt: new Date() },
            })
        })
      })().catch(error => {
        app.log.error({ error }, 'Provider Work connection failed')
        socket.close(1011, 'provider connection failed')
      })
    })
  }
