export function isProtectedPath(path: string): boolean {
  // The coach surface is the product entry point, not a public landing page.
  // Keep only the login route public so a stale session cannot leave users on
  // a partially rendered, unauthenticated coach screen.
  return path !== '/login'
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
