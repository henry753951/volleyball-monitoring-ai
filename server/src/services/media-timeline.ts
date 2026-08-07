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
}

export interface CaptureSessionView {
  id: string
  matchId: string
  sourceLabel: string | null
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

  const programIds = [...newestProgramBySession.values()].map((program) => program.id)
  const segments = await db.dvrSegment.findMany({
    orderBy: [{ captureStartUs: 'asc' }, { sequenceNumber: 'asc' }],
    where: {
      dvrProgramId: { in: programIds },
      initAsset: { internalSchemaVersion: { not: null }, state: 'READY' },
      isGap: false,
      mediaAsset: { internalSchemaVersion: { not: null }, state: 'READY' },
      readyAt: { not: null },
      sampleIndexAsset: { internalSchemaVersion: { not: null }, state: 'READY' },
    },
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
    for (const segment of segmentsByProgram.get(program.id) ?? []) {
      const previous = availableRanges.at(-1)
      if (
        previous
        && previous.discontinuity === segment.discontinuitySequence
        && previous.endUs >= segment.captureStartUs
      ) {
        previous.endUs = previous.endUs > segment.captureEndUs
          ? previous.endUs
          : segment.captureEndUs
      } else {
        availableRanges.push({
          discontinuity: segment.discontinuitySequence,
          endUs: segment.captureEndUs,
          startUs: segment.captureStartUs,
        })
      }
    }

    if (availableRanges.length > 0) {
      timelines.set(sessionId, {
        availableRanges,
        captureSessionId: sessionId,
        captureStartTimeUs: availableRanges[0]!.startUs,
        liveEdgeCaptureTimeUs: availableRanges.at(-1)!.endUs,
        timelineVersion: program.playlistRevision,
      })
    }
  }
  return timelines
}

export async function listCaptureSessionsForMatch(
  matchId: string,
): Promise<CaptureSessionView[]> {
  const sessions = await db.captureSession.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: { matchId },
  })
  const timelines = await loadCaptureTimelines(sessions.map((session) => session.id))
  return sessions.map((session) => ({
    endedAt: session.endedAt,
    health: session.health,
    id: session.id,
    matchId: session.matchId,
    sourceLabel: session.sourceLabel,
    startedAt: session.startedAt,
    status: session.status,
    timeline: timelines.get(session.id) ?? null,
  }))
}

export async function loadCaptureTimeline(
  sessionId: string,
): Promise<CaptureTimelineView | null> {
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
      ...(role === UserRole.ADMIN
        ? {}
        : { match: { members: { some: { userId } } } }),
    },
  })
}
