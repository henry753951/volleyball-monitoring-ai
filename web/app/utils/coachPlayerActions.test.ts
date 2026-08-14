import { describe, expect, it } from 'vitest'
import type { CoachMatchAnalytics, CoachRallyReplay } from '~/lib/coachDomain'
import {
  actionDisplayLabel,
  actionColor,
  actionKey,
  actionOutcomeRate,
  collectCoachActionEvents,
  replayEventUrl,
  replayStartSeconds,
} from './coachPlayerActions'

describe('coachPlayerActions', () => {
  it('translates known labels without hiding provider-specific labels', () => {
    expect(actionDisplayLabel({ label: 'spiking', confidence: 0.92 })).toBe('殺球')
    expect(actionDisplayLabel({ label: 'jump-float custom' })).toBe('jump-float custom')
    expect(actionKey('Jump Float')).toBe('jump_float')
    expect(actionColor('spiking')).not.toBe(actionColor('digging'))
  })

  it('opens replay five seconds before the event using decimal-string microseconds', () => {
    expect(replayStartSeconds('12300000')).toBe(7.3)
    expect(replayStartSeconds('2500000')).toBe(0)
    expect(replayEventUrl('match-1', { rallyId: 'rally-1', anchorTimeUs: '12300000' })).toBe('/matches/match-1/replay/rally-1?event_us=12300000')
  })

  it('collects mapped and local-track actions while keeping rally outcome semantics explicit', () => {
    const tracks = [{
      analysis_run_id: 'run-1', track_id: 8, rally_id: 'rally-1', set_number: 1, rally_ordinal: 2,
      court_side: 'left', first_frame_index: '0', last_frame_index: '120', roster_entry_id: null,
      identity_mapping_completed: false,
    }] as CoachMatchAnalytics['tracks']
    const replay = {
      rally: {
        left_team: { id: 'team-left', name: 'Left', shortName: 'L' },
        right_team: { id: 'team-right', name: 'Right', shortName: 'R' },
        outcome: { score_resolution: 'resolved', scoring_team: { id: 'team-left', name: 'Left', shortName: 'L' } },
      },
      analysis: {
        contact_events: [{
          key_point_id: 'event-1', anchor_time_us: '8500000',
          actors: [{ track_id: 8, action: { label: 'digging', confidence: 0.81 }, court_pos: { x: 1.08, y: -0.12 } }],
        }],
      },
    } as unknown as CoachRallyReplay

    const events = collectCoachActionEvents(tracks, new Map([['rally-1', replay]]))
    expect(events).toMatchObject([{
      rallyId: 'rally-1', trackId: 8, actionLabel: '接球', actionConfidence: 0.81,
      courtPosition: { x: 1.08, y: -0.12 }, outcome: 'won',
    }])
    expect(actionOutcomeRate(events)).toEqual({ won: 1, resolved: 1, unknown: 0, rate: 1 })
  })

  it('does not invent an action when the provider omitted it', () => {
    const tracks = [{
      analysis_run_id: 'run-1', track_id: 8, rally_id: 'rally-1', set_number: 1, rally_ordinal: 2,
      court_side: 'left', first_frame_index: '0', last_frame_index: '120', roster_entry_id: null,
      identity_mapping_completed: false,
    }] as CoachMatchAnalytics['tracks']
    const replay = {
      rally: { left_team: { id: 'left' }, right_team: { id: 'right' }, outcome: { score_resolution: 'unknown', scoring_team: null } },
      analysis: { contact_events: [{ key_point_id: 'event-1', anchor_time_us: '1', actors: [{ track_id: 8, action: null, court_pos: null }] }] },
    } as unknown as CoachRallyReplay
    expect(collectCoachActionEvents(tracks, new Map([['rally-1', replay]]))).toEqual([])
  })
})
