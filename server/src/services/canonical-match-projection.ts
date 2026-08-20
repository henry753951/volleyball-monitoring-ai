import type { PrismaClient } from '@volleyball-monitoring/db'

export interface CanonicalMatchSetInput {
  id: string
  setNumber: number
  status?: string
  winningTeamId: string | null
  winningRallyId?: string | null
}

export interface CanonicalMatchSegmentInput {
  id: string
  rawSetNumber: number
  rawOrdinal: number
  startCaptureTimeUs: bigint | null
  createdAt?: Date | null
  submitted: boolean
  scoreResolutionState?: string | null
  scoringCourtSide?: string | null
  scoringTeamId?: string | null
  baseLeftTeamId?: string | null
  baseRightTeamId?: string | null
  sideAssignmentReversed?: boolean
}

export interface CanonicalCourtSideBoundaryInput {
  id: string
  effectiveRallyId: string
  leftTeamId: string
  rightTeamId: string
}

export interface CanonicalSegmentProjection {
  id: string
  setNumber: number
  ordinal: number
  globalOrdinal: number
  leftTeamId: string | null
  rightTeamId: string | null
  scoringCourtSide: 'left' | 'right' | null
  scoringTeamId: string | null
  leftScoreBefore: number
  rightScoreBefore: number
  leftScoreAfter: number
  rightScoreAfter: number
  officialLeftScoreBefore: number
  officialRightScoreBefore: number
  officialLeftScoreAfter: number
  officialRightScoreAfter: number
  winnerSide: 'left' | 'right' | null
  endsSet: boolean
  winnerSetId: string | null
  winningTeamId: string | null
}

export interface CanonicalSetProjection {
  setNumber: number
  rallyIds: string[]
  winnerSetId: string | null
  winningRallyId: string | null
  winningTeamId: string | null
  leftTeamId: string | null
  rightTeamId: string | null
  leftScore: number
  rightScore: number
  previewLeftScore: number
  previewRightScore: number
}

export interface CanonicalMatchProjection {
  orderedSegmentIds: string[]
  segmentById: ReadonlyMap<string, CanonicalSegmentProjection>
  sets: CanonicalSetProjection[]
  diagnostics: {
    orphanWinnerSetIds: string[]
    duplicateWinnerRallyIds: string[]
    orphanCourtSideBoundaryIds: string[]
    duplicateCourtSideBoundaryRallyIds: string[]
  }
}

function normalized(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? ''
}

function compareSegments(left: CanonicalMatchSegmentInput, right: CanonicalMatchSegmentInput) {
  if (
    left.startCaptureTimeUs !== null &&
    right.startCaptureTimeUs !== null &&
    left.startCaptureTimeUs !== right.startCaptureTimeUs
  )
    return left.startCaptureTimeUs < right.startCaptureTimeUs ? -1 : 1
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs === null) return -1
  if (left.startCaptureTimeUs === null && right.startCaptureTimeUs !== null) return 1
  const leftCreatedAt = left.createdAt?.getTime() ?? 0
  const rightCreatedAt = right.createdAt?.getTime() ?? 0
  return (
    leftCreatedAt - rightCreatedAt ||
    left.rawSetNumber - right.rawSetNumber ||
    left.rawOrdinal - right.rawOrdinal ||
    left.id.localeCompare(right.id)
  )
}

function effectiveSides(segment: CanonicalMatchSegmentInput) {
  const leftTeamId = segment.baseLeftTeamId ?? null
  const rightTeamId = segment.baseRightTeamId ?? null
  if (!leftTeamId || !rightTeamId) return { leftTeamId, rightTeamId }
  return segment.sideAssignmentReversed
    ? { leftTeamId: rightTeamId, rightTeamId: leftTeamId }
    : { leftTeamId, rightTeamId }
}

