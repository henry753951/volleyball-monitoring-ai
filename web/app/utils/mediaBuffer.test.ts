import { describe, expect, it } from 'vitest'
import { bufferedSecondsAhead } from './mediaBuffer'

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: index => values[index]?.[0] ?? 0,
    end: index => values[index]?.[1] ?? 0,
  }
}

describe('bufferedSecondsAhead', () => {
  it('uses the active MSE range when a live playlist has infinite duration', () => {
    expect(bufferedSecondsAhead({
      buffered: ranges([[0, 8], [10, 24]]),
      currentTime: 18,
      duration: Number.POSITIVE_INFINITY,
    })).toBe(6)
  })

  it('falls back to finite media duration before the first buffered range arrives', () => {
    expect(bufferedSecondsAhead({
      buffered: ranges([]),
      currentTime: 12,
      duration: 20,
    })).toBe(8)
  })

  it('requests continuation when no playable range is available', () => {
    expect(bufferedSecondsAhead({
      buffered: ranges([[20, 30]]),
      currentTime: 4,
      duration: Number.POSITIVE_INFINITY,
    })).toBe(0)
  })
})
