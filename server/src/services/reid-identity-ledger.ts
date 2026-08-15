import type { Prisma } from '@volleyball-monitoring/db/client'
import {
  ArtifactState,
  IdentitySource,
  ReidCorrectionDisplayScope,
  ReidEvidenceRole,
  ReidEvidenceState,
  ReidFutureEvidenceAction,
} from '@volleyball-monitoring/db/client'

type TransactionClient = Prisma.TransactionClient
type Position = { setNumber: number; rallyOrdinal: number }

export type ReidCorrectionMode = 'from_here' | 'split_identity' | 'clip_only'

export function correctionPolicyForIdentityMode(mode: ReidCorrectionMode) {
  if (mode === 'from_here')
    return {
      displayScope: ReidCorrectionDisplayScope.FROM_HERE,
      futureEvidenceAction: ReidFutureEvidenceAction.REJECT_SOURCE_AND_CONFIRM_TARGET,
    }
  if (mode === 'split_identity')
    return {
      displayScope: ReidCorrectionDisplayScope.CURRENT_CLIP,
      futureEvidenceAction: ReidFutureEvidenceAction.REJECT_SOURCE_AND_CONFIRM_TARGET,
    }
  return {
    displayScope: ReidCorrectionDisplayScope.CURRENT_CLIP,
    futureEvidenceAction: ReidFutureEvidenceAction.NONE,
  }
}

export function positionInCorrectionScope(
  candidate: Position,
  anchor: Position,
  scope: ReidCorrectionDisplayScope,
) {
  if (scope === ReidCorrectionDisplayScope.WHOLE_MATCH) return true
  if (scope === ReidCorrectionDisplayScope.CURRENT_CLIP)
    return (
      candidate.setNumber === anchor.setNumber && candidate.rallyOrdinal === anchor.rallyOrdinal
    )
  return (
    candidate.setNumber > anchor.setNumber ||
    (candidate.setNumber === anchor.setNumber && candidate.rallyOrdinal >= anchor.rallyOrdinal)
  )
}

export class ReidIdentityLedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ReidIdentityLedgerError'
  }
}

