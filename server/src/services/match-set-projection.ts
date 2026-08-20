import type { PrismaClient } from '@volleyball-monitoring/db'
import type { CourtSideAssignment, MatchSet } from '@volleyball-monitoring/db/client'
import { segmentStartCaptureTimeUs } from '../domain/rally-display-order.js'
import {
  loadCanonicalCourtSideBoundaries,
  projectCanonicalMatch,
} from './canonical-match-projection.js'

export type ProjectedMatchSet = MatchSet & {
  /** Resolved side history for the logical set, used by the GraphQL field resolver. */
  projectedSideAssignments?: CourtSideAssignment[]
}

/**
 * Projects the durable winner markers and resolved rally points into the
 * logical MatchSet rows exposed by the generic Match GraphQL type.
 *
 * Legacy rows and their stored left/right scores are deliberately not used as
 * display truth. This is what makes deleting a winner marker merge the
 * following rows back into the previous logical set without rewriting rallies.
 */
export async function projectMatchSets(
  database: PrismaClient,
  matchId: string,
): Promise<ProjectedMatchSet[]> {
  const [rawSets, rawRallies, courtSideBoundaries] = await Promise.all([
    database.matchSet.findMany({
      where: { matchId },
      orderBy: [{ setNumber: 'asc' }, { id: 'asc' }],
      include: {
        sideAssignments: {
          orderBy: [{ effectiveFromRallyOrdinal: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    database.rally.findMany({
      where: { matchId, activeSubmissionId: { not: null }, voidedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        setId: true,
        ordinal: true,
        createdAt: true,
        scoringTeamId: true,
        scoringCourtSide: true,
        scoreResolutionState: true,
        sideAssignmentReversed: true,
        sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
        activeSubmission: {
          select: {
            scoringTeamId: true,
            scoringCourtSide: true,
            scoreResolutionState: true,
            leftTeamId: true,
            rightTeamId: true,
            sideAssignmentReversed: true,
            boundaries: { select: { kind: true, captureTimeUs: true } },
            keyPoints: { select: { markerKind: true, captureTimeUs: true } },
          },
        },
      },
    }),
    loadCanonicalCourtSideBoundaries(database, matchId),
  ])

  if (rawSets.length === 0) return []

  const rawSetById = new Map(rawSets.map(set => [set.id, set]))
  const projectionRows = rawRallies.flatMap(rally => {
    const rawSet = rawSetById.get(rally.setId)
    const submission = rally.activeSubmission
    if (!rawSet || !submission) return []
    return [
      {
        ...rally,
        rawSetNumber: rawSet.setNumber,
        startCaptureTimeUs: segmentStartCaptureTimeUs(submission),
      },
    ]
  })
  const projection = projectCanonicalMatch({
    sets: rawSets,
    courtSideBoundaries,
    segments: projectionRows.map(rally => {
      const submission = rally.activeSubmission!
      return {
        id: rally.id,
        rawSetNumber: rally.rawSetNumber,
        rawOrdinal: rally.ordinal,
        startCaptureTimeUs: rally.startCaptureTimeUs,
        createdAt: rally.createdAt,
        submitted: true,
        scoreResolutionState: submission.scoreResolutionState,
        scoringCourtSide: rally.scoringCourtSide ?? submission.scoringCourtSide,
        scoringTeamId: rally.scoringTeamId ?? submission.scoringTeamId,
        baseLeftTeamId: rally.sideAssignment?.leftTeamId ?? submission.leftTeamId,
        baseRightTeamId: rally.sideAssignment?.rightTeamId ?? submission.rightTeamId,
        sideAssignmentReversed: rally.sideAssignment
          ? rally.sideAssignmentReversed
          : submission.sideAssignmentReversed,
      }
    }),
  })

  const projected: ProjectedMatchSet[] = []
  const projectionRowById = new Map(projectionRows.map(rally => [rally.id, rally]))
  const unusedOpenRows = rawSets.filter(set => !set.winningTeamId)
  for (const setProjection of projection.sets) {
    const rallies = setProjection.rallyIds.flatMap(id => {
      const rally = projectionRowById.get(id)
      return rally ? [rally] : []
    })
    const winnerRow = setProjection.winnerSetId
      ? rawSets.find(set => set.id === setProjection.winnerSetId)
      : null
    const representative =
      winnerRow ??
      (rallies.length ? rawSetById.get(rallies.at(-1)!.setId) : null) ??
      unusedOpenRows.at(-1) ??
      rawSets.at(-1)!
    const assignment = representative.sideAssignments.at(-1)
    const projectedAssignments = assignment
      ? [
          {
            ...assignment,
            effectiveFromRallyOrdinal: 1,
            effectiveToRallyOrdinal: null,
            leftTeamId: setProjection.leftTeamId ?? assignment.leftTeamId,
            rightTeamId: setProjection.rightTeamId ?? assignment.rightTeamId,
          },
        ]
      : []
    projected.push({
      ...representative,
      setNumber: setProjection.setNumber,
      leftScore: rallies.length ? setProjection.leftScore : representative.leftScore,
      rightScore: rallies.length ? setProjection.rightScore : representative.rightScore,
      winningTeamId: setProjection.winningTeamId,
      winningRallyId: setProjection.winningRallyId,
      projectedSideAssignments: projectedAssignments,
    } as ProjectedMatchSet)
  }

  return projected
}
