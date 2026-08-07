import { describe, expect, it } from 'vitest'
import { availableBounds, canSeekCaptureTime, findAvailableRange, isCaptureGap } from './mediaTimeline'
const ranges = [{ startUs: '9007199254740993', endUs: '9007199254741993', discontinuity: 0 }, { startUs: '9007199254742993', endUs: '9007199254743993', discontinuity: 1 }]
describe('timeline gaps', () => {
  it('finds ranges without Number coercion', () => { expect(findAvailableRange('9007199254740993', ranges)?.discontinuity).toBe(0); expect(isCaptureGap('9007199254742493', ranges)).toBe(true); expect(canSeekCaptureTime('9007199254742993', ranges)).toBe(true) })
  it('returns exact bounds', () => { expect(availableBounds(ranges)).toEqual({ startUs: '9007199254740993', endUs: '9007199254743993' }) })
})
