export type AnnotationState = 'OPEN' | 'AWAITING_SCORE' | 'READY' | 'SUBMITTED' | 'VOIDED'
export type ScoreResolution = 'PENDING' | 'RESOLVED' | 'UNKNOWN'

export function canSubmit(state: AnnotationState, score: ScoreResolution): boolean {
  return state === 'READY' && (score === 'RESOLVED' || score === 'UNKNOWN')
}

export function maskTone(state: AnnotationState): 'gray' | 'green' {
  return state === 'SUBMITTED' ? 'green' : 'gray'
}

export function canMarkTerminal(params: { state: AnnotationState; targetKeyPointId: string | null; currentLastKeyPointId: string | null }): boolean {
  return params.state === 'OPEN' && params.targetKeyPointId !== null && params.targetKeyPointId === params.currentLastKeyPointId
}
