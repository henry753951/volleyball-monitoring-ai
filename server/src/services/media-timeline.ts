import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import {
  applyTimelineSegments,
  emptyTimelineProjection,
  parseTimelineProjection,
  serializeTimelineProjection,
  type TimelineProjection,
  type TimelineProjectionSegment,
} from './media-timeline-projection.js'

type CaptureSessionRow = Awaited<ReturnType<typeof db.captureSession.findMany>>[number]

interface TimelineProgramRow {
  id: string
  captureSessionId: string
  playlistRevision: bigint
  createdAt: Date
}

export interface MediaTimelineRedisLike {
  get(key: string): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
}

export interface CaptureTimelineRangeView {
  startUs: bigint
  endUs: bigint
  discontinuity: number
}

export interface CaptureTimelineView {
  captureSessionId: string
  timelineVersion: bigint
  captureStartTimeUs: bigint
  liveEdgeCaptureTimeUs: bigint | null
  availableRanges: CaptureTimelineRangeView[]
  availabilityComplete: boolean
  gapRanges: CaptureTimelineRangeView[]
  ingestFrontierCaptureTimeUs: bigint | null
  sourceEndCaptureTimeUs: bigint | null
}

export interface CaptureSessionView {
  id: string
  matchId: string
  sourceLabel: string | null
  sourceKind: string
  sourceDurationUs: bigint | null
  status: CaptureSessionRow['status']
  health: CaptureSessionRow['health']
  startedAt: Date | null
  endedAt: Date | null
  timeline: CaptureTimelineView | null
}

const LOCAL_TIMELINE_TTL_MS = 750
const REDIS_TIMELINE_TTL_SECONDS = 6 * 60 * 60
const REDIS_READ_BUDGET_MS = 75
const REDIS_KEY_PREFIX = 'vmai:media:timeline:v1:'
const localTimelineCache = new Map<
  string,
  { expiresAt: number; timeline: CaptureTimelineView | null }
>()
const timelineLoadsInFlight = new Map<string, Promise<CaptureTimelineView | null>>()
let timelineRedis: MediaTimelineRedisLike | null = null

export function configureMediaTimelineCache(redis: MediaTimelineRedisLike | null): void {
  timelineRedis = redis
  localTimelineCache.clear()
}

function redisKey(programId: string): string {
  return `${REDIS_KEY_PREFIX}${programId}`
}

function localCachedTimeline(sessionId: string): CaptureTimelineView | null | undefined {
  const cached = localTimelineCache.get(sessionId)
  if (!cached) return undefined
  if (cached.expiresAt <= Date.now()) {
    localTimelineCache.delete(sessionId)
    return undefined
  }
  return cached.timeline
}

function setLocalTimeline(sessionId: string, timeline: CaptureTimelineView | null): void {
  localTimelineCache.set(sessionId, {
    expiresAt: Date.now() + LOCAL_TIMELINE_TTL_MS,
    timeline,
  })
  // Keep this a small, process-local anti-stampede cache rather than another
  // unbounded source of truth.
  if (localTimelineCache.size > 256) {
    const oldest = localTimelineCache.keys().next().value as string | undefined
    if (oldest) localTimelineCache.delete(oldest)
  }
}

async function withinBudget<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), milliseconds)
        timer.unref?.()
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readCachedProjection(program: TimelineProgramRow): Promise<TimelineProjection | null> {
  if (!timelineRedis) return null
  const serialized = await withinBudget(timelineRedis.get(redisKey(program.id)), REDIS_READ_BUDGET_MS)
  if (!serialized) return null
  try {
    const projection = parseTimelineProjection(serialized)
    if (projection.programId !== program.id) throw new TypeError('timeline cache program mismatch')
    return projection
  } catch {
    void timelineRedis.del(redisKey(program.id)).catch(() => undefined)
    return null
  }
}

function writeCachedProjection(projection: TimelineProjection): void {
  if (!timelineRedis) return
  void timelineRedis
    .setex(
      redisKey(projection.programId),
      REDIS_TIMELINE_TTL_SECONDS,
      serializeTimelineProjection(projection),
    )
    .catch(() => undefined)
}

