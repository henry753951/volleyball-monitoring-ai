import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'

type CaptureSessionRow = Awaited<ReturnType<typeof db.captureSession.findMany>>[number]

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

export async function loadCaptureTimelines(
  sessionIds: string[],
): Promise<Map<string, CaptureTimelineView>> {
  if (sessionIds.length === 0) return new Map()

  const programs = await db.dvrProgram.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: { captureSessionId: { in: sessionIds } },
  })
  const newestProgramBySession = new Map<string, (typeof programs)[number]>()
  for (const program of programs) {
    if (!newestProgramBySession.has(program.captureSessionId)) {
      newestProgramBySession.set(program.captureSessionId, program)
    }
  }

  const programIds = [...newestProgramBySession.values()].map(program => program.id)
  const sessions = await db.captureSession.findMany({
    where: { id: { in: sessionIds } },
  })
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const segments = await db.dvrSegment.findMany({
    include: { initAsset: true, mediaAsset: true, sampleIndexAsset: true },
    orderBy: [{ captureStartUs: 'asc' }, { sequenceNumber: 'asc' }],
    where: { dvrProgramId: { in: programIds } },
  })
  const segmentsByProgram = new Map<string, typeof segments>()
  for (const segment of segments) {
    const grouped = segmentsByProgram.get(segment.dvrProgramId) ?? []
    grouped.push(segment)
    segmentsByProgram.set(segment.dvrProgramId, grouped)
  }

  const timelines = new Map<string, CaptureTimelineView>()
  for (const [sessionId, program] of newestProgramBySession) {
    const availableRanges: CaptureTimelineRangeView[] = []
    const gapRanges: CaptureTimelineRangeView[] = []
    const programSegments = segmentsByProgram.get(program.id) ?? []
    for (const segment of programSegments) {
      if (segment.isGap) {
        gapRanges.push({
          discontinuity: segment.discontinuitySequence,
          endUs: segment.captureEndUs,
          startUs: segment.captureStartUs,
        })
        continue
      }
      const ready =
        segment.readyAt !== null &&
        segment.initAsset?.state === 'READY' &&
        segment.initAsset.internalSchemaVersion !== null &&
        segment.mediaAsset?.state === 'READY' &&
        segment.mediaAsset.internalSchemaVersion !== null &&
        segment.sampleIndexAsset?.state === 'READY' &&
        segment.sampleIndexAsset.internalSchemaVersion !== null
      if (!ready) continue
      const previous = availableRanges.at(-1)
      if (
        previous &&
        previous.discontinuity === segment.discontinuitySequence &&
        previous.endUs >= segment.captureStartUs
      ) {
        previous.endUs =
          previous.endUs > segment.captureEndUs ? previous.endUs : segment.captureEndUs
      } else {
        availableRanges.push({
          discontinuity: segment.discontinuitySequence,
          endUs: segment.captureEndUs,
          startUs: segment.captureStartUs,
        })
      }
    }

    if (availableRanges.length > 0) {
      const session = sessionById.get(sessionId)
      const captureStartTimeUs = availableRanges[0]!.startUs
      const lastReadyEndUs = availableRanges.at(-1)!.endUs
      const ingestFrontierCaptureTimeUs = programSegments.reduce<bigint | null>(
        (frontier, segment) =>
          frontier === null || segment.captureEndUs > frontier ? segment.captureEndUs : frontier,
        null,
      )
      const sourceEndCaptureTimeUs =
        session?.status === 'FAILED'
          ? lastReadyEndUs
          : session?.sourceDurationUs
            ? captureStartTimeUs + session.sourceDurationUs
            : session?.status === 'FINISHED'
              ? lastReadyEndUs
              : null
      timelines.set(sessionId, {
        availableRanges,
        availabilityComplete: session?.status === 'FINISHED' || session?.status === 'FAILED',
        captureSessionId: sessionId,
        captureStartTimeUs,
        gapRanges,
        ingestFrontierCaptureTimeUs,
        liveEdgeCaptureTimeUs: lastReadyEndUs,
        sourceEndCaptureTimeUs,
        timelineVersion: program.playlistRevision,
      })
    }
  }
  return timelines
}

export async function listCaptureSessionsForMatch(matchId: string): Promise<CaptureSessionView[]> {
  const sessions = await db.captureSession.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: { matchId },
  })
  const timelines = await loadCaptureTimelines(sessions.map(session => session.id))
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

export async function loadCaptureTimeline(sessionId: string): Promise<CaptureTimelineView | null> {
  return (await loadCaptureTimelines([sessionId])).get(sessionId) ?? null
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
