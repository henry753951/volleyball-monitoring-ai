import type { PrismaClient } from '@volleyball-monitoring/db'
import type { CourtSideAssignment, MatchSet } from '@volleyball-monitoring/db/client'
import { deriveEffectiveSetNumberMap } from './set-display-projection.js'

export type ProjectedMatchSet = MatchSet & {
  /** Resolved side history for the logical set, used by the GraphQL field resolver. */
  projectedSideAssignments?: CourtSideAssignment[]
}

function firstCaptureTimeUs(source: {
  boundaries: ReadonlyArray<{ kind: string; captureTimeUs: bigint }>
  keyPoints: ReadonlyArray<{ markerKind: string; captureTimeUs: bigint }>
}): bigint | null {
  const startBoundary = source.boundaries.find(boundary => boundary.kind.toUpperCase() === 'START')
  if (startBoundary) return startBoundary.captureTimeUs

  const servicePoint = source.keyPoints.find(point => point.markerKind.toUpperCase() === 'SERVICE')
  if (servicePoint) return servicePoint.captureTimeUs

  return source.keyPoints.reduce<bigint | null>(
    (earliest, point) =>
      earliest === null || point.captureTimeUs < earliest ? point.captureTimeUs : earliest,
    null,
  )
}

function compareRallies(
  left: {
    id: string
    ordinal: number
    createdAt: Date
    startCaptureTimeUs: bigint | null
    rawSetNumber: number
  },
  right: {
    id: string
    ordinal: number
    createdAt: Date
    startCaptureTimeUs: bigint | null
    rawSetNumber: number
  },
): number {
  if (
    left.startCaptureTimeUs !== null &&
    right.startCaptureTimeUs !== null &&
    left.startCaptureTimeUs !== right.startCaptureTimeUs
  )
    return left.startCaptureTimeUs < right.startCaptureTimeUs ? -1 : 1
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs === null) return -1
  if (left.startCaptureTimeUs === null && right.startCaptureTimeUs !== null) return 1
  if (left.createdAt.getTime() !== right.createdAt.getTime())
    return left.createdAt.getTime() - right.createdAt.getTime()
  return (
    left.rawSetNumber - right.rawSetNumber ||
    left.ordinal - right.ordinal ||
    left.id.localeCompare(right.id)
  )
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
  const [rawSets, rawRallies] = await Promise.all([
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
        scoreResolutionState: true,
        sideAssignmentReversed: true,
        sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
        activeSubmission: {
          select: {
            scoringTeamId: true,
            scoreResolutionState: true,
            leftTeamId: true,
            rightTeamId: true,
            boundaries: { select: { kind: true, captureTimeUs: true } },
            keyPoints: { select: { markerKind: true, captureTimeUs: true } },
          },
        },
      },
    }),
  ])

  if (rawSets.length === 0) return []

  const rawToEffective = deriveEffectiveSetNumberMap(rawSets)
  const rawSetById = new Map(rawSets.map(set => [set.id, set]))
  const orderedRallies = rawRallies
    .flatMap(rally => {
      const rawSet = rawSetById.get(rally.setId)
      if (!rawSet) return []
      return [
        {
          ...rally,
          rawSetNumber: rawSet.setNumber,
          startCaptureTimeUs: rally.activeSubmission
            ? firstCaptureTimeUs(rally.activeSubmission)
            : null,
        },
      ]
    })
    .sort(compareRallies)

  const groups = new Map<
    number,
    {
      rawSets: typeof rawSets
      rallies: typeof orderedRallies
    }
  >()
  for (const row of rawSets) {
    const setNumber = rawToEffective.get(row.setNumber) ?? row.setNumber
    const group = groups.get(setNumber)
    if (group) group.rawSets.push(row)
    else groups.set(setNumber, { rawSets: [row], rallies: [] })
  }
  for (const rally of orderedRallies) {
    const setNumber = rawToEffective.get(rally.rawSetNumber) ?? rally.rawSetNumber
    const group = groups.get(setNumber)
    if (group) group.rallies.push(rally)
  }

  const projected: ProjectedMatchSet[] = []
  for (const [setNumber, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    const representative = group.rawSets.at(-1)!
    const points = new Map<string, number>()
    let latestSides: { leftTeamId: string; rightTeamId: string } | null = null

    for (const rally of group.rallies) {
      const assignment = rally.sideAssignment
      const submission = rally.activeSubmission
      const sides = assignment
        ? rally.sideAssignmentReversed
          ? { leftTeamId: assignment.rightTeamId, rightTeamId: assignment.leftTeamId }
          : assignment
        : submission
          ? { leftTeamId: submission.leftTeamId, rightTeamId: submission.rightTeamId }
          : null
      if (sides) latestSides = sides

      const scoringTeamId = rally.scoringTeamId ?? submission?.scoringTeamId ?? null
      const resolved =
        rally.scoreResolutionState === 'RESOLVED' || submission?.scoreResolutionState === 'RESOLVED'
      if (resolved && scoringTeamId) points.set(scoringTeamId, (points.get(scoringTeamId) ?? 0) + 1)
    }

    const projectedAssignments = group.rawSets
      .flatMap(set => set.sideAssignments)
      .sort(
        (left, right) =>
          left.effectiveFromRallyOrdinal - right.effectiveFromRallyOrdinal ||
          left.id.localeCompare(right.id),
      )
    if (!latestSides) {
      const assignment = projectedAssignments.at(-1)
      latestSides = assignment
        ? { leftTeamId: assignment.leftTeamId, rightTeamId: assignment.rightTeamId }
        : null
    }

    const hasRallyScoreEvidence = group.rallies.length > 0
    projected.push({
      ...representative,
      setNumber,
      // New annotation data is always projected from resolved active rallies.
      // Keep the stored score only for legacy MatchSet rows that have no rally
      // evidence yet; otherwise a deleted winner or stale score ledger could
      // leak back into the display.
      leftScore: hasRallyScoreEvidence
        ? latestSides
          ? (points.get(latestSides.leftTeamId) ?? 0)
          : 0
        : representative.leftScore,
      rightScore: hasRallyScoreEvidence
        ? latestSides
          ? (points.get(latestSides.rightTeamId) ?? 0)
          : 0
        : representative.rightScore,
      projectedSideAssignments: projectedAssignments,
    } as ProjectedMatchSet)
  }

  return projected
}