function projectionNeedsRebuild(
  projection: TimelineProjection,
  program: TimelineProgramRow,
  latestSequence: bigint | null,
): boolean {
  if (projection.programId !== program.id) return true
  if (projection.playlistRevision > program.playlistRevision) return true
  if (
    projection.observedSequence !== null &&
    (latestSequence === null || latestSequence < projection.observedSequence)
  ) {
    return true
  }
  return false
}

async function loadProgramProjection(program: TimelineProgramRow): Promise<TimelineProjection> {
  const latestSegment = await db.dvrSegment.findFirst({
    orderBy: { sequenceNumber: 'desc' },
    select: { captureEndUs: true, sequenceNumber: true },
    where: { dvrProgramId: program.id },
  })
  const cachedProjection = await readCachedProjection(program)
  const rebuild =
    cachedProjection === null ||
    projectionNeedsRebuild(cachedProjection, program, latestSegment?.sequenceNumber ?? null)
  let projection = rebuild
    ? emptyTimelineProjection(program.id, program.playlistRevision)
    : cachedProjection
  const hasUnobservedTail =
    latestSegment !== null &&
    (projection.observedSequence === null ||
      latestSegment.sequenceNumber > projection.observedSequence)
  const revisionAdvanced = projection.playlistRevision < program.playlistRevision

  if (rebuild || hasUnobservedTail || revisionAdvanced) {
    const segments = await db.dvrSegment.findMany({
      orderBy: { sequenceNumber: 'asc' },
      select: {
        captureEndUs: true,
        captureStartUs: true,
        discontinuitySequence: true,
        isGap: true,
        readyAt: true,
        sequenceNumber: true,
      },
      where: {
        dvrProgramId: program.id,
        ...(!rebuild && projection.finalizedSequence !== null
          ? { sequenceNumber: { gt: projection.finalizedSequence } }
          : {}),
      },
    })
    projection = applyTimelineSegments(
      projection,
      program.playlistRevision,
      segments satisfies TimelineProjectionSegment[],
    )
  }

  if (latestSegment) {
    projection.ingestFrontierUs =
      projection.ingestFrontierUs === null ||
      latestSegment.captureEndUs > projection.ingestFrontierUs
        ? latestSegment.captureEndUs
        : projection.ingestFrontierUs
  }
  writeCachedProjection(projection)
  return projection
}

function timelineFromProjection(
  session: CaptureSessionRow,
  program: TimelineProgramRow,
  projection: TimelineProjection,
): CaptureTimelineView | null {
  if (
    projection.captureStartUs === null ||
    projection.liveEdgeUs === null ||
    projection.availableRanges.length === 0
  ) {
    return null
  }
  const sourceEndCaptureTimeUs =
    session.status === 'FAILED'
      ? projection.liveEdgeUs
      : session.sourceDurationUs !== null
        ? projection.captureStartUs + session.sourceDurationUs
        : session.status === 'FINISHED'
          ? projection.liveEdgeUs
          : null
  return {
    availableRanges: projection.availableRanges.map(range => ({ ...range })),
    availabilityComplete: session.status === 'FINISHED' || session.status === 'FAILED',
    captureSessionId: session.id,
    captureStartTimeUs: projection.captureStartUs,
    gapRanges: projection.gapRanges.map(range => ({ ...range })),
    ingestFrontierCaptureTimeUs: projection.ingestFrontierUs,
    liveEdgeCaptureTimeUs: projection.liveEdgeUs,
    sourceEndCaptureTimeUs,
    timelineVersion: program.playlistRevision,
  }
}

