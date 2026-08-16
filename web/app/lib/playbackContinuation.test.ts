import { describe, expect, it } from 'vitest'
import { decidePlaybackContinuation, nextPlayableRangeAfter } from './playbackContinuation'

const base = {
  availabilityComplete: false,
  browserBufferedSeconds: 0,
  currentCaptureTimeUs: '9000000',
  ended: false,
  paused: false,
  playbackHasStarted: true,
  refreshLeadSeconds: 2,
  seekPreviewActive: false,
  windowEndCaptureTimeUs: '10000000',
}

describe('playback continuation policy', () => {
  it('recovers HLS instead of extending when the mapped window still has headroom', () => {
    expect(
      decidePlaybackContinuation({
        ...base,
        currentCaptureTimeUs: '1000000',
      }),
    ).toBe('recover-buffer')
  })

  it('extends only at the mapped frontier while the source can still grow', () => {
    expect(decidePlaybackContinuation(base)).toBe('extend-window')
  })

  it('stops cleanly at a completed source edge', () => {
    expect(decidePlaybackContinuation({ ...base, availabilityComplete: true, ended: true })).toBe(
      'terminal',
    )
  })

  it('does nothing while paused or while enough browser media is buffered', () => {
    expect(decidePlaybackContinuation({ ...base, paused: true })).toBe('idle')
    expect(decidePlaybackContinuation({ ...base, browserBufferedSeconds: 4 })).toBe('idle')
  })
})

describe('nextPlayableRangeAfter', () => {
  const ranges = [
    { startUs: '0', endUs: '10000000' },
    { startUs: '12500000', endUs: '20000000' },
  ]

  it('returns the first playable capture range after a real gap', () => {
    expect(nextPlayableRangeAfter('10000000', ranges)).toEqual({
      gapDurationUs: '2500000',
      targetCaptureTimeUs: '12500000',
    })
  })

  it('does not turn a contiguous range boundary into a gap', () => {
    expect(
      nextPlayableRangeAfter('10000000', [
        { startUs: '0', endUs: '10000000' },
        { startUs: '10000000', endUs: '20000000' },
      ]),
    ).toBeNull()
  })
})
