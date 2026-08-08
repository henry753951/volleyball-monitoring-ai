import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'

const OPERATOR_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR])
const CAPTURE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/
const SOURCE_KIND = /^[a-z][a-z0-9_-]{1,31}$/

export class OperationalMutationError extends Error {
  constructor(
    public readonly code: 'BAD_USER_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_RETRYABLE',
    message: string,
  ) {
    super(message)
    this.name = 'OperationalMutationError'
  }
}

export interface StartCaptureInput {
  ingestPath: string
  matchId: string
  sourceConfigSecretRef?: string | null | undefined
  sourceKind: string
  sourceLabel?: string | null | undefined
}

export interface ProcessingStateView {
  rallyId: string
  retriedStage: 'clip' | 'ai'
  status: 'CLIP_QUEUED' | 'AI_QUEUED'
  submissionId: string
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)

function assertOperator(identity: { id: string; role: UserRole }): void {
  if (!OPERATOR_ROLES.has(identity.role)) {
    throw new OperationalMutationError('FORBIDDEN', 'This operation requires operator access')
  }
}

function normalizedCapturePath(value: string): string {
  const path = value.trim()
  const parts = path.split('/')
  if (!CAPTURE_PATH.test(path) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new OperationalMutationError('BAD_USER_INPUT', 'ingestPath must be a safe media stream path')
  }
  return path
}

export async function startCapture(
  database: PrismaClient,
  identity: { id: string; role: UserRole },
  input: StartCaptureInput,
) {
  assertOperator(identity)
  const sourceKind = input.sourceKind.trim().toLowerCase()
  const ingestPath = normalizedCapturePath(input.ingestPath)
  const sourceLabel = input.sourceLabel?.trim() || null
  const sourceConfigSecretRef = input.sourceConfigSecretRef?.trim() || null
  if (!SOURCE_KIND.test(sourceKind)) throw new OperationalMutationError('BAD_USER_INPUT', 'sourceKind is invalid')
  if (sourceLabel && sourceLabel.length > 120) throw new OperationalMutationError('BAD_USER_INPUT', 'sourceLabel is too long')
  if (sourceConfigSecretRef && (sourceConfigSecretRef.length > 200 || /\s/.test(sourceConfigSecretRef))) {
    throw new OperationalMutationError('BAD_USER_INPUT', 'sourceConfigSecretRef must be an opaque secret reference')
  }

  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-path:${ingestPath}`}, 0))::text AS lock`
    const match = await tx.match.findFirst({
      where: {
        id: input.matchId,
        status: { not: 'ARCHIVED' },
        ...(identity.role === UserRole.ADMIN ? {} : { members: { some: { userId: identity.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } } } }),
      },
      select: { id: true, status: true },
    })
    if (!match) throw new OperationalMutationError('NOT_FOUND', 'Match was not found or is not writable')
    const duplicate = await tx.captureSession.findFirst({
      where: { ingestPath, status: { in: ['STARTING', 'LIVE', 'STOPPING'] } },
      select: { id: true },
    })
    if (duplicate) throw new OperationalMutationError('BAD_USER_INPUT', 'ingestPath already belongs to an active capture')

    const capture = await tx.captureSession.create({
      data: {
        matchId: match.id,
        sourceKind,
        sourceLabel,
        sourceConfigSecretRef,
        ingestPath,
        status: 'STARTING',
        health: 'STARTING',
        startedAt: new Date(),
      },
    })
    if (match.status === 'PLANNED') await tx.match.update({ where: { id: match.id }, data: { status: 'LIVE' } })
    await tx.outboxEvent.create({
      data: {
        aggregateId: capture.id,
        aggregateType: 'CaptureSession',
        dedupeKey: `capture-start-requested:${capture.id}`,
        eventType: 'capture.start_requested.v1',
        payload: json({ capture_session_id: capture.id, ingest_path: capture.ingestPath, match_id: capture.matchId }),
      },
    })
    return { ...capture, timeline: null }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

