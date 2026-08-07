import { describe, expect, it } from 'vitest'
import { capturePercentBps, pointerTarget, rulerTicks, readyAt, timelineBounds } from '../lib/dvrTimeline'
describe('DVR timeline bigint positioning', () => {
  const ranges = [{ startUs: '9007199254740993', endUs: '9007199254741993', discontinuity: 0 }]
  it('maps large capture values proportionally', () => { const bounds = timelineBounds(ranges)!; expect(capturePercentBps('9007199254741243', bounds)).toBe(2500) })
  it('derives ruler ticks and pointer target in ready range', () => { const bounds = timelineBounds(ranges)!; expect(rulerTicks(bounds)).toHaveLength(9); expect(pointerTarget(25, { left: 0, width: 100 }, bounds)).toBe('9007199254741243'); expect(readyAt('9007199254741243', ranges)).toBe(true) })
})
