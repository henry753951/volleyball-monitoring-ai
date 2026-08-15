import { describe, expect, it } from 'vitest'
import { estimateFrameDurationSeconds } from './framePreviewCalibration'

describe('estimateFrameDurationSeconds', () => {
  it('calibrates single and coalesced 30 fps navigation from canonical anchors', () => {
    expect(estimateFrameDurationSeconds('566667', '600000', 1)).toBeCloseTo(1 / 30, 6)
    expect(estimateFrameDurationSeconds('566667', '966667', 12)).toBeCloseTo(1 / 30, 6)
    expect(estimateFrameDurationSeconds('966667', '566667', 12)).toBeCloseTo(1 / 30, 6)
  })

  it('rejects missing, implausible, and malformed anchor deltas', () => {
    expect(estimateFrameDurationSeconds('1000', '1000', 1)).toBeNull()
    expect(estimateFrameDurationSeconds('0', '500000', 1)).toBeNull()
    expect(estimateFrameDurationSeconds('not-a-time', '1000', 1)).toBeNull()
    expect(estimateFrameDurationSeconds('0', '33333', 0)).toBeNull()
  })
})
