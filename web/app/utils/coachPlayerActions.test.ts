import { describe, expect, it } from 'vitest'
import type { CoachMatchAnalytics, CoachRallyReplay } from '~/lib/coachDomain'
import {
  actionDisplayLabel,
  actionColor,
  actionKey,
  actionOutcomeRate,
  coachBallType,
  collectCoachActionEvents,
  replayEventUrl,
  replayStartSeconds,
} from './coachPlayerActions'

describe('coachPlayerActions', () => {
  it('translates known labels without hiding provider-specific labels', () => {
    expect(actionDisplayLabel({ label: 'spiking', confidence: 0.92 })).toBe('殺球')
    expect(actionDisplayLabel({ label: 'standing' })).toBe('站立')
    expect(actionDisplayLabel({ label: 'jump-float custom' })).toBe('jump-float custom')
    expect(actionKey('Jump Float')).toBe('jump_float')
    expect(actionColor('spiking')).not.toBe(actionColor('digging'))
  })

  it('opens replay three seconds before the event using decimal-string microseconds', () => {
    expect(replayStartSeconds('12300000')).toBe(9.3)
    expect(replayStartSeconds('2500000')).toBe(0)
    expect(replayEventUrl('match-1', { rallyId: 'rally-1', anchorTimeUs: '12300000' })).toBe(
      '/matches/match-1/replay/rally-1?event_us=12300000',
    )
  })

  it('groups coach ball types into the four human-facing categories', () => {
    const events = [
      { key_point_id: 'serve', ball_event: { ordinal: 1, kind: 'serve' } },
      { key_point_id: 'receive', ball_event: { ordinal: 2, kind: 'receive' } },
      { key_point_id: 'spike', ball_event: { ordinal: 3, kind: 'spike' } },
      { key_point_id: 'contact', ball_event: { ordinal: 4, kind: 'contact' } },
    ] as unknown as NonNullable<CoachRallyReplay['analysis']>['contact_events']

    expect(coachBallType(events, events[0]!)).toEqual({ key: 'serve', label: '發球' })
    expect(coachBallType(events, events[1]!)).toEqual({
      key: 'serve_receive',
      label: '接發',
    })
    expect(coachBallType(events, events[2]!)).toEqual({ key: 'spike', label: '殺球' })
    expect(coachBallType(events, events[3]!)).toEqual({ key: 'hit', label: 'HIT' })
  })

  it('collects human ball events and uses their explicit result and landing position', () => {
    const tracks = [
      {
        analysis_run_id: 'run-1',
        track_id: 8,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 2,
        court_side: 'left',
        first_frame_index: '0',
        last_frame_index: '120',
        roster_entry_id: null,
        identity_mapping_completed: false,
      },
    ] as CoachMatchAnalytics['tracks']
    const replay = {
      rally: {
        left_team: { id: 'team-left', name: 'Left', shortName: 'L' },
        right_team: { id: 'team-right', name: 'Right', shortName: 'R' },
        outcome: {
          score_resolution: 'resolved',
          scoring_team: { id: 'team-left', name: 'Left', shortName: 'L' },
        },
      },
      analysis: {
        contact_events: [
          {
            key_point_id: 'event-1',
            anchor_time_us: '8500000',
            ball_event: {
              ordinal: 2,
              kind: 'receive',
              result: 'success',
              semantic_source: 'human',
              actor: {
                roster_entry_id: 'roster-8',
                jersey_number: '8',
                name: 'Player 8',
                track_id: 8,
              },
            },
            actors: [
              {
                track_id: 8,
                action: { label: 'digging', confidence: 0.81 },
                court_pos: { x: 1.08, y: -0.12 },
              },
            ],
          },
        ],
        paths: [
          {
            start_key_point_id: 'event-1',
            start_court_positions: [
              {
                track_id: 8,
                basis: 'player_footprint_proxy',
                court_pos: { x: 1.08, y: -0.12 },
                confidence: 0.81,
              },
            ],
            end_court_positions: [
              {
                track_id: null,
                basis: 'ball_landing',
                court_pos: { x: 0.4, y: 0.7 },
                confidence: 0.8,
              },
            ],
          },
        ],
      },
    } as unknown as CoachRallyReplay

    const events = collectCoachActionEvents(tracks, new Map([['rally-1', replay]]))
    expect(events).toMatchObject([
      {
        rallyId: 'rally-1',
        trackId: 8,
        actionLabel: 'HIT',
        actionConfidence: null,
        resultKey: 'success',
        routeStart: { x: 1.08, y: -0.12 },
        routeEnd: { x: 0.4, y: 0.7 },
        courtSide: 'left',
        outcome: 'won',
      },
    ])
    expect(actionOutcomeRate(events)).toEqual({ won: 1, resolved: 1, unknown: 0, rate: 1 })
  })

  it('does not invent an action when the provider omitted it', () => {
    const tracks = [
      {
        analysis_run_id: 'run-1',
        track_id: 8,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 2,
        court_side: 'left',
        first_frame_index: '0',
        last_frame_index: '120',
        roster_entry_id: null,
        identity_mapping_completed: false,
      },
    ] as CoachMatchAnalytics['tracks']
    const replay = {
      rally: {
        left_team: { id: 'left' },
        right_team: { id: 'right' },
        outcome: { score_resolution: 'unknown', scoring_team: null },
      },
      analysis: {
        contact_events: [
          {
            key_point_id: 'event-1',
            anchor_time_us: '1',
            actors: [{ track_id: 8, action: null, court_pos: null }],
          },
        ],
      },
    } as unknown as CoachRallyReplay
    expect(collectCoachActionEvents(tracks, new Map([['rally-1', replay]]))).toEqual([])
  })

  it('shows a manually marked player contact even without provider ball semantics', () => {
    const tracks = [
      {
        analysis_run_id: 'run-1',
        track_id: 8,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 2,
        court_side: 'left',
        first_frame_index: '0',
        last_frame_index: '120',
        roster_entry_id: null,
        identity_mapping_completed: false,
      },
    ] as CoachMatchAnalytics['tracks']
    const replay = {
      rally: {
        left_team: { id: 'left' },
        right_team: { id: 'right' },
        outcome: { score_resolution: 'unknown', scoring_team: null },
      },
      analysis: {
        contact_events: [
          {
            key_point_id: 'event-1',
            anchor_time_us: '8500000',
            anchor_origin: 'review_manual',
            quality_flags: ['manual_review_contact'],
            ball_event: null,
            actors: [{ track_id: 8, action: null, court_pos: { x: 0.2, y: 0.3 } }],
          },
        ],
        paths: [],
      },
    } as unknown as CoachRallyReplay

    expect(collectCoachActionEvents(tracks, new Map([['rally-1', replay]]))).toMatchObject([
      {
        rallyId: 'rally-1',
        trackId: 8,
        actionKey: 'hit',
        actionLabel: 'HIT',
        resultKey: null,
        routeStart: { x: 0.2, y: 0.3 },
        outcome: 'unknown',
      },
    ])
  })

  it('keeps a missing per-ball result unknown instead of borrowing the rally winner', () => {
    const tracks = [
      {
        analysis_run_id: 'run-1',
        track_id: 8,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 2,
        court_side: 'left',
        first_frame_index: '0',
        last_frame_index: '120',
        roster_entry_id: null,
        identity_mapping_completed: false,
      },
    ] as CoachMatchAnalytics['tracks']
    const replay = {
      rally: {
        left_team: { id: 'team-left' },
        right_team: { id: 'team-right' },
        outcome: {
          score_resolution: 'resolved',
          scoring_team: { id: 'team-left' },
        },
      },
      analysis: {
        contact_events: [
          {
            key_point_id: 'event-1',
            anchor_time_us: '1',
            ball_event: {
              ordinal: 1,
              kind: 'spike',
              result: null,
              semantic_source: 'human',
              actor: { roster_entry_id: 'roster-8', jersey_number: '8', name: 'P8', track_id: 8 },
            },
            actors: [{ track_id: 8, action: null, court_pos: { x: 0.2, y: 0.3 } }],
          },
        ],
        paths: [],
      },
    } as unknown as CoachRallyReplay

    const events = collectCoachActionEvents(tracks, new Map([['rally-1', replay]]))
    expect(events[0]?.outcome).toBe('unknown')
    expect(actionOutcomeRate(events)).toEqual({ won: 0, resolved: 0, unknown: 1, rate: null })
  })
})
