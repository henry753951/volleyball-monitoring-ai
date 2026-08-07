import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'

export async function loadCaptureTimeline(sessionId: string) {
  const program = await db.dvrProgram.findFirst({ where: { captureSessionId: sessionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!program) return null
  const segments = await db.dvrSegment.findMany({ where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null }, initAsset: { state: 'READY', internalSchemaVersion: { not: null } }, mediaAsset: { state: 'READY', internalSchemaVersion: { not: null } }, sampleIndexAsset: { state: 'READY', internalSchemaVersion: { not: null } } }, orderBy: [{ captureStartUs: 'asc' }, { sequenceNumber: 'asc' }] })
  const ranges: { startUs: bigint; endUs: bigint; discontinuity: number }[] = []
  for (const segment of segments) { const previous = ranges[ranges.length - 1]; if (previous !== undefined && previous.discontinuity === segment.discontinuitySequence && previous.endUs >= segment.captureStartUs) previous.endUs = previous.endUs > segment.captureEndUs ? previous.endUs : segment.captureEndUs; else ranges.push({ startUs: segment.captureStartUs, endUs: segment.captureEndUs, discontinuity: segment.discontinuitySequence }) }
  return ranges.length ? { captureSessionId: sessionId, timelineVersion: program.playlistRevision, captureStartTimeUs: ranges[0]!.startUs, liveEdgeCaptureTimeUs: ranges[ranges.length - 1]!.endUs, availableRanges: ranges } : null
}

export async function listCaptureSessionsForMatch(matchId: string) {
  const sessions = await db.captureSession.findMany({ where: { matchId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  return Promise.all(sessions.map(async (session) => ({ id: session.id, matchId: session.matchId, sourceLabel: session.sourceLabel, status: session.status, health: session.health, startedAt: session.startedAt, endedAt: session.endedAt, timeline: await loadCaptureTimeline(session.id) })))
}

export async function getVisibleCaptureSession(id: string, userId: string, role: UserRole) {
  return db.captureSession.findFirst({ where: { id, ...(role === UserRole.ADMIN ? {} : { match: { members: { some: { userId } } } }) } })
}
