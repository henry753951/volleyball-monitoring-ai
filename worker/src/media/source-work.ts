import type { PrismaClient } from '@volleyball-monitoring/db'

export type ClaimedMediaSourceWork = {
  id: string
  captureSessionId: string
  sourceKind: 'youtube' | 'local_mp4'
  sourceUrl: string | null
  importKey: string | null
  attempts: number
  status: 'RUNNING' | 'DRAINING'
  segmentBaseAt: Date
  resumeSegmentIndex: number
  resumeCaptureTimeUs: bigint
  ingestPath: string
  captureSourceKind?: string
  captureSourceDurationUs?: bigint | null
}

export type SourceCompletion = {
  expectedSegments: number
  sourceDurationUs: bigint | null
  sourceKind: 'youtube' | 'youtube_live' | 'youtube_vod' | 'local_mp4'
}

export type MediaSourceWorkState = {
  sourceOnline: boolean
  status: string
}

export type CompletedMediaSpoolCandidate = {
  workId: string
  ingestPath: string
}

export async function listCompletedMediaSpoolCandidates(
  database: PrismaClient,
): Promise<CompletedMediaSpoolCandidate[]> {
  return database.$queryRaw<CompletedMediaSpoolCandidate[]>`
    WITH segment_counts AS (
      SELECT
        program."captureSessionId",
        COUNT(segment."id") FILTER (WHERE segment."isGap" = FALSE)::int AS "segmentCount",
        COUNT(segment."id") FILTER (
          WHERE segment."isGap" = FALSE
            AND segment."readyAt" IS NOT NULL
            AND init."state" = 'READY'
            AND init."sha256" IS NOT NULL
            AND media."state" = 'READY'
            AND media."sha256" IS NOT NULL
            AND sample."state" = 'READY'
            AND sample."sha256" IS NOT NULL
        )::int AS "readySegmentCount"
      FROM "DvrProgram" program
      LEFT JOIN "DvrSegment" segment ON segment."dvrProgramId" = program."id"
      LEFT JOIN "MediaAsset" init ON init."id" = segment."initAssetId"
      LEFT JOIN "MediaAsset" media ON media."id" = segment."mediaAssetId"
      LEFT JOIN "MediaAsset" sample ON sample."id" = segment."sampleIndexAssetId"
      GROUP BY program."captureSessionId"
    )
    SELECT
      work."id" AS "workId",
      capture."ingestPath"
    FROM "MediaSourceWork" work
    JOIN "CaptureSession" capture ON capture."id" = work."captureSessionId"
    LEFT JOIN segment_counts counts ON counts."captureSessionId" = capture."id"
    WHERE work."status" = 'COMPLETED'
      AND capture."status" = 'FINISHED'
      AND capture."completionExpectedSegments" IS NOT NULL
      AND COALESCE(counts."segmentCount", 0) = capture."completionExpectedSegments"
      AND COALESCE(counts."readySegmentCount", 0) = capture."completionExpectedSegments"
      AND NOT EXISTS (
        SELECT 1 FROM "MediaIngestFailure" failure
        WHERE failure."captureSessionId" = capture."id"
    )
    ORDER BY work."updatedAt" ASC, work."id" ASC
  `
}

export async function recordPermanentMediaIngestFailure(
  database: PrismaClient,
  input: { sourceJobId: string; captureSessionId: string; code: string },
): Promise<void> {
  try {
    await database.mediaIngestFailure.upsert({
      create: input,
      update: { captureSessionId: input.captureSessionId, code: input.code },
      where: { sourceJobId: input.sourceJobId },
    })
  }
  catch (error) {
    // Match deletion may cascade the capture/work rows while a leased worker unwinds.
    // There is intentionally no failure record to retain once its capture is gone.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003') return
    throw error
  }
}