export async function failCaptureStartup(
  database: PrismaClient,
  captureSessionId: string,
  reason: string,
) {
  const errorCode = createHash('sha256').update(reason).digest('hex').slice(0, 16)
  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-session:${captureSessionId}`}, 0))::text AS lock`
    const capture = await tx.captureSession.findUnique({ where: { id: captureSessionId } })
    if (!capture || !['STARTING', 'LIVE'].includes(capture.status)) return capture
    const failed = await tx.captureSession.update({
      data: { endedAt: new Date(), health: 'OFFLINE', status: 'FAILED' },
      where: { id: capture.id },
    })
    await tx.outboxEvent.create({ data: {
      aggregateId: failed.id,
      aggregateType: 'CaptureSession',
      dedupeKey: `capture-start-failed:${failed.id}`,
      eventType: 'capture.start_failed.v1',
      payload: json({ capture_session_id: failed.id, error_code: errorCode }),
    } })
    return failed
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

export async function stopCapture(
  database: PrismaClient,
  identity: { id: string; role: UserRole },
  captureSessionId: string,
) {
  assertOperator(identity)
  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-session:${captureSessionId}`}, 0))::text AS lock`
    const capture = await tx.captureSession.findFirst({
      where: {
        id: captureSessionId,
        ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } } } } }),
      },
      include: {
        programs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
      },
    })
    if (!capture) throw new OperationalMutationError('NOT_FOUND', 'Capture session was not found')
    if (!['STARTING', 'LIVE', 'STOPPING'].includes(capture.status)) {
      throw new OperationalMutationError('BAD_USER_INPUT', 'Capture session is already terminal')
    }
    const endedAt = new Date()
    const endCaptureUs = capture.programs[0]?.liveEdgeUs ?? null
    await tx.dvrProgram.updateMany({ where: { captureSessionId: capture.id, status: { in: ['STARTING', 'LIVE', 'STOPPING'] } }, data: { status: 'FINISHED' } })
    if (endCaptureUs !== null) {
      await tx.captureEpoch.updateMany({ where: { captureSessionId: capture.id, endedAtCaptureUs: null }, data: { endedAtCaptureUs: endCaptureUs } })
    }
    const stopped = await tx.captureSession.update({
      where: { id: capture.id },
      data: { status: 'FINISHED', health: 'OFFLINE', endedAt },
    })
    await tx.outboxEvent.create({
      data: {
        aggregateId: stopped.id,
        aggregateType: 'CaptureSession',
        dedupeKey: `capture-stopped:${stopped.id}`,
        eventType: 'capture.stopped.v1',
        payload: json({ capture_session_id: stopped.id, ended_at: endedAt.toISOString(), final_capture_time_us: endCaptureUs?.toString() ?? null }),
      },
    })
    return { ...stopped, timeline: null }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

function callbackToken(secret: string, aiJobId: string): string {
  if (secret.length < 32) throw new OperationalMutationError('NOT_RETRYABLE', 'AI callback retry secret is unavailable')
  return createHmac('sha256', secret).update(`volleyball-ai-callback:${aiJobId}`).digest('base64url')
}

function retryPayload(value: Prisma.JsonValue, sourceAiJobId: string, nextAiJobId: string) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new OperationalMutationError('NOT_RETRYABLE', 'Stored AI request is invalid')
  }
  const source = value as Record<string, Prisma.JsonValue>
  const clipValue = source.clip
  if (!clipValue || Array.isArray(clipValue) || typeof clipValue !== 'object') {
    throw new OperationalMutationError('NOT_RETRYABLE', 'Stored AI clip request is invalid')
  }
  const clip = { ...(clipValue as Record<string, Prisma.JsonValue>) }
  delete clip.download_url
  delete clip.download_url_expires_at
  const payload: Record<string, unknown> = { ...source, ai_job_id: nextAiJobId, clip }
  delete payload.callback
  const replace = (entry: unknown): unknown => {
    if (entry === sourceAiJobId) return nextAiJobId
    if (Array.isArray(entry)) return entry.map(replace)
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, replace(nested)]))
    return entry
  }
  return replace(payload)
}

