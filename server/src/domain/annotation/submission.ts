import { createHash, randomUUID } from 'node:crypto'
import {
  parseAnnotationCommandResponse,
  type AnnotationCommand,
  type AnnotationCommandRejected,
  type AnnotationCommandResponse,
} from '@volleyball-monitoring/contracts'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'
import type { AnnotationIdentity, AnnotationRoom } from './room.js'
import { reuseCompletedSubmissionGeometry } from './submission-geometry-reuse.js'
import {
  CLIP_CANONICALIZATION_PROFILE,
  CLIP_POLICY_VERSION,
  CLIP_POST_ROLL_US,
  CLIP_PRE_ROLL_US,
} from '../../config/clip-policy.js'

type Tx = Prisma.TransactionClient
type SubmissionCommand = Extract<AnnotationCommand, { kind: 'SUBMIT_RALLY' }>

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)
const reject = (command: AnnotationCommand, code: string, message: string, actual?: string): AnnotationCommandRejected => ({
  schema_version: '2.0.0',
  type: 'command_rejected',
  command_id: command.command_id,
  room_id: command.room_id,
  rally_id: command.rally_id,
  code,
  message,
  snapshot_refetch_required: code === 'REVISION_CONFLICT',
  ...(actual ? { actual_revision: actual, expected_revision: command.base_revision } : {}),
})

function contribution(resolution: 'RESOLVED' | 'UNKNOWN', side: 'LEFT' | 'RIGHT' | null) {
  return {
    left: resolution === 'RESOLVED' && side === 'LEFT' ? 1 : 0,
    right: resolution === 'RESOLVED' && side === 'RIGHT' ? 1 : 0,
  }
}

