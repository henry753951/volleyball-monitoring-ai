import { createHash, randomUUID } from 'node:crypto'
import {
  parseAnnotationCommandResponse,
  type AnnotationCommand,
  type AnnotationCommandRejected,
  type AnnotationCommandResponse,
} from '@volleyball-monitoring/contracts'
import type { Prisma } from '@volleyball-monitoring/db/client'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { AnnotationIdentity, AnnotationRoom } from './room.js'
import {
  isSubmissionBallEventValid,
  unresolvedBallEventSubmissionMessage,
} from './ball-event-submission-validation.js'
import { CLIP_CANONICALIZATION_PROFILE, CLIP_POLICY_VERSION } from '../../config/clip-policy.js'
import type { MediaObjectReader } from '../../media/playback-domain.js'
import { reuseCompletedSubmissionGeometry } from './submission-geometry-reuse.js'

type Tx = Prisma.TransactionClient
type SubmissionCommand = Extract<AnnotationCommand, { kind: 'SUBMIT_RALLY' }>

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value as object)
          .sort()
          .map(
            key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : JSON.stringify(value)
const reject = (
  command: AnnotationCommand,
  code: string,
  message: string,
  actual?: string,
): AnnotationCommandRejected => ({
  schema_version: command.schema_version,
  type: 'command_rejected',
  command_id: command.command_id,
  room_id: command.room_id,
  rally_id: command.rally_id,
  code,
  message,
  snapshot_refetch_required: code === 'REVISION_CONFLICT',
  ...(actual ? { actual_revision: actual, expected_revision: command.base_revision } : {}),
})

function ordinaryDraftBelongsToDevice(
  rally: {
    activeSubmissionId: string | null
    annotationStatus?: string
    draftOwnerDeviceSessionId?: string | null
    boundaries: Array<{ kind: string; deviceSessionId: string }>
    keyPoints: Array<{ markerKind: string; deviceSessionId: string }>
    operations: Array<{ deviceSessionId: string }>
  },
  deviceSessionId: string,
) {
  if (rally.activeSubmissionId !== null) return true
  if (rally.annotationStatus === 'READY') return true
  const owner =
    rally.draftOwnerDeviceSessionId ??
    rally.boundaries.find(boundary => boundary.kind === 'START')?.deviceSessionId ??
    rally.keyPoints.find(point => point.markerKind === 'SERVICE')?.deviceSessionId ??
    rally.operations[0]?.deviceSessionId
  return owner === deviceSessionId
}

function immutableSubmissionRange(submission: {
  boundaries: Array<{ captureTimeUs: bigint }>
  keyPoints: Array<{ captureTimeUs: bigint }>
  clipPreRollUs: bigint
  clipPostRollUs: bigint
  clipJobs: Array<{
    actualStartCaptureUs: bigint | null
    actualEndCaptureUs: bigint | null
    requestedStartCaptureUs: bigint
    requestedEndCaptureUs: bigint
  }>
}) {
  const clip = submission.clipJobs[0]
  if (clip) {
    return {
      start: clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs,
      end: clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs,
    }
  }
  const anchors = [...submission.boundaries, ...submission.keyPoints].sort((left, right) =>
    left.captureTimeUs < right.captureTimeUs
      ? -1
      : left.captureTimeUs > right.captureTimeUs
        ? 1
        : 0,
  )
  const first = anchors[0]
  const last = anchors.at(-1)
  if (!first || !last) return null
  const paddedStart = first.captureTimeUs - submission.clipPreRollUs
  return {
    start: paddedStart < 0n ? 0n : paddedStart,
    end: last.captureTimeUs + submission.clipPostRollUs,
  }
}

export async function submitRally(
  tx: Tx,
  room: AnnotationRoom,
  command: SubmissionCommand,
  identity: AnnotationIdentity,
  hash: string,
  timingManifestReader?: MediaObjectReader,
): Promise<AnnotationCommandResponse> {
  const device = await tx.deviceSession.findUnique({
    select: { revokedAt: true, userId: true },
    where: { id: identity.deviceSessionId },
  })
  if (!device || device.userId !== identity.userId || device.revokedAt) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'),
    )
  }
  const member = await tx.match.findFirst({
    select: { clipPostRollUs: true, clipPreRollUs: true, id: true },
    where: {
      id: room.matchId,
      captureSessions: { some: { id: room.captureSessionId } },
      ...(identity.role === UserRole.ADMIN
        ? {}
        : {
            members: {
              some: {
                userId: identity.userId,
                role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
              },
            },
          }),
    },
  })
  if (!member)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(
        command,
        'ROOM_AUTHORIZATION_STALE',
        'Annotation room authorization changed before commit',
      ),
    )
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${room.matchId}))`
  const clipPreRollUs = member.clipPreRollUs
  const clipPostRollUs = member.clipPostRollUs

  const rally = await tx.rally.findUnique({
    where: { id: command.rally_id },
    include: {
      boundaries: { orderBy: { kind: 'asc' } },
      keyPoints: {
        where: { deletedAt: null },
        orderBy: { sequenceIndex: 'asc' },
        include: { ballEvent: true },
      },
      operations: { orderBy: { resultRevision: 'asc' }, take: 1 },
      sideAssignment: true,
    },
  })
  if (!rally || rally.matchId !== room.matchId)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'RALLY_NOT_FOUND', 'Rally was not found'),
    )
  if (!ordinaryDraftBelongsToDevice(rally, identity.deviceSessionId)) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'RALLY_OWNED_BY_OTHER_CLIENT', '這個片段屬於另一個標註客戶端'),
    )
  }
  const correctionIsEditable =
    rally.annotationStatus === 'OPEN' && rally.activeSubmissionId !== null
  if (rally.annotationStatus !== 'READY' && !correctionIsEditable)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Rally must be READY before submit'),
    )
  if (rally.annotationRevision.toString() !== command.base_revision)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(
        command,
        'REVISION_CONFLICT',
        'Rally revision is stale',
        rally.annotationRevision.toString(),
      ),
    )

  const superseded = rally.activeSubmissionId
    ? await tx.rallySubmission.findUnique({
        where: { id: rally.activeSubmissionId },
        include: {
          boundaries: { orderBy: { kind: 'asc' } },
          keyPoints: {
            orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }],
            include: { ballEvent: true },
          },
        },
      })
    : null
  if (
    rally.activeSubmissionId &&
    (!superseded || superseded.rallyId !== rally.id || superseded.status !== 'ACTIVE')
  ) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Correction source submission is no longer active'),
    )
  }

  const services = rally.keyPoints.filter(point => point.markerKind === 'SERVICE')
  const terminals = rally.keyPoints.filter(point => point.isTerminal)
  const service = services[0]
  const terminal = terminals[0]
  const contiguous = rally.keyPoints.every((point, index) => point.sequenceIndex === index)
  const startBoundary = rally.boundaries.find(boundary => boundary.kind === 'START')
  const endBoundary = rally.boundaries.find(boundary => boundary.kind === 'END')
  const boundaryIntegrity =
    !!startBoundary &&
    !!endBoundary &&
    (endBoundary.captureTimeUs > startBoundary.captureTimeUs ||
      (endBoundary.captureTimeUs === startBoundary.captureTimeUs &&
        endBoundary.captureFrameIndex > startBoundary.captureFrameIndex)) &&
    contiguous &&
    rally.keyPoints.every(point => point.markerKind === 'CONTACT' && !point.isTerminal)
  const legacyIntegrity =
    (services.length !== 1 ||
      terminals.length !== 1 ||
      !service ||
      !terminal ||
      !contiguous ||
      service.sequenceIndex !== 0 ||
      terminal.sequenceIndex !== rally.keyPoints.length - 1 ||
      terminal.captureTimeUs < service.captureTimeUs ||
      (terminal.captureTimeUs === service.captureTimeUs &&
        terminal.captureFrameIndex < service.captureFrameIndex)) === false
  if (!boundaryIntegrity && !legacyIntegrity) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Rally key-point integrity is invalid'),
    )
  }
  if (command.schema_version === '4.0.0') {
    const invalidEvent = rally.keyPoints.find(
      (_, index) => isSubmissionBallEventValid(rally.keyPoints, index) === false,
    )
    if (invalidEvent) {
      return persist(
        tx,
        command,
        identity,
        hash,
        reject(
          command,
          'BALL_EVENT_INTEGRITY_INVALID',
          'Keypoint ball-event semantics require automatic correction before submission',
        ),
      )
    }
    const onlyEvent = rally.keyPoints.length === 1 ? rally.keyPoints[0]?.ballEvent : null
    if (onlyEvent && !['POINT_SCORED', 'ERROR'].includes(onlyEvent.result ?? '')) {
      return persist(
        tx,
        command,
        identity,
        hash,
        reject(
          command,
          'SINGLE_POINT_SERVE_DECISION_REQUIRED',
          'Choose whether the single serve scored or was an error before submission',
        ),
      )
    }
    const unresolvedMessage = unresolvedBallEventSubmissionMessage(rally.keyPoints)
    if (unresolvedMessage) {
      return persist(
        tx,
        command,
        identity,
        hash,
        reject(command, 'BALL_EVENT_RESULT_REQUIRED', unresolvedMessage),
      )
    }
  }
  const clipStartAnchor = startBoundary ?? service!
  const clipEndAnchor = endBoundary ?? terminal!
  const clipCoverageAnchors = boundaryIntegrity
    ? [clipStartAnchor, clipEndAnchor, ...rally.keyPoints]
    : [clipStartAnchor, clipEndAnchor]
  const coverageStartAnchor = clipCoverageAnchors.reduce((earliest, candidate) =>
    candidate.captureTimeUs < earliest.captureTimeUs ? candidate : earliest,
  )
  const coverageEndAnchor = clipCoverageAnchors.reduce((latest, candidate) =>
    candidate.captureTimeUs > latest.captureTimeUs ? candidate : latest,
  )

  const assignment = rally.sideAssignment
  if (assignment.setId !== rally.setId)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(
        command,
        'ANNOTATION_NOT_READY',
        'Court-side assignment does not belong to the Rally set',
      ),
    )
  if (
    (rally.scoreResolutionState === 'RESOLVED') !==
    (rally.scoringCourtSide === 'LEFT' || rally.scoringCourtSide === 'RIGHT')
  ) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Score resolution and court side are inconsistent'),
    )
  }
  if (rally.scoreResolutionState === 'UNKNOWN' && rally.scoringCourtSide !== null) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Unknown rallies cannot have a scoring side'),
    )
  }
  if (rally.scoreResolutionState === 'PENDING' && rally.scoringCourtSide !== null) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Pending rallies cannot have a scoring side'),
    )
  }

  const resolution = rally.scoreResolutionState
  const side = rally.scoringCourtSide
  const effectiveAssignment = rally.sideAssignmentReversed
    ? { leftTeamId: assignment.rightTeamId, rightTeamId: assignment.leftTeamId }
    : { leftTeamId: assignment.leftTeamId, rightTeamId: assignment.rightTeamId }
  const scoringTeamId =
    resolution === 'RESOLVED'
      ? side === 'LEFT'
        ? effectiveAssignment.leftTeamId
        : effectiveAssignment.rightTeamId
      : null

  const set = await tx.matchSet.findUnique({
    where: { id: rally.setId },
    select: {
      id: true,
      leftScore: true,
      rightScore: true,
      scoreRevision: true,
      sideAssignments: {
        orderBy: { effectiveFromRallyOrdinal: 'desc' },
        take: 1,
        select: { leftTeamId: true, rightTeamId: true },
      },
      rallies: {
        where: { id: { not: rally.id }, voidedAt: null, activeSubmissionId: { not: null } },
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          ordinal: true,
          activeSubmission: { select: { scoreResolutionState: true, scoringTeamId: true } },
        },
      },
    },
  })
  if (!set)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Set no longer exists'),
    )
  const currentAssignment = set.sideAssignments[0]
  if (!currentAssignment)
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'ANNOTATION_NOT_READY', 'Current court-side assignment is missing'),
    )

  const teamScores = new Map<string, number>()
  const scoreFor = (leftTeamId: string, rightTeamId: string) => ({
    left: teamScores.get(leftTeamId) ?? 0,
    right: teamScores.get(rightTeamId) ?? 0,
  })
  const scoreEntries = [
    ...set.rallies.flatMap(entry =>
      entry.activeSubmission
        ? [
            {
              id: entry.id,
              ordinal: entry.ordinal,
              resolution: entry.activeSubmission.scoreResolutionState,
              scoringTeamId: entry.activeSubmission.scoringTeamId,
            },
          ]
        : [],
    ),
    { id: rally.id, ordinal: rally.ordinal, resolution, scoringTeamId },
  ].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
  let historicalBefore = { left: 0, right: 0 }
  let historicalAfter = { left: 0, right: 0 }
  for (const entry of scoreEntries) {
    if (entry.id === rally.id)
      historicalBefore = scoreFor(effectiveAssignment.leftTeamId, effectiveAssignment.rightTeamId)
    if (entry.resolution === 'RESOLVED' && entry.scoringTeamId) {
      teamScores.set(entry.scoringTeamId, (teamScores.get(entry.scoringTeamId) ?? 0) + 1)
    }
    if (entry.id === rally.id)
      historicalAfter = scoreFor(effectiveAssignment.leftTeamId, effectiveAssignment.rightTeamId)
  }
  const currentScore = scoreFor(currentAssignment.leftTeamId, currentAssignment.rightTeamId)
  const leftDelta = currentScore.left - set.leftScore
  const rightDelta = currentScore.right - set.rightScore
  const scoreChanged = leftDelta !== 0 || rightDelta !== 0
  const scoreAfter = {
    left: currentScore.left,
    right: currentScore.right,
    revision: set.scoreRevision + (scoreChanged ? 1 : 0),
  }
  const snapshot = rally.keyPoints.map(point => ({
    capture_epoch_id: point.captureEpochId,
    sequence_index: point.sequenceIndex,
    marker_kind: point.markerKind,
    is_terminal: point.isTerminal,
    source_pts: point.sourcePts.toString(),
    capture_time_us: point.captureTimeUs.toString(),
    capture_frame_index: point.captureFrameIndex.toString(),
    timing_precision: point.timingPrecision,
    ball_event: point.ballEvent
      ? {
          kind: point.ballEvent.kind,
          result: point.ballEvent.result,
          semantic_source: point.ballEvent.semanticSource,
          actor_roster_entry_id: point.ballEvent.actorRosterEntryId,
        }
      : null,
  }))
  const boundarySnapshot = rally.boundaries.map(boundary => ({
    kind: boundary.kind,
    capture_epoch_id: boundary.captureEpochId,
    source_pts: boundary.sourcePts.toString(),
    capture_time_us: boundary.captureTimeUs.toString(),
    capture_frame_index: boundary.captureFrameIndex.toString(),
    timing_precision: boundary.timingPrecision,
  }))
  const clipWindowUnchanged =
    superseded !== null &&
    superseded.clipPolicyVersion === CLIP_POLICY_VERSION &&
    superseded.clipPreRollUs === clipPreRollUs &&
    superseded.clipPostRollUs === clipPostRollUs &&
    superseded.boundaries.length === rally.boundaries.length &&
    superseded.boundaries.every(boundary => {
      const draft = rally.boundaries.find(item => item.id === boundary.sourceDraftBoundaryId)
      return (
        !!draft &&
        boundary.kind === draft.kind &&
        boundary.captureEpochId === draft.captureEpochId &&
        boundary.sourcePts === draft.sourcePts &&
        boundary.captureTimeUs === draft.captureTimeUs &&
        boundary.captureFrameIndex === draft.captureFrameIndex &&
        boundary.timingPrecision === draft.timingPrecision
      )
    })
  const contactTopologyUnchanged =
    superseded !== null &&
    superseded.keyPoints.length === rally.keyPoints.length &&
    superseded.keyPoints.every(
      (point, index) => point.sequenceIndex === rally.keyPoints[index]?.sequenceIndex,
    )
  const geometryUnchanged =
    clipWindowUnchanged &&
    contactTopologyUnchanged &&
    superseded.keyPoints.every((point, index) => {
      const draft = rally.keyPoints[index]
      return (
        !!draft &&
        point.sourceDraftKeyPointId === draft.id &&
        point.captureEpochId === draft.captureEpochId &&
        point.sequenceIndex === draft.sequenceIndex &&
        point.markerKind === draft.markerKind &&
        point.isTerminal === draft.isTerminal &&
        point.sourcePts === draft.sourcePts &&
        point.captureTimeUs === draft.captureTimeUs &&
        point.captureFrameIndex === draft.captureFrameIndex &&
        point.timingPrecision === draft.timingPrecision
      )
    })
  const requestedStart =
    coverageStartAnchor.captureTimeUs - clipPreRollUs < 0n
      ? 0n
      : coverageStartAnchor.captureTimeUs - clipPreRollUs
  const requestedEnd = coverageEndAnchor.captureTimeUs + clipPostRollUs
  const immutableSubmissions = await tx.rallySubmission.findMany({
    where: {
      status: 'ACTIVE',
      rally: { matchId: room.matchId, id: { not: rally.id }, voidedAt: null },
    },
    select: {
      boundaries: { select: { captureTimeUs: true } },
      clipPostRollUs: true,
      clipPreRollUs: true,
      clipJobs: {
        orderBy: { createdAt: 'desc' },
        select: {
          actualEndCaptureUs: true,
          actualStartCaptureUs: true,
          requestedEndCaptureUs: true,
          requestedStartCaptureUs: true,
        },
        take: 1,
      },
      keyPoints: { select: { captureTimeUs: true } },
    },
  })
  const overlapsImmutableSubmission = immutableSubmissions.some(submission => {
    const range = immutableSubmissionRange(submission)
    return range !== null && requestedStart < range.end && requestedEnd > range.start
  })
  if (overlapsImmutableSubmission) {
    return persist(
      tx,
      command,
      identity,
      hash,
      reject(command, 'RALLY_OVERLAP', '這個片段與已送出的片段重疊；草稿仍保留，可調整後再送出'),
    )
  }
  const scoreSnapshot =
    resolution === 'RESOLVED'
      ? {
          before: { ...historicalBefore, revision: set.scoreRevision },
          after: { ...historicalAfter, revision: scoreAfter.revision },
        }
      : { before: null, after: null }
  const contentHash = createHash('sha256')
    .update(
      canonical({
        schema_version:
          command.schema_version === '4.0.0'
            ? 'rally-submission-content-v3'
            : boundaryIntegrity
              ? 'rally-submission-content-v2'
              : 'rally-submission-content-v1',
        boundaries: boundarySnapshot,
        key_points: snapshot,
        outcome: { resolution, side: side ?? null, scoring_team_id: scoringTeamId },
        assignment: {
          id: assignment.id,
          reversed: rally.sideAssignmentReversed,
          left_team_id: effectiveAssignment.leftTeamId,
          right_team_id: effectiveAssignment.rightTeamId,
        },
        score: scoreSnapshot,
        clip: {
          policy_version: CLIP_POLICY_VERSION,
          canonicalization_profile: CLIP_CANONICALIZATION_PROFILE,
          pre_us: clipPreRollUs.toString(),
          post_us: clipPostRollUs.toString(),
          requested_start_us: requestedStart.toString(),
          requested_end_us: requestedEnd.toString(),
        },
      }),
    )
    .digest('hex')

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
      leftTeamId: effectiveAssignment.leftTeamId,
      rightTeamId: effectiveAssignment.rightTeamId,
      sideAssignmentId: assignment.id,
      sideAssignmentReversed: rally.sideAssignmentReversed,
      leftScoreBefore: scoreSnapshot.before?.left ?? null,
      rightScoreBefore: scoreSnapshot.before?.right ?? null,
      leftScoreAfter: scoreSnapshot.after?.left ?? null,
      rightScoreAfter: scoreSnapshot.after?.right ?? null,
      scoreRevisionBefore: scoreSnapshot.before?.revision ?? null,
      scoreRevisionAfter: scoreSnapshot.after?.revision ?? null,
      clipPolicyVersion: CLIP_POLICY_VERSION,
      clipPreRollUs,
      clipPostRollUs,
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
  const ballEventRows = rally.keyPoints.flatMap(point => {
    const event = point.ballEvent
    const submissionPoint = rows.find(row => row.sourceDraftKeyPointId === point.id)
    if (!event || !submissionPoint) return []
    return [
      {
        id: randomUUID(),
        submissionId: submission.id,
        submissionKeyPointId: submissionPoint.id,
        ordinal: point.sequenceIndex + 1,
        kind: event.kind,
        result: event.result,
        semanticSource: event.semanticSource,
        actorRosterEntryId: event.actorRosterEntryId,
      },
    ]
  })
  if (ballEventRows.length > 0) {
    await tx.rallySubmissionBallEvent.createMany({ data: ballEventRows })
  }
  const boundaryRows = rally.boundaries.map(boundary => ({
    captureEpochId: boundary.captureEpochId,
    captureFrameIndex: boundary.captureFrameIndex,
    captureTimeUs: boundary.captureTimeUs,
    id: randomUUID(),
    kind: boundary.kind,
    sourceDraftBoundaryId: boundary.id,
    sourcePts: boundary.sourcePts,
    submissionId: submission.id,
    timingPrecision: boundary.timingPrecision,
  }))
  if (boundaryRows.length) {
    await tx.rallySubmissionBoundary.createMany({ data: boundaryRows })
  }
  if (legacyIntegrity) {
    const serviceRow = rows.find(row => row.sourceDraftKeyPointId === service!.id)
    const terminalRow = rows.find(row => row.sourceDraftKeyPointId === terminal!.id)
    if (!serviceRow || !terminalRow) throw new Error('SNAPSHOT_KEYPOINT_MISSING')
    await tx.rallySubmission.update({
      where: { id: submission.id },
      data: { serviceKeyPointId: serviceRow.id, terminalKeyPointId: terminalRow.id },
    })
  }

  if (scoreChanged) {
    const cas = await tx.matchSet.updateMany({
      where: { id: set.id, scoreRevision: set.scoreRevision },
      data: {
        leftScore: scoreAfter.left,
        rightScore: scoreAfter.right,
        scoreRevision: scoreAfter.revision,
      },
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
    if (resolution === 'RESOLVED' && scoringTeamId) {
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

  const clipReused =
    superseded && clipWindowUnchanged && contactTopologyUnchanged && resolution !== 'PENDING'
      ? await reuseCompletedSubmissionGeometry(tx, {
          allowLegacyMappingCopy: geometryUnchanged,
          newBoundaries: boundaryRows,
          newKeyPoints: rows.map(row => {
            const draft = rally.keyPoints.find(point => point.id === row.sourceDraftKeyPointId)!
            return {
              actorRosterEntryId: draft.ballEvent?.actorRosterEntryId ?? null,
              captureEpochId: row.captureEpochId,
              captureFrameIndex: row.captureFrameIndex,
              captureTimeUs: row.captureTimeUs,
              id: row.id,
              sequenceIndex: row.sequenceIndex,
              sourcePts: row.sourcePts,
            }
          }),
          newSubmissionId: submission.id,
          sourceBoundaries: superseded.boundaries,
          sourceKeyPoints: superseded.keyPoints,
          sourceSubmissionId: superseded.id,
          ...(timingManifestReader ? { timingManifestReader } : {}),
        })
      : false
  if (!clipReused) {
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
    await tx.rallySubmission.update({
      where: { id: superseded.id },
      data: { status: 'SUPERSEDED' },
    })
    // Completed evidence can remain the explicit projection source for an
    // identical-geometry correction. Only unfinished source work is retired.
    await Promise.all([
      tx.clipJob.updateMany({
        where: { submissionId: superseded.id, status: { not: 'COMPLETED' } },
        data: { status: 'SUPERSEDED', leasedUntil: null },
      }),
      tx.aiJob.updateMany({
        where: { submissionId: superseded.id, status: { not: 'COMPLETED' } },
        data: { status: 'SUPERSEDED', leasedUntil: null },
      }),
    ])
  }

  const revision = rally.annotationRevision + 1n
  const rallyCas = await tx.rally.updateMany({
    where: {
      id: rally.id,
      annotationStatus: superseded ? { in: ['OPEN', 'READY'] } : 'READY',
      annotationRevision: rally.annotationRevision,
      activeSubmissionId: superseded?.id ?? null,
    },
    data: {
      annotationRevision: revision,
      annotationStatus: 'SUBMITTED',
      activeSubmissionId: submission.id,
      processingStatus: clipReused ? 'COMPLETED' : 'CLIP_QUEUED',
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
    schema_version: command.schema_version,
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
  await tx.annotationCommandReceipt.update({
    where: { serverSequence: receipt.serverSequence },
    data: { responseJson: json(response) },
  })
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
      eventType: `annotation.command_accepted.v${command.schema_version.split('.')[0]}`,
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
          clip_reused: clipReused,
          clip_window_unchanged: clipWindowUnchanged,
          contact_topology_unchanged: contactTopologyUnchanged,
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