function scoringProjection(
  segment: CanonicalMatchSegmentInput,
  sides: { leftTeamId: string | null; rightTeamId: string | null },
) {
  const resolved = normalized(segment.scoreResolutionState) === 'RESOLVED'
  if (!resolved) return { scoringCourtSide: null, scoringTeamId: null }

  let scoringTeamId = segment.scoringTeamId ?? null
  if (scoringTeamId !== sides.leftTeamId && scoringTeamId !== sides.rightTeamId) {
    const scoringCourtSide = normalized(segment.scoringCourtSide)
    scoringTeamId =
      scoringCourtSide === 'LEFT'
        ? sides.leftTeamId
        : scoringCourtSide === 'RIGHT'
          ? sides.rightTeamId
          : null
  }
  return {
    scoringCourtSide:
      scoringTeamId && scoringTeamId === sides.leftTeamId
        ? ('left' as const)
        : scoringTeamId && scoringTeamId === sides.rightTeamId
          ? ('right' as const)
          : null,
    scoringTeamId,
  }
}

function scoreFor(teamScores: ReadonlyMap<string, number>, teamId: string | null) {
  return teamId ? (teamScores.get(teamId) ?? 0) : 0
}

/**
 * The only score/set/order projection used by backend read models.
 *
 * Persisted MatchSet numbers, Rally display ordinals and score ledgers are audit and
 * compatibility data. Product-visible order comes from canonical START capture time;
 * a set boundary belongs to MatchSet.winningRallyId, so inserting an earlier rally never
 * moves the winner or creates duplicate court-side transitions.
 */
