import { describe, expect, it } from 'vitest'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from './playbackWindow'

const descriptor = {
  window_capture_start_us: '9007199254740000',
  window_capture_end_us: '9007199254745000',
  presentation_origin_capture_us: '9007199254740100',
}

describe('bounded playback window helpers', () => {
  it('treats both window boundaries as inclusive', () => {
    expect(isCaptureTimeWithinWindow(descriptor.window_capture_start_us, descriptor)).toBe(true)
    expect(isCaptureTimeWithinWindow(descriptor.window_capture_end_us, descriptor)).toBe(true)
  })

  it('rejects capture times outside the bounded window', () => {
    expect(isCaptureTimeWithinWindow('9007199254739999', descriptor)).toBe(false)
    expect(isCaptureTimeWithinWindow('9007199254745001', descriptor)).toBe(false)
    expect(() => captureTimeToPlayerSeconds('9007199254745001', descriptor)).toThrow(RangeError)
  })

  it('keeps large canonical values exact while converting only the local delta', () => {
    expect(captureTimeToPlayerSeconds('9007199254742100', descriptor)).toBe(0.002)
  })
})
