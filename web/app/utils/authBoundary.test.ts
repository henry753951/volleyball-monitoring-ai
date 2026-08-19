import { describe, expect, it } from 'vitest'
import { authRedirectQuery, classifyViewerState, isProtectedPath } from './authBoundary'

describe('auth boundary paths', () => {
  it('protects the coach entry point and all application routes', () => {
    expect(isProtectedPath('/')).toBe(true)
    expect(isProtectedPath('/control')).toBe(true)
    expect(isProtectedPath('/matches/new')).toBe(true)
    expect(isProtectedPath('/matches/real-id/live')).toBe(true)
    expect(isProtectedPath('/annotate/real-id')).toBe(true)
    expect(isProtectedPath('/settings')).toBe(true)
    expect(isProtectedPath('/login')).toBe(false)
  })

  it('distinguishes unauthenticated from an unavailable auth service', () => {
    expect(classifyViewerState(true, false, null, null)).toBe('unauthenticated')
    expect(classifyViewerState(true, false, null, new Error('offline'))).toBe('error')
    expect(classifyViewerState(false, true, null, null)).toBe('loading')
    expect(authRedirectQuery({ code: 'UNAUTHENTICATED' })).toBe('required')
    expect(authRedirectQuery(null)).toBe('unavailable')
  })
})
