import { describe, expect, it } from 'vitest'
import { bufferedSecondsAhead, mediaTimeRangesToCaptureRanges } from './mediaBuffer'

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

describe('mediaTimeRangesToCaptureRanges', () => {
  it('maps bounded player-local ranges onto the canonical capture timeline', () => {
    expect(mediaTimeRangesToCaptureRanges(ranges([[1.25, 3.5], [8, 9.125]]), '9007199254740993')).toEqual([
      { startCaptureTimeUs: '9007199255990993', endCaptureTimeUs: '9007199258240993' },
      { startCaptureTimeUs: '9007199262740993', endCaptureTimeUs: '9007199263865993' },
    ])
  })
})