export async function submitRally(
  tx: Tx,
  room: AnnotationRoom,
  command: SubmissionCommand,
  identity: AnnotationIdentity,
  hash: string,
): Promise<AnnotationCommandResponse> {
  const device = await tx.deviceSession.findUnique({
    select: { revokedAt: true, userId: true },
    where: { id: identity.deviceSessionId },
  })
  if (!device || device.userId !== identity.userId || device.revokedAt) {
    return persist(tx, command, identity, hash, reject(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'))
  }
  const member = await tx.match.findFirst({
    select: { id: true },
    where: {
      id: room.matchId,
      captureSessions: { some: { id: room.captureSessionId } },
      ...(identity.role === UserRole.ADMIN
        ? {}
        : { members: { some: { userId: identity.userId, role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] } } } }),
    },
  })
  if (!member) return persist(tx, command, identity, hash, reject(command, 'ROOM_AUTHORIZATION_STALE', 'Annotation room authorization changed before commit'))

  const rally = await tx.rally.findUnique({
    where: { id: command.rally_id },
    include: {
      keyPoints: { where: { deletedAt: null }, orderBy: { sequenceIndex: 'asc' } },
      sideAssignment: true,
    },
  })
  if (!rally || rally.matchId !== room.matchId) return persist(tx, command, identity, hash, reject(command, 'RALLY_NOT_FOUND', 'Rally was not found'))
  if (rally.annotationStatus !== 'READY') return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Rally must be READY before submit'))
  if (rally.annotationRevision.toString() !== command.base_revision) return persist(tx, command, identity, hash, reject(command, 'REVISION_CONFLICT', 'Rally revision is stale', rally.annotationRevision.toString()))

  const superseded = rally.activeSubmissionId
    ? await tx.rallySubmission.findUnique({
        where: { id: rally.activeSubmissionId },
        include: { keyPoints: { orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] } },
      })
    : null
  if (rally.activeSubmissionId && (!superseded || superseded.rallyId !== rally.id || superseded.status !== 'ACTIVE')) {
    return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Correction source submission is no longer active'))
  }

  const services = rally.keyPoints.filter(point => point.markerKind === 'SERVICE')
  const terminals = rally.keyPoints.filter(point => point.isTerminal)
  const service = services[0]
  const terminal = terminals[0]
  const contiguous = rally.keyPoints.every((point, index) => point.sequenceIndex === index)
  if (
    services.length !== 1
    || terminals.length !== 1
    || !service
    || !terminal
    || !contiguous
    || service.sequenceIndex !== 0
    || terminal.sequenceIndex !== rally.keyPoints.length - 1
    || terminal.captureTimeUs < service.captureTimeUs
    || (terminal.captureTimeUs === service.captureTimeUs && terminal.captureFrameIndex < service.captureFrameIndex)
  ) {
    return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Rally key-point integrity is invalid'))
  }

  const assignment = rally.sideAssignment
  if (assignment.setId !== rally.setId) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Court-side assignment does not belong to the Rally set'))
  if (rally.scoreResolutionState === 'PENDING') return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Pending rallies cannot be submitted'))
  if ((rally.scoreResolutionState === 'RESOLVED') !== (rally.scoringCourtSide === 'LEFT' || rally.scoringCourtSide === 'RIGHT')) {
    return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Score resolution and court side are inconsistent'))
  }
  if (rally.scoreResolutionState === 'UNKNOWN' && rally.scoringCourtSide !== null) {
    return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Unknown rallies cannot have a scoring side'))
  }

  const resolution = rally.scoreResolutionState
  const side = rally.scoringCourtSide
  const currentContribution = contribution(resolution, side)
  const previousContribution = superseded
    ? contribution(superseded.scoreResolutionState, superseded.scoringCourtSide)
    : { left: 0, right: 0 }
  const leftDelta = currentContribution.left - previousContribution.left
  const rightDelta = currentContribution.right - previousContribution.right
  const scoreChanged = leftDelta !== 0 || rightDelta !== 0

  const set = await tx.matchSet.findUnique({
    where: { id: rally.setId },
    select: { id: true, leftScore: true, rightScore: true, scoreRevision: true },
  })
  if (!set) return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Set no longer exists'))
  const scoreAfter = {
    left: set.leftScore + leftDelta,
    right: set.rightScore + rightDelta,
    revision: set.scoreRevision + (scoreChanged ? 1 : 0),
  }
  if (scoreAfter.left < 0 || scoreAfter.right < 0) {
    return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Correction would produce a negative set score'))
  }

  const scoringTeamId = resolution === 'RESOLVED'
    ? side === 'LEFT' ? assignment.leftTeamId : assignment.rightTeamId
    : null
  const snapshot = rally.keyPoints.map(point => ({
    capture_epoch_id: point.captureEpochId,
    sequence_index: point.sequenceIndex,
    marker_kind: point.markerKind,
    is_terminal: point.isTerminal,
    source_pts: point.sourcePts.toString(),
    capture_time_us: point.captureTimeUs.toString(),
    capture_frame_index: point.captureFrameIndex.toString(),
    timing_precision: point.timingPrecision,
  }))
  const geometryUnchanged = superseded !== null
    && superseded.clipPolicyVersion === CLIP_POLICY_VERSION
    && superseded.clipPreRollUs === CLIP_PRE_ROLL_US
    && superseded.clipPostRollUs === CLIP_POST_ROLL_US
    && superseded.keyPoints.length === rally.keyPoints.length
    && superseded.keyPoints.every((point, index) => {
      const draft = rally.keyPoints[index]
      return !!draft
        && point.sourceDraftKeyPointId === draft.id
        && point.captureEpochId === draft.captureEpochId
        && point.sequenceIndex === draft.sequenceIndex
        && point.markerKind === draft.markerKind
        && point.isTerminal === draft.isTerminal
        && point.sourcePts === draft.sourcePts
        && point.captureTimeUs === draft.captureTimeUs
        && point.captureFrameIndex === draft.captureFrameIndex
        && point.timingPrecision === draft.timingPrecision
    })
  const outcomeUnchanged = superseded !== null
    && superseded.scoreResolutionState === resolution
    && superseded.scoringCourtSide === side
    && superseded.scoringTeamId === scoringTeamId
  if (superseded && geometryUnchanged && outcomeUnchanged) {
    return persist(tx, command, identity, hash, reject(command, 'ANNOTATION_NOT_READY', 'Correction draft has no immutable content changes'))
  }

  const requestedStart = service.captureTimeUs - CLIP_PRE_ROLL_US < 0n ? 0n : service.captureTimeUs - CLIP_PRE_ROLL_US
  const requestedEnd = terminal.captureTimeUs + CLIP_POST_ROLL_US
  const scoreSnapshot = resolution === 'RESOLVED'
    ? {
        before: { left: set.leftScore, right: set.rightScore, revision: set.scoreRevision },
        after: scoreAfter,
      }
    : { before: null, after: null }
  const contentHash = createHash('sha256').update(canonical({
    schema_version: 'rally-submission-content-v1',
    key_points: snapshot,
    outcome: { resolution, side: side ?? null, scoring_team_id: scoringTeamId },
    assignment: { id: assignment.id, left_team_id: assignment.leftTeamId, right_team_id: assignment.rightTeamId },
    score: scoreSnapshot,
    clip: {
      policy_version: CLIP_POLICY_VERSION,
      canonicalization_profile: CLIP_CANONICALIZATION_PROFILE,
      pre_us: CLIP_PRE_ROLL_US.toString(),
      post_us: CLIP_POST_ROLL_US.toString(),
      requested_start_us: requestedStart.toString(),
      requested_end_us: requestedEnd.toString(),
    },
  })).digest('hex')

  const submission = await tx.rallySubmission.create({
    data: {
      id: randomUUID(),
      rallyId: rally.id,
      annotationRevision: rally.annotationRevision,
      contentHash,
      status: 'ACTIVE',
      scoreResolutionState: resolution,
      scoringCourtSide: side,
      scoringTeamId,
      leftTeamId: assignment.leftTeamId,
      rightTeamId: assignment.rightTeamId,
      sideAssignmentId: assignment.id,
      leftScoreBefore: scoreSnapshot.before?.left ?? null,
      rightScoreBefore: scoreSnapshot.before?.right ?? null,
      leftScoreAfter: scoreSnapshot.after?.left ?? null,
      rightScoreAfter: scoreSnapshot.after?.right ?? null,
      scoreRevisionBefore: scoreSnapshot.before?.revision ?? null,
      scoreRevisionAfter: scoreSnapshot.after?.revision ?? null,
      clipPolicyVersion: CLIP_POLICY_VERSION,
      clipPreRollUs: CLIP_PRE_ROLL_US,
      clipPostRollUs: CLIP_POST_ROLL_US,
      serviceKeyPointId: null,
      terminalKeyPointId: null,
      submittedByUserId: identity.userId,
      supersedesSubmissionId: superseded?.id ?? null,
    },
  })
  const rows = rally.keyPoints.map(point => ({
    id: randomUUID(),
    submissionId: submission.id,
    captureEpochId: point.captureEpochId,
    sourceDraftKeyPointId: point.id,
    sequenceIndex: point.sequenceIndex,
    markerKind: point.markerKind,
    isTerminal: point.isTerminal,
    sourcePts: point.sourcePts,
    captureTimeUs: point.captureTimeUs,
    captureFrameIndex: point.captureFrameIndex,
    timingPrecision: point.timingPrecision,
  }))
  await tx.rallySubmissionKeyPoint.createMany({ data: rows })
  const serviceRow = rows.find(row => row.sourceDraftKeyPointId === service.id)
  const terminalRow = rows.find(row => row.sourceDraftKeyPointId === terminal.id)
  if (!serviceRow || !terminalRow) throw new Error('SNAPSHOT_KEYPOINT_MISSING')
  await tx.rallySubmission.update({
    where: { id: submission.id },
    data: { serviceKeyPointId: serviceRow.id, terminalKeyPointId: terminalRow.id },
  })

  const geometryReused = Boolean(superseded && geometryUnchanged) && await reuseCompletedSubmissionGeometry(tx, {
    annotationRevision: rally.annotationRevision,
    newKeyPoints: rows.map(row => ({ id: row.id, sequenceIndex: row.sequenceIndex })),
    newSubmissionId: submission.id,
    outcome: { resolution, side },
    sourceKeyPoints: superseded!.keyPoints.map(point => ({ id: point.id, sequenceIndex: point.sequenceIndex })),
    sourceSubmissionId: superseded!.id,
  })

  if (scoreChanged) {
    const cas = await tx.matchSet.updateMany({
      where: { id: set.id, scoreRevision: set.scoreRevision },
      data: { leftScore: scoreAfter.left, rightScore: scoreAfter.right, scoreRevision: scoreAfter.revision },
    })
    if (cas.count !== 1) throw new Error('SCORE_REVISION_CONFLICT')
    const ledger = await tx.scoreLedgerEntry.create({
      data: {
        kind: superseded ? 'CORRECTION' : 'POINT_AWARD',
        setId: set.id,
        submissionId: submission.id,
        supersededSubmissionId: superseded?.id ?? null,
        leftDelta,
        rightDelta,
        leftScoreBefore: set.leftScore,
        rightScoreBefore: set.rightScore,
        leftScoreAfter: scoreAfter.left,
        rightScoreAfter: scoreAfter.right,
        scoreRevisionBefore: set.scoreRevision,
        scoreRevisionAfter: scoreAfter.revision,
      },
    })
    if (!superseded && resolution === 'RESOLVED' && scoringTeamId) {
      await tx.pointAward.create({
        data: {
          submissionId: submission.id,
          ledgerEntryId: ledger.id,
          setId: set.id,
          scoringTeamId,
          leftScoreBefore: set.leftScore,
          rightScoreBefore: set.rightScore,
          leftScoreAfter: scoreAfter.left,
          rightScoreAfter: scoreAfter.right,
          scoreRevisionBefore: set.scoreRevision,
          scoreRevisionAfter: scoreAfter.revision,
        },
      })
    }
  }

  if (!geometryReused) {
    await tx.clipJob.create({
      data: {
        submissionId: submission.id,
        status: 'QUEUED',
        idempotencyKey: `rally-submission:${submission.id}`,
        canonicalizationProfileVersion: CLIP_CANONICALIZATION_PROFILE,
        requestedStartCaptureUs: requestedStart,
        requestedEndCaptureUs: requestedEnd,
      },
    })
  }

  if (superseded) {
    await tx.rallySubmission.update({ where: { id: superseded.id }, data: { status: 'SUPERSEDED' } })
    await Promise.all([
      tx.clipJob.updateMany({ where: { submissionId: superseded.id }, data: { status: 'SUPERSEDED', leasedUntil: null } }),
      tx.aiJob.updateMany({ where: { submissionId: superseded.id }, data: { status: 'SUPERSEDED', leasedUntil: null } }),
      tx.analysisRun.updateMany({ where: { submissionId: superseded.id }, data: { status: 'SUPERSEDED' } }),
    ])
  }

  const revision = rally.annotationRevision + 1n
  const rallyCas = await tx.rally.updateMany({
    where: {
      id: rally.id,
      annotationStatus: 'READY',
      annotationRevision: rally.annotationRevision,
      activeSubmissionId: superseded?.id ?? null,
    },
    data: {
      annotationRevision: revision,
      annotationStatus: 'SUBMITTED',
      activeSubmissionId: submission.id,
      processingStatus: geometryReused ? 'COMPLETED' : 'CLIP_QUEUED',
      scoringTeamId,
      leftScoreBefore: scoreSnapshot.before?.left ?? null,
      rightScoreBefore: scoreSnapshot.before?.right ?? null,
      leftScoreAfter: scoreSnapshot.after?.left ?? null,
      rightScoreAfter: scoreSnapshot.after?.right ?? null,
    },
  })
  if (rallyCas.count !== 1) throw new Error('RALLY_SUBMIT_CONFLICT')

  const receipt = await tx.annotationCommandReceipt.create({
    data: {
      accepted: true,
      commandId: command.command_id,
      deviceSessionId: identity.deviceSessionId,
      rallyId: rally.id,
      requestHash: hash,
      requestJson: json(command),
      responseJson: {},
      roomId: command.room_id,
      userId: identity.userId,
    },
  })
  const response = parseAnnotationCommandResponse({
    schema_version: '2.0.0',
    type: 'command_ack',
    command_id: command.command_id,
    room_id: command.room_id,
    rally_id: rally.id,
    operation_kind: command.kind,
    result_revision: revision.toString(),
    server_sequence: receipt.serverSequence.toString(),
    effects: {
      submission_id: submission.id,
      annotation_status: 'submitted',
      score_resolution: resolution.toLowerCase(),
      scoring_court_side: side ? side.toLowerCase() : null,
    },
    resolved_anchor: null,
  })
  await tx.annotationCommandReceipt.update({ where: { serverSequence: receipt.serverSequence }, data: { responseJson: json(response) } })
  await tx.annotationOperation.create({
    data: {
      baseRevision: rally.annotationRevision,
      clientMutationId: command.command_id,
      deviceSessionId: identity.deviceSessionId,
      operationKind: command.kind,
      payload: json(command.payload),
      payloadHash: hash,
      rallyId: rally.id,
      receiptServerSequence: receipt.serverSequence,
      resultRevision: revision,
      userId: identity.userId,
    },
  })
  await tx.outboxEvent.create({
    data: {
      aggregateId: rally.id,
      aggregateType: 'Rally',
      dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
      eventType: 'annotation.command_accepted.v2',
      payload: json(response),
    },
  })
  if (superseded) {
    await tx.outboxEvent.create({
      data: {
        aggregateId: rally.id,
        aggregateType: 'RallySubmission',
        dedupeKey: `submission-superseded:${superseded.id}:${submission.id}`,
        eventType: 'rally.submission_superseded.v1',
        payload: json({
          geometry_reused: geometryReused,
          geometry_unchanged: geometryUnchanged,
          rally_id: rally.id,
          submission_id: submission.id,
          supersedes_submission_id: superseded.id,
        }),
      },
    })
  }
  const stored = await tx.annotationCommandReceipt.findUnique({
    where: { serverSequence: receipt.serverSequence },
    select: { responseJson: true },
  })
  return stored ? parseAnnotationCommandResponse(stored.responseJson) : response
}

async function persist(
  tx: Tx,
  command: AnnotationCommand,
  identity: AnnotationIdentity,
  hash: string,
  response: AnnotationCommandRejected,
): Promise<AnnotationCommandRejected> {
  const receipt = await tx.annotationCommandReceipt.create({
    data: {
      accepted: false,
      commandId: command.command_id,
      deviceSessionId: identity.deviceSessionId,
      rallyId: command.rally_id,
      requestHash: hash,
      requestJson: json(command),
      responseJson: json(response),
      roomId: command.room_id,
      userId: identity.userId,
    },
  })
  await tx.outboxEvent.create({
    data: {
      aggregateId: command.rally_id,
      aggregateType: 'AnnotationCommandReceipt',
      dedupeKey: `annotation-rejected:${receipt.serverSequence}`,
      eventType: 'annotation.command_rejected.v2',
      payload: json(response),
    },
  })
  return response
}
