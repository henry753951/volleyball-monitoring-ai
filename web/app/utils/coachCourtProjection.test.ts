import { describe, expect, it } from 'vitest'
import { projectCanonicalCourtPoint } from './coachCourtProjection'

describe('projectCanonicalCourtPoint', () => {
  it('keeps the canonical left-to-right and upper-to-lower orientation', () => {
    expect(projectCanonicalCourtPoint({ x: 0.25, y: 0.2 }, 200, 100)).toEqual({
      x: 50,
      y: 20,
    })
  })

  it('does not clamp positions outside the court', () => {
    expect(projectCanonicalCourtPoint({ x: -0.06, y: 1.08 }, 200, 100)).toEqual({
      x: -12,
      y: 108,
    })
  })
})
