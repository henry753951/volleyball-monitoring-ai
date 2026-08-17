import { randomUUID } from 'node:crypto'

import type { Prisma, ReidAssignmentRevision } from '../generated/client/client.js'
import {
  ArtifactState,
  IdentitySource,
  ReidCorrectionDisplayScope,
  ReidEvidenceRole,
  ReidEvidenceState,
  ReidFutureEvidenceAction,
} from '../generated/client/client.js'

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

async function queueAssociationRematches(
  tx: TransactionClient,
  input: {
    matchId: string
    anchor: Position
    identityRevision: bigint
    userId: string
  },
) {
  const runs = await tx.analysisRun.findMany({
    where: {
      submission: { rally: { matchId: input.matchId } },
      reidEvidenceSets: {
        some: { status: ArtifactState.READY, supersededAt: null },
      },
    },
    select: {
      id: true,
      submission: {
        select: {
          rally: {
            select: {
              ordinal: true,
              set: { select: { setNumber: true } },
            },
          },
        },
      },
    },
  })
  const eligibleRunIds = runs
    .filter(run =>
      positionInCorrectionScope(
        {
          setNumber: run.submission.rally.set.setNumber,
          rallyOrdinal: run.submission.rally.ordinal,
        },
        input.anchor,
        ReidCorrectionDisplayScope.FROM_HERE,
      ),
    )
    .map(run => run.id)
  if (eligibleRunIds.length === 0) return 0
  const created = await tx.reidAssociationRerunRequest.createMany({
    data: eligibleRunIds.map(analysisRunId => ({
      id: randomUUID(),
      analysisRunId,
      requestedByUserId: input.userId,
      requestedIdentityRevision: input.identityRevision,
      reason: `human identity seed revision ${input.identityRevision.toString()}`,
    })),
    skipDuplicates: true,
  })
  return created.count
}

export async function applyVersionedReidCorrection(
  tx: TransactionClient,
  input: {
    analysisRunId: string
    canonicalTrackId: number
    rosterEntryId: string | null
    userId: string
    mode: ReidCorrectionMode
    reason?: string | null | undefined
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
  let targetCluster = sourceCluster

  if (input.mode === 'from_here') {
    if (!targetCluster && roster) {
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
    if (targetCluster)
      await tx.reidPersonCluster.update({
        where: { id: targetCluster.id },
        data: {
          canonicalRosterEntryId: roster?.id ?? null,
          ...(roster ? { teamId: roster.teamId } : {}),
        },
      })
  } else if (input.mode === 'split_identity' && roster) {
    targetCluster = await tx.reidPersonCluster.create({
      data: {
        matchId,
        teamId: roster.teamId,
        canonicalRosterEntryId: roster.id,
        label: null,
        createdRevision: nextRevision(),
      },
    })
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
        (input.mode === 'from_here' ? 'confirmed GID roster binding' : null),
      createdByUserId: input.userId,
    },
  })

  if (
    targetCluster &&
    (input.mode === 'from_here' || (input.mode === 'split_identity' && roster))
  ) {
    const priorBinding = await tx.reidGidRosterBindingRevision.findFirst({
      where: { personClusterId: targetCluster.id },
      orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
    })
    await tx.reidGidRosterBindingRevision.create({
      data: {
        matchId,
        personClusterId: targetCluster.id,
        rosterEntryId: roster?.id ?? null,
        source: IdentitySource.MANUAL,
        revision: nextRevision(),
        effectiveFromSetNumber: position.setNumber,
        effectiveFromRallyOrdinal: position.rallyOrdinal,
        supersedesRevisionId: priorBinding?.id ?? null,
        correctionId: correction.id,
        createdByUserId: input.userId,
      },
    })
  }

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
          pendingCorrectionMode: null,
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
          pendingCorrectionMode: null,
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
  const queuedAssociationReruns = await queueAssociationRematches(tx, {
    matchId,
    anchor: position,
    identityRevision: revision,
    userId: input.userId,
  })
  return {
    matchId,
    correction,
    targetClusterId: targetCluster?.id ?? null,
    identityRevision: revision,
    assignmentRevisions: revisions,
    queuedAssociationReruns,
  }
}

