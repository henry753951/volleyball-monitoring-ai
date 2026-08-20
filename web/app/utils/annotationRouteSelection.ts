import type { CoachRally } from '~/lib/coachDomain'

export type AnnotationRouteInspectorTab = 'match' | 'mapping' | 'analysis'
export type AnnotationRouteAnalysisPage = 'root' | 'hits' | 'ball' | 'players'

function queryValue(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim()
  return ''
}

export function resolveAnnotationRouteRally(
  value: unknown,
  rallies: readonly CoachRally[],
): CoachRally | null {
  const requested = queryValue(value)
  if (!requested) return null

  const byId = rallies.find(rally => rally.id === requested)
  if (byId) return byId

  if (!/^\d+$/.test(requested)) return null
  const ordinal = Number(requested)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return null
  return rallies.find(rally => rally.ordinal === ordinal) ?? null
}

export function resolveAnnotationRouteInspector(
  value: unknown,
): AnnotationRouteInspectorTab | null {
  const requested = queryValue(value)
  return requested === 'match' || requested === 'mapping' || requested === 'analysis'
    ? requested
    : null
}

export function resolveAnnotationRouteAnalysisPage(
  value: unknown,
): AnnotationRouteAnalysisPage | null {
  const requested = queryValue(value)
  return requested === 'root' ||
    requested === 'hits' ||
    requested === 'ball' ||
    requested === 'players'
    ? requested
    : null
}
