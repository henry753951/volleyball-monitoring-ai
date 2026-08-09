import { describe, expect, it } from 'vitest'
import { resolveFrameFromRate, resolveFrameFromTimeline } from './overlayFrameTimeline'

describe('overlay frame timeline', () => {
  const frameTimes = ['1000000', '1016683', '1033367', '1050050']

  it('selects the exact PTS-backed frame instead of flooring it to the previous frame', () => {
    expect(resolveFrameFromTimeline('1016683', frameTimes, '1066733')).toBe(1)
    expect(resolveFrameFromTimeline('1033367', frameTimes, '1066733')).toBe(2)
  })

  it('tolerates only microsecond conversion noise at a frame boundary', () => {
    expect(resolveFrameFromTimeline('1016682', frameTimes, '1066733')).toBe(1)
    expect(resolveFrameFromTimeline('1016670', frameTimes, '1066733')).toBe(0)
  })

  it('does not display an overlay outside the canonical clip', () => {
    expect(resolveFrameFromTimeline('999990', frameTimes, '1066733')).toBe(-1)
    expect(resolveFrameFromTimeline('1066733', frameTimes, '1066733')).toBe(-1)
  })

  it('rounds the legacy CFR fallback so 60000/1001 does not lag by one frame', () => {
    expect(resolveFrameFromRate('16683', { num: 60_000, den: 1_001 }, '100')).toBe(1)
    expect(resolveFrameFromRate('33367', { num: 60_000, den: 1_001 }, '100')).toBe(2)
  })
})