export async function applyVersionedReidCorrection(
  tx: TransactionClient,
  input: {
    analysisRunId: string
    canonicalTrackId: number
    rosterEntryId: string | null
    userId: string
    mode: ReidCorrectionMode
    reason?: string | null
  },
) {
  const evidenceRepository = tx.reidEvidenceSet
  if (!evidenceRepository)
    throw new ReidIdentityLedgerError(
      'REID_EVIDENCE_PENDING',
      '此片段的新版 ReID evidence 尚未完成，請稍後再試',
    )
  const evidenceSet = await evidenceRepository.findFirst({
    where: { analysisRunId: input.analysisRunId, status: ArtifactState.READY },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (!evidenceSet)
    throw new ReidIdentityLedgerError(
      'REID_EVIDENCE_PENDING',
      '此片段的新版 ReID evidence 尚未完成，請稍後再試',
    )
  const tracklet = await tx.reidTracklet.findUnique({
    where: {
      evidenceSetId_canonicalTrackId: {
        evidenceSetId: evidenceSet.id,
        canonicalTrackId: input.canonicalTrackId,
      },
    },
    include: {
      activeProjection: { include: { assignmentRevision: true } },
      associationDecisions: {
        where: { selectedPersonClusterId: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      evidenceSet: {
        include: {
          analysisRun: {
            include: {
              submission: { include: { rally: { include: { set: true } } } },
            },
          },
        },
      },
    },
  })
  if (!tracklet)
    throw new ReidIdentityLedgerError(
      'REID_EVIDENCE_PENDING',
      '此片段的新版 ReID evidence 尚未完成，請稍後再試',
    )
  const submission = tracklet.evidenceSet.analysisRun.submission
  const matchId = submission.rally.matchId
  const position = {
    setNumber: submission.rally.set.setNumber,
    rallyOrdinal: submission.rally.ordinal,
  }
  const roster = input.rosterEntryId
    ? await tx.matchRosterEntry.findUnique({ where: { id: input.rosterEntryId } })
    : null
  if (input.rosterEntryId && (!roster || roster.matchId !== matchId))
    throw new ReidIdentityLedgerError('ROSTER_NOT_FOUND', '找不到此場次的球員名單項目')
  const expectedTeamId =
    tracklet.courtSide === 'LEFT'
      ? submission.leftTeamId
      : tracklet.courtSide === 'RIGHT'
        ? submission.rightTeamId
        : null
  if (roster && expectedTeamId && roster.teamId !== expectedTeamId)
    throw new ReidIdentityLedgerError('REID_TEAM_MISMATCH', '所選球員不屬於此片段該場側的隊伍')

  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId}::uuid FOR UPDATE`
  const match = await tx.match.findUniqueOrThrow({
    where: { id: matchId },
    select: { identityRevision: true },
  })
  let revision = match.identityRevision
  const nextRevision = () => {
    revision += 1n
    return revision
  }
  let targetCluster = roster
    ? await tx.reidPersonCluster.findUnique({
        where: { canonicalRosterEntryId: roster.id },
      })
    : null
  if (roster && !targetCluster)
    targetCluster = await tx.reidPersonCluster.create({
      data: {
        matchId,
        teamId: roster.teamId,
        canonicalRosterEntryId: roster.id,
        label: roster.displayNameSnapshot ?? `#${roster.jerseyNumber}`,
        createdRevision: nextRevision(),
      },
    })
  const sourcePersonClusterId =
    tracklet.activeProjection?.assignmentRevision.personClusterId ??
    tracklet.associationDecisions[0]?.selectedPersonClusterId ??
    null
  const sourceCluster = sourcePersonClusterId
    ? await tx.reidPersonCluster.findUnique({ where: { id: sourcePersonClusterId } })
    : null
  const policy = correctionPolicyForIdentityMode(input.mode)
  const correction = await tx.reidIdentityCorrection.create({
    data: {
      matchId,
      teamId: roster?.teamId ?? sourceCluster?.teamId ?? expectedTeamId,
      analysisRunId: input.analysisRunId,
      trackletId: tracklet.id,
      sourcePersonClusterId,
      targetPersonClusterId: targetCluster?.id ?? null,
      rosterEntryId: roster?.id ?? null,
      displayScope: policy.displayScope,
      futureEvidenceAction: policy.futureEvidenceAction,
      revision: nextRevision(),
      reason: input.reason?.slice(0, 1_000) ?? null,
      createdByUserId: input.userId,
    },
  })

  const propagated = sourcePersonClusterId
    ? await tx.reidTracklet.findMany({
        where: {
          evidenceSet: {
            analysisRun: { submission: { rally: { matchId } } },
          },
          activeProjection: {
            assignmentRevision: { personClusterId: sourcePersonClusterId },
          },
        },
        include: {
          activeProjection: { include: { assignmentRevision: true } },
          evidenceSet: {
            include: {
              analysisRun: {
                include: {
                  submission: { include: { rally: { include: { set: true } } } },
                },
              },
            },
          },
        },
      })
    : []
  const affected = new Map<string, (typeof propagated)[number] | typeof tracklet>()
  affected.set(tracklet.id, tracklet)
  for (const item of propagated) affected.set(item.id, item)
  const revisions = []
  for (const candidate of affected.values()) {
    const candidatePosition = {
      setNumber: candidate.evidenceSet.analysisRun.submission.rally.set.setNumber,
      rallyOrdinal: candidate.evidenceSet.analysisRun.submission.rally.ordinal,
    }
    if (!positionInCorrectionScope(candidatePosition, position, policy.displayScope)) continue
    const assignmentRevision = await tx.reidAssignmentRevision.create({
      data: {
        matchId,
        analysisRunId: candidate.evidenceSet.analysisRunId,
        trackletId: candidate.id,
        personClusterId: targetCluster?.id ?? null,
        rosterEntryId: roster?.id ?? null,
        correctionId: correction.id,
        source: candidate.id === tracklet.id ? IdentitySource.MANUAL : IdentitySource.PROPAGATED,
        sourcePriority: 1_000,
        revision: nextRevision(),
        effectiveFromSetNumber: position.setNumber,
        effectiveFromRallyOrdinal: position.rallyOrdinal,
        supersedesRevisionId: candidate.activeProjection?.assignmentRevisionId ?? null,
        createdByUserId: input.userId,
      },
    })
    await tx.reidActiveProjection.upsert({
      where: { trackletId: candidate.id },
      update: {
        analysisRunId: candidate.evidenceSet.analysisRunId,
        assignmentRevisionId: assignmentRevision.id,
        sourcePriority: 1_000,
      },
      create: {
        analysisRunId: candidate.evidenceSet.analysisRunId,
        trackletId: candidate.id,
        assignmentRevisionId: assignmentRevision.id,
        sourcePriority: 1_000,
      },
    })
    if (roster)
      await tx.trackIdentityAssignment.upsert({
        where: {
          analysisRunId_trackId: {
            analysisRunId: candidate.evidenceSet.analysisRunId,
            trackId: candidate.canonicalTrackId,
          },
        },
        update: {
          rosterEntryId: roster.id,
          source: candidate.id === tracklet.id ? IdentitySource.MANUAL : IdentitySource.PROPAGATED,
          assignedByUserId: input.userId,
          confidence: 1,
          reidIdentityId: null,
          reidBindingId: null,
          identityRevision: assignmentRevision.revision,
        },
        create: {
          analysisRunId: candidate.evidenceSet.analysisRunId,
          trackId: candidate.canonicalTrackId,
          rosterEntryId: roster.id,
          source: candidate.id === tracklet.id ? IdentitySource.MANUAL : IdentitySource.PROPAGATED,
          assignedByUserId: input.userId,
          confidence: 1,
          identityRevision: assignmentRevision.revision,
        },
      })
    else
      await tx.trackIdentityAssignment.deleteMany({
        where: {
          analysisRunId: candidate.evidenceSet.analysisRunId,
          trackId: candidate.canonicalTrackId,
        },
      })
    revisions.push(assignmentRevision)
  }

  const supersedeEvidence = async (
    personClusterId: string,
    role: ReidEvidenceRole,
    state: ReidEvidenceState,
    rosterEntryId: string | null,
  ) => {
    const previous = await tx.reidEvidenceMembership.findFirst({
      where: {
        personClusterId,
        trackletId: tracklet.id,
        supersededByMemberships: { none: {} },
      },
      orderBy: { sourceRevision: 'desc' },
    })
    return tx.reidEvidenceMembership.create({
      data: {
        personClusterId,
        trackletId: tracklet.id,
        rosterEntryId,
        evidenceState: state,
        evidenceRole: role,
        weight: 1,
        sourceRevision: nextRevision(),
        supersedesMembershipId: previous?.id ?? null,
        correctionId: correction.id,
        createdByUserId: input.userId,
      },
    })
  }
  const rejectsSource =
    policy.futureEvidenceAction === ReidFutureEvidenceAction.REJECT_SOURCE_AND_CONFIRM_TARGET
  const confirmsTarget = rejectsSource
  if (rejectsSource && sourceCluster && sourceCluster.id !== targetCluster?.id)
    await supersedeEvidence(
      sourceCluster.id,
      ReidEvidenceRole.NEGATIVE,
      ReidEvidenceState.CONFIRMED,
      sourceCluster.canonicalRosterEntryId,
    )
  if (confirmsTarget && targetCluster)
    await supersedeEvidence(
      targetCluster.id,
      ReidEvidenceRole.POSITIVE,
      ReidEvidenceState.CONFIRMED,
      roster?.id ?? null,
    )

  await tx.match.update({ where: { id: matchId }, data: { identityRevision: revision } })
  return {
    matchId,
    correction,
    targetClusterId: targetCluster?.id ?? null,
    identityRevision: revision,
    assignmentRevisions: revisions,
  }
}
