export type MatchViewState = 'loading' | 'error' | 'not_found' | 'ready'

export function classifyMatchViewState(
  pending: boolean,
  error: unknown,
  match: unknown,
): MatchViewState {
  if (pending) return 'loading'
  if (error) return 'error'
  return match ? 'ready' : 'not_found'
}
