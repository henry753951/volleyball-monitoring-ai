import { describe, expect, it } from 'vitest'
import { isProtectedPath } from './authBoundary'

describe('auth boundary paths', () => {
  it('protects match, annotation and settings routes without looping the public home', () => {
    expect(isProtectedPath('/')).toBe(false)
    expect(isProtectedPath('/matches/new')).toBe(true)
    expect(isProtectedPath('/matches/real-id/live')).toBe(true)
    expect(isProtectedPath('/annotate/real-id')).toBe(true)
    expect(isProtectedPath('/settings')).toBe(true)
  })
})
