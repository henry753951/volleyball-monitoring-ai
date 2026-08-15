import { describe, expect, it } from 'vitest'
import { formatReidGlobalId, formatReidPair, formatReidTrackId } from './reidIdentity'

describe('ReID identity presentation', () => {
  it('uses clip-local TIDs and six physical slots per side', () => {
    expect(formatReidTrackId(7)).toBe('T007')
    expect(formatReidGlobalId('L1')).toBe('舊關聯 L1')
    expect(formatReidPair(42, 'R6')).toBe('T042  舊關聯 R6')
    expect(formatReidGlobalId('G009')).toBe('群組 G009')
  })

  it('keeps an explicit placeholder when no global identity exists', () => {
    expect(formatReidGlobalId(null)).toBe('群組未定')
    expect(formatReidPair(3, null)).toBe('T003  群組未定')
  })
})
