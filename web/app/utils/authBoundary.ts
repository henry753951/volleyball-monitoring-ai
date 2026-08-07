export function isProtectedPath(path: string): boolean {
  return path === '/settings' || path.startsWith('/matches/') || path.startsWith('/annotate/')
}
