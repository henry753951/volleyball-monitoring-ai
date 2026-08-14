import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  parseAIProviderClientMessage,
  type AIProviderActiveJob,
  type AIProviderCapabilitiesPayload,
  type AIProviderServerMessage,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, Prisma, ProcessingStatus } from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync } from 'fastify'
import { Client } from 'minio'
import type { RawData } from 'ws'
import type { AiProgressService } from './ai-progress.js'
import { authenticateAiWorkerToken } from '../services/ai-worker-access.js'

const leaseMs = 60_000
const callbackLifetimeMs = 30 * 60_000
const tickMs = 1_000
const heartbeatIntervalSeconds = 10
const heartbeatTimeoutMs = heartbeatIntervalSeconds * 3 * 1_000
const AI_JOB_SCHEMA_VERSION = '3.0.0'
const ANALYSIS_DATA_VERSION = '1.0.0'
const REQUIRED_ANALYSIS_MODULES = ['court', 'tracking', 'reid', 'contacts'] as const
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function bearer(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/.exec(header ?? '')
  return match?.[1] ?? null
}

function createMinioSigner() {
  const endpoint = new URL(
    process.env.MINIO_PUBLIC_ENDPOINT
      ?? process.env.MINIO_ENDPOINT
      ?? 'http://minio:9000',
  )
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey) throw new Error('MinIO credentials are required for AI job delivery')
  return new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey,
    secretKey,
    pathStyle: true,
    // A public endpoint can be unreachable from inside the server container.
    // Supplying the deployment region keeps presigning offline instead of
    // performing a bucket-region lookup against that public hostname first.
    region: process.env.MINIO_REGION ?? 'us-east-1',
  })
}

export function compatible(capabilities: AIProviderCapabilitiesPayload) {
  return capabilities.supported_job_schema_versions.includes(AI_JOB_SCHEMA_VERSION)
    && capabilities.supported_analysis_data_versions.includes(ANALYSIS_DATA_VERSION)
    && REQUIRED_ANALYSIS_MODULES.every(module => capabilities.supported_analysis_modules.includes(module))
}

export interface AiProviderWebSocketDependencies {
  database: PrismaClient
  presign?: (bucket: string, objectKey: string, expiresSeconds: number) => Promise<string>
  callbackBaseUrl?: string
  progress?: AiProgressService
  transportPingIntervalMs?: number
}

interface ProviderInstanceLoadRow {
  id: string
}

export function isActiveProviderDelivery(
  job: { status: JobStatus; leasedUntil: Date | null },
  now: Date,
): boolean {
  return (job.status === JobStatus.RUNNING || job.status === JobStatus.QUEUED)
    && job.leasedUntil !== null
    && job.leasedUntil > now
}

type ExpiredRunningJob = {
  id: string
  attemptCount: number
  maxAttempts: number
  submission: {
    id: string
    rally: {
      id: string
      matchId: string
      program: { captureSessionId: string }
    }
  }
}

export async function recoverExpiredRunningAiJobs(database: PrismaClient, now: Date) {
  const expired = await database.aiJob.findMany({
    where: { status: JobStatus.RUNNING, leasedUntil: { lt: now } },
    select: {
      id: true,
      attemptCount: true,
      maxAttempts: true,
      submission: {
        select: {
          id: true,
          rally: {
            select: {
              id: true,
              matchId: true,
              program: { select: { captureSessionId: true } },
            },
          },
        },
      },
    },
    take: 100,
  })
  const recovered: Array<{ job: ExpiredRunningJob; terminal: boolean }> = []
  for (const job of expired) {
    const terminal = job.attemptCount >= job.maxAttempts
    const changed = await database.$transaction(async (tx) => {
      const updated = await tx.aiJob.updateMany({
        where: { id: job.id, status: JobStatus.RUNNING, leasedUntil: { lt: now } },
        data: {
          status: terminal ? JobStatus.FAILED : JobStatus.QUEUED,
          providerInstanceId: null,
          deliveryId: null,
          providerJobId: null,
          leasedUntil: null,
          acceptedAt: null,
          startedAt: null,
          completedAt: terminal ? now : null,
          lastCallbackAt: null,
          ...(terminal ? {} : { progress: null }),
          stage: 'worker_lease_expired',
          errorCode: terminal ? 'AI_EXECUTION_LEASE_EXHAUSTED' : null,
          errorMessage: terminal ? 'AI Worker stopped renewing the execution lease before every attempt completed' : null,
          availableAt: now,
        },
      })
      if (updated.count !== 1) return false
      await tx.rally.updateMany({
        where: {
          id: job.submission.rally.id,
          voidedAt: null,
          processingStatus: { in: [ProcessingStatus.AI_QUEUED, ProcessingStatus.AI_PROCESSING] },
        },
        data: { processingStatus: terminal ? ProcessingStatus.FAILED : ProcessingStatus.AI_QUEUED },
      })
      return true
    })
    if (changed) recovered.push({ job, terminal })
  }
  return recovered
}

