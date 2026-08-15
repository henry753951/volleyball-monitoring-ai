import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'

const OPERATOR_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR])
const CAPTURE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/
const SOURCE_KIND = /^[a-z][a-z0-9_-]{1,31}$/
const MEDIA_INGEST_LOCK_DOMAIN = 'volleyball-media-ingest-v1'
const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3

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
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value as object)
          .sort()
          .map(
            key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
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
    throw new OperationalMutationError(
      'BAD_USER_INPUT',
      'ingestPath must be a safe media stream path',
    )
  }
  return path
}

function transactionWriteConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

async function serializableTransaction<T>(
  database: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (!transactionWriteConflict(error) || attempt >= SERIALIZABLE_TRANSACTION_ATTEMPTS)
        throw error
      // PostgreSQL can abort a serializable snapshot after the per-match
      // advisory lock wakes up. Retry the whole operation so it observes the
      // capture committed by the winner and returns the domain-level duplicate
      // result instead of leaking Prisma P2034 to the UI.
      await new Promise(resolve => setTimeout(resolve, attempt * 10))
    }
  }
}

async function mediaLifecycleLock(
  tx: Prisma.TransactionClient,
  captureSessionId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        CAST(${MEDIA_INGEST_LOCK_DOMAIN} AS text) || ':' || CAST(${captureSessionId} AS text),
        0
      )
    )::text AS lock
  `
}

async function finalizeCaptureIfDrainedInTransaction(
  tx: Prisma.TransactionClient,
  captureSessionId: string,
) {
  const capture = await tx.captureSession.findUnique({
    include: { programs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
    where: { id: captureSessionId },
  })
  if (!capture || capture.status !== 'STOPPING' || capture.completionExpectedSegments === null)
    return capture

  const program = capture.programs[0] ?? null
  if (capture.completionExpectedSegments > 0 && !program) return capture
  if (program) {
    const [readySegments, pendingSegments] = await Promise.all([
      tx.dvrSegment.count({
        where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null } },
      }),
      tx.dvrSegment.count({ where: { dvrProgramId: program.id, readyAt: null } }),
    ])
    if (readySegments < capture.completionExpectedSegments || pendingSegments > 0) return capture
  }

  const endedAt = new Date()
  const endCaptureUs = program?.liveEdgeUs ?? null
  if (program) {
    await tx.dvrProgram.update({
      data: { status: 'FINISHED' },
      where: { id: program.id },
    })
  }
  if (endCaptureUs !== null) {
    await tx.captureEpoch.updateMany({
      data: { endedAtCaptureUs: endCaptureUs },
      where: { captureSessionId, endedAtCaptureUs: null },
    })
  }
  const finished = await tx.captureSession.update({
    data: {
      endedAt,
      health: 'OFFLINE',
      sourceDurationUs: capture.sourceDurationUs ?? program?.durationUs ?? null,
      status: 'FINISHED',
    },
    where: { id: captureSessionId },
  })
  await tx.outboxEvent.create({
    data: {
      aggregateId: finished.id,
      aggregateType: 'CaptureSession',
      dedupeKey: `capture-source-completed:${finished.id}`,
      eventType: 'capture.source_completed.v1',
      payload: json({
        capture_session_id: finished.id,
        ended_at: endedAt.toISOString(),
        final_capture_time_us: endCaptureUs?.toString() ?? null,
      }),
    },
  })
  return finished
}

export async function updateCaptureSourceMetadata(
  database: PrismaClient,
  captureSessionId: string,
  input: { sourceKind: string; sourceDurationUs: bigint | null },
) {
  const sourceKind = input.sourceKind.trim().toLowerCase()
  if (
    !SOURCE_KIND.test(sourceKind) ||
    (input.sourceDurationUs !== null && input.sourceDurationUs <= 0n)
  ) {
    throw new OperationalMutationError('BAD_USER_INPUT', 'Capture source metadata is invalid')
  }
  return serializableTransaction(database, async tx => {
    await mediaLifecycleLock(tx, captureSessionId)
    const capture = await tx.captureSession.findUnique({ where: { id: captureSessionId } })
    if (!capture) throw new OperationalMutationError('NOT_FOUND', 'Capture session was not found')
    return tx.captureSession.update({
      data: {
        sourceKind,
        ...(input.sourceDurationUs === null ? {} : { sourceDurationUs: input.sourceDurationUs }),
      },
      where: { id: captureSessionId },
    })
  })
}

export async function requestCaptureCompletion(
  database: PrismaClient,
  captureSessionId: string,
  input: {
    expectedSegments: number
    sourceKind: string
    sourceDurationUs: bigint | null
  },
) {
  if (!Number.isSafeInteger(input.expectedSegments) || input.expectedSegments < 0) {
    throw new OperationalMutationError('BAD_USER_INPUT', 'Capture completion watermark is invalid')
  }
  const sourceKind = input.sourceKind.trim().toLowerCase()
  if (
    !SOURCE_KIND.test(sourceKind) ||
    (input.sourceDurationUs !== null && input.sourceDurationUs <= 0n)
  ) {
    throw new OperationalMutationError('BAD_USER_INPUT', 'Capture completion metadata is invalid')
  }
  return serializableTransaction(database, async tx => {
    await mediaLifecycleLock(tx, captureSessionId)
    const capture = await tx.captureSession.findUnique({ where: { id: captureSessionId } })
    if (!capture) throw new OperationalMutationError('NOT_FOUND', 'Capture session was not found')
    if (['FAILED', 'FINISHED'].includes(capture.status)) return capture
    if (
      capture.completionExpectedSegments !== null &&
      capture.completionExpectedSegments !== input.expectedSegments
    ) {
      throw new OperationalMutationError('BAD_USER_INPUT', 'Capture completion watermark changed')
    }
    await tx.captureSession.update({
      data: {
        completionExpectedSegments: input.expectedSegments,
        completionRequestedAt: capture.completionRequestedAt ?? new Date(),
        health: 'HEALTHY',
        sourceKind,
        ...(input.sourceDurationUs === null ? {} : { sourceDurationUs: input.sourceDurationUs }),
        status: 'STOPPING',
      },
      where: { id: captureSessionId },
    })
    await tx.dvrProgram.updateMany({
      data: { status: 'STOPPING' },
      where: { captureSessionId, status: { in: ['STARTING', 'LIVE'] } },
    })
    return finalizeCaptureIfDrainedInTransaction(tx, captureSessionId)
  })
}

export async function finalizeCaptureIfDrained(database: PrismaClient, captureSessionId: string) {
  return database.$transaction(
    async tx => {
      await mediaLifecycleLock(tx, captureSessionId)
      return finalizeCaptureIfDrainedInTransaction(tx, captureSessionId)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
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
  if (!SOURCE_KIND.test(sourceKind))
    throw new OperationalMutationError('BAD_USER_INPUT', 'sourceKind is invalid')
  if (sourceLabel && sourceLabel.length > 120)
    throw new OperationalMutationError('BAD_USER_INPUT', 'sourceLabel is too long')
  if (
    sourceConfigSecretRef &&
    (sourceConfigSecretRef.length > 200 || /\s/.test(sourceConfigSecretRef))
  ) {
    throw new OperationalMutationError(
      'BAD_USER_INPUT',
      'sourceConfigSecretRef must be an opaque secret reference',
    )
  }

  return serializableTransaction(database, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-match:${input.matchId}`}, 0))::text AS lock`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-path:${ingestPath}`}, 0))::text AS lock`
    const match = await tx.match.findFirst({
      where: {
        deletionRequestedAt: null,
        id: input.matchId,
        status: { not: 'ARCHIVED' },
        ...(identity.role === UserRole.ADMIN
          ? {}
          : {
              members: {
                some: { userId: identity.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } },
              },
            }),
      },
      select: { id: true, status: true },
    })
    if (!match)
      throw new OperationalMutationError('NOT_FOUND', 'Match was not found or is not writable')
    const duplicate = await tx.captureSession.findFirst({
      where: {
        OR: [{ ingestPath }, { matchId: match.id }],
        status: { in: ['STARTING', 'LIVE', 'STOPPING'] },
      },
      select: { id: true },
    })
    if (duplicate)
      throw new OperationalMutationError(
        'BAD_USER_INPUT',
        'Match already has an active media source',
      )

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
    if (match.status === 'PLANNED')
      await tx.match.update({ where: { id: match.id }, data: { status: 'LIVE' } })
    await tx.outboxEvent.create({
      data: {
        aggregateId: capture.id,
        aggregateType: 'CaptureSession',
        dedupeKey: `capture-start-requested:${capture.id}`,
        eventType: 'capture.start_requested.v1',
        payload: json({
          capture_session_id: capture.id,
          ingest_path: capture.ingestPath,
          match_id: capture.matchId,
        }),
      },
    })
    return { ...capture, timeline: null }
  })
}

export async function failCaptureStartup(
  database: PrismaClient,
  captureSessionId: string,
  reason: string,
) {
  const errorCode = createHash('sha256').update(reason).digest('hex').slice(0, 16)
  return database.$transaction(
    async tx => {
      await mediaLifecycleLock(tx, captureSessionId)
      const capture = await tx.captureSession.findUnique({ where: { id: captureSessionId } })
      if (!capture || !['STARTING', 'LIVE'].includes(capture.status)) return capture
      const endedAt = new Date()
      const program = await tx.dvrProgram.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: { captureSessionId: capture.id },
      })
      await tx.dvrProgram.updateMany({
        data: { status: 'FINISHED' },
        where: { captureSessionId: capture.id, status: { in: ['STARTING', 'LIVE', 'STOPPING'] } },
      })
      if (program) {
        await tx.captureEpoch.updateMany({
          data: { endedAtCaptureUs: program.liveEdgeUs },
          where: { captureSessionId: capture.id, endedAtCaptureUs: null },
        })
      }
      const failed = await tx.captureSession.update({
        data: { endedAt, health: 'OFFLINE', status: 'FAILED' },
        where: { id: capture.id },
      })
      await tx.outboxEvent.create({
        data: {
          aggregateId: failed.id,
          aggregateType: 'CaptureSession',
          dedupeKey: `capture-start-failed:${failed.id}`,
          eventType: 'capture.start_failed.v1',
          payload: json({ capture_session_id: failed.id, error_code: errorCode }),
        },
      })
      return failed
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}

export async function stopCapture(
  database: PrismaClient,
  identity: { id: string; role: UserRole },
  captureSessionId: string,
) {
  assertOperator(identity)
  return database.$transaction(
    async tx => {
      await mediaLifecycleLock(tx, captureSessionId)
      const capture = await tx.captureSession.findFirst({
        where: {
          id: captureSessionId,
          ...(identity.role === UserRole.ADMIN
            ? {}
            : {
                match: {
                  members: {
                    some: {
                      userId: identity.id,
                      role: { in: [UserRole.ADMIN, UserRole.OPERATOR] },
                    },
                  },
                },
              }),
        },
        include: {
          programs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
        },
      })
      if (!capture) throw new OperationalMutationError('NOT_FOUND', 'Capture session was not found')
      if (['FAILED', 'FINISHED'].includes(capture.status)) {
        return { ...capture, timeline: null }
      }
      if (capture.completionExpectedSegments !== null) {
        const finalized = (await finalizeCaptureIfDrainedInTransaction(tx, capture.id)) ?? capture
        return { ...finalized, timeline: null }
      }
      const managedSource = ['local_mp4', 'youtube', 'youtube_live', 'youtube_vod'].includes(
        capture.sourceKind,
      )
      if (managedSource) {
        if (capture.status !== 'STOPPING') {
          const stopping = await tx.captureSession.update({
            data: { status: 'STOPPING' },
            where: { id: capture.id },
          })
          await tx.dvrProgram.updateMany({
            data: { status: 'STOPPING' },
            where: { captureSessionId: capture.id, status: { in: ['STARTING', 'LIVE'] } },
          })
          await tx.outboxEvent.create({
            data: {
              aggregateId: stopping.id,
              aggregateType: 'CaptureSession',
              dedupeKey: `capture-stop-requested:${stopping.id}`,
              eventType: 'capture.stop_requested.v1',
              payload: json({ capture_session_id: stopping.id }),
            },
          })
          return { ...stopping, timeline: null }
        }
        return { ...capture, timeline: null }
      }
      const endedAt = new Date()
      const endCaptureUs = capture.programs[0]?.liveEdgeUs ?? null
      await tx.dvrProgram.updateMany({
        where: { captureSessionId: capture.id, status: { in: ['STARTING', 'LIVE', 'STOPPING'] } },
        data: { status: 'FINISHED' },
      })
      if (endCaptureUs !== null) {
        await tx.captureEpoch.updateMany({
          where: { captureSessionId: capture.id, endedAtCaptureUs: null },
          data: { endedAtCaptureUs: endCaptureUs },
        })
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
          payload: json({
            capture_session_id: stopped.id,
            ended_at: endedAt.toISOString(),
            final_capture_time_us: endCaptureUs?.toString() ?? null,
          }),
        },
      })
      return { ...stopped, timeline: null }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}

function callbackToken(secret: string, aiJobId: string): string {
  if (secret.length < 32)
    throw new OperationalMutationError('NOT_RETRYABLE', 'AI callback retry secret is unavailable')
  return createHmac('sha256', secret)
    .update(`volleyball-ai-callback:${aiJobId}`)
    .digest('base64url')
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
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry).map(([key, nested]) => [key, replace(nested)]),
      )
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
  return database.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`processing-retry:${rallyId}`}, 0))::text AS lock`
      const rally = await tx.rally.findFirst({
        where: {
          id: rallyId,
          processingStatus: 'FAILED',
          activeSubmissionId: { not: null },
          ...(identity.role === UserRole.ADMIN
            ? {}
            : { match: { members: { some: { userId: identity.id } } } }),
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
        throw new OperationalMutationError(
          'NOT_FOUND',
          'Failed active Rally processing state was not found',
        )
      }
      const clip = submission.clipJobs[0]
      if (clip?.status === 'FAILED') {
        await tx.clipKeyPointMapping.deleteMany({ where: { clipJobId: clip.id } })
        await tx.clipJob.update({
          where: { id: clip.id },
          data: {
            status: 'QUEUED',
            attemptCount: 0,
            availableAt: new Date(),
            leasedUntil: null,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
            actualStartCaptureUs: null,
            actualEndCaptureUs: null,
            clipAssetId: null,
            timingManifestAssetId: null,
          },
        })
        await tx.rally.update({
          where: { id: rally.id },
          data: { processingStatus: 'CLIP_QUEUED' },
        })
        await tx.outboxEvent.create({
          data: {
            aggregateId: rally.id,
            aggregateType: 'Rally',
            dedupeKey: `processing-retry:clip:${clip.id}:${Date.now()}`,
            eventType: 'rally.processing_retry_requested.v1',
            payload: json({ rally_id: rally.id, stage: 'clip', submission_id: submission.id }),
          },
        })
        return {
          rallyId: rally.id,
          submissionId: submission.id,
          status: 'CLIP_QUEUED',
          retriedStage: 'clip',
        }
      }

      const sourceAi = submission.aiJobs[0]
      const failedAnalysis = submission.analysisRuns.find(run => run.status === 'FAILED')
      if (!sourceAi || (sourceAi.status !== 'FAILED' && !failedAnalysis)) {
        throw new OperationalMutationError(
          'NOT_RETRYABLE',
          'No failed clip or AI stage is retryable',
        )
      }
      if (clip?.status !== 'COMPLETED' || !clip.clipAssetId) {
        throw new OperationalMutationError(
          'NOT_RETRYABLE',
          'Canonical clip is not ready for AI retry',
        )
      }
      const aiJobId = randomUUID()
      const requestPayload = retryPayload(sourceAi.requestPayload, sourceAi.id, aiJobId)
      const token = callbackToken(callbackSecret, aiJobId)
      await tx.aiJob.create({
        data: {
          id: aiJobId,
          submissionId: submission.id,
          clipJobId: clip.id,
          status: 'QUEUED',
          idempotencyKey: `volleyball-analysis-engine:${submission.id}:${clip.id}:retry:${aiJobId}`,
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
      await tx.aiJob.update({
        where: { id: sourceAi.id },
        data: { status: 'SUPERSEDED', leasedUntil: null },
      })
      await tx.analysisRun.updateMany({
        where: { submissionId: submission.id, status: 'FAILED' },
        data: { status: 'SUPERSEDED', supersededAt: new Date() },
      })
      await tx.rally.update({ where: { id: rally.id }, data: { processingStatus: 'AI_QUEUED' } })
      await tx.outboxEvent.create({
        data: {
          aggregateId: rally.id,
          aggregateType: 'Rally',
          dedupeKey: `processing-retry:ai:${aiJobId}`,
          eventType: 'rally.processing_retry_requested.v1',
          payload: json({
            ai_job_id: aiJobId,
            rally_id: rally.id,
            stage: 'ai',
            submission_id: submission.id,
            supersedes_ai_job_id: sourceAi.id,
          }),
        },
      })
      return {
        rallyId: rally.id,
        submissionId: submission.id,
        status: 'AI_QUEUED',
        retriedStage: 'ai',
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}