export function projectCanonicalMatch(input: {
  sets: readonly CanonicalMatchSetInput[]
  segments: readonly CanonicalMatchSegmentInput[]
  courtSideBoundaries?: readonly CanonicalCourtSideBoundaryInput[]
}): CanonicalMatchProjection {
  // A correction draft replaces the submitted geometry with the same rally ID.
  const segmentByInputId = new Map<string, CanonicalMatchSegmentInput>()
  for (const segment of input.segments) segmentByInputId.set(segment.id, segment)
  const ordered = [...segmentByInputId.values()].sort(compareSegments)
  const orderedIndexById = new Map(ordered.map((segment, index) => [segment.id, index]))
  const winnerByRallyId = new Map<string, CanonicalMatchSetInput>()
  const orphanWinnerSetIds: string[] = []
  const duplicateWinnerRallyIds: string[] = []
  const orphanCourtSideBoundaryIds: string[] = []
  const duplicateCourtSideBoundaryRallyIds: string[] = []
  const courtSideBoundaryByRallyId = new Map<string, CanonicalCourtSideBoundaryInput>()

  for (const boundary of input.courtSideBoundaries ?? []) {
    if (!orderedIndexById.has(boundary.effectiveRallyId)) {
      orphanCourtSideBoundaryIds.push(boundary.id)
      continue
    }
    if (courtSideBoundaryByRallyId.has(boundary.effectiveRallyId)) {
      duplicateCourtSideBoundaryRallyIds.push(boundary.effectiveRallyId)
      continue
    }
    courtSideBoundaryByRallyId.set(boundary.effectiveRallyId, boundary)
  }

  for (const set of [...input.sets].sort((left, right) => left.setNumber - right.setNumber)) {
    if (!set.winningTeamId) continue
    let winningRallyId = set.winningRallyId ?? null
    if (!winningRallyId) {
      winningRallyId =
        ordered.filter(segment => segment.rawSetNumber === set.setNumber).at(-1)?.id ?? null
    }
    if (!winningRallyId || !orderedIndexById.has(winningRallyId)) {
      orphanWinnerSetIds.push(set.id)
      continue
    }
    if (winnerByRallyId.has(winningRallyId)) {
      duplicateWinnerRallyIds.push(winningRallyId)
      continue
    }
    winnerByRallyId.set(winningRallyId, set)
  }

  const segmentById = new Map<string, CanonicalSegmentProjection>()
  const sets: CanonicalSetProjection[] = []
  let setNumber = 1
  let ordinal = 0
  let officialTeamScores = new Map<string, number>()
  let previewTeamScores = new Map<string, number>()
  let currentSet: CanonicalSetProjection = {
    setNumber,
    rallyIds: [],
    winnerSetId: null,
    winningRallyId: null,
    winningTeamId: null,
    leftTeamId: null,
    rightTeamId: null,
    leftScore: 0,
    rightScore: 0,
    previewLeftScore: 0,
    previewRightScore: 0,
  }
  sets.push(currentSet)
  let activeCourtSides: { leftTeamId: string | null; rightTeamId: string | null } | null = null

  ordered.forEach((segment, globalIndex) => {
    ordinal += 1
    const courtSideBoundary = courtSideBoundaryByRallyId.get(segment.id)
    if (courtSideBoundary) {
      activeCourtSides = {
        leftTeamId: courtSideBoundary.leftTeamId,
        rightTeamId: courtSideBoundary.rightTeamId,
      }
    } else if (activeCourtSides === null) {
      // Legacy rally rows may each carry a different side assignment. Treat only
      // the first rally as the baseline; after that, explicit rally-anchored
      // boundaries are the sole authority allowed to change court sides.
      activeCourtSides = effectiveSides(segment)
    }
    const sides = activeCourtSides
    const scoring = scoringProjection(segment, sides)
    const leftScoreBefore = scoreFor(previewTeamScores, sides.leftTeamId)
    const rightScoreBefore = scoreFor(previewTeamScores, sides.rightTeamId)
    const officialLeftScoreBefore = scoreFor(officialTeamScores, sides.leftTeamId)
    const officialRightScoreBefore = scoreFor(officialTeamScores, sides.rightTeamId)

    if (scoring.scoringTeamId) {
      previewTeamScores.set(
        scoring.scoringTeamId,
        (previewTeamScores.get(scoring.scoringTeamId) ?? 0) + 1,
      )
      if (segment.submitted)
        officialTeamScores.set(
          scoring.scoringTeamId,
          (officialTeamScores.get(scoring.scoringTeamId) ?? 0) + 1,
        )
    }

    const winner = winnerByRallyId.get(segment.id) ?? null
    const projected: CanonicalSegmentProjection = {
      id: segment.id,
      setNumber,
      ordinal,
      globalOrdinal: globalIndex + 1,
      leftTeamId: sides.leftTeamId,
      rightTeamId: sides.rightTeamId,
      scoringCourtSide: scoring.scoringCourtSide,
      scoringTeamId: scoring.scoringTeamId,
      leftScoreBefore,
      rightScoreBefore,
      leftScoreAfter: scoreFor(previewTeamScores, sides.leftTeamId),
      rightScoreAfter: scoreFor(previewTeamScores, sides.rightTeamId),
      officialLeftScoreBefore,
      officialRightScoreBefore,
      officialLeftScoreAfter: scoreFor(officialTeamScores, sides.leftTeamId),
      officialRightScoreAfter: scoreFor(officialTeamScores, sides.rightTeamId),
      winnerSide:
        scoring.scoringTeamId === sides.leftTeamId
          ? 'left'
          : scoring.scoringTeamId === sides.rightTeamId
            ? 'right'
            : null,
      endsSet: Boolean(winner),
      winnerSetId: winner?.id ?? null,
      winningTeamId: winner?.winningTeamId ?? null,
    }
    segmentById.set(segment.id, projected)
    currentSet.rallyIds.push(segment.id)
    currentSet.leftTeamId = sides.leftTeamId
    currentSet.rightTeamId = sides.rightTeamId
    currentSet.leftScore = projected.officialLeftScoreAfter
    currentSet.rightScore = projected.officialRightScoreAfter
    currentSet.previewLeftScore = projected.leftScoreAfter
    currentSet.previewRightScore = projected.rightScoreAfter

    if (winner) {
      currentSet.winnerSetId = winner.id
      currentSet.winningRallyId = segment.id
      currentSet.winningTeamId = winner.winningTeamId
      setNumber += 1
      ordinal = 0
      officialTeamScores = new Map<string, number>()
      previewTeamScores = new Map<string, number>()
      currentSet = {
        setNumber,
        rallyIds: [],
        winnerSetId: null,
        winningRallyId: null,
        winningTeamId: null,
        leftTeamId: null,
        rightTeamId: null,
        leftScore: 0,
        rightScore: 0,
        previewLeftScore: 0,
        previewRightScore: 0,
      }
      sets.push(currentSet)
    }
  })

  const highestWinnerRawSetNumber = input.sets.reduce(
    (highest, set) => (set.winningTeamId ? Math.max(highest, set.setNumber) : highest),
    0,
  )
  const hasTrailingOpenRawSet = input.sets.some(
    set => !set.winningTeamId && set.setNumber > highestWinnerRawSetNumber,
  )
  if (sets.length > 1 && sets.at(-1)?.rallyIds.length === 0 && !hasTrailingOpenRawSet) sets.pop()

  return {
    orderedSegmentIds: ordered.map(segment => segment.id),
    segmentById,
    sets,
    diagnostics: {
      orphanWinnerSetIds,
      duplicateWinnerRallyIds,
      orphanCourtSideBoundaryIds,
      duplicateCourtSideBoundaryRallyIds,
    },
  }
}