export async function retryProcessing(
  database: PrismaClient,
  identity: { id: string; role: UserRole },
  rallyId: string,
  callbackSecret: string,
): Promise<ProcessingStateView> {
  assertOperator(identity)
  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`processing-retry:${rallyId}`}, 0))::text AS lock`
    const rally = await tx.rally.findFirst({
      where: {
        id: rallyId,
        processingStatus: 'FAILED',
        activeSubmissionId: { not: null },
        ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } } } } }),
      },
      include: {
        activeSubmission: {
          include: {
            aiJobs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
            analysisRuns: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
            clipJobs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
          },
        },
      },
    })
    const submission = rally?.activeSubmission
    if (!rally || !submission || submission.status !== 'ACTIVE') {
      throw new OperationalMutationError('NOT_FOUND', 'Failed active Rally processing state was not found')
    }
    const clip = submission.clipJobs[0]
    if (clip?.status === 'FAILED') {
      await tx.clipKeyPointMapping.deleteMany({ where: { clipJobId: clip.id } })
      await tx.clipJob.update({
        where: { id: clip.id },
        data: {
          status: 'QUEUED', attemptCount: 0, availableAt: new Date(), leasedUntil: null,
          errorCode: null, errorMessage: null, startedAt: null, completedAt: null,
          actualStartCaptureUs: null, actualEndCaptureUs: null, clipAssetId: null, timingManifestAssetId: null,
        },
      })
      await tx.rally.update({ where: { id: rally.id }, data: { processingStatus: 'CLIP_QUEUED' } })
      await tx.outboxEvent.create({ data: { aggregateId: rally.id, aggregateType: 'Rally', dedupeKey: `processing-retry:clip:${clip.id}:${Date.now()}`, eventType: 'rally.processing_retry_requested.v1', payload: json({ rally_id: rally.id, stage: 'clip', submission_id: submission.id }) } })
      return { rallyId: rally.id, submissionId: submission.id, status: 'CLIP_QUEUED', retriedStage: 'clip' }
    }

    const sourceAi = submission.aiJobs[0]
    const failedAnalysis = submission.analysisRuns.find(run => run.status === 'FAILED')
    if (!sourceAi || (sourceAi.status !== 'FAILED' && !failedAnalysis)) {
      throw new OperationalMutationError('NOT_RETRYABLE', 'No failed clip or AI stage is retryable')
    }
    if (clip?.status !== 'COMPLETED' || !clip.clipAssetId) {
      throw new OperationalMutationError('NOT_RETRYABLE', 'Canonical clip is not ready for AI retry')
    }
    const aiJobId = randomUUID()
    const requestPayload = retryPayload(sourceAi.requestPayload, sourceAi.id, aiJobId)
    const token = callbackToken(callbackSecret, aiJobId)
    await tx.aiJob.create({
      data: {
        id: aiJobId,
        integrationId: sourceAi.integrationId,
        submissionId: submission.id,
        clipJobId: clip.id,
        status: 'QUEUED',
        idempotencyKey: `${sourceAi.integrationId}:${submission.id}:${clip.id}:retry:${aiJobId}`,
        requestPayload: json(requestPayload),
        requestPayloadHash: createHash('sha256').update(canonical(requestPayload)).digest('hex'),
        jobSchemaVersion: sourceAi.jobSchemaVersion,
        callbackTokenHash: createHash('sha256').update(token).digest('hex'),
        callbackTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        attemptCount: 0,
        maxAttempts: sourceAi.maxAttempts,
        availableAt: new Date(),
      },
    })
    await tx.aiJob.update({ where: { id: sourceAi.id }, data: { status: 'SUPERSEDED', leasedUntil: null } })
    await tx.analysisRun.updateMany({ where: { submissionId: submission.id, status: 'FAILED' }, data: { status: 'SUPERSEDED', supersededAt: new Date() } })
    await tx.rally.update({ where: { id: rally.id }, data: { processingStatus: 'AI_QUEUED' } })
    await tx.outboxEvent.create({ data: { aggregateId: rally.id, aggregateType: 'Rally', dedupeKey: `processing-retry:ai:${aiJobId}`, eventType: 'rally.processing_retry_requested.v1', payload: json({ ai_job_id: aiJobId, rally_id: rally.id, stage: 'ai', submission_id: submission.id, supersedes_ai_job_id: sourceAi.id }) } })
    return { rallyId: rally.id, submissionId: submission.id, status: 'AI_QUEUED', retriedStage: 'ai' }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}
