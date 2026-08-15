export type AnnotationState = 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'
export type ScoreResolution = 'PENDING' | 'RESOLVED' | 'UNKNOWN'
export type RallyOutcome =
  | { scoreResolution: 'RESOLVED'; scoringCourtSide: 'LEFT' | 'RIGHT' }
  | { scoreResolution: 'UNKNOWN'; scoringCourtSide: null }

export function canSubmit(state: AnnotationState, score: ScoreResolution): boolean {
  return state === 'READY' && (score === 'RESOLVED' || score === 'UNKNOWN')
}

export function maskTone(state: AnnotationState): 'gray' | 'green' {
  return state === 'SUBMITTED' ? 'green' : 'gray'
}

export function canCloseRally(params: {
  state: AnnotationState
  targetKeyPointId: string | null
  currentLastKeyPointId: string | null
  outcome: RallyOutcome
}): boolean {
  const outcomeIsValid =
    params.outcome.scoreResolution === 'RESOLVED'
      ? params.outcome.scoringCourtSide === 'LEFT' || params.outcome.scoringCourtSide === 'RIGHT'
      : params.outcome.scoreResolution === 'UNKNOWN' && params.outcome.scoringCourtSide === null

  return (
    params.state === 'OPEN' &&
    params.targetKeyPointId !== null &&
    params.targetKeyPointId === params.currentLastKeyPointId &&
    outcomeIsValid
  )
}
