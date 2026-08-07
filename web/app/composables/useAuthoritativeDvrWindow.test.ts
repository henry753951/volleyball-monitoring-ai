import { describe, expect, it } from 'vitest'
import { boundedPlayerSeconds, frameCommandEnabled, frameRecovery } from './useAuthoritativeDvrWindow'

describe('authoritative DVR recovery classification', () => {
  it.each([
    ['WINDOW_BOUNDARY', 'recenter'],
    ['WINDOW_EXPIRED', 'refresh'],
    ['MAPPING_STALE', 'refresh'],
    ['SAMPLE_NOT_FOUND', 'blocked'],
    ['CAPTURE_GAP', 'blocked'],
    ['UNKNOWN', 'error'],
  ])('%s remains typed and non-optimistic', (code, expected) => {
    expect(frameRecovery(code)).toBe(expected)
  })
})
it('uses player-local microseconds directly', () => expect(boundedPlayerSeconds('2000000')).toBe(2))
it('rejects unbounded local frame time', () => expect(() => boundedPlayerSeconds('-1')).toThrow(RangeError))
it.each([
  [{ descriptor: true, anchor: true, cursorReady: true, busy: false, recovering: false }, true],
  [{ descriptor: false, anchor: true, cursorReady: true, busy: false, recovering: false }, false],
  [{ descriptor: true, anchor: true, cursorReady: true, busy: true, recovering: false }, false],
  [{ descriptor: true, anchor: true, cursorReady: true, busy: false, recovering: true }, false],
])('gates frame commands by authoritative ready state', (input, expected) => expect(frameCommandEnabled(input)).toBe(expected))