async function loadCaptureTimelinesUncached(
  sessionIds: string[],
  knownSessions: ReadonlyMap<string, CaptureSessionRow> = new Map(),
): Promise<Map<string, CaptureTimelineView>> {
  if (sessionIds.length === 0) return new Map()
  const uniqueSessionIds = [...new Set(sessionIds)]
  const missingSessionIds = uniqueSessionIds.filter(id => !knownSessions.has(id))
  const loadedSessions = missingSessionIds.length
    ? await db.captureSession.findMany({ where: { id: { in: missingSessionIds } } })
    : []
  const sessionById = new Map(knownSessions)
  for (const session of loadedSessions) sessionById.set(session.id, session)

  const programSelect = {
    captureSessionId: true,
    createdAt: true,
    id: true,
    playlistRevision: true,
  } as const
  const programs: TimelineProgramRow[] =
    uniqueSessionIds.length === 1
      ? [
          await db.dvrProgram.findFirst({
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: programSelect,
            where: { captureSessionId: uniqueSessionIds[0]! },
          }),
        ].filter((program): program is TimelineProgramRow => program !== null)
      : await db.dvrProgram.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: programSelect,
          where: { captureSessionId: { in: uniqueSessionIds } },
        })
  const newestProgramBySession = new Map<string, TimelineProgramRow>()
  for (const program of programs) {
    if (!newestProgramBySession.has(program.captureSessionId)) {
      newestProgramBySession.set(program.captureSessionId, program)
    }
  }

  const timelines = new Map<string, CaptureTimelineView>()
  await Promise.all(
    uniqueSessionIds.map(async sessionId => {
      const session = sessionById.get(sessionId)
      const program = newestProgramBySession.get(sessionId)
      if (!session || !program) {
        setLocalTimeline(sessionId, null)
        return
      }
      const projection = await loadProgramProjection(program)
      const timeline = timelineFromProjection(session, program, projection)
      setLocalTimeline(sessionId, timeline)
      if (timeline) timelines.set(sessionId, timeline)
    }),
  )
  return timelines
}

export async function loadCaptureTimelines(
  sessionIds: string[],
  knownSessions: ReadonlyMap<string, CaptureSessionRow> = new Map(),
): Promise<Map<string, CaptureTimelineView>> {
  if (sessionIds.length === 0) return new Map()
  const timelines = new Map<string, CaptureTimelineView>()
  const missing: string[] = []
  for (const sessionId of new Set(sessionIds)) {
    const cached = localCachedTimeline(sessionId)
    if (cached === undefined) missing.push(sessionId)
    else if (cached) timelines.set(sessionId, cached)
  }
  if (missing.length) {
    const loaded = await loadCaptureTimelinesUncached(missing, knownSessions)
    for (const [sessionId, timeline] of loaded) timelines.set(sessionId, timeline)
  }
  return timelines
}

export async function listCaptureSessionsForMatch(matchId: string): Promise<CaptureSessionView[]> {
  const sessions = await db.captureSession.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: { matchId },
  })
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const timelines = await loadCaptureTimelines(
    sessions.map(session => session.id),
    sessionById,
  )
  return sessions.map(session => ({
    endedAt: session.endedAt,
    health: session.health,
    id: session.id,
    matchId: session.matchId,
    sourceLabel: session.sourceLabel,
    sourceDurationUs: session.sourceDurationUs,
    sourceKind: session.sourceKind,
    startedAt: session.startedAt,
    status: session.status,
    timeline: timelines.get(session.id) ?? null,
  }))
}

export async function loadCaptureTimeline(
  sessionId: string,
  knownSession?: CaptureSessionRow,
): Promise<CaptureTimelineView | null> {
  const cached = localCachedTimeline(sessionId)
  if (cached !== undefined) return cached
  const existing = timelineLoadsInFlight.get(sessionId)
  if (existing) return existing
  const pending = loadCaptureTimelinesUncached(
    [sessionId],
    knownSession ? new Map([[knownSession.id, knownSession]]) : new Map(),
  ).then(timelines => timelines.get(sessionId) ?? null)
  timelineLoadsInFlight.set(sessionId, pending)
  try {
    return await pending
  } finally {
    if (timelineLoadsInFlight.get(sessionId) === pending) timelineLoadsInFlight.delete(sessionId)
  }
}

export function getVisibleCaptureSession(
  id: string,
  userId: string,
  role: UserRole,
): Promise<CaptureSessionRow | null> {
  return db.captureSession.findFirst({
    where: {
      id,
      ...(role === UserRole.ADMIN ? {} : { match: { members: { some: { userId } } } }),
    },
  })
}
