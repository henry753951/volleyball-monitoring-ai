import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { parseAnnotationServerMessage } from '@volleyball-monitoring/contracts'
import { parseAnnotationRoomId } from '../domain/annotation/room.js'

export async function getAnnotationSnapshot(database: PrismaClient, input: { roomId: string; rallyId: string; userId: string; role: UserRole }) {
  let room
  try { room = parseAnnotationRoomId(input.roomId) } catch { return null }
  const authorized = input.role === UserRole.ADMIN || await database.matchMember.findFirst({ where: { matchId: room.matchId, userId: input.userId, role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] } } })
  if (!authorized) return null
  const rally = await database.rally.findFirst({ where: { id: input.rallyId, matchId: room.matchId, match: { captureSessions: { some: { id: room.captureSessionId } } } }, include: { keyPoints: { where: { deletedAt: null }, orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] } } })
  if (!rally) return null
  const response = { schema_version: '2.0.0', type: 'rally_snapshot', room_id: input.roomId, rally_id: rally.id, revision: rally.annotationRevision.toString(), server_sequence: (await database.annotationCommandReceipt.aggregate({ _max: { serverSequence: true }, where: { roomId: input.roomId } }))._max.serverSequence?.toString() ?? '0', snapshot: { annotation_status: rally.annotationStatus.toLowerCase(), side_assignment_id: rally.sideAssignmentId, score_resolution: rally.scoreResolutionState.toLowerCase(), scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null, processing_status: rally.processingStatus.toLowerCase(), active_submission_id: rally.activeSubmissionId, key_points: rally.keyPoints.map((p) => ({ key_point_id: p.id, sequence_index: p.sequenceIndex, marker_kind: p.markerKind.toLowerCase(), is_terminal: p.isTerminal, capture_time_us: p.captureTimeUs.toString(), capture_frame_index: p.captureFrameIndex.toString(), timing_precision: p.timingPrecision.toLowerCase(), possible_duplicate: p.possibleDuplicate })) } }
  return parseAnnotationServerMessage(response)
}
