import type { CoachMatchAnalytics, CoachRally } from '~/lib/coachDomain'

export function coachRallyContactCount(rally: CoachRally) {
  return rally.submission.analysis?.contact_count ?? rally.submission.contact_count
}

export function coachRallyPathCount(rally: CoachRally) {
  return rally.submission.analysis?.ball_path_count ?? 0
}

export function coachRallyTrackCount(rally: CoachRally) {
  return rally.submission.analysis?.track_count ?? 0
}

export function playerParticipation(analytics: CoachMatchAnalytics, rosterEntryId: string) {
  const rallies = new Map<string, CoachMatchAnalytics['tracks'][number]>()
  for (const track of analytics.tracks) {
    if (track.roster_entry_id !== rosterEntryId) continue
    rallies.set(track.rally_id, track)
  }
  return [...rallies.values()].sort((left, right) =>
    right.set_number - left.set_number
    || right.rally_ordinal - left.rally_ordinal,
  )
}

export function playerContactShare(analytics: CoachMatchAnalytics, rosterEntryId: string) {
  const total = analytics.players.reduce((sum, player) => sum + player.contact_count, 0)
  const player = analytics.players.find(candidate => candidate.roster_entry_id === rosterEntryId)
  return total > 0 && player ? player.contact_count / total : 0
}
