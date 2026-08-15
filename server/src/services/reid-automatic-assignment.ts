import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  ArtifactState,
  IdentitySource,
  JobStatus,
  UserRole,
} from '@volleyball-monitoring/db/client'

const canManageIdentity = (role: UserRole) =>
  role === UserRole.ADMIN || role === UserRole.OPERATOR || role === UserRole.COACH

/**
 * Re-materialize legacy Local/TID reads from the versioned active projection.
 * Association workers create AI projections; human corrections remain higher priority.
 */
export async function applyReidAutomaticAssignments(
  database: PrismaClient,
  input: { analysisRunId: string; userId: string; role: UserRole },
) {
  if (!canManageIdentity(input.role)) throw new Error('FORBIDDEN')
  return database.$transaction(async tx => {
    const run = await tx.analysisRun.findUnique({
      where: { id: input.analysisRunId },
      select: {
        id: true,
        status: true,
        submission: {
          select: {
            rally: {
              select: {
                matchId: true,
                ordinal: true,
                set: { select: { setNumber: true } },
              },
            },
          },
        },
        tracks: {
          select: {
            trackId: true,
            identityAssignments: {
              select: {
                source: true,
                rosterEntryId: true,
                reidIdentityId: true,
                reidBindingId: true,
              },
            },
            reidObservation: {
              select: {
                reidIdentityId: true,
                matchConfidence: true,
              },
            },
          },
        },
        reidEvidenceSets: {
          where: { status: ArtifactState.READY },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            tracklets: {
              select: {
                canonicalTrackId: true,
                activeProjection: {
                  select: {
                    assignmentRevision: {
                      select: {
                        rosterEntryId: true,
                        source: true,
                        revision: true,
                        createdByUserId: true,
                      },
                    },
                  },
                },
                associationDecisions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { confidence: true },
                },
              },
            },
          },
        },
      },
    })
    if (!run || run.status !== JobStatus.COMPLETED) throw new Error('NOT_FOUND')
    const matchId = run.submission.rally.matchId
    const member =
      input.role === UserRole.ADMIN ||
      Boolean(
        await tx.matchMember.findUnique({
          where: { matchId_userId: { matchId, userId: input.userId } },
          select: { userId: true },
        }),
      )
    if (!member) throw new Error('NOT_FOUND')
    await tx.$queryRaw`SELECT id FROM "AnalysisRun" WHERE id = ${input.analysisRunId}::uuid FOR UPDATE`

    const evidence = run.reidEvidenceSets?.[0]
    if (!evidence) {
      const reidIdentityIds = [
        ...new Set(
          run.tracks
            .map(track => track.reidObservation?.reidIdentityId)
            .filter((identityId): identityId is string => Boolean(identityId)),
        ),
      ]
      const position = {
        setNumber: run.submission.rally.set.setNumber,
        rallyOrdinal: run.submission.rally.ordinal,
      }
      const bindings =
        reidIdentityIds.length === 0
          ? []
          : await tx.reidPlayerBinding.findMany({
              where: {
                reidIdentityId: { in: reidIdentityIds },
                rosterEntryId: { not: null },
                reidIdentity: { matchId },
                rosterEntry: { matchId, active: true },
                OR: [
                  { effectiveFromSetNumber: { lt: position.setNumber } },
                  {
                    effectiveFromSetNumber: position.setNumber,
                    effectiveFromRallyOrdinal: { lte: position.rallyOrdinal },
                  },
                ],
              },
              orderBy: [
                { effectiveFromSetNumber: 'desc' },
                { effectiveFromRallyOrdinal: 'desc' },
                { identityRevision: 'desc' },
              ],
              select: {
                id: true,
                reidIdentityId: true,
                rosterEntryId: true,
                identityRevision: true,
                reidIdentity: { select: { teamId: true } },
                rosterEntry: { select: { teamId: true } },
              },
            })
      const bindingByIdentity = new Map<string, (typeof bindings)[number]>()
      for (const binding of bindings) {
        if (
          binding.rosterEntryId &&
          binding.reidIdentity.teamId === binding.rosterEntry?.teamId &&
          !bindingByIdentity.has(binding.reidIdentityId)
        )
          bindingByIdentity.set(binding.reidIdentityId, binding)
      }

      let assignedCount = 0
      let alreadyAssignedCount = 0
      let preservedManualCount = 0
      let unresolvedCount = 0
      for (const track of run.tracks) {
        const existing = track.identityAssignments[0] ?? null
        const identityId = track.reidObservation?.reidIdentityId ?? null
        const binding = identityId ? bindingByIdentity.get(identityId) : null
        if (!binding?.rosterEntryId) {
          if (existing) alreadyAssignedCount += 1
          else if (track.reidObservation) unresolvedCount += 1
          continue
        }
        if (existing?.source === IdentitySource.MANUAL) {
          preservedManualCount += 1
          continue
        }
        if (
          existing?.source === IdentitySource.PROPAGATED &&
          existing.rosterEntryId === binding.rosterEntryId &&
          existing.reidIdentityId === identityId &&
          existing.reidBindingId === binding.id
        ) {
          alreadyAssignedCount += 1
          continue
        }
        await tx.trackIdentityAssignment.upsert({
          where: {
            analysisRunId_trackId: {
              analysisRunId: input.analysisRunId,
              trackId: track.trackId,
            },
          },
          create: {
            analysisRunId: input.analysisRunId,
            trackId: track.trackId,
            rosterEntryId: binding.rosterEntryId,
            source: IdentitySource.PROPAGATED,
            assignedByUserId: null,
            confidence: track.reidObservation?.matchConfidence ?? null,
            reidIdentityId: identityId,
            reidBindingId: binding.id,
            identityRevision: binding.identityRevision,
          },
          update: {
            rosterEntryId: binding.rosterEntryId,
            source: IdentitySource.PROPAGATED,
            assignedByUserId: null,
            confidence: track.reidObservation?.matchConfidence ?? null,
            reidIdentityId: identityId,
            reidBindingId: binding.id,
            identityRevision: binding.identityRevision,
          },
        })
        assignedCount += 1
      }
      return {
        schema_version: '1.0.0',
        match_id: matchId,
        analysis_run_id: input.analysisRunId,
        evidence_state: 'legacy',
        assigned_count: assignedCount,
        already_assigned_count: alreadyAssignedCount,
        preserved_manual_count: preservedManualCount,
        unresolved_count: unresolvedCount,
      }
    }
    let assignedCount = 0
    let alreadyAssignedCount = 0
    let preservedManualCount = 0
    let unresolvedCount = 0
    for (const tracklet of evidence.tracklets) {
      const revision = tracklet.activeProjection?.assignmentRevision
      if (!revision?.rosterEntryId) {
        unresolvedCount += 1
        continue
      }
      const existing = await tx.trackIdentityAssignment.findUnique({
        where: {
          analysisRunId_trackId: {
            analysisRunId: input.analysisRunId,
            trackId: tracklet.canonicalTrackId,
          },
        },
      })
      if (
        existing?.source === IdentitySource.MANUAL &&
        existing.identityRevision !== null &&
        existing.identityRevision >= revision.revision
      ) {
        preservedManualCount += 1
        continue
      }
      if (
        existing?.rosterEntryId === revision.rosterEntryId &&
        existing.identityRevision === revision.revision
      ) {
        alreadyAssignedCount += 1
        continue
      }
      await tx.trackIdentityAssignment.upsert({
        where: {
          analysisRunId_trackId: {
            analysisRunId: input.analysisRunId,
            trackId: tracklet.canonicalTrackId,
          },
        },
        create: {
          analysisRunId: input.analysisRunId,
          trackId: tracklet.canonicalTrackId,
          rosterEntryId: revision.rosterEntryId,
          source: revision.source,
          assignedByUserId: revision.createdByUserId,
          confidence: tracklet.associationDecisions[0]?.confidence ?? 1,
          identityRevision: revision.revision,
        },
        update: {
          rosterEntryId: revision.rosterEntryId,
          source: revision.source,
          assignedByUserId: revision.createdByUserId,
          confidence: tracklet.associationDecisions[0]?.confidence ?? 1,
          reidIdentityId: null,
          reidBindingId: null,
          identityRevision: revision.revision,
        },
      })
      assignedCount += 1
    }
    return {
      schema_version: '2.0.0',
      match_id: matchId,
      analysis_run_id: input.analysisRunId,
      evidence_state: 'ready',
      assigned_count: assignedCount,
      already_assigned_count: alreadyAssignedCount,
      preserved_manual_count: preservedManualCount,
      unresolved_count: unresolvedCount,
    }
  })
}
