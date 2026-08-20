import { describe, expect, it } from 'vitest'
import type { ReplayContactEvent, ReplayPath } from '~/lib/coachDomain'
import { analysisContactSemantic, analysisPathLabel } from './analysisContactPresentation'

function event(id: string, label: string): ReplayContactEvent {
  return {
    key_point_id: id,
    detection_evidence: { group_activity_label: label },
    sequence_index: 0,
    marker_kind: 'contact',
    is_terminal: false,
    anchor_frame_index: '10',
    resolved_frame_index: '10',
    anchor_time_us: '100000',
    association_state: 'resolved_single',
    ball: { state: 'observed', frame_index: '10', frame_pos: { x: 0.5, y: 0.5 } },
    quality_flags: [],
    actors: [],
    candidates: [],
    representative_court_positions: [],
  }
}

const teams = { left: 'IRI', right: 'ALG' }

describe('analysis contact presentation', () => {
  it('maps legacy left and right phases to team-aware ball types', () => {
    expect(analysisContactSemantic(event('a', 'l_set'), teams)).toEqual({
      courtSide: 'left',
      teamLabel: 'IRI',
      phase: 'set',
      typeLabel: '舉球',
    })
    expect(analysisContactSemantic(event('b', 'r_spike'), teams)?.typeLabel).toBe('攻擊')
  })

  it('labels a complete cross-net path from adjacent contacts', () => {
    const start = event('a', 'l_spike')
    const end = event('b', 'r_pass')
    const path = {
      start_key_point_id: 'a',
      end_key_point_id: 'b',
      render_state: 'complete',
    } as ReplayPath

    expect(
      analysisPathLabel(
        path,
        new Map([
          ['a', start],
          ['b', end],
        ]),
        teams,
      ),
    ).toBe('IRI → ALG 過網球路：攻擊 → 接球')
  })
})