export async function reconcilePendingReidAssignments(
  tx: TransactionClient,
  input: { analysisRunId: string },
) {
  const pending = await tx.trackIdentityAssignment.findMany({
    where: {
      analysisRunId: input.analysisRunId,
      source: IdentitySource.MANUAL,
      identityRevision: null,
      pendingCorrectionMode: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      trackId: true,
      rosterEntryId: true,
      assignedByUserId: true,
      pendingCorrectionMode: true,
    },
  })
  const reconciled: Array<{
    trackId: number
    rosterEntryId: string
    identityRevision: bigint
  }> = []
  for (const assignment of pending) {
    if (!assignment.assignedByUserId || !assignment.pendingCorrectionMode) continue
    const result = await applyVersionedReidCorrection(tx, {
      analysisRunId: input.analysisRunId,
      canonicalTrackId: assignment.trackId,
      rosterEntryId: assignment.rosterEntryId,
      userId: assignment.assignedByUserId,
      mode: parseReidCorrectionMode(assignment.pendingCorrectionMode),
      reason: 'reconciled from manual assignment saved before ReID evidence was ready',
    })
    reconciled.push({
      trackId: assignment.trackId,
      rosterEntryId: assignment.rosterEntryId,
      identityRevision: result.identityRevision,
    })
  }
  return reconciled
}

