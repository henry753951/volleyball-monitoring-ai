import { describe, expect, it } from 'vitest'
import { resolveVideoContentRect } from './volleyballOverlayRenderer'

describe('resolveVideoContentRect', () => {
  it('centres a 16:9 video horizontally in a wider player', () => {
    const rect = resolveVideoContentRect({ x: 0, y: 0, width: 1200, height: 500 }, 1920, 1080)
    expect(rect.x).toBeCloseTo(155.556, 3)
    expect(rect.y).toBe(0)
    expect(rect.width).toBeCloseTo(888.889, 3)
    expect(rect.height).toBe(500)
  })

  it('centres a 16:9 video vertically in a square player', () => {
    expect(resolveVideoContentRect({ x: 0, y: 0, width: 800, height: 800 }, 1920, 1080)).toEqual({
      x: 0,
      y: 175,
      width: 800,
      height: 450,
    })
  })

  it('uses the full player until intrinsic video dimensions are known', () => {
    expect(resolveVideoContentRect({ x: 0, y: 0, width: 800, height: 450 }, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 450,
    })
  })
})
