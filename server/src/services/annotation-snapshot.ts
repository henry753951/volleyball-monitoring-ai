import { parseAnnotationServerMessage } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { AnnotationStatus, UserRole } from '@volleyball-monitoring/db/client'
import { parseAnnotationRoomId } from '../domain/annotation/room.js'

interface SnapshotIdentity {
  roomId: string
  userId: string
  role: UserRole
  deviceSessionId?: string
}

async function loadAnnotationSnapshot(
  database: PrismaClient,
  input: SnapshotIdentity,
  rallyId?: string,
) {
  let room
  try {
    room = parseAnnotationRoomId(input.roomId)
  } catch {
    return null
  }

  const authorized =
    input.role === UserRole.ADMIN ||
    (await database.matchMember.findFirst({
      where: {
        matchId: room.matchId,
        userId: input.userId,
        role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
      },
    }))
  if (!authorized) return null

  const snapshotInclude = {
    activeSubmission: {
      include: {
        boundaries: { orderBy: { kind: 'asc' as const } },
        keyPoints: { orderBy: [{ sequenceIndex: 'asc' as const }, { id: 'asc' as const }] },
      },
    },
    boundaries: { orderBy: { kind: 'asc' as const } },
    keyPoints: {
      where: { deletedAt: null },
      orderBy: [{ sequenceIndex: 'asc' as const }, { id: 'asc' as const }],
    },
  }

  let rally
  if (rallyId) {
    rally = await database.rally.findFirst({
      where: {
        id: rallyId,
        matchId: room.matchId,
        program: { captureSessionId: room.captureSessionId },
      },
      include: snapshotInclude,
    })
  } else {
    const deviceSessionId = input.deviceSessionId
    if (!deviceSessionId) return null
    const device = await database.deviceSession.findFirst({
      where: { id: deviceSessionId, revokedAt: null, userId: input.userId },
      select: { id: true },
    })
    if (!device) return null
    rally = await database.rally.findFirst({
      where: {
        annotationStatus: { in: [AnnotationStatus.OPEN, AnnotationStatus.READY] },
        voidedAt: null,
        matchId: room.matchId,
        program: { captureSessionId: room.captureSessionId },
        OR: [
          { boundaries: { some: { deviceSessionId, kind: 'START' } } },
          { keyPoints: { some: { deviceSessionId, markerKind: 'SERVICE' } } },
        ],
      },
      include: snapshotInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  }
  if (!rally) return null

  const serverSequence = await database.annotationCommandReceipt.aggregate({
    _max: { serverSequence: true },
    where: { roomId: input.roomId },
  })
  const keyPoints =
    rally.annotationStatus === AnnotationStatus.SUBMITTED && rally.activeSubmission
      ? rally.activeSubmission.keyPoints.map(point => ({
          id: point.id,
          sequenceIndex: point.sequenceIndex,
          markerKind: point.markerKind,
          isTerminal: point.isTerminal,
          captureTimeUs: point.captureTimeUs,
          captureFrameIndex: point.captureFrameIndex,
          timingPrecision: point.timingPrecision,
          possibleDuplicate: false,
        }))
      : rally.keyPoints
  const boundaries =
    (rally.annotationStatus === AnnotationStatus.SUBMITTED && rally.activeSubmission
      ? rally.activeSubmission.boundaries
      : rally.boundaries) ?? []
  return parseAnnotationServerMessage({
    schema_version: boundaries.length ? '3.0.0' : '2.0.0',
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
      ...(boundaries.length
        ? {
            boundaries: boundaries.map(boundary => ({
              kind: boundary.kind.toLowerCase(),
              capture_time_us: boundary.captureTimeUs.toString(),
              capture_frame_index: boundary.captureFrameIndex.toString(),
              timing_precision: boundary.timingPrecision.toLowerCase(),
            })),
          }
        : {}),
      key_points: keyPoints.map(point => ({
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
