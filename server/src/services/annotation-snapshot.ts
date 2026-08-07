import { parseAnnotationServerMessage } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { AnnotationStatus, UserRole } from '@volleyball-monitoring/db/client'
import { parseAnnotationRoomId } from '../domain/annotation/room.js'

interface SnapshotIdentity {
  roomId: string
  userId: string
  role: UserRole
}

async function loadAnnotationSnapshot(
  database: PrismaClient,
  input: SnapshotIdentity,
  rallyId?: string,
) {
  let room
  try {
    room = parseAnnotationRoomId(input.roomId)
  }
  catch {
    return null
  }

  const authorized = input.role === UserRole.ADMIN || await database.matchMember.findFirst({
    where: {
      matchId: room.matchId,
      userId: input.userId,
      role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
    },
  })
  if (!authorized) return null

  const rally = rallyId
    ? await database.rally.findFirst({
        where: {
          id: rallyId,
          matchId: room.matchId,
          program: { captureSessionId: room.captureSessionId },
        },
        include: {
          keyPoints: {
            where: { deletedAt: null },
            orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }],
          },
        },
      })
    : await database.rally.findFirst({
        where: {
          annotationStatus: { in: [AnnotationStatus.OPEN, AnnotationStatus.READY] },
          voidedAt: null,
          matchId: room.matchId,
          program: { captureSessionId: room.captureSessionId },
        },
        include: {
          keyPoints: {
            where: { deletedAt: null },
            orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
  if (!rally) return null

  const serverSequence = await database.annotationCommandReceipt.aggregate({
    _max: { serverSequence: true },
    where: { roomId: input.roomId },
  })
  return parseAnnotationServerMessage({
    schema_version: '2.0.0',
    type: 'rally_snapshot',
    room_id: input.roomId,
    rally_id: rally.id,
    revision: rally.annotationRevision.toString(),
    server_sequence: serverSequence._max.serverSequence?.toString() ?? '0',
    snapshot: {
      annotation_status: rally.annotationStatus.toLowerCase(),
      side_assignment_id: rally.sideAssignmentId,
      score_resolution: rally.scoreResolutionState.toLowerCase(),
      scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null,
      processing_status: rally.processingStatus.toLowerCase(),
      active_submission_id: rally.activeSubmissionId,
      key_points: rally.keyPoints.map(point => ({
        key_point_id: point.id,
        sequence_index: point.sequenceIndex,
        marker_kind: point.markerKind.toLowerCase(),
        is_terminal: point.isTerminal,
        capture_time_us: point.captureTimeUs.toString(),
        capture_frame_index: point.captureFrameIndex.toString(),
        timing_precision: point.timingPrecision.toLowerCase(),
        possible_duplicate: point.possibleDuplicate,
      })),
    },
  })
}

export function getAnnotationSnapshot(
  database: PrismaClient,
  input: SnapshotIdentity & { rallyId: string },
) {
  return loadAnnotationSnapshot(database, input, input.rallyId)
}

export function getActiveAnnotationSnapshot(database: PrismaClient, input: SnapshotIdentity) {
  return loadAnnotationSnapshot(database, input)
}
