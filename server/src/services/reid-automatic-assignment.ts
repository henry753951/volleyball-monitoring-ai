import type { PrismaClient } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'

const canManageIdentity = (role: UserRole) =>
  role === UserRole.ADMIN || role === UserRole.OPERATOR || role === UserRole.COACH

/**
 * Materialize the latest versioned ReID projection into the track read model.
 * The versioned evidence/projection ledger is the only identity authority.
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
          select: { rally: { select: { matchId: true } } },
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

    const evidence = run.reidEvidenceSets[0]
    if (!evidence) throw new Error('REID_EVIDENCE_PENDING')

    const trackIds = evidence.tracklets.map(tracklet => tracklet.canonicalTrackId)
    await tx.trackIdentityAssignment.deleteMany({
      where: {
        analysisRunId: input.analysisRunId,
        ...(trackIds.length > 0 ? { trackId: { notIn: trackIds } } : {}),
      },
    })

    let assignedCount = 0
    let alreadyAssignedCount = 0
    let unresolvedCount = 0

    for (const tracklet of evidence.tracklets) {
      const revision = tracklet.activeProjection?.assignmentRevision
      if (!revision?.rosterEntryId) {
        await tx.trackIdentityAssignment.deleteMany({
          where: {
            analysisRunId: input.analysisRunId,
            trackId: tracklet.canonicalTrackId,
          },
        })
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
        existing?.rosterEntryId === revision.rosterEntryId &&
        existing.source === revision.source &&
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
      preserved_manual_count: 0,
      unresolved_count: unresolvedCount,
    }
  })
}
