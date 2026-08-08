import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, ProcessingStatus } from '@volleyball-monitoring/db/client'
import { callbackToken, sha256Hex, stableJson } from '../workflow/crypto.js'
import { createWorkflowMinio } from '../workflow/minio.js'
import { createPollingLifecycle } from '../workflow/poller.js'

const leaseMs = 2 * 60_000
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

async function claimAiJob(database: PrismaClient) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT job.id FROM "AiJob" job
      INNER JOIN "AiIntegration" integration ON integration.id = job."integrationId"
      WHERE integration."transportMode" = 'HTTP_PUSH'
        AND ((job.status = 'QUEUED' AND job."availableAt" <= NOW()) OR (job.status = 'RUNNING' AND job."leasedUntil" < NOW() AND job."acceptedAt" IS NULL))
        AND job."attemptCount" < job."maxAttempts"
      ORDER BY job."availableAt", job."createdAt", job.id
      FOR UPDATE SKIP LOCKED LIMIT 1
    `
    const id = rows[0]?.id
    if (!id) return null
    return tx.aiJob.update({ where: { id }, data: { status: JobStatus.RUNNING, attemptCount: { increment: 1 }, leasedUntil: new Date(Date.now() + leaseMs), startedAt: new Date(), errorCode: null, errorMessage: null } })
  })
}

async function failAiJob(database: PrismaClient, jobId: string, error: unknown) {
  const current = await database.aiJob.findUnique({ where: { id: jobId }, select: { attemptCount: true, maxAttempts: true, submission: { select: { rallyId: true } } } })
  if (!current) return
  const terminal = current.attemptCount >= current.maxAttempts
  await database.$transaction([
    database.aiJob.update({ where: { id: jobId }, data: { status: terminal ? JobStatus.FAILED : JobStatus.QUEUED, leasedUntil: null, availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** current.attemptCount)), errorCode: 'AI_DISPATCH_FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'AI dispatch failed' } }),
    database.rally.update({ where: { id: current.submission.rallyId }, data: { processingStatus: terminal ? ProcessingStatus.FAILED : ProcessingStatus.AI_QUEUED } }),
  ])
}

export function createAiDispatcher(database: PrismaClient) {
  const storage = createWorkflowMinio()
  const callbackSecret = process.env.AI_CALLBACK_TOKEN_SECRET ?? ''
  const callbackBase = (process.env.CALLBACK_PUBLIC_BASE_URL ?? 'http://server:4000').replace(/\/+$/, '')
  const providerToken = process.env.AI_PROVIDER_BEARER_TOKEN

  async function processNext(signal: AbortSignal): Promise<boolean> {
    const claimed = await claimAiJob(database)
    if (!claimed) return false
    try {
      if (!providerToken) throw new Error('AI_PROVIDER_BEARER_TOKEN is required')
      const job = await database.aiJob.findUniqueOrThrow({ where: { id: claimed.id }, include: { integration: true, submission: { include: { rally: true } }, clipJob: { include: { clipAsset: true } } } })
      if (!job.integration.enabled || job.integration.transportMode !== 'HTTP_PUSH' || !job.integration.submitUrl || !job.clipJob.clipAsset?.sha256 || job.clipJob.clipAsset.byteLength === null) throw new Error('HTTP AI integration or canonical clip is not ready')
      const capabilitiesUrl = job.integration.capabilitiesUrl ?? new URL('/v1/capabilities', job.integration.submitUrl).toString()
      const capabilitiesResponse = await fetch(capabilitiesUrl, { signal, headers: { Authorization: `Bearer ${providerToken}` } })
      if (!capabilitiesResponse.ok) throw new Error(`AI capabilities returned ${capabilitiesResponse.status}`)
      const capabilities = await capabilitiesResponse.json()
      if (!isRecord(capabilities) || capabilities.schema_version !== '1.0.0' || !Array.isArray(capabilities.supported_job_schema_versions) || !capabilities.supported_job_schema_versions.includes(job.jobSchemaVersion) || !Array.isArray(capabilities.supported_result_schema_versions) || !capabilities.supported_result_schema_versions.includes(job.integration.resultSchemaVersion) || !Array.isArray(capabilities.supported_overlay_formats) || !capabilities.supported_overlay_formats.includes(job.integration.overlayFormat)) throw new Error('AI provider capabilities are incompatible')

      const downloadExpiresSeconds = 15 * 60
      const downloadExpiresAt = new Date(Date.now() + downloadExpiresSeconds * 1_000)
      const downloadUrl = await storage.client.presignedGetObject(job.clipJob.clipAsset.bucket, job.clipJob.clipAsset.objectKey, downloadExpiresSeconds)
      const token = callbackToken(callbackSecret, job.id)
      if (sha256Hex(token) !== job.callbackTokenHash || job.callbackTokenExpiresAt <= new Date()) throw new Error('AI callback token state is invalid or expired')
      if (!isRecord(job.requestPayload) || !isRecord(job.requestPayload.clip)) throw new Error('AI base request payload is invalid')
      const payload = {
        ...job.requestPayload,
        clip: { ...job.requestPayload.clip, download_url: downloadUrl, download_url_expires_at: downloadExpiresAt.toISOString() },
        callback: { url: `${callbackBase}/api/v1/ai/callback/${job.id}`, token, expires_at: job.callbackTokenExpiresAt.toISOString() },
      }
      const payloadText = stableJson(payload)
      const response = await fetch(job.integration.submitUrl, { method: 'POST', signal, headers: { Authorization: `Bearer ${providerToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': job.id }, body: payloadText })
      const responseText = await response.text()
      let accepted: unknown
      try { accepted = JSON.parse(responseText) } catch { accepted = null }
      if (!response.ok || !isRecord(accepted) || accepted.schema_version !== '1.0.0' || accepted.ai_job_id !== job.id || accepted.state !== 'accepted' || typeof accepted.provider_job_id !== 'string' || typeof accepted.accepted_at !== 'string' || Number.isNaN(Date.parse(accepted.accepted_at))) throw new Error(`AI provider rejected job (${response.status}): ${responseText.slice(0, 800)}`)
      const redacted = { ...payload, callback: { ...(payload.callback as Record<string, unknown>), token: '[redacted]' } }
      await database.$transaction([
        database.aiJob.update({ where: { id: job.id }, data: { requestPayload: redacted, requestPayloadHash: sha256Hex(payloadText), providerJobId: accepted.provider_job_id, acceptedAt: new Date(accepted.accepted_at), status: JobStatus.RUNNING, leasedUntil: null } }),
        database.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.AI_PROCESSING } }),
      ])
      return true
    }
    catch (error) {
      await failAiJob(database, claimed.id, error)
      return true
    }
  }

  return createPollingLifecycle(processNext, { onError: error => console.error('ai-dispatcher loop error', error), disconnect: () => database.$disconnect() })
}