export async function claimStoppedMediaSourceWork(
  database: PrismaClient,
  owner: string,
  limit: number,
  leaseSeconds = 30,
): Promise<ClaimedMediaSourceWork[]> {
  if (limit <= 0) return []
  return database.$queryRaw<ClaimedMediaSourceWork[]>`
    WITH candidate AS (
      SELECT work."id"
      FROM "MediaSourceWork" work
      WHERE work."status" = 'STOP_REQUESTED'
        AND (work."leaseExpiresAt" IS NULL OR work."leaseExpiresAt" < CURRENT_TIMESTAMP)
      ORDER BY work."updatedAt" ASC, work."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "MediaSourceWork" work
      SET
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        "lastHeartbeatAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE work."id" = candidate."id"
      RETURNING work.*
    )
    SELECT
      claimed."id",
      claimed."captureSessionId",
      claimed."sourceKind",
      claimed."sourceUrl",
      claimed."importKey",
      claimed."attempts",
      'RUNNING'::text AS "status",
      claimed."segmentBaseAt",
      claimed."resumeSegmentIndex",
      claimed."resumeCaptureTimeUs",
      capture."ingestPath",
      capture."sourceKind" AS "captureSourceKind",
      capture."sourceDurationUs" AS "captureSourceDurationUs"
    FROM claimed
    JOIN "CaptureSession" capture ON capture."id" = claimed."captureSessionId"
  `
}

export async function claimMediaSourceWork(
  database: PrismaClient,
  owner: string,
  limit: number,
  leaseSeconds = 30,
): Promise<ClaimedMediaSourceWork[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new TypeError('invalid media source claim limit')
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) throw new TypeError('invalid media source lease')
  return database.$queryRaw<ClaimedMediaSourceWork[]>`
    WITH candidate AS (
      SELECT work."id"
      FROM "MediaSourceWork" work
      WHERE (
        work."status" = 'REQUESTED'
        AND work."availableAt" <= CURRENT_TIMESTAMP
      ) OR (
        work."status" = 'RUNNING'
        AND work."leaseExpiresAt" < CURRENT_TIMESTAMP
      )
      ORDER BY work."availableAt" ASC, work."createdAt" ASC, work."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "MediaSourceWork" work
      SET
        "status" = 'RUNNING'::"MediaSourceWorkStatus",
        "attempts" = work."attempts" + 1,
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        "lastHeartbeatAt" = CURRENT_TIMESTAMP,
        "lastErrorCode" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE work."id" = candidate."id"
      RETURNING work.*
    )
    SELECT
      claimed."id",
      claimed."captureSessionId",
      claimed."sourceKind",
      claimed."sourceUrl",
      claimed."importKey",
      claimed."attempts",
      claimed."status",
      claimed."segmentBaseAt",
      claimed."resumeSegmentIndex",
      claimed."resumeCaptureTimeUs",
      capture."ingestPath"
    FROM claimed
    JOIN "CaptureSession" capture ON capture."id" = claimed."captureSessionId"
  `
}

export async function claimDrainingMediaSourceWork(
  database: PrismaClient,
  owner: string,
  limit: number,
  leaseSeconds = 30,
): Promise<ClaimedMediaSourceWork[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new TypeError('invalid media source drain claim limit')
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) throw new TypeError('invalid media source lease')
  return database.$queryRaw<ClaimedMediaSourceWork[]>`
    WITH candidate AS (
      SELECT work."id"
      FROM "MediaSourceWork" work
      WHERE work."status" = 'DRAINING'
        AND (work."leaseExpiresAt" IS NULL OR work."leaseExpiresAt" < CURRENT_TIMESTAMP)
      ORDER BY work."updatedAt" ASC, work."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "MediaSourceWork" work
      SET
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        "lastHeartbeatAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE work."id" = candidate."id"
      RETURNING work.*
    )
    SELECT
      claimed."id",
      claimed."captureSessionId",
      claimed."sourceKind",
      claimed."sourceUrl",
      claimed."importKey",
      claimed."attempts",
      claimed."status",
      claimed."segmentBaseAt",
      claimed."resumeSegmentIndex",
      claimed."resumeCaptureTimeUs",
      capture."ingestPath",
      capture."sourceKind" AS "captureSourceKind",
      capture."sourceDurationUs" AS "captureSourceDurationUs"
    FROM claimed
    JOIN "CaptureSession" capture ON capture."id" = claimed."captureSessionId"
  `
}

export async function heartbeatMediaSourceWork(
  database: PrismaClient,
  owner: string,
  workIds: string[],
  leaseSeconds = 30,
): Promise<number> {
  if (workIds.length === 0) return 0
  const result = await database.mediaSourceWork.updateMany({
    data: {
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1_000),
    },
    where: { id: { in: workIds }, leaseOwner: owner, status: { in: ['RUNNING', 'DRAINING'] } },
  })
  return result.count
}

