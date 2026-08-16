import type { Prisma, ReidAssignmentRevision } from '@volleyball-monitoring/db/client'
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

export function parseReidCorrectionMode(value: unknown): ReidCorrectionMode {
  if (value === undefined || value === null || value === '') return 'from_here'
  if (value === 'from_here' || value === 'clip_only' || value === 'split_identity') return value
  throw new TypeError('identityMode must be from_here, clip_only or split_identity')
}

export function correctionPolicyForIdentityMode(mode: ReidCorrectionMode) {
  if (mode === 'from_here')
    return {
      displayScope: ReidCorrectionDisplayScope.FROM_HERE,
      futureEvidenceAction: ReidFutureEvidenceAction.CONFIRM_TARGET,
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

export function planGidRosterBindingChange(input: {
  sourceClusterId: string
  sourceRosterEntryId: string | null
  selectedRosterEntryId: string
  occupiedClusterId: string | null
}) {
  const displacedClusterId =
    input.occupiedClusterId && input.occupiedClusterId !== input.sourceClusterId
      ? input.occupiedClusterId
      : null
  return {
    source: {
      personClusterId: input.sourceClusterId,
      rosterEntryId: input.selectedRosterEntryId,
    },
    displaced: displacedClusterId
      ? {
          personClusterId: displacedClusterId,
          rosterEntryId:
            input.sourceRosterEntryId === input.selectedRosterEntryId
              ? null
              : input.sourceRosterEntryId,
        }
      : null,
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
  const sourcePersonClusterId =
    tracklet.activeProjection?.assignmentRevision.personClusterId ??
    tracklet.associationDecisions[0]?.selectedPersonClusterId ??
    null
  let sourceCluster = sourcePersonClusterId
    ? await tx.reidPersonCluster.findUnique({ where: { id: sourcePersonClusterId } })
    : null
  const occupiedCluster = roster
    ? await tx.reidPersonCluster.findUnique({ where: { canonicalRosterEntryId: roster.id } })
    : null
  let targetCluster = sourceCluster
  let displacedCluster: typeof occupiedCluster = null
  let displacedRosterEntryId: string | null = null

  if (input.mode === 'from_here' && roster) {
    if (!targetCluster) {
      targetCluster = await tx.reidPersonCluster.create({
        data: {
          matchId,
          teamId: roster.teamId,
          canonicalRosterEntryId: null,
          label: null,
          createdRevision: nextRevision(),
        },
      })
      sourceCluster = targetCluster
    }
    const binding = planGidRosterBindingChange({
      sourceClusterId: targetCluster.id,
      sourceRosterEntryId: targetCluster.canonicalRosterEntryId,
      selectedRosterEntryId: roster.id,
      occupiedClusterId: occupiedCluster?.id ?? null,
    })
    if (binding.displaced) {
      displacedCluster = occupiedCluster
      displacedRosterEntryId = binding.displaced.rosterEntryId
      await tx.reidPersonCluster.update({
        where: { id: binding.displaced.personClusterId },
        data: { canonicalRosterEntryId: null },
      })
    }
    await tx.reidPersonCluster.update({
      where: { id: binding.source.personClusterId },
      data: { canonicalRosterEntryId: binding.source.rosterEntryId, teamId: roster.teamId },
    })
    if (binding.displaced?.rosterEntryId)
      await tx.reidPersonCluster.update({
        where: { id: binding.displaced.personClusterId },
        data: { canonicalRosterEntryId: binding.displaced.rosterEntryId },
      })
  } else if (input.mode === 'split_identity' && roster) {
    targetCluster = occupiedCluster
    if (!targetCluster)
      targetCluster = await tx.reidPersonCluster.create({
        data: {
          matchId,
          teamId: roster.teamId,
          canonicalRosterEntryId: roster.id,
          label: null,
          createdRevision: nextRevision(),
        },
      })
    if (sourceCluster?.id !== targetCluster.id) {
      const targetTracklets = await tx.reidEvidenceMembership.findMany({
        where: {
          personClusterId: targetCluster.id,
          supersededByMemberships: { none: {} },
        },
        select: { trackletId: true },
      })
      const targetTrackletIds = [...new Set(targetTracklets.map(item => item.trackletId))]
      const cannotLink = targetTrackletIds.length
        ? await tx.reidCannotLink.findFirst({
            where: {
              OR: [
                { leftTrackletId: tracklet.id, rightTrackletId: { in: targetTrackletIds } },
                { rightTrackletId: tracklet.id, leftTrackletId: { in: targetTrackletIds } },
              ],
            },
            select: { id: true },
          })
        : null
      if (cannotLink)
        throw new ReidIdentityLedgerError(
          'REID_GID_CANNOT_LINK',
          '這個 Local ID 與所選球員的人員群組曾在同一 frame 出現，不能合併；請改用 GID 配對交換',
        )
    }
  }
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
      reason:
        input.reason?.slice(0, 1_000) ??
        (displacedCluster
          ? `atomic GID roster swap with ${displacedCluster.id}`
          : input.mode === 'from_here'
            ? 'confirmed GID roster binding'
            : null),
      createdByUserId: input.userId,
    },
  })

  const propagated =
    input.mode === 'from_here' && targetCluster
      ? await tx.reidTracklet.findMany({
          where: {
            evidenceSet: {
              analysisRun: { submission: { rally: { matchId } } },
            },
            activeProjection: {
              assignmentRevision: { personClusterId: targetCluster.id },
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
  const revisions: ReidAssignmentRevision[] = []
  const writeProjection = async (
    candidate: (typeof propagated)[number] | typeof tracklet,
    personClusterId: string | null,
    rosterEntryId: string | null,
    propagatedAssignment: boolean,
  ) => {
    const candidatePosition = {
      setNumber: candidate.evidenceSet.analysisRun.submission.rally.set.setNumber,
      rallyOrdinal: candidate.evidenceSet.analysisRun.submission.rally.ordinal,
    }
    if (!positionInCorrectionScope(candidatePosition, position, policy.displayScope)) return
    const assignmentRevision = await tx.reidAssignmentRevision.create({
      data: {
        matchId,
        analysisRunId: candidate.evidenceSet.analysisRunId,
        trackletId: candidate.id,
        personClusterId,
        rosterEntryId,
        correctionId: correction.id,
        source:
          candidate.id === tracklet.id && !propagatedAssignment
            ? IdentitySource.MANUAL
            : IdentitySource.PROPAGATED,
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
    if (rosterEntryId)
      await tx.trackIdentityAssignment.upsert({
        where: {
          analysisRunId_trackId: {
            analysisRunId: candidate.evidenceSet.analysisRunId,
            trackId: candidate.canonicalTrackId,
          },
        },
        update: {
          rosterEntryId,
          source:
            candidate.id === tracklet.id && !propagatedAssignment
              ? IdentitySource.MANUAL
              : IdentitySource.PROPAGATED,
          assignedByUserId: input.userId,
          confidence: 1,
          identityRevision: assignmentRevision.revision,
        },
        create: {
          analysisRunId: candidate.evidenceSet.analysisRunId,
          trackId: candidate.canonicalTrackId,
          rosterEntryId,
          source:
            candidate.id === tracklet.id && !propagatedAssignment
              ? IdentitySource.MANUAL
              : IdentitySource.PROPAGATED,
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
  for (const candidate of affected.values())
    await writeProjection(
      candidate,
      targetCluster?.id ?? sourceCluster?.id ?? null,
      roster?.id ?? null,
      candidate.id !== tracklet.id,
    )

  if (displacedCluster) {
    const displacedTracklets = await tx.reidTracklet.findMany({
      where: {
        evidenceSet: { analysisRun: { submission: { rally: { matchId } } } },
        activeProjection: {
          assignmentRevision: { personClusterId: displacedCluster.id },
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
    for (const candidate of displacedTracklets)
      await writeProjection(candidate, displacedCluster.id, displacedRosterEntryId, true)
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
  const confirmsTarget =
    policy.futureEvidenceAction === ReidFutureEvidenceAction.REJECT_SOURCE_AND_CONFIRM_TARGET ||
    policy.futureEvidenceAction === ReidFutureEvidenceAction.CONFIRM_TARGET
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