/**
 * Selects one globally least-loaded, recently-seen provider instance.
 *
 * Every connected socket asks the database for the same deterministic winner
 * before claiming a job. This avoids the old per-socket race where the fastest
 * reconnecting worker could fill every one of its slots while idle workers
 * remained unused.
 */
export async function findLeastBusyProviderInstanceId(
  database: PrismaClient,
  jobSchemaVersion?: string,
): Promise<string | null> {
  const schemaCondition = jobSchemaVersion
    ? Prisma.sql`AND instance.capabilities->'supported_job_schema_versions' @> ${JSON.stringify([jobSchemaVersion])}::jsonb`
    : Prisma.empty
  const rows = await database.$queryRaw<ProviderInstanceLoadRow[]>`
    SELECT instance.id
    FROM "AiProviderInstance" instance
    LEFT JOIN "AiJob" job
      ON job."providerInstanceId" = instance.id
      AND (
        job.status = 'RUNNING'
        OR (job.status = 'QUEUED' AND job."leasedUntil" > NOW())
      )
      AND job."deliveryId" IS NOT NULL
    WHERE instance."disconnectedAt" IS NULL
      AND instance."lastSeenAt" >= NOW() - INTERVAL '30 seconds'
      AND instance."maxConcurrency" > 0
      ${schemaCondition}
    GROUP BY instance.id, instance."maxConcurrency", instance."connectedAt"
    HAVING COUNT(job.id) < instance."maxConcurrency"
    ORDER BY
      COUNT(job.id)::numeric / instance."maxConcurrency" ASC,
      COUNT(job.id) ASC,
      instance."connectedAt" ASC,
      instance.id ASC
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

export const aiProviderWebSocketRoutes = (
  dependencies: AiProviderWebSocketDependencies,
): FastifyPluginAsync => async (app) => {
  const database = dependencies.database
  const minio = dependencies.presign ? null : createMinioSigner()
  const presign = dependencies.presign ?? ((bucket: string, objectKey: string, expiresSeconds: number) => minio!.presignedGetObject(bucket, objectKey, expiresSeconds))
  const callbackBase = (dependencies.callbackBaseUrl ?? process.env.CALLBACK_PUBLIC_BASE_URL ?? 'http://server:4000').replace(/\/+$/, '')
  const transportPingIntervalMs = dependencies.transportPingIntervalMs ?? heartbeatIntervalSeconds * 1_000
  const transportPingTimeoutMs = Math.max(transportPingIntervalMs * 3, 1_000)

  app.get(
    '/api/v1/ai/providers/ws',
    { websocket: true },
    (socket, request) => {
      const pendingMessages: RawData[] = []
      let handleMessage: ((raw: RawData) => void) | null = null
      socket.on('message', raw => {
        if (handleMessage) handleMessage(raw)
        else if (pendingMessages.length < 16) pendingMessages.push(raw)
        else socket.close(1008, 'too many messages before provider authentication')
      })
      void (async () => {
        const presentedToken = bearer(request.headers.authorization) ?? undefined
        const authenticated = await authenticateAiWorkerToken(
          database,
          presentedToken,
        )
        if (!authenticated) {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              schema_version: '1.0.0',
              type: 'protocol_error',
              code: 'AUTHORIZATION_REVOKED',
              message: 'Worker token is missing, disabled, rotated, or deleted',
              retryable: false,
            } satisfies AIProviderServerMessage))
          }
          socket.close(1008, 'authentication required')
          return
        }

        let instanceId: string | null = null
        let instanceKey: string | null = null
        let providerBuildId: string | null = null
        let maxConcurrency = 0
        let supportedJobSchemaVersions: string[] = []
        let ticking = false
        let lastHeartbeatAt = Date.now()
        let transportPingSentAt: number | null = null
        const abortSent = new Set<string>()
        const committedSent = new Set<string>()
        const send = (message: AIProviderServerMessage) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(message))
        }

        const revokeAuthorization = async () => {
          const revokedInstanceId = instanceId
          if (revokedInstanceId) {
            const activeJobs = await database.aiJob.findMany({
              where: {
                providerInstanceId: revokedInstanceId,
                status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
              },
              select: {
                id: true,
                submission: {
                  select: {
                    id: true,
                    rally: {
                      select: {
                        id: true,
                        matchId: true,
                        program: { select: { captureSessionId: true } },
                      },
                    },
                  },
                },
              },
            })
            const rallyIds = [...new Set(activeJobs.map(job => job.submission.rally.id))]
            await database.$transaction(async (tx) => {
              await tx.aiJob.updateMany({
                where: {
                  providerInstanceId: revokedInstanceId,
                  status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
                },
                data: {
                  status: JobStatus.QUEUED,
                  providerInstanceId: null,
                  deliveryId: null,
                  providerJobId: null,
                  leasedUntil: null,
                  acceptedAt: null,
                  startedAt: null,
                  completedAt: null,
                  lastCallbackAt: null,
                  progress: null,
                  stage: 'authorization_revoked',
                  errorCode: null,
                  errorMessage: null,
                  availableAt: new Date(),
                },
              })
              if (rallyIds.length > 0) {
                await tx.rally.updateMany({
                  where: {
                    id: { in: rallyIds },
                    voidedAt: null,
                    processingStatus: { in: [ProcessingStatus.AI_QUEUED, ProcessingStatus.AI_PROCESSING] },
                  },
                  data: { processingStatus: ProcessingStatus.AI_QUEUED },
                })
              }
              await tx.aiProviderInstance.deleteMany({ where: { id: revokedInstanceId } })
            })
            for (const job of activeJobs) {
              await publishProgress(job, 'ai_queued', null, 'authorization_revoked')
            }
          }

          send({
            schema_version: '1.0.0',
            type: 'protocol_error',
            code: 'AUTHORIZATION_REVOKED',
            message: 'Worker token was disabled, rotated, or deleted',
            retryable: false,
          })
          instanceId = null
          instanceKey = null
          socket.close(1008, 'worker authorization revoked')
        }

        const reconcile = async () => {
          if (!instanceId || ticking || socket.readyState !== 1) return
          if (Date.now() - lastHeartbeatAt > heartbeatTimeoutMs) {
            socket.close(1011, 'provider heartbeat timeout')
            return
          }
          ticking = true
          try {
            const now = new Date()
            const recoveredRunningJobs = await recoverExpiredRunningAiJobs(database, now)
            for (const recovered of recoveredRunningJobs) {
              await publishProgress(
                recovered.job,
                recovered.terminal ? 'failed' : 'ai_queued',
                null,
                recovered.terminal ? 'execution_lease_exhausted' : 'worker_lease_expired',
              )
            }
            const expiredQueuedOffers = await database.aiJob.findMany({
              where: { status: JobStatus.QUEUED, leasedUntil: { lt: now } },
              select: {
                id: true,
                attemptCount: true,
                maxAttempts: true,
                submission: {
                  select: {
                    id: true,
                    rally: {
                      select: {
                        id: true,
                        matchId: true,
                        program: { select: { captureSessionId: true } },
                      },
                    },
                  },
                },
              },
              take: 100,
            })
            for (const expired of expiredQueuedOffers) {
              if (expired.attemptCount < expired.maxAttempts) continue
              const changed = await database.$transaction(async (tx) => {
                const updated = await tx.aiJob.updateMany({
                  where: { id: expired.id, status: JobStatus.QUEUED, leasedUntil: { lt: now } },
                  data: {
                    status: JobStatus.FAILED,
                    leasedUntil: null,
                    completedAt: now,
                    errorCode: 'AI_DELIVERY_EXHAUSTED',
                    errorMessage: 'AI Worker did not accept the job before every delivery lease expired',
                  },
                })
                if (updated.count !== 1) return false
                await tx.rally.updateMany({
                  where: {
                    id: expired.submission.rally.id,
                    voidedAt: null,
                    processingStatus: { in: [ProcessingStatus.AI_QUEUED, ProcessingStatus.AI_PROCESSING] },
                  },
                  data: { processingStatus: ProcessingStatus.FAILED },
                })
                return true
              })
              if (changed) await publishProgress(expired, 'failed', null, 'delivery_failed')
            }
            const durableAbortEvents = await database.outboxEvent.findMany({
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, payload: true },
              take: 100,
              where: {
                createdAt: { gte: new Date(now.getTime() - callbackLifetimeMs) },
                eventType: 'ai.job_abort_requested.v1',
                payload: { path: ['provider_instance_id'], equals: instanceId },
              },
            })
            for (const event of durableAbortEvents) {
              if (abortSent.has(event.id) || !isRecord(event.payload)) continue
              const aiJobId = typeof event.payload.ai_job_id === 'string' ? event.payload.ai_job_id : null
              const deliveryId = typeof event.payload.delivery_id === 'string' ? event.payload.delivery_id : null
              if (!aiJobId || !deliveryId) continue
              send({ schema_version: '1.0.0', type: 'abort_job', ai_job_id: aiJobId, delivery_id: deliveryId, reason: 'rally deleted' })
              abortSent.add(event.id)
            }
            const assigned = await database.aiJob.findMany({
              where: { providerInstanceId: instanceId, deliveryId: { not: null }, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLED, JobStatus.COMPLETED] } },
              select: { id: true, deliveryId: true, status: true, cancelRequestedAt: true, completedAt: true, leasedUntil: true },
            })
            for (const job of assigned) {
              if (!job.deliveryId) continue
              if (job.status === JobStatus.CANCELLED && !abortSent.has(job.id)) {
                send({ schema_version: '1.0.0', type: 'abort_job', ai_job_id: job.id, delivery_id: job.deliveryId, reason: 'processing clip deleted or cancelled' })
                abortSent.add(job.id)
              }
              if (job.status === JobStatus.COMPLETED && !committedSent.has(job.id)) {
                send({ schema_version: '1.0.0', type: 'job_committed', ai_job_id: job.id, delivery_id: job.deliveryId, committed_at: (job.completedAt ?? now).toISOString() })
                committedSent.add(job.id)
              }
            }

            const activeDeliveries = assigned.filter(job => isActiveProviderDelivery(job, now)).length
            for (let slot = activeDeliveries; slot < maxConcurrency; slot += 1) {
              const compatibleSchemas = Prisma.join(supportedJobSchemaVersions)
              const nextCompatibleRows = await database.$queryRaw<Array<{ jobSchemaVersion: string }>>`
                SELECT job."jobSchemaVersion"
                FROM "AiJob" job
                WHERE job.status = 'QUEUED'
                  AND job."availableAt" <= NOW()
                  AND (job."leasedUntil" IS NULL OR job."leasedUntil" < NOW())
                  AND job."attemptCount" < job."maxAttempts"
                  AND job."cancelRequestedAt" IS NULL
                  AND job."jobSchemaVersion" IN (${compatibleSchemas})
                ORDER BY job."availableAt", job."createdAt", job.id
                LIMIT 1
              `
              const nextCompatibleJob = nextCompatibleRows[0]
              if (!nextCompatibleJob) break
              const leastBusyInstanceId = await findLeastBusyProviderInstanceId(database, nextCompatibleJob.jobSchemaVersion)
              if (leastBusyInstanceId !== instanceId) break
              const deliveryId = randomUUID()
              const callbackToken = randomBytes(32).toString('base64url')
              const callbackExpiresAt = new Date(Date.now() + callbackLifetimeMs)
              const leaseExpiresAt = new Date(Date.now() + leaseMs)
              const job = await database.$transaction(async (tx) => {
                const rows = await tx.$queryRaw<Array<{ id: string }>>`
                  SELECT job.id
                  FROM "AiJob" job
                  WHERE job.status = 'QUEUED'
                    AND job."availableAt" <= NOW()
                    AND (job."leasedUntil" IS NULL OR job."leasedUntil" < NOW())
                    AND job."attemptCount" < job."maxAttempts"
                    AND job."cancelRequestedAt" IS NULL
                    AND job."jobSchemaVersion" = ${nextCompatibleJob.jobSchemaVersion}
                  ORDER BY job."availableAt", job."createdAt", job.id
                  FOR UPDATE SKIP LOCKED LIMIT 1
                `
                const id = rows[0]?.id
                if (!id) return null
                return tx.aiJob.update({
                  where: { id },
                  data: {
                    providerInstanceId: instanceId,
                    deliveryId,
                    leasedUntil: leaseExpiresAt,
                    callbackTokenHash: sha256(callbackToken),
                    callbackTokenExpiresAt: callbackExpiresAt,
                    attemptCount: { increment: 1 },
                    errorCode: null,
                    errorMessage: null,
                  },
                  include: {
                    clipJob: { include: { clipAsset: true } },
                    submission: {
                      select: {
                        id: true,
                        rally: {
                          select: {
                            id: true,
                            matchId: true,
                            program: { select: { captureSessionId: true } },
                          },
                        },
                      },
                    },
                  },
                })
              })
              if (!job) break
              if (!job.clipJob.clipAsset || !job.clipJob.clipAsset.sha256 || job.clipJob.clipAsset.byteLength === null || !isRecord(job.requestPayload) || !isRecord(job.requestPayload.clip)) {
                await database.aiJob.update({ where: { id: job.id }, data: { status: JobStatus.FAILED, errorCode: 'AI_INPUT_NOT_READY', errorMessage: 'canonical clip or request payload is unavailable', completedAt: new Date(), leasedUntil: null } })
                continue
              }
              const expiresSeconds = Math.floor(callbackLifetimeMs / 1_000)
              const downloadUrl = await presign(job.clipJob.clipAsset.bucket, job.clipJob.clipAsset.objectKey, expiresSeconds)
              const payload = {
                ...job.requestPayload,
                clip: {
                  ...job.requestPayload.clip,
                  download_url: downloadUrl,
                  download_url_expires_at: callbackExpiresAt.toISOString(),
                },
                callback: {
                  url: `${callbackBase}/api/v1/ai/callback/${job.id}`,
                  token: callbackToken,
                  expires_at: callbackExpiresAt.toISOString(),
                },
              }
              await publishProgress(job, 'ai_queued', job.progress ?? 0, 'assigned')
              send({ schema_version: '1.0.0', type: 'job_offer', ai_job_id: job.id, delivery_id: deliveryId, lease_expires_at: leaseExpiresAt.toISOString(), job: payload })
            }
          }
          finally {
            ticking = false
          }
        }

        const interval = setInterval(() => { void reconcile().catch(error => request.log.error({ error }, 'AI provider reconciliation failed')) }, tickMs)
        const latencyInterval = setInterval(() => {
          if (!instanceId || socket.readyState !== 1) return
          if (transportPingSentAt !== null && Date.now() - transportPingSentAt > transportPingTimeoutMs) {
            socket.close(1011, 'provider transport heartbeat timeout')
            return
          }
          if (transportPingSentAt !== null) return
          transportPingSentAt = Date.now()
          socket.ping()
          void database.aiProviderInstance.update({
            data: { lastPingAt: new Date(transportPingSentAt) },
            where: { id: instanceId },
          }).catch(error => request.log.warn({ error, instanceId }, 'AI provider ping persistence failed'))
        }, transportPingIntervalMs)
        socket.on('pong', () => {
          if (!instanceId || transportPingSentAt === null) return
          const latencyMs = Math.max(0, Date.now() - transportPingSentAt)
          transportPingSentAt = null
          void database.aiProviderInstance.update({
            data: { latencyMs, lastPongAt: new Date() },
            where: { id: instanceId },
          }).catch(error => request.log.warn({ error, instanceId }, 'AI provider pong persistence failed'))
        })
        socket.on('close', () => {
          clearInterval(interval)
          clearInterval(latencyInterval)
          if (instanceId) void database.aiProviderInstance.update({ where: { id: instanceId }, data: { disconnectedAt: new Date() } }).catch(() => undefined)
        })
        let messageQueue = Promise.resolve()
        handleMessage = raw => {
          messageQueue = messageQueue.then(async () => {
            let message
            try { message = parseAIProviderClientMessage(JSON.parse(raw.toString())) }
            catch {
              send({ schema_version: '1.0.0', type: 'protocol_error', code: 'INVALID_MESSAGE', message: 'message failed Provider Realtime 1.0.0 validation', retryable: false })
              socket.close(1003, 'invalid provider message')
              return
            }
            if (message.type === 'provider_hello') {
              if (instanceId) {
                socket.close(1008, 'provider_hello may only be sent once')
                return
              }
              if (message.provider_build_id !== message.capabilities.provider_build_id || !compatible(message.capabilities)) {
                send({ schema_version: '1.0.0', type: 'protocol_error', code: 'INCOMPATIBLE_CAPABILITIES', message: 'provider capabilities are incompatible with volleyball-analysis-engine', retryable: false })
                socket.close(1008, 'incompatible capabilities')
                return
              }
              instanceKey = message.instance_id
              providerBuildId = message.provider_build_id
              maxConcurrency = message.max_concurrency
              supportedJobSchemaVersions = message.capabilities.supported_job_schema_versions.filter(version => version === AI_JOB_SCHEMA_VERSION)
              const instance = await database.aiProviderInstance.upsert({
                where: { instanceKey },
                update: { sdkVersion: message.sdk_version, providerBuildId: message.provider_build_id, capabilities: json(message.capabilities), maxConcurrency, lastSeenAt: new Date(), connectedAt: new Date(), disconnectedAt: null, latencyMs: null, lastPingAt: null, lastPongAt: null },
                create: { instanceKey, sdkVersion: message.sdk_version, providerBuildId: message.provider_build_id, capabilities: json(message.capabilities), maxConcurrency, lastSeenAt: new Date(), latencyMs: null, lastPingAt: null, lastPongAt: null },
              })
              instanceId = instance.id
              lastHeartbeatAt = Date.now()
              send({ schema_version: '1.0.0', type: 'connection_ready', connection_id: randomUUID(), server_time: new Date().toISOString(), heartbeat_interval_seconds: heartbeatIntervalSeconds, lease_seconds: leaseMs / 1_000 })
              for (const active of message.active_jobs) await resumeOrStop(active)
              await reconcile()
              return
            }
            if (!instanceId || !instanceKey) {
              socket.close(1008, 'provider_hello is required first')
              return
            }
            if (message.type === 'heartbeat' || message.type === 'resume_request') {
              if (message.instance_id !== instanceKey) {
                socket.close(1008, 'instance_id mismatch')
                return
              }
              const stillAuthorized = await authenticateAiWorkerToken(database, presentedToken)
              if (!stillAuthorized) {
                await revokeAuthorization()
                return
              }
              lastHeartbeatAt = Date.now()
              await database.aiProviderInstance.update({ where: { id: instanceId }, data: { lastSeenAt: new Date() } })
              for (const active of message.active_jobs) await resumeOrStop(active)
              return
            }
            const owned = await database.aiJob.findFirst({
              where: { id: message.ai_job_id, providerInstanceId: instanceId, deliveryId: message.delivery_id },
              select: {
                id: true,
                status: true,
                submission: {
                  select: {
                    id: true,
                    rally: {
                      select: {
                        id: true,
                        matchId: true,
                        program: { select: { captureSessionId: true } },
                      },
                    },
                  },
                },
              },
            })
            if (!owned) {
              send({ schema_version: '1.0.0', type: 'discard_job', ai_job_id: message.ai_job_id, delivery_id: message.delivery_id, reason: 'delivery is no longer owned by this worker instance' })
              return
            }
            if (owned.status === JobStatus.CANCELLED) {
              if (message.type === 'abort_ack') await database.aiJob.update({ where: { id: owned.id }, data: { cancelAcknowledgedAt: new Date(message.acknowledged_at), leasedUntil: null } })
              else send({ schema_version: '1.0.0', type: 'abort_job', ai_job_id: message.ai_job_id, delivery_id: message.delivery_id, reason: 'processing clip deleted or cancelled' })
              return
            }
            if (owned.status !== JobStatus.QUEUED && owned.status !== JobStatus.RUNNING) {
              send({ schema_version: '1.0.0', type: 'discard_job', ai_job_id: message.ai_job_id, delivery_id: message.delivery_id, reason: `central job is ${owned.status.toLowerCase()}` })
              return
            }
            if (message.type === 'job_accepted') {
              const accepted = await database.$transaction(async (tx) => {
                const updated = await tx.aiJob.updateMany({
                  where: {
                    id: owned.id,
                    providerInstanceId: instanceId,
                    deliveryId: message.delivery_id,
                    status: JobStatus.QUEUED,
                    cancelRequestedAt: null,
                    leasedUntil: { gt: new Date() },
                  },
                  data: { status: JobStatus.RUNNING, acceptedAt: new Date(message.accepted_at), startedAt: new Date(), leasedUntil: new Date(Date.now() + leaseMs) },
                })
                if (updated.count !== 1) return false
                await tx.rally.updateMany({
                  where: { id: owned.submission.rally.id, voidedAt: null, processingStatus: { in: [ProcessingStatus.AI_QUEUED, ProcessingStatus.AI_PROCESSING] } },
                  data: { processingStatus: ProcessingStatus.AI_PROCESSING },
                })
                return true
              })
              if (!accepted) await resumeOrStop({ ai_job_id: message.ai_job_id, delivery_id: message.delivery_id })
              else await publishProgress(owned, 'ai_processing', 0, 'accepted')
            }
            else if (message.type === 'progress') {
              const updated = await database.aiJob.updateMany({
                where: { id: owned.id, providerInstanceId: instanceId, deliveryId: message.delivery_id, status: JobStatus.RUNNING, cancelRequestedAt: null },
                data: { progress: message.progress, stage: message.stage ?? null, leasedUntil: new Date(Date.now() + leaseMs) },
              })
              if (updated.count !== 1) await resumeOrStop({ ai_job_id: message.ai_job_id, delivery_id: message.delivery_id, progress: message.progress })
              else await publishProgress(owned, 'ai_processing', message.progress, message.stage ?? null)
            }
            else if (message.type === 'abort_ack') {
              await database.aiJob.update({ where: { id: owned.id }, data: { cancelAcknowledgedAt: new Date(message.acknowledged_at), leasedUntil: null } })
            }
            else if (message.type === 'job_rejected' || message.type === 'job_failed') {
              const terminal = !message.retryable
              const expectedStatus = message.type === 'job_rejected' ? JobStatus.QUEUED : JobStatus.RUNNING
              const changed = await database.$transaction(async (tx) => {
                const updated = await tx.aiJob.updateMany({
                  where: { id: owned.id, providerInstanceId: instanceId, deliveryId: message.delivery_id, status: expectedStatus, cancelRequestedAt: null },
                  data: { status: terminal ? JobStatus.FAILED : JobStatus.QUEUED, providerInstanceId: null, deliveryId: null, leasedUntil: null, availableAt: new Date(Date.now() + 2_000), errorCode: message.code, errorMessage: message.message.slice(0, 500), completedAt: terminal ? new Date() : null },
                })
                if (updated.count !== 1) return false
                await tx.rally.updateMany({
                  where: { id: owned.submission.rally.id, voidedAt: null, processingStatus: { in: [ProcessingStatus.AI_QUEUED, ProcessingStatus.AI_PROCESSING] } },
                  data: { processingStatus: terminal ? ProcessingStatus.FAILED : ProcessingStatus.AI_QUEUED },
                })
                return true
              })
              if (!changed) await resumeOrStop({ ai_job_id: message.ai_job_id, delivery_id: message.delivery_id })
              else await publishProgress(
                owned,
                terminal ? 'failed' : 'ai_queued',
                null,
                terminal ? 'failed' : 'retry_queued',
              )
            }
          }).catch(error => request.log.error({ error }, 'AI provider message handling failed'))
        }
        for (const raw of pendingMessages.splice(0)) handleMessage(raw)

        async function resumeOrStop(active: AIProviderActiveJob) {
          if (!instanceId) return
          const job = await database.aiJob.findUnique({ where: { id: active.ai_job_id }, select: { status: true, providerInstanceId: true, deliveryId: true } })
          if (!job || job.providerInstanceId !== instanceId || job.deliveryId !== active.delivery_id) {
            send({ schema_version: '1.0.0', type: 'discard_job', ai_job_id: active.ai_job_id, delivery_id: active.delivery_id, reason: 'delivery is unknown or reassigned' })
            return
          }
          if (job.status === JobStatus.CANCELLED) {
            send({ schema_version: '1.0.0', type: 'abort_job', ai_job_id: active.ai_job_id, delivery_id: active.delivery_id, reason: 'processing clip deleted or cancelled' })
            return
          }
          if (job.status !== JobStatus.RUNNING) {
            send({ schema_version: '1.0.0', type: 'discard_job', ai_job_id: active.ai_job_id, delivery_id: active.delivery_id, reason: `central job is ${job.status.toLowerCase()}` })
            return
          }
          const leaseExpiresAt = new Date(Date.now() + leaseMs)
          const resumed = await database.aiJob.updateMany({
            where: {
              id: active.ai_job_id,
              providerInstanceId: instanceId,
              deliveryId: active.delivery_id,
              status: JobStatus.RUNNING,
            },
            data: { leasedUntil: leaseExpiresAt, ...(active.progress === undefined ? {} : { progress: active.progress }) },
          })
          if (resumed.count !== 1) {
            send({ schema_version: '1.0.0', type: 'discard_job', ai_job_id: active.ai_job_id, delivery_id: active.delivery_id, reason: 'central job changed while resuming' })
            return
          }
          send({ schema_version: '1.0.0', type: 'resume_job', ai_job_id: active.ai_job_id, delivery_id: active.delivery_id, lease_expires_at: leaseExpiresAt.toISOString() })
        }

        async function publishProgress(
          job: {
            id: string
            submission: {
              id: string
              rally: { id: string; matchId: string; program: { captureSessionId: string } }
            }
          },
          processingStatus: 'ai_queued' | 'ai_processing' | 'failed',
          progress: number | null,
          stage: string | null,
        ) {
          if (!dependencies.progress) return
          try {
            await dependencies.progress.publish({
              schema_version: '2.0.0',
              type: 'rally_processing_update',
              room_id: `match:${job.submission.rally.matchId}:capture:${job.submission.rally.program.captureSessionId}`,
              rally_id: job.submission.rally.id,
              submission_id: job.submission.id,
              processing_status: processingStatus,
              ai_job_id: job.id,
              worker_instance_key: instanceKey,
              provider_build_id: providerBuildId,
              progress,
              stage,
              updated_at: new Date().toISOString(),
            })
          }
          catch (error) {
            request.log.warn({ error, aiJobId: job.id }, 'AI progress publication failed')
          }
        }
      })().catch(error => {
        request.log.error({ error }, 'AI provider WebSocket setup failed')
        socket.close(1011, 'AI provider gateway failed')
      })
    },
  )
}