export async function mediaSourceWorkStates(
  database: PrismaClient,
  workIds: string[],
): Promise<Map<string, MediaSourceWorkState>> {
  if (workIds.length === 0) return new Map()
  const rows = await database.mediaSourceWork.findMany({
    select: {
      captureSession: { select: { sourceOnline: true } },
      id: true,
      status: true,
    },
    where: { id: { in: workIds } },
  })
  return new Map(rows.map(row => [row.id, {
    sourceOnline: row.captureSession.sourceOnline,
    status: row.status,
  }]))
}

export async function recordMediaSourceClassification(
  database: PrismaClient,
  captureSessionId: string,
  input: Pick<SourceCompletion, 'sourceDurationUs' | 'sourceKind'>,
): Promise<void> {
  await database.captureSession.update({
    data: {
      health: 'HEALTHY',
      sourceDurationUs: input.sourceDurationUs,
      sourceKind: input.sourceKind,
    },
    where: { id: captureSessionId },
  })
}

export async function recordMediaSourceResume(
  database: PrismaClient,
  workId: string,
  segmentIndex: number,
  captureTimeUs: bigint,
): Promise<void> {
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || captureTimeUs < 0n) throw new TypeError('invalid media source resume point')
  await database.mediaSourceWork.update({
    data: {
      resumeCaptureTimeUs: captureTimeUs,
      resumeSegmentIndex: segmentIndex,
    },
    where: { id: workId },
  })
}

export async function recordMediaSourceRelayError(
  database: PrismaClient,
  workId: string,
  owner: string,
  errorCode: string | null,
): Promise<number> {
  const safeCode = errorCode === null
    ? null
    : errorCode.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 120) || 'MEDIA_COMMAND_FAILED'
  const result = await database.mediaSourceWork.updateMany({
    data: { lastErrorCode: safeCode },
    where: { id: workId, leaseOwner: owner, status: 'RUNNING' },
  })
  return result.count
}

export async function recordMediaSourceRelayHealthy(
  database: PrismaClient,
  workId: string,
  owner: string,
): Promise<number> {
  const result = await database.mediaSourceWork.updateMany({
    data: { attempts: 0, lastErrorCode: null },
    where: { id: workId, leaseOwner: owner, status: 'RUNNING' },
  })
  return result.count
}

export async function requestMediaSourceCompletion(
  database: PrismaClient,
  workId: string,
  completion: SourceCompletion,
): Promise<void> {
  await database.$transaction(async (tx) => {
    const work = await tx.mediaSourceWork.findUnique({ where: { id: workId } })
    if (!work) return
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-media:${work.captureSessionId}`}, 0))::text AS lock`
    const capture = await tx.captureSession.findUnique({ where: { id: work.captureSessionId } })
    if (!capture || ['FAILED', 'FINISHED'].includes(capture.status)) return
    if (
      capture.completionExpectedSegments !== null
      && capture.completionExpectedSegments !== completion.expectedSegments
    ) throw new Error('Capture completion watermark changed')
    await tx.captureSession.update({
      data: {
        completionExpectedSegments: completion.expectedSegments,
        completionRequestedAt: capture.completionRequestedAt ?? new Date(),
        health: 'HEALTHY',
        sourceDurationUs: completion.sourceDurationUs,
        sourceKind: completion.sourceKind,
        status: 'STOPPING',
      },
      where: { id: work.captureSessionId },
    })
    await tx.dvrProgram.updateMany({
      data: { status: 'STOPPING' },
      where: { captureSessionId: work.captureSessionId, status: { in: ['STARTING', 'LIVE'] } },
    })
    await tx.mediaSourceWork.update({
      data: { status: 'DRAINING' },
      where: { id: workId },
    })
  }, { isolationLevel: 'Serializable' })
}

export async function releaseMediaSourceLease(
  database: PrismaClient,
  workId: string,
): Promise<void> {
  await database.mediaSourceWork.updateMany({
    data: { leaseExpiresAt: null, leaseOwner: null },
    where: { id: workId, status: 'DRAINING' },
  })
}

