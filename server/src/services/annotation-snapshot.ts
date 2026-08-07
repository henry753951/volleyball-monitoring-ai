import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'

export async function getAnnotationSnapshot(input: { roomId: string; rallyId: string; userId: string; role: UserRole }) {
  const matchId = input.roomId.match(/^match:([^:]+):capture:([^:]+)$/)?.[1]
  const captureId = input.roomId.match(/^match:([^:]+):capture:([^:]+)$/)?.[2]
  if (!matchId || !captureId) return null
  const authorized = input.role === UserRole.ADMIN || await db.matchMember.findFirst({ where: { matchId, userId: input.userId, role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] } } })
  if (!authorized) return null
  const rally = await db.rally.findFirst({ where: { id: input.rallyId, matchId, match: { captureSessions: { some: { id: captureId } } } }, include: { keyPoints: { where: { deletedAt: null }, orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] } } })
  if (!rally) return null
  return { schema_version: '2.0.0', type: 'rally_snapshot', room_id: input.roomId, rally_id: rally.id, revision: rally.annotationRevision.toString(), server_sequence: (await db.annotationCommandReceipt.aggregate({ _max: { serverSequence: true }, where: { rallyId: rally.id } }))._max.serverSequence?.toString() ?? '0', snapshot: { annotation_status: rally.annotationStatus.toLowerCase(), score_resolution: rally.scoreResolutionState.toLowerCase(), scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null, processing_status: rally.processingStatus.toLowerCase(), active_submission_id: rally.activeSubmissionId, side_assignment: rally.sideAssignmentId, key_points: rally.keyPoints.map((p) => ({ key_point_id: p.id, sequence_index: p.sequenceIndex, marker_kind: p.markerKind.toLowerCase(), is_terminal: p.isTerminal, capture_time_us: p.captureTimeUs.toString(), capture_frame_index: p.captureFrameIndex.toString(), timing_precision: p.timingPrecision.toLowerCase(), possible_duplicate: p.possibleDuplicate })) } }
}
