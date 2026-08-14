import type { CoachMatchAnalytics } from '~/lib/coachDomain'
import type { PlayerComboboxOption } from '~/types/identityAssignment'
import { formatReidGlobalId, formatReidTrackId } from '~/utils/reidIdentity'

export type IdentityTrack = CoachMatchAnalytics['tracks'][number]
export type IdentityPlayer = CoachMatchAnalytics['players'][number]

export interface IdentityStatusView {
  label: string
  tone: 'manual' | 'propagated' | 'suggested' | 'required' | 'muted'
}

export interface IdentityAssignmentModelInput {
  analytics: CoachMatchAnalytics | null
  analysisRunId: string | null
  currentFrame?: number
}

export interface TrackOptionRequest {
  teamId: string | null
  trackId: number
}

function identityStatus(track: IdentityTrack): IdentityStatusView {
  if (track.identity_source === 'manual') return { label: '人工確認', tone: 'manual' }
  if (track.identity_source === 'propagated') return { label: '沿用先前確認', tone: 'propagated' }
  if (track.roster_entry_id) return { label: '系統建議', tone: 'suggested' }
  if (track.gid_id || track.manual_required) return { label: '待指派', tone: 'required' }
  return { label: '無辨識資料', tone: 'muted' }
}

function gidLabel(track: IdentityTrack) {
  return formatReidGlobalId(track.gid_label)
}

function isEarlierTrack(candidate: IdentityTrack, current: IdentityTrack | undefined) {
  if (!current) return true
  return candidate.set_number < current.set_number
    || (candidate.set_number === current.set_number && candidate.rally_ordinal < current.rally_ordinal)
}

export function createIdentityAssignmentModel(input: IdentityAssignmentModelInput) {
  const allTracks = input.analytics?.tracks ?? []
  const tracks = allTracks.filter(track => track.analysis_run_id === input.analysisRunId)
  const activeTrackIds = new Set(tracks
    .filter(track => input.currentFrame !== undefined
      && input.currentFrame >= Number(track.first_frame_index)
      && input.currentFrame <= Number(track.last_frame_index))
    .map(track => track.track_id))
  const trackById = new Map(tracks.map(track => [track.track_id, track]))
  const players = input.analytics?.players ?? []
  const playerByRosterEntry = new Map(players.map(player => [player.roster_entry_id, player]))

  function playersForTeam(teamId: string | null) {
    return players.filter(player => !teamId || player.team_id === teamId)
  }

  function conflictFor(trackId: number, rosterEntryId: string) {
    return tracks.find(track => track.track_id !== trackId
      && activeTrackIds.has(track.track_id)
      && track.roster_entry_id === rosterEntryId) ?? null
  }

  function optionsForTrack(request: TrackOptionRequest): PlayerComboboxOption[] {
    const current = trackById.get(request.trackId) ?? tracks[0]
    const previousByRoster = new Map<string, IdentityTrack>()
    const historicalTracks = allTracks
      .filter(track => track.analysis_run_id !== input.analysisRunId && isEarlierTrack(track, current))
      .sort((left, right) => right.set_number - left.set_number || right.rally_ordinal - left.rally_ordinal)
    for (const track of historicalTracks) {
      if (track.roster_entry_id && !previousByRoster.has(track.roster_entry_id)) {
        previousByRoster.set(track.roster_entry_id, track)
      }
    }

    return [
      { value: '', label: '清除球員關聯', description: '保留辨識身分，移除姓名綁定' },
      ...playersForTeam(request.teamId).map((player) => {
        const occupiedTrack = conflictFor(request.trackId, player.roster_entry_id)
        const previousTrack = previousByRoster.get(player.roster_entry_id)
        return {
          value: player.roster_entry_id,
          label: `#${player.jersey_number} ${player.name}`,
          description: occupiedTrack
            ? `目前由 ${formatReidTrackId(occupiedTrack.track_id)} · ${gidLabel(occupiedTrack)} 使用，選擇後可取代`
            : previousTrack
              ? `最近出現在第 ${previousTrack.set_number} 局 · 回合 ${previousTrack.rally_ordinal}`
              : '尚無過往片段',
          tone: occupiedTrack ? 'occupied' as const : 'default' as const,
        }
      }),
    ]
  }

  return {
    tracks,
    activeTrackIds,
    identityReady: tracks.every(track => !track.manual_required || Boolean(track.roster_entry_id)),
    players: {
      all: players,
      byRosterEntry: (rosterEntryId: string) => playerByRosterEntry.get(rosterEntryId) ?? null,
      forTeam: playersForTeam,
    },
    track: {
      byId: (trackId: number) => trackById.get(trackId) ?? null,
      conflictFor,
      status: identityStatus,
      gidLabel,
      tidLabel: (track: IdentityTrack) => formatReidTrackId(track.track_id),
    },
    options: {
      forTrack: optionsForTrack,
    },
  }
}
