import { describe, expect, it } from 'vitest'
import type { CoachRally } from '~/lib/coachDomain'
import {
  resolveAnnotationRouteAnalysisPage,
  resolveAnnotationRouteInspector,
  resolveAnnotationRouteRally,
} from './annotationRouteSelection'

const rallies = [
  { id: 'rally-1', ordinal: 1 },
  { id: 'rally-126', ordinal: 126 },
] as CoachRally[]

describe('annotation route selection', () => {
  it('resolves a rally by stable id or display ordinal', () => {
    expect(resolveAnnotationRouteRally('rally-1', rallies)?.id).toBe('rally-1')
    expect(resolveAnnotationRouteRally('126', rallies)?.id).toBe('rally-126')
  })

  it('rejects malformed or unavailable rally selections', () => {
    expect(resolveAnnotationRouteRally('0', rallies)).toBeNull()
    expect(resolveAnnotationRouteRally('unknown', rallies)).toBeNull()
    expect(resolveAnnotationRouteRally(['999'], rallies)).toBeNull()
  })

  it('accepts only supported inspector and analysis pages', () => {
    expect(resolveAnnotationRouteInspector('analysis')).toBe('analysis')
    expect(resolveAnnotationRouteInspector('other')).toBeNull()
    expect(resolveAnnotationRouteAnalysisPage('hits')).toBe('hits')
    expect(resolveAnnotationRouteAnalysisPage('other')).toBeNull()
  })
})
