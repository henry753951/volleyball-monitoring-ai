import { describe, expect, it } from 'vitest'
import {
  continuousBallTrailLinks,
  COURT_LINE_PATHS,
  overlayTrackIdentityLabel,
} from './volleyballOverlayRenderer'

describe('Court60 overlay topology', () => {
  it('uses the provider edge order instead of the retired Court36 paths', () => {
    expect(COURT_LINE_PATHS).toHaveLength(13)
    expect(COURT_LINE_PATHS[0]).toEqual([0, 10, 11, 12, 13, 14, 1])
    expect(COURT_LINE_PATHS[9]).toEqual([9, 55, 56, 57, 58, 59, 0])
    expect(COURT_LINE_PATHS.slice(-3)).toEqual([
      [1, 8],
      [2, 7],
      [3, 6],
    ])
  })
})

describe('continuousBallTrailLinks', () => {
  it('keeps short consecutive ball movement', () => {
    const links = continuousBallTrailLinks(
      [
        { frame: 10, point: { x: 100, y: 100 } },
        { frame: 11, point: { x: 118, y: 107 } },
        { frame: 12, point: { x: 138, y: 116 } },
      ],
      { width: 1000, height: 500 },
    )
    expect(links).toHaveLength(2)
  })

  it('does not draw chords across missing frames or implausible detector jumps', () => {
    const links = continuousBallTrailLinks(
      [
        { frame: 10, point: { x: 100, y: 100 } },
        { frame: 11, point: { x: 900, y: 400 } },
        { frame: 15, point: { x: 130, y: 110 } },
      ],
      { width: 1000, height: 500 },
    )
    expect(links).toEqual([])
  })
})

describe('overlayTrackIdentityLabel', () => {
  it('prefers a jersey number and only falls back to GID or Local TID', () => {
    expect(overlayTrackIdentityLabel(12, '9b17a6e9', '15')).toBe('#15')
    expect(overlayTrackIdentityLabel(12, '9b17a6e9')).toBe('GID 9B17A6E9')
    expect(overlayTrackIdentityLabel(12, null, null)).toBe('T012')
  })
})
