import { describe, expect, it } from 'vitest'
import { deriveSetDisplayProjection } from './setDisplayProjection'

describe('deriveSetDisplayProjection', () => {
  it('merges a following raw set after its winner is cleared', () => {
    const projection = deriveSetDisplayProjection([
      { id: 'set-1', set_number: 1, status: 'FINISHED', winning_team_id: null },
      { id: 'set-2', set_number: 2, status: 'LIVE', winning_team_id: null },
    ])

    expect(projection.rawToEffective.get(1)).toBe(1)
    expect(projection.rawToEffective.get(2)).toBe(1)
    expect(projection.winnerByEffective.size).toBe(0)
  })

  it('keeps later winner boundaries while collapsing the cleared one', () => {
    const projection = deriveSetDisplayProjection([
      { id: 'set-1', set_number: 1, status: 'FINISHED', winning_team_id: null },
      { id: 'set-2', set_number: 2, status: 'FINISHED', winning_team_id: 'team-a' },
      { id: 'set-3', set_number: 3, status: 'LIVE', winning_team_id: null },
    ])

    expect(projection.rawToEffective.get(1)).toBe(1)
    expect(projection.rawToEffective.get(2)).toBe(1)
    expect(projection.rawToEffective.get(3)).toBe(2)
    expect(projection.winnerByEffective.get(1)).toEqual({
      setId: 'set-2',
      teamId: 'team-a',
    })
  })
})
