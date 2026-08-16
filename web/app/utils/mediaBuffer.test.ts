import { describe, expect, it } from 'vitest'
import {
  bufferedSecondsAhead,
  mediaTimeRangesToCaptureRanges,
  mediaTimeRangeContains,
  playbackWindowSecondsAhead,
} from './mediaBuffer'

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: index => values[index]?.[0] ?? 0,
    end: index => values[index]?.[1] ?? 0,
  }
}

describe('bufferedSecondsAhead', () => {
  it('uses the active MSE range instead of presentation duration', () => {
    expect(
      bufferedSecondsAhead({
        buffered: ranges([
          [0, 8],
          [10, 24],
        ]),
        currentTime: 18,
      }),
    ).toBe(6)
  })

  it('returns zero before data arrives or while the cursor is in a hole', () => {
    expect(bufferedSecondsAhead({ buffered: ranges([]), currentTime: 12 })).toBe(0)
    expect(
      bufferedSecondsAhead({
        buffered: ranges([
          [0, 8],
          [10, 24],
        ]),
        currentTime: 9,
      }),
    ).toBe(0)
  })
})

describe('mediaTimeRangeContains', () => {
  it('accepts only media time that the browser actually holds', () => {
    const buffered = ranges([
      [0, 8],
      [10, 24],
    ])
    expect(mediaTimeRangeContains(buffered, 7.5)).toBe(true)
    expect(mediaTimeRangeContains(buffered, 9)).toBe(false)
    expect(mediaTimeRangeContains(buffered, 18)).toBe(true)
  })

  it('allows only a sub-frame rounding tolerance at a range edge', () => {
    const buffered = ranges([[10, 20]])
    expect(mediaTimeRangeContains(buffered, 9.9995)).toBe(true)
    expect(mediaTimeRangeContains(buffered, 9.9)).toBe(false)
  })
})

describe('playbackWindowSecondsAhead', () => {
  it('uses canonical window bounds instead of transient MSE buffer ranges', () => {
    expect(
      playbackWindowSecondsAhead({
        currentTimeSeconds: 18,
        presentationOriginCaptureUs: '9007199254740993',
        windowCaptureEndUs: '9007199300740993',
      }),
    ).toBe(28)
  })

  it('returns zero at and beyond the bounded playback window', () => {
    expect(
      playbackWindowSecondsAhead({
        currentTimeSeconds: 46,
        presentationOriginCaptureUs: '9007199254740993',
        windowCaptureEndUs: '9007199300740993',
      }),
    ).toBe(0)
    expect(
      playbackWindowSecondsAhead({
        currentTimeSeconds: 47,
        presentationOriginCaptureUs: '9007199254740993',
        windowCaptureEndUs: '9007199300740993',
      }),
    ).toBe(0)
  })
})

describe('mediaTimeRangesToCaptureRanges', () => {
  it('maps bounded player-local ranges onto the canonical capture timeline', () => {
    expect(
      mediaTimeRangesToCaptureRanges(
        ranges([
          [1.25, 3.5],
          [8, 9.125],
        ]),
        '9007199254740993',
      ),
    ).toEqual([
      { startCaptureTimeUs: '9007199255990993', endCaptureTimeUs: '9007199258240993' },
      { startCaptureTimeUs: '9007199262740993', endCaptureTimeUs: '9007199263865993' },
    ])
  })
})
