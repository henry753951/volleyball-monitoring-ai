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

export async function recordPermanentMediaIngestFailure(
  database: PrismaClient,
  input: { sourceJobId: string; captureSessionId: string; code: string },
): Promise<void> {
  await database.mediaIngestFailure.upsert({
    create: input,
    update: { captureSessionId: input.captureSessionId, code: input.code },
    where: { sourceJobId: input.sourceJobId },
  })
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
): Promise<Map<string, string>> {
  if (workIds.length === 0) return new Map()
  const rows = await database.mediaSourceWork.findMany({
    select: { id: true, status: true },
    where: { id: { in: workIds } },
  })
  return new Map(rows.map(row => [row.id, row.status]))
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
): Promise<void> {
  await database.mediaSourceWork.update({
    data: {
      resumeCaptureTimeUs: BigInt(segmentIndex) * 2_000_000n,
      resumeSegmentIndex: segmentIndex,
    },
    where: { id: workId },
  })
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
      const [readySegments, failedSegments, pendingSegments] = await Promise.all([
        tx.dvrSegment.count({ where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null } } }),
        tx.mediaIngestFailure.count({ where: { captureSessionId: capture.id } }),
        tx.dvrSegment.count({ where: { dvrProgramId: program.id, readyAt: null } }),
      ])
      if (readySegments + failedSegments < capture.completionExpectedSegments || pendingSegments > 0) return false
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
