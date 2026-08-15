import { describe, expect, it } from 'vitest'
import { canCloseRally, canSubmit, maskTone } from '../src/domain/annotation-state.js'

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

  it.each([
    { scoreResolution: 'RESOLVED' as const, scoringCourtSide: 'LEFT' as const },
    { scoreResolution: 'RESOLVED' as const, scoringCourtSide: 'RIGHT' as const },
    { scoreResolution: 'UNKNOWN' as const, scoringCourtSide: null },
  ])(
    'atomically closes on the current last key point with outcome $scoreResolution/$scoringCourtSide',
    outcome => {
      expect(
        canCloseRally({
          state: 'OPEN',
          targetKeyPointId: 'kp-2',
          currentLastKeyPointId: 'kp-2',
          outcome,
        }),
      ).toBe(true)
    },
  )

  it('rejects a stale target so the client must refetch after a revision conflict', () => {
    expect(
      canCloseRally({
        state: 'OPEN',
        targetKeyPointId: 'kp-1',
        currentLastKeyPointId: 'kp-2',
        outcome: { scoreResolution: 'RESOLVED', scoringCourtSide: 'LEFT' },
      }),
    ).toBe(false)
  })
})
