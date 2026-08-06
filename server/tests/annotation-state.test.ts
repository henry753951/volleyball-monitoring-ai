import { describe, expect, it } from 'vitest'
import { canMarkTerminal, canSubmit, maskTone } from '../src/domain/annotation-state.js'

describe('annotation state baseline', () => {
  it('submits resolved or explicit unknown, but not pending', () => {
    expect(canSubmit('READY', 'RESOLVED')).toBe(true)
    expect(canSubmit('READY', 'UNKNOWN')).toBe(true)
    expect(canSubmit('READY', 'PENDING')).toBe(false)
  })

  it('uses green only after immutable submission', () => {
    expect(maskTone('READY')).toBe('gray')
    expect(maskTone('SUBMITTED')).toBe('green')
  })

  it('X targets the existing last key point instead of creating a timestamp', () => {
    expect(canMarkTerminal({ state: 'OPEN', targetKeyPointId: 'kp-2', currentLastKeyPointId: 'kp-2' })).toBe(true)
    expect(canMarkTerminal({ state: 'OPEN', targetKeyPointId: 'kp-1', currentLastKeyPointId: 'kp-2' })).toBe(false)
  })
})
