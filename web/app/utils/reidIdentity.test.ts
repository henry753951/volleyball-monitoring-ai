import { describe, expect, it } from 'vitest'
import { formatReidGlobalId, formatReidPair, formatReidTrackId } from './reidIdentity'

describe('ReID identity presentation', () => {
  it('uses the volley-reid Txxx and Gxxx format', () => {
    expect(formatReidTrackId(7)).toBe('T007')
    expect(formatReidGlobalId('G1')).toBe('G001')
    expect(formatReidPair(42, 'G009')).toBe('T042  G009')
  })

  it('keeps an explicit placeholder when no global identity exists', () => {
    expect(formatReidGlobalId(null)).toBe('G---')
    expect(formatReidPair(3, null)).toBe('T003  G---')
  })
})