export async function swapVersionedGidRosterBindings(
  tx: TransactionClient,
  input: {
    analysisRunId: string
    canonicalTrackId: number
    targetPersonClusterId: string
    userId: string
    reason?: string | null | undefined
  },
) {
  const evidenceSet = await tx.reidEvidenceSet.findFirst({
    where: {
      analysisRunId: input.analysisRunId,
      status: ArtifactState.READY,
      supersededAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (!evidenceSet)
    throw new ReidIdentityLedgerError('REID_EVIDENCE_PENDING', '此片段的 ReID evidence 尚未完成')
  const sourceTracklet = await tx.reidTracklet.findUnique({
    where: {
      evidenceSetId_canonicalTrackId: {
        evidenceSetId: evidenceSet.id,
        canonicalTrackId: input.canonicalTrackId,
      },
    },
    include: {
      activeProjection: { include: { assignmentRevision: true } },
      evidenceSet: {
        include: {
          analysisRun: {
            include: { submission: { include: { rally: { include: { set: true } } } } },
          },
        },
      },
    },
  })
  const sourceClusterId = sourceTracklet?.activeProjection?.assignmentRevision.personClusterId
  if (!sourceTracklet || !sourceClusterId)
    throw new ReidIdentityLedgerError('REID_GID_NOT_FOUND', '目前 Local ID 尚未連到可交換的 GID')
  if (sourceClusterId === input.targetPersonClusterId)
    throw new ReidIdentityLedgerError('REID_GID_SAME_TARGET', '來源與目標是同一個 GID')
  const [sourceCluster, targetCluster] = await Promise.all([
    tx.reidPersonCluster.findUnique({ where: { id: sourceClusterId } }),
    tx.reidPersonCluster.findUnique({ where: { id: input.targetPersonClusterId } }),
  ])
  const submission = sourceTracklet.evidenceSet.analysisRun.submission
  const matchId = submission.rally.matchId
  if (
    !sourceCluster ||
    !targetCluster ||
    sourceCluster.matchId !== matchId ||
    targetCluster.matchId !== matchId ||
    (sourceCluster.teamId && targetCluster.teamId && sourceCluster.teamId !== targetCluster.teamId)
  )
    throw new ReidIdentityLedgerError('REID_GID_NOT_FOUND', '找不到同場同隊的目標 GID')
  const position = {
    setNumber: submission.rally.set.setNumber,
    rallyOrdinal: submission.rally.ordinal,
  }
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId}::uuid FOR UPDATE`
  let revision = (
    await tx.match.findUniqueOrThrow({
      where: { id: matchId },
      select: { identityRevision: true },
    })
  ).identityRevision
  const nextRevision = () => (revision += 1n)
  const correction = await tx.reidIdentityCorrection.create({
    data: {
      matchId,
      teamId: sourceCluster.teamId ?? targetCluster.teamId,
      analysisRunId: input.analysisRunId,
      trackletId: sourceTracklet.id,
      sourcePersonClusterId: sourceCluster.id,
      targetPersonClusterId: targetCluster.id,
      rosterEntryId: targetCluster.canonicalRosterEntryId,
      displayScope: ReidCorrectionDisplayScope.FROM_HERE,
      futureEvidenceAction: ReidFutureEvidenceAction.CONFIRM_TARGET,
      revision: nextRevision(),
      reason: input.reason?.slice(0, 1_000) ?? `atomic GID swap with ${targetCluster.id}`,
      createdByUserId: input.userId,
    },
  })
  const sourceRosterEntryId = sourceCluster.canonicalRosterEntryId
  const targetRosterEntryId = targetCluster.canonicalRosterEntryId
  await tx.reidPersonCluster.update({
    where: { id: sourceCluster.id },
    data: { canonicalRosterEntryId: targetRosterEntryId },
  })
  await tx.reidPersonCluster.update({
    where: { id: targetCluster.id },
    data: { canonicalRosterEntryId: sourceRosterEntryId },
  })
  for (const [cluster, rosterEntryId] of [
    [sourceCluster, targetRosterEntryId],
    [targetCluster, sourceRosterEntryId],
  ] as const) {
    const prior = await tx.reidGidRosterBindingRevision.findFirst({
      where: { personClusterId: cluster.id },
      orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
    })
    await tx.reidGidRosterBindingRevision.create({
      data: {
        matchId,
        personClusterId: cluster.id,
        rosterEntryId,
        source: IdentitySource.MANUAL,
        revision: nextRevision(),
        effectiveFromSetNumber: position.setNumber,
        effectiveFromRallyOrdinal: position.rallyOrdinal,
        supersedesRevisionId: prior?.id ?? null,
        correctionId: correction.id,
        createdByUserId: input.userId,
      },
    })
  }
  const affected = await tx.reidTracklet.findMany({
    where: {
      evidenceSet: { analysisRun: { submission: { rally: { matchId } } } },
      activeProjection: {
        assignmentRevision: { personClusterId: { in: [sourceCluster.id, targetCluster.id] } },
      },
    },
    include: {
      activeProjection: { include: { assignmentRevision: true } },
      evidenceSet: {
        include: {
          analysisRun: {
            include: { submission: { include: { rally: { include: { set: true } } } } },
          },
        },
      },
    },
  })
  for (const tracklet of affected) {
    const candidatePosition = {
      setNumber: tracklet.evidenceSet.analysisRun.submission.rally.set.setNumber,
      rallyOrdinal: tracklet.evidenceSet.analysisRun.submission.rally.ordinal,
    }
    if (
      !positionInCorrectionScope(candidatePosition, position, ReidCorrectionDisplayScope.FROM_HERE)
    )
      continue
    const clusterId = tracklet.activeProjection!.assignmentRevision.personClusterId
    const rosterEntryId = clusterId === sourceCluster.id ? targetRosterEntryId : sourceRosterEntryId
    const assignment = await tx.reidAssignmentRevision.create({
      data: {
        matchId,
        analysisRunId: tracklet.evidenceSet.analysisRunId,
        trackletId: tracklet.id,
        personClusterId: clusterId,
        rosterEntryId,
        correctionId: correction.id,
        source:
          tracklet.id === sourceTracklet.id ? IdentitySource.MANUAL : IdentitySource.PROPAGATED,
        sourcePriority: 1_000,
        revision: nextRevision(),
        effectiveFromSetNumber: position.setNumber,
        effectiveFromRallyOrdinal: position.rallyOrdinal,
        supersedesRevisionId: tracklet.activeProjection?.assignmentRevisionId ?? null,
        createdByUserId: input.userId,
      },
    })
    await tx.reidActiveProjection.update({
      where: { trackletId: tracklet.id },
      data: {
        analysisRunId: tracklet.evidenceSet.analysisRunId,
        assignmentRevisionId: assignment.id,
        sourcePriority: 1_000,
      },
    })
    if (rosterEntryId)
      await tx.trackIdentityAssignment.upsert({
        where: {
          analysisRunId_trackId: {
            analysisRunId: tracklet.evidenceSet.analysisRunId,
            trackId: tracklet.canonicalTrackId,
          },
        },
        update: {
          rosterEntryId,
          source: IdentitySource.PROPAGATED,
          assignedByUserId: input.userId,
          confidence: 1,
          identityRevision: assignment.revision,
          pendingCorrectionMode: null,
        },
        create: {
          analysisRunId: tracklet.evidenceSet.analysisRunId,
          trackId: tracklet.canonicalTrackId,
          rosterEntryId,
          source: IdentitySource.PROPAGATED,
          assignedByUserId: input.userId,
          confidence: 1,
          identityRevision: assignment.revision,
          pendingCorrectionMode: null,
        },
      })
    else
      await tx.trackIdentityAssignment.deleteMany({
        where: {
          analysisRunId: tracklet.evidenceSet.analysisRunId,
          trackId: tracklet.canonicalTrackId,
        },
      })
  }
  await tx.match.update({ where: { id: matchId }, data: { identityRevision: revision } })
  return {
    matchId,
    correctionId: correction.id,
    identityRevision: revision,
    sourceClusterId: sourceCluster.id,
    targetClusterId: targetCluster.id,
    sourceRosterEntryId: targetRosterEntryId,
    targetRosterEntryId: sourceRosterEntryId,
  }
}