export async function finalizeMediaSourceIfDrained(
  database: PrismaClient,
  workId: string,
): Promise<boolean> {
  return database.$transaction(async (tx) => {
    const work = await tx.mediaSourceWork.findUnique({ where: { id: workId } })
    if (!work) return true
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-media:${work.captureSessionId}`}, 0))::text AS lock`
    const capture = await tx.captureSession.findUnique({
      include: { programs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
      where: { id: work.captureSessionId },
    })
    if (!capture || capture.status === 'FAILED') {
      await tx.mediaSourceWork.update({ data: { leaseExpiresAt: null, leaseOwner: null, status: 'FAILED' }, where: { id: workId } })
      return true
    }
    if (capture.status === 'FINISHED') {
      await tx.mediaSourceWork.update({ data: { leaseExpiresAt: null, leaseOwner: null, status: 'COMPLETED' }, where: { id: workId } })
      return true
    }
    if (capture.status !== 'STOPPING' || capture.completionExpectedSegments === null) return false
    const program = capture.programs[0] ?? null
    if (capture.completionExpectedSegments > 0 && !program) return false
    if (program) {
      const [readySegments, pendingSegments] = await Promise.all([
        tx.dvrSegment.count({ where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null } } }),
        tx.dvrSegment.count({ where: { dvrProgramId: program.id, readyAt: null } }),
      ])
      if (readySegments < capture.completionExpectedSegments || pendingSegments > 0) return false
    }
    const endedAt = new Date()
    const endCaptureUs = program?.liveEdgeUs ?? null
    if (program) await tx.dvrProgram.update({ data: { status: 'FINISHED' }, where: { id: program.id } })
    if (endCaptureUs !== null) {
      await tx.captureEpoch.updateMany({
        data: { endedAtCaptureUs: endCaptureUs },
        where: { captureSessionId: capture.id, endedAtCaptureUs: null },
      })
    }
    await tx.captureSession.update({
      data: {
        endedAt,
        health: 'OFFLINE',
        sourceDurationUs: capture.sourceDurationUs ?? program?.durationUs ?? null,
        status: 'FINISHED',
      },
      where: { id: capture.id },
    })
    await tx.mediaSourceWork.update({
      data: { leaseExpiresAt: null, leaseOwner: null, status: 'COMPLETED' },
      where: { id: workId },
    })
    await tx.outboxEvent.upsert({
      create: {
        aggregateId: capture.id,
        aggregateType: 'CaptureSession',
        dedupeKey: `capture-source-completed:${capture.id}`,
        eventType: 'capture.source_completed.v1',
        payload: {
          capture_session_id: capture.id,
          ended_at: endedAt.toISOString(),
          final_capture_time_us: endCaptureUs?.toString() ?? null,
        },
      },
      update: {},
      where: { dedupeKey: `capture-source-completed:${capture.id}` },
    })
    return true
  }, { isolationLevel: 'Serializable' })
}

export async function failMediaSourceWork(
  database: PrismaClient,
  workId: string,
  errorCode: string,
): Promise<void> {
  const safeCode = errorCode.replace(/[^A-Z0-9_]/gi, '_').slice(0, 120) || 'MEDIA_SOURCE_FAILED'
  await database.$transaction(async (tx) => {
    const work = await tx.mediaSourceWork.findUnique({ where: { id: workId } })
    if (!work) return
    await tx.mediaSourceWork.update({
      data: { lastErrorCode: safeCode, leaseExpiresAt: null, leaseOwner: null, status: 'FAILED' },
      where: { id: workId },
    })
    await tx.captureSession.updateMany({
      data: { endedAt: new Date(), health: 'OFFLINE', status: 'FAILED' },
      where: { id: work.captureSessionId, status: { notIn: ['FAILED', 'FINISHED'] } },
    })
    await tx.dvrProgram.updateMany({
      data: { status: 'FAILED' },
      where: { captureSessionId: work.captureSessionId, status: { in: ['STARTING', 'LIVE', 'STOPPING'] } },
    })
  })
}

export async function retryMediaSourceWork(
  database: PrismaClient,
  workId: string,
  errorCode: string,
  delayMs: number,
): Promise<void> {
  await database.mediaSourceWork.update({
    data: {
      availableAt: new Date(Date.now() + delayMs),
      lastErrorCode: errorCode.replace(/[^A-Z0-9_]/gi, '_').slice(0, 120),
      leaseExpiresAt: null,
      leaseOwner: null,
      status: 'REQUESTED',
    },
    where: { id: workId },
  })
}
