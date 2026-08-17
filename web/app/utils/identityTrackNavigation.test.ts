import { describe, expect, it } from 'vitest'
import { captureTimeForIdentityTrackFrame } from './identityTrackNavigation'

describe('captureTimeForIdentityTrackFrame', () => {
  it('maps a track frame to the rally clip capture time', () => {
    expect(
      captureTimeForIdentityTrackFrame({
        clipStartCaptureTimeUs: '1000000',
        frameIndex: '25',
        fps: { num: 25, den: 1 },
      }),
    ).toBe('2000000')
  })

  it('rejects malformed or non-positive timing inputs', () => {
    expect(
      captureTimeForIdentityTrackFrame({
        clipStartCaptureTimeUs: '1000000',
        frameIndex: '-1',
        fps: { num: 25, den: 1 },
      }),
    ).toBeNull()
    expect(
      captureTimeForIdentityTrackFrame({
        clipStartCaptureTimeUs: 'not-a-time',
        frameIndex: '25',
        fps: { num: 25, den: 1 },
      }),
    ).toBeNull()
    expect(
      captureTimeForIdentityTrackFrame({
        clipStartCaptureTimeUs: '1000000',
        frameIndex: '25',
        fps: { num: 0, den: 1 },
      }),
    ).toBeNull()
  })
})
