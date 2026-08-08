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
    })).toBe(6)
  })

  it('does not mistake finite media duration for buffered data', () => {
    expect(bufferedSecondsAhead({
      buffered: ranges([]),
      currentTime: 12,
    })).toBe(0)
  })

  it('requests continuation when no playable range is available', () => {
    expect(bufferedSecondsAhead({
      buffered: ranges([[20, 30]]),
      currentTime: 4,
    })).toBe(0)
  })

  it('requests continuation when the cursor is inside an MSE hole', () => {
    expect(bufferedSecondsAhead({
      buffered: ranges([[0, 8], [10, 24]]),
      currentTime: 9,
    })).toBe(0)
  })
})
