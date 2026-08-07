import { createHash, randomUUID } from 'node:crypto'
import { parseAnnotationCommandResponse, type AnnotationCommand, type AnnotationCommandResponse, type AnnotationCommandRejected } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'
import type { AnnotationIdentity, AnnotationRoom } from './room.js'
import { CLIP_POLICY_VERSION, CLIP_CANONICALIZATION_PROFILE, CLIP_POST_ROLL_US, CLIP_PRE_ROLL_US } from '../../config/clip-policy.js'

type Tx = Prisma.TransactionClient
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v)
const reject = (c: AnnotationCommand, code: string, message: string, actual?: string): AnnotationCommandRejected => ({ schema_version: '2.0.0', type: 'command_rejected', command_id: c.command_id, room_id: c.room_id, rally_id: c.rally_id, code, message, snapshot_refetch_required: code === 'REVISION_CONFLICT', ...(actual ? { actual_revision: actual, expected_revision: c.base_revision } : {}) })

export async function submitRally(tx: Tx, room: AnnotationRoom, command: Extract<AnnotationCommand, { kind: 'SUBMIT_RALLY' }>, identity: AnnotationIdentity, hash: string): Promise<AnnotationCommandResponse> {
  const device = await tx.deviceSession.findUnique({ select: { revokedAt: true, userId: true }, where: { id: identity.deviceSessionId } })
  if (!device || device.userId !== identity.userId || device.revokedAt) return persist(tx, command, identity, hash, reject(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'))
  const member = await tx.match.findFirst({ select: { id: true }, where: { id: room.matchId, captureSessions: { some: { id: room.captureSessionId } }, ...(identity.role === UserRole.ADMIN ? {} : { members: { some: { userId: identity.userId, role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] } } } }) } })
  if (!member) return persist(tx, command, identity, hash, reject(command, 'ROOM_AUTHORIZATION_STALE', 'Annotation room authorization changed before commit'))
  const rally = await tx.rally.findUnique({ where: { id: command.rally_id }, include: { keyPoints: { where: { deletedAt: null }, orderBy: { sequenceIndex: 'asc' } }, sideAssignment: true } })
  if (!rally || rally.matchId !== room.matchId) return persist(tx, command, identity, hash, reject(command, 'RALLY_NOT_FOUND', 'Rally was not found'))
  if (rally.annotationStatus !== 'READY') return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Rally must be READY before submit'))
  if (rally.activeSubmissionId !== null) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Rally already has an active submission'))
  if (rally.annotationRevision.toString() !== command.base_revision) return persist(tx, command, identity, hash, reject(command, 'REVISION_CONFLICT', 'Rally revision is stale', rally.annotationRevision.toString()))
  const services = rally.keyPoints.filter(k => k.markerKind === 'SERVICE')
  const terminals = rally.keyPoints.filter(k => k.isTerminal)
  const service = services[0]
  const terminal = terminals[0]
  const contiguous = rally.keyPoints.every((point, index) => point.sequenceIndex === index)
  if (services.length !== 1 || terminals.length !== 1 || !service || !terminal || !contiguous || service.sequenceIndex !== 0 || terminal.sequenceIndex !== rally.keyPoints.length - 1 || terminal.captureTimeUs < service.captureTimeUs || (terminal.captureTimeUs === service.captureTimeUs && terminal.captureFrameIndex < service.captureFrameIndex)) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Rally key-point integrity is invalid'))
  const assignment = rally.sideAssignment
  if (assignment.setId !== rally.setId) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Court-side assignment does not belong to the Rally set'))
  if (rally.scoreResolutionState === 'PENDING') return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Pending rallies cannot be submitted'))
  if ((rally.scoreResolutionState === 'RESOLVED') !== (rally.scoringCourtSide === 'LEFT' || rally.scoringCourtSide === 'RIGHT')) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Score resolution and court side are inconsistent'))
  if (rally.scoreResolutionState === 'UNKNOWN' && rally.scoringCourtSide !== null) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Unknown rallies cannot have a scoring side'))
  const resolution = rally.scoreResolutionState
  const side = rally.scoringCourtSide
  const set = await tx.matchSet.findUnique({ where: { id: rally.setId }, select: { id: true, leftScore: true, rightScore: true, scoreRevision: true } })
  if (!set) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Set no longer exists'))
  const resolvedScores = resolution === 'RESOLVED'
    ? {
        scoringTeamId: side === 'LEFT' ? assignment.leftTeamId : assignment.rightTeamId,
        left: set.leftScore + (side === 'LEFT' ? 1 : 0),
        right: set.rightScore + (side === 'RIGHT' ? 1 : 0),
        revision: set.scoreRevision + 1,
      }
    : null
  const scoringTeamId = resolvedScores?.scoringTeamId ?? null
  const before = { left: set.leftScore, right: set.rightScore, revision: set.scoreRevision }
  const after = resolvedScores ?? { left: null, right: null, revision: null }
  const submissionId = randomUUID()
  const snapshot = rally.keyPoints.map(k => ({ capture_epoch_id: k.captureEpochId, sequence_index: k.sequenceIndex, marker_kind: k.markerKind, is_terminal: k.isTerminal, source_pts: k.sourcePts.toString(), capture_time_us: k.captureTimeUs.toString(), capture_frame_index: k.captureFrameIndex.toString(), timing_precision: k.timingPrecision }))
  const requestedStart = service.captureTimeUs - CLIP_PRE_ROLL_US < 0n ? 0n : service.captureTimeUs - CLIP_PRE_ROLL_US
  const requestedEnd = terminal.captureTimeUs + CLIP_POST_ROLL_US
  const hashInput = { schema_version: 'rally-submission-content-v1', key_points: snapshot, outcome: { resolution, side: side ?? null, scoring_team_id: scoringTeamId }, assignment: { id: assignment.id, left_team_id: assignment.leftTeamId, right_team_id: assignment.rightTeamId }, score: { before: resolution === 'RESOLVED' ? { left: before.left, right: before.right, revision: before.revision } : { left: null, right: null, revision: null }, after }, clip: { policy_version: CLIP_POLICY_VERSION, canonicalization_profile: CLIP_CANONICALIZATION_PROFILE, pre_us: CLIP_PRE_ROLL_US.toString(), post_us: CLIP_POST_ROLL_US.toString(), requested_start_us: requestedStart.toString(), requested_end_us: requestedEnd.toString() } }
  const contentHash = createHash('sha256').update(canonical(hashInput)).digest('hex')
  const submission = await tx.rallySubmission.create({ data: { id: submissionId, rallyId: rally.id, annotationRevision: rally.annotationRevision, contentHash, status: 'ACTIVE', scoreResolutionState: resolution, scoringCourtSide: side, scoringTeamId, leftTeamId: assignment.leftTeamId, rightTeamId: assignment.rightTeamId, sideAssignmentId: assignment.id, leftScoreBefore: resolution === 'RESOLVED' ? before.left : null, rightScoreBefore: resolution === 'RESOLVED' ? before.right : null, leftScoreAfter: after.left, rightScoreAfter: after.right, scoreRevisionBefore: after.revision === null ? null : before.revision, scoreRevisionAfter: after.revision, clipPolicyVersion: CLIP_POLICY_VERSION, clipPreRollUs: CLIP_PRE_ROLL_US, clipPostRollUs: CLIP_POST_ROLL_US, serviceKeyPointId: null, terminalKeyPointId: null, submittedByUserId: identity.userId } })
  const rows = rally.keyPoints.map(k => ({ id: randomUUID(), submissionId: submission.id, captureEpochId: k.captureEpochId, sourceDraftKeyPointId: k.id, sequenceIndex: k.sequenceIndex, markerKind: k.markerKind, isTerminal: k.isTerminal, sourcePts: k.sourcePts, captureTimeUs: k.captureTimeUs, captureFrameIndex: k.captureFrameIndex, timingPrecision: k.timingPrecision }))
  await tx.rallySubmissionKeyPoint.createMany({ data: rows })
  const serviceRow = rows.find(r => r.sourceDraftKeyPointId === service.id); const terminalRow = rows.find(r => r.sourceDraftKeyPointId === terminal.id)
  if (!serviceRow || !terminalRow) throw new Error('SNAPSHOT_KEYPOINT_MISSING')
  await tx.rallySubmission.update({ where: { id: submission.id }, data: { serviceKeyPointId: serviceRow.id, terminalKeyPointId: terminalRow.id } })
  if (resolvedScores) {
    const cas = await tx.matchSet.updateMany({ where: { id: set.id, scoreRevision: before.revision }, data: { leftScore: resolvedScores.left, rightScore: resolvedScores.right, scoreRevision: resolvedScores.revision } })
    if (cas.count !== 1) throw new Error('SCORE_REVISION_CONFLICT')
    await tx.pointAward.create({ data: { submissionId: submission.id, setId: set.id, scoringTeamId: resolvedScores.scoringTeamId, leftScoreBefore: before.left, rightScoreBefore: before.right, leftScoreAfter: resolvedScores.left, rightScoreAfter: resolvedScores.right, scoreRevisionBefore: before.revision, scoreRevisionAfter: resolvedScores.revision } })
  }
  await tx.clipJob.create({ data: { submissionId: submission.id, status: 'QUEUED', idempotencyKey: `rally-submission:${submission.id}`, canonicalizationProfileVersion: CLIP_CANONICALIZATION_PROFILE, requestedStartCaptureUs: requestedStart, requestedEndCaptureUs: requestedEnd } })
  const revision = rally.annotationRevision + 1n
  const rallyCas = await tx.rally.updateMany({ where: { id: rally.id, annotationStatus: 'READY', annotationRevision: rally.annotationRevision, activeSubmissionId: null }, data: { annotationRevision: revision, annotationStatus: 'SUBMITTED', activeSubmissionId: submission.id, processingStatus: 'CLIP_QUEUED', scoringTeamId, leftScoreBefore: resolution === 'RESOLVED' ? before.left : null, rightScoreBefore: resolution === 'RESOLVED' ? before.right : null, leftScoreAfter: after.left, rightScoreAfter: after.right } })
  if (rallyCas.count !== 1) throw new Error('RALLY_SUBMIT_CONFLICT')
  const receipt = await tx.annotationCommandReceipt.create({ data: { accepted: true, commandId: command.command_id, deviceSessionId: identity.deviceSessionId, rallyId: rally.id, requestHash: hash, requestJson: json(command), responseJson: {}, roomId: command.room_id, userId: identity.userId } })
  const response = parseAnnotationCommandResponse({ schema_version: '2.0.0', type: 'command_ack', command_id: command.command_id, room_id: command.room_id, rally_id: rally.id, operation_kind: command.kind, result_revision: revision.toString(), server_sequence: receipt.serverSequence.toString(), effects: { submission_id: submission.id, annotation_status: 'submitted', score_resolution: resolution.toLowerCase(), scoring_court_side: side ? side.toLowerCase() : null }, resolved_anchor: null })
  await tx.annotationCommandReceipt.update({ where: { serverSequence: receipt.serverSequence }, data: { responseJson: json(response) } })
  await tx.annotationOperation.create({ data: { baseRevision: rally.annotationRevision, clientMutationId: command.command_id, deviceSessionId: identity.deviceSessionId, operationKind: command.kind, payload: json(command.payload), payloadHash: hash, rallyId: rally.id, receiptServerSequence: receipt.serverSequence, resultRevision: revision, userId: identity.userId } })
  await tx.outboxEvent.create({ data: { aggregateId: rally.id, aggregateType: 'Rally', dedupeKey: `annotation-accepted:${receipt.serverSequence}`, eventType: 'annotation.command_accepted.v2', payload: json(response) } })
  const stored = await tx.annotationCommandReceipt.findUnique({ where: { serverSequence: receipt.serverSequence }, select: { responseJson: true } })
  return stored ? parseAnnotationCommandResponse(stored.responseJson) : response
}

async function persist(tx: Tx, command: AnnotationCommand, identity: AnnotationIdentity, hash: string, response: AnnotationCommandRejected): Promise<AnnotationCommandRejected> {
  const receipt = await tx.annotationCommandReceipt.create({ data: { accepted: false, commandId: command.command_id, deviceSessionId: identity.deviceSessionId, rallyId: command.rally_id, requestHash: hash, requestJson: json(command), responseJson: json(response), roomId: command.room_id, userId: identity.userId } })
  await tx.outboxEvent.create({ data: { aggregateId: command.rally_id, aggregateType: 'AnnotationCommandReceipt', dedupeKey: `annotation-rejected:${receipt.serverSequence}`, eventType: 'annotation.command_rejected.v2', payload: json(response) } })
  return response
}