export async function loadCanonicalCourtSideBoundaries(
  database: PrismaClient,
  matchId: string,
): Promise<CanonicalCourtSideBoundaryInput[]> {
  return database.courtSideSwapMarker.findMany({
    where: { matchId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      effectiveRallyId: true,
      leftTeamId: true,
      rightTeamId: true,
    },
  })
}

export async function loadCanonicalMatchProjection(database: PrismaClient, matchId: string) {
  const [sets, rallies, courtSideBoundaries] = await Promise.all([
    database.matchSet.findMany({
      where: { matchId },
      orderBy: [{ setNumber: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        setNumber: true,
        status: true,
        winningTeamId: true,
        winningRallyId: true,
      },
    }),
    database.rally.findMany({
      where: { matchId, activeSubmissionId: { not: null }, voidedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        ordinal: true,
        createdAt: true,
        scoreResolutionState: true,
        scoringCourtSide: true,
        scoringTeamId: true,
        sideAssignmentReversed: true,
        sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
        set: { select: { setNumber: true } },
        activeSubmission: {
          select: {
            scoreResolutionState: true,
            scoringCourtSide: true,
            scoringTeamId: true,
            leftTeamId: true,
            rightTeamId: true,
            boundaries: { select: { kind: true, captureTimeUs: true } },
            keyPoints: { select: { markerKind: true, captureTimeUs: true } },
          },
        },
      },
    }),
    loadCanonicalCourtSideBoundaries(database, matchId),
  ])

  return projectCanonicalMatch({
    sets,
    courtSideBoundaries,
    segments: rallies.flatMap(rally => {
      const submission = rally.activeSubmission
      if (!submission) return []
      const startBoundary = submission.boundaries.find(
        boundary => normalized(boundary.kind) === 'START',
      )
      const legacyStart = submission.keyPoints.find(
        point => normalized(point.markerKind) === 'SERVICE',
      )
      const startCaptureTimeUs =
        startBoundary?.captureTimeUs ??
        legacyStart?.captureTimeUs ??
        submission.keyPoints.reduce<bigint | null>(
          (earliest, point) =>
            earliest === null || point.captureTimeUs < earliest ? point.captureTimeUs : earliest,
          null,
        )
      return [
        {
          id: rally.id,
          rawSetNumber: rally.set.setNumber,
          rawOrdinal: rally.ordinal,
          startCaptureTimeUs,
          createdAt: rally.createdAt,
          submitted: true,
          scoreResolutionState: rally.scoreResolutionState ?? submission.scoreResolutionState,
          scoringCourtSide: rally.scoringCourtSide ?? submission.scoringCourtSide,
          scoringTeamId: rally.scoringTeamId ?? submission.scoringTeamId,
          baseLeftTeamId: rally.sideAssignment?.leftTeamId ?? submission.leftTeamId,
          baseRightTeamId: rally.sideAssignment?.rightTeamId ?? submission.rightTeamId,
          sideAssignmentReversed: rally.sideAssignment ? rally.sideAssignmentReversed : false,
        },
      ]
    }),
  })
}
