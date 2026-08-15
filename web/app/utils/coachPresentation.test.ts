import { describe, expect, it } from 'vitest'
import type { CoachMatchAnalytics, CoachRally } from '~/lib/coachDomain'
import {
  coachRallyContactCount,
  playerContactShare,
  playerParticipation,
  teamContactCount,
  teamParticipation,
  teamTracks,
} from './coachPresentation'

const rally = {
  submission: {
    contact_count: 0,
    analysis: { contact_count: 8, ball_path_count: 7, track_count: 12 },
  },
} as CoachRally

const analytics = {
  players: [
    { roster_entry_id: 'player-a', team_id: 'team-a', contact_count: 6 },
    { roster_entry_id: 'player-b', team_id: 'team-b', contact_count: 2 },
  ],
  tracks: [
    {
      roster_entry_id: 'player-a',
      gid_team_id: null,
      rally_id: 'rally-1',
      set_number: 1,
      rally_ordinal: 2,
    },
    {
      roster_entry_id: 'player-a',
      gid_team_id: null,
      rally_id: 'rally-1',
      set_number: 1,
      rally_ordinal: 2,
    },
    {
      roster_entry_id: 'player-a',
      gid_team_id: null,
      rally_id: 'rally-2',
      set_number: 2,
      rally_ordinal: 1,
    },
    {
      roster_entry_id: 'player-b',
      gid_team_id: null,
      rally_id: 'rally-3',
      set_number: 1,
      rally_ordinal: 3,
    },
    {
      roster_entry_id: null,
      gid_team_id: 'team-a',
      rally_id: 'rally-4',
      set_number: 2,
      rally_ordinal: 3,
    },
  ],
} as CoachMatchAnalytics

describe('coach presentation values', () => {
  it('uses the completed analysis count instead of stale manual contacts', () => {
    expect(coachRallyContactCount(rally)).toBe(8)
  })

  it('deduplicates player participation by rally and orders the newest first', () => {
    expect(playerParticipation(analytics, 'player-a').map(item => item.rally_id)).toEqual([
      'rally-2',
      'rally-1',
    ])
  })

  it('computes player share across mapped contact events', () => {
    expect(playerContactShare(analytics, 'player-a')).toBe(0.75)
  })

  it('includes roster and anonymous global identities in a team view', () => {
    expect(teamTracks(analytics, 'team-a')).toHaveLength(4)
    expect(teamParticipation(analytics, 'team-a')).toBe(3)
    expect(teamContactCount(analytics, 'team-a')).toBe(6)
  })
})
