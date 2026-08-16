import { describe, expect, it } from 'vitest'
import {
  formatReidGlobalId,
  formatReidGroupCode,
  formatReidPair,
  formatReidTrackId,
} from './reidIdentity'

describe('ReID identity presentation', () => {
  it('uses clip-local TIDs and six physical slots per side', () => {
    expect(formatReidTrackId(7)).toBe('T007')
    expect(formatReidGlobalId('L1')).toBe('群組未定')
    expect(formatReidPair(42, 'R6')).toBe('T042  群組未定')
    expect(formatReidGlobalId('G009')).toBe('群組 G009')
  })

  it('keeps an explicit placeholder when no global identity exists', () => {
    expect(formatReidGlobalId(null)).toBe('群組未定')
    expect(formatReidPair(3, null)).toBe('T003  群組未定')
  })

  it('uses a stable short GID code instead of a roster name', () => {
    expect(formatReidGroupCode('2d9a44cc-21f2-4c02-a172-c4ca8aa00001')).toBe('GID 2D9A44CC')
    expect(formatReidGroupCode(null)).toBe('未分群')
  })
})
