import { describe, expect, it } from 'vitest'
import type { CoachMatchAnalytics, CoachRally } from '~/lib/coachDomain'
import { coachRallyContactCount, playerContactShare, playerParticipation } from './coachPresentation'

const rally = {
  submission: {
    contact_count: 0,
    analysis: { contact_count: 8, ball_path_count: 7, track_count: 12 },
  },
} as CoachRally

const analytics = {
  players: [
    { roster_entry_id: 'player-a', contact_count: 6 },
    { roster_entry_id: 'player-b', contact_count: 2 },
  ],
  tracks: [
    { roster_entry_id: 'player-a', rally_id: 'rally-1', set_number: 1, rally_ordinal: 2 },
    { roster_entry_id: 'player-a', rally_id: 'rally-1', set_number: 1, rally_ordinal: 2 },
    { roster_entry_id: 'player-a', rally_id: 'rally-2', set_number: 2, rally_ordinal: 1 },
    { roster_entry_id: 'player-b', rally_id: 'rally-3', set_number: 1, rally_ordinal: 3 },
  ],
} as CoachMatchAnalytics

describe('coach presentation values', () => {
  it('uses the completed analysis count instead of stale manual contacts', () => {
    expect(coachRallyContactCount(rally)).toBe(8)
  })

  it('deduplicates player participation by rally and orders the newest first', () => {
    expect(playerParticipation(analytics, 'player-a').map(item => item.rally_id)).toEqual(['rally-2', 'rally-1'])
  })

  it('computes player share across mapped contact events', () => {
    expect(playerContactShare(analytics, 'player-a')).toBe(.75)
  })
})
