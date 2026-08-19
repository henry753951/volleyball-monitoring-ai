import { describe, expect, it } from 'vitest'
import type { CoachRally } from '~/lib/coachDomain'
import { deriveCoachDisplayOrdinals } from './rallyDisplayOrder'

function rally(id: string, setNumber: number, start: string): CoachRally {
  return {
    id,
    display_set_number: setNumber,
    submission: {
      boundaries: [{ kind: 'start', capture_time_us: start }],
      key_points: [],
    },
  } as unknown as CoachRally
}

describe('deriveCoachDisplayOrdinals', () => {
  it('continues rally numbering when two raw sets are projected into one visible set', () => {
    const result = deriveCoachDisplayOrdinals(
      [],
      [rally('raw-set-1-rally', 1, '100'), rally('raw-set-2-rally', 2, '200')],
      rawSetNumber => (rawSetNumber === 2 ? 1 : rawSetNumber),
    )

    expect(result.get('raw-set-1-rally')).toBe(1)
    expect(result.get('raw-set-2-rally')).toBe(2)
  })
})
