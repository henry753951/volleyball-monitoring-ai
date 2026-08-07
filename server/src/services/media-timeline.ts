import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'

type Session = Awaited<ReturnType<typeof db.captureSession.findMany>>[number]
type View = { id: string; matchId: string; sourceLabel: string | null; status: Session['status']; health: Session['health']; startedAt: Date | null; endedAt: Date | null; timeline: { captureSessionId: string; timelineVersion: bigint; captureStartTimeUs: bigint; liveEdgeCaptureTimeUs: bigint | null; availableRanges: { startUs: bigint; endUs: bigint; discontinuity: number }[] } | null }

export async function loadCaptureTimelines(sessionIds: string[]): Promise<Map<string, View['timeline']>> {
  if (!sessionIds.length) return new Map()
  const programs = await db.dvrProgram.findMany({ where: { captureSessionId: { in: sessionIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const newest = new Map<string, typeof programs[number]>()
  for (const program of programs) if (!newest.has(program.captureSessionId)) newest.set(program.captureSessionId, program)
  const programIds = [...newest.values()].map((program) => program.id)
  const segments = await db.dvrSegment.findMany({ where: { dvrProgramId: { in: programIds }, isGap: false, readyAt: { not: null }, initAsset: { state: 'READY', internalSchemaVersion: { not: null } }, mediaAsset: { state: 'READY', internalSchemaVersion: { not: null } }, sampleIndexAsset: { state: 'READY', internalSchemaVersion: { not: null } } }, orderBy: [{ captureStartUs: 'asc' }, { sequenceNumber: 'asc' }] })
  const grouped = new Map<string, typeof segments>()
  for (const segment of segments) { const list = grouped.get(segment.dvrProgramId) ?? []; list.push(segment); grouped.set(segment.dvrProgramId, list) }
  const result = new Map<string, View['timeline']>()
  for (const [sessionId, program] of newest) {
    const ranges: { startUs: bigint; endUs: bigint; discontinuity: number }[] = []
    for (const segment of grouped.get(program.id) ?? []) { const previous = ranges.at(-1); if (previous && previous.discontinuity === segment.discontinuitySequence && previous.endUs >= segment.captureStartUs) previous.endUs = previous.endUs > segment.captureEndUs ? previous.endUs : segment.captureEndUs; else ranges.push({ startUs: segment.captureStartUs, endUs: segment.captureEndUs, discontinuity: segment.discontinuitySequence }) }
    if (ranges.length) result.set(sessionId, { captureSessionId: sessionId, timelineVersion: program.playlistRevision, captureStartTimeUs: ranges[0]!.startUs, liveEdgeCaptureTimeUs: ranges.at(-1)!.endUs, availableRanges: ranges })
  }
  return result
}

export async function listCaptureSessionsForMatch(matchId: string): Promise<View[]> {
  const sessions = await db.captureSession.findMany({ where: { matchId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const timelines = await loadCaptureTimelines(sessions.map((session) => session.id))
  return sessions.map((session) => ({ id: session.id, matchId: session.matchId, sourceLabel: session.sourceLabel, status: session.status, health: session.health, startedAt: session.startedAt, endedAt: session.endedAt, timeline: timelines.get(session.id) ?? null }))
}
export async function loadCaptureTimeline(sessionId: string) { return (await loadCaptureTimelines([sessionId])).get(sessionId) ?? null }
export async function getVisibleCaptureSession(id: string, userId: string, role: UserRole) { return db.captureSession.findFirst({ where: { id, ...(role === UserRole.ADMIN ? {} : { match: { members: { some: { userId } } } }) } }) }
