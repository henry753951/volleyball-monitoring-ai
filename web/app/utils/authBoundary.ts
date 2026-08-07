export function isProtectedPath(path: string): boolean {
  return path === '/settings' || path.startsWith('/matches/') || path.startsWith('/annotate/')
}

export type ViewerBoundaryState = 'loading' | 'authenticated' | 'unauthenticated' | 'error'

export function classifyViewerState(
  checked: boolean,
  pending: boolean,
  viewer: unknown,
  error: unknown,
): ViewerBoundaryState {
  if (pending || !checked) return 'loading'
  if (error) return 'error'
  return viewer ? 'authenticated' : 'unauthenticated'
}

export function authRedirectQuery(error: { code?: string } | null): 'required' | 'unavailable' {
  return error?.code === 'UNAUTHENTICATED' ? 'required' : 'unavailable'
}
