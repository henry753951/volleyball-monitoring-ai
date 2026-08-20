import type { CoachMatchAnalytics, CoachRally } from '~/lib/coachDomain'

export function coachIdentityLabel(
  name: string | null | undefined,
  jerseyNumber: string | null | undefined,
  fallback: string,
) {
  const normalizedName = name?.trim()
  const normalizedJerseyNumber = jerseyNumber?.trim()
  if (normalizedJerseyNumber && normalizedName)
    return `#${normalizedJerseyNumber} ${normalizedName}`
  if (normalizedName) return normalizedName
  if (normalizedJerseyNumber) return `#${normalizedJerseyNumber}`
  return fallback
}

export function coachRallyContactCount(rally: CoachRally) {
  return rally.submission.analysis?.contact_count ?? rally.submission.contact_count
}

export function coachRallyPathCount(rally: CoachRally) {
  return rally.submission.analysis?.ball_path_count ?? 0
}

export function coachRallyTrackCount(rally: CoachRally) {
  return rally.submission.analysis?.track_count ?? 0
}

export function coachRallyNeighbours(rallies: CoachRally[], currentRallyId: string) {
  const chronological = [...rallies].sort(
    (left, right) => left.set_number - right.set_number || left.ordinal - right.ordinal,
  )
  const index = chronological.findIndex(rally => rally.id === currentRallyId)

  return {
    previous: index > 0 ? (chronological[index - 1]?.id ?? null) : null,
    next:
      index >= 0 && index < chronological.length - 1
        ? (chronological[index + 1]?.id ?? null)
        : null,
  }
}

export function playerParticipation(analytics: CoachMatchAnalytics, rosterEntryId: string) {
  const rallies = new Map<string, CoachMatchAnalytics['tracks'][number]>()
  for (const track of analytics.tracks) {
    if (track.roster_entry_id !== rosterEntryId) continue
    rallies.set(track.rally_id, track)
  }
  return [...rallies.values()].sort(
    (left, right) => right.set_number - left.set_number || right.rally_ordinal - left.rally_ordinal,
  )
}

export function playerContactShare(analytics: CoachMatchAnalytics, rosterEntryId: string) {
  const total = analytics.players.reduce((sum, player) => sum + player.contact_count, 0)
  const player = analytics.players.find(candidate => candidate.roster_entry_id === rosterEntryId)
  return total > 0 && player ? player.contact_count / total : 0
}

export function teamTracks(analytics: CoachMatchAnalytics, teamId: string) {
  const rosterIds = new Set(
    analytics.players
      .filter(player => player.team_id === teamId)
      .map(player => player.roster_entry_id),
  )
  return analytics.tracks.filter(
    track =>
      (track.roster_entry_id !== null && rosterIds.has(track.roster_entry_id)) ||
      track.gid_team_id === teamId,
  )
}

export function teamParticipation(analytics: CoachMatchAnalytics, teamId: string) {
  if (analytics.action_events === undefined)
    return new Set(teamTracks(analytics, teamId).map(track => track.rally_id)).size
  const rosterIds = new Set(
    analytics.players
      .filter(player => player.team_id === teamId)
      .map(player => player.roster_entry_id),
  )
  const rallies = new Set(
    (analytics.action_events ?? [])
      .filter(event => event.roster_entry_id !== null && rosterIds.has(event.roster_entry_id))
      .map(event => event.rally_id),
  )
  return rallies.size
}

export function teamContactCount(analytics: CoachMatchAnalytics, teamId: string) {
  return analytics.players
    .filter(player => player.team_id === teamId)
    .reduce((sum, player) => sum + player.contact_count, 0)
}
