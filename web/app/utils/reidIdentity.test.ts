import { describe, expect, it } from 'vitest'
import { formatReidGlobalId, formatReidPair, formatReidTrackId } from './reidIdentity'

describe('ReID identity presentation', () => {
  it('uses clip-local TIDs and six physical slots per side', () => {
    expect(formatReidTrackId(7)).toBe('T007')
    expect(formatReidGlobalId('L1')).toBe('L1')
    expect(formatReidPair(42, 'R6')).toBe('T042  R6')
    expect(formatReidGlobalId('G009')).toBe('G---')
  })

  it('keeps an explicit placeholder when no global identity exists', () => {
    expect(formatReidGlobalId(null)).toBe('G---')
    expect(formatReidPair(3, null)).toBe('T003  G---')
  })
})
