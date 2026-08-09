import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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

const leaseMs = 60_000
const callbackLifetimeMs = 30 * 60_000
const tickMs = 1_000
const heartbeatIntervalSeconds = 10
const heartbeatTimeoutMs = heartbeatIntervalSeconds * 3 * 1_000
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function secureTokenMatches(actual: string | null, expected: string | undefined) {
  if (!actual || !expected) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function bearer(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/.exec(header ?? '')
  return match?.[1] ?? null
}

function integrationToken(authSecretRef: string) {
  const referenced = authSecretRef.startsWith('env:') ? process.env[authSecretRef.slice(4)] : undefined
  return process.env.AI_PROVIDER_WS_TOKEN ?? referenced
}

function createMinioSigner() {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000')
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
  })
}

function compatible(capabilities: AIProviderCapabilitiesPayload, integration: {
  jobSchemaVersion: string
  resultSchemaVersion: string
  overlayFormat: string
}) {
  return capabilities.supported_job_schema_versions.includes(integration.jobSchemaVersion)
    && capabilities.supported_result_schema_versions.includes(integration.resultSchemaVersion)
    && capabilities.supported_overlay_formats.includes(integration.overlayFormat)
}

export interface AiProviderWebSocketDependencies {
  database: PrismaClient
  presign?: (bucket: string, objectKey: string, expiresSeconds: number) => Promise<string>
  callbackBaseUrl?: string
  progress?: AiProgressService
}

interface ProviderInstanceLoadRow {
  id: string
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
  integrationId: string,
): Promise<string | null> {
  const rows = await database.$queryRaw<ProviderInstanceLoadRow[]>`
    SELECT instance.id
    FROM "AiProviderInstance" instance
    LEFT JOIN "AiJob" job
      ON job."providerInstanceId" = instance.id
      AND job.status IN ('QUEUED', 'RUNNING')
      AND job."deliveryId" IS NOT NULL
    WHERE instance."integrationId" = ${integrationId}::uuid
      AND instance."disconnectedAt" IS NULL
      AND instance."lastSeenAt" >= NOW() - INTERVAL '30 seconds'
      AND instance."maxConcurrency" > 0
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

  app.get<{ Querystring: { integration_id?: string } }>(
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
        const integrationId = request.query.integration_id
        if (!integrationId) {
          socket.close(1008, 'integration_id is required')
          return
        }
        const integration = await database.aiIntegration.findUnique({ where: { id: integrationId } })
        if (!integration || !integration.enabled || integration.transportMode !== 'WS_AGENT') {
          socket.close(1008, 'WebSocket AI integration not found')
          return
        }
        if (!secureTokenMatches(bearer(request.headers.authorization), integrationToken(integration.authSecretRef))) {
          socket.close(1008, 'authentication required')
          return
        }

        let instanceId: string | null = null
        let instanceKey: string | null = null
        let providerBuildId: string | null = null
        let maxConcurrency = 0
        let ticking = false
        let lastHeartbeatAt = Date.now()
        const abortSent = new Set<string>()
        const committedSent = new Set<string>()
        const send = (message: AIProviderServerMessage) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(message))
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
              select: { id: true, deliveryId: true, status: true, cancelRequestedAt: true, completedAt: true },
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

            const activeDeliveries = assigned.filter(job => job.status === JobStatus.QUEUED || job.status === JobStatus.RUNNING).length
            for (let slot = activeDeliveries; slot < maxConcurrency; slot += 1) {
              const leastBusyInstanceId = await findLeastBusyProviderInstanceId(database, integration.id)
              if (leastBusyInstanceId !== instanceId) break
              const deliveryId = randomUUID()
              const callbackToken = randomBytes(32).toString('base64url')
              const callbackExpiresAt = new Date(Date.now() + callbackLifetimeMs)
              const leaseExpiresAt = new Date(Date.now() + leaseMs)
              const job = await database.$transaction(async (tx) => {
                const rows = await tx.$queryRaw<Array<{ id: string }>>`
                  SELECT job.id
                  FROM "AiJob" job
                  INNER JOIN "AiIntegration" integration ON integration.id = job."integrationId"
                  WHERE job."integrationId" = ${integration.id}::uuid
                    AND integration."transportMode" = 'WS_AGENT'
                    AND job.status = 'QUEUED'
                    AND job."availableAt" <= NOW()
                    AND (job."leasedUntil" IS NULL OR job."leasedUntil" < NOW())
                    AND job."attemptCount" < job."maxAttempts"
                    AND job."cancelRequestedAt" IS NULL
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
        socket.on('close', () => {
          clearInterval(interval)
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
              if (message.provider_build_id !== message.capabilities.provider_build_id || !compatible(message.capabilities, integration)) {
                send({ schema_version: '1.0.0', type: 'protocol_error', code: 'INCOMPATIBLE_CAPABILITIES', message: 'provider capabilities are incompatible with this integration', retryable: false })
                socket.close(1008, 'incompatible capabilities')
                return
              }
              instanceKey = message.instance_id
              providerBuildId = message.provider_build_id
              maxConcurrency = message.max_concurrency
              const instance = await database.aiProviderInstance.upsert({
                where: { integrationId_instanceKey: { integrationId: integration.id, instanceKey } },
                update: { sdkVersion: message.sdk_version, providerBuildId: message.provider_build_id, capabilities: json(message.capabilities), maxConcurrency, lastSeenAt: new Date(), connectedAt: new Date(), disconnectedAt: null },
                create: { integrationId: integration.id, instanceKey, sdkVersion: message.sdk_version, providerBuildId: message.provider_build_id, capabilities: json(message.capabilities), maxConcurrency, lastSeenAt: new Date() },
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
          await database.aiJob.update({ where: { id: active.ai_job_id }, data: { leasedUntil: leaseExpiresAt, ...(active.progress === undefined ? {} : { progress: active.progress }) } })
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
