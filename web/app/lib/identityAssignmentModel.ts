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
  trackIds?: number[]
}

export interface IdentityGidGroup {
  gidId: string
  gidLabel: string
  slotIndex: number | null
  teamId: string | null
  tracks: IdentityTrack[]
  trackIds: number[]
  representativeTrackId: number
  rosterEntryId: string | null
  assignedCount: number
  active: boolean
  confidence: number | null
  status: IdentityStatusView
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
  return (
    candidate.set_number < current.set_number ||
    (candidate.set_number === current.set_number && candidate.rally_ordinal < current.rally_ordinal)
  )
}

function parsedObservedFrameRanges(track: IdentityTrack) {
  if (!Array.isArray(track.observed_frame_ranges)) return null
  const ranges = []
  for (const range of track.observed_frame_ranges) {
    if (!range || typeof range.start !== 'string' || typeof range.end !== 'string') return null
    try {
      const start = BigInt(range.start)
      const end = BigInt(range.end)
      if (start > end) return null
      ranges.push({ start, end })
    } catch {
      return null
    }
  }
  return ranges.sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  )
}

function trackIsActive(track: IdentityTrack, frame: number | undefined) {
  if (frame === undefined) return false
  const exact = parsedObservedFrameRanges(track)
  if (exact) {
    const target = BigInt(Math.trunc(frame))
    return exact.some(range => range.start <= target && target <= range.end)
  }
  return frame >= Number(track.first_frame_index) && frame <= Number(track.last_frame_index)
}

function tracksShareObservedFrame(left: IdentityTrack, right: IdentityTrack) {
  const leftRanges = parsedObservedFrameRanges(left)
  const rightRanges = parsedObservedFrameRanges(right)
  if (!leftRanges || !rightRanges) return false
  let rightIndex = 0
  for (const leftRange of leftRanges) {
    while (rightIndex < rightRanges.length && rightRanges[rightIndex]!.end < leftRange.start)
      rightIndex += 1
    if (rightIndex >= rightRanges.length) return false
    if (rightRanges[rightIndex]!.start <= leftRange.end) return true
  }
  return false
}

export function createIdentityAssignmentModel(input: IdentityAssignmentModelInput) {
  const allTracks = input.analytics?.tracks ?? []
  const tracks = allTracks.filter(track => track.analysis_run_id === input.analysisRunId)
  const activeTrackIds = new Set(
    tracks.filter(track => trackIsActive(track, input.currentFrame)).map(track => track.track_id),
  )
  const trackById = new Map(tracks.map(track => [track.track_id, track]))
  const players = input.analytics?.players ?? []
  const playerByRosterEntry = new Map(players.map(player => [player.roster_entry_id, player]))

  const gidGroups = [
    ...tracks.reduce((groups, track) => {
      if (!track.gid_id) return groups
      const group = groups.get(track.gid_id) ?? []
      group.push(track)
      groups.set(track.gid_id, group)
      return groups
    }, new Map<string, IdentityTrack[]>()),
  ]
    .map(([gidId, groupedTracks]): IdentityGidGroup => {
      const assigned = groupedTracks.filter(track => track.roster_entry_id)
      const rosterEntryIds = [...new Set(assigned.map(track => track.roster_entry_id!))]
      const confidenceSamples = groupedTracks
        .map(track => track.identity_confidence)
        .filter((value): value is number => value != null)
      const allAssigned = assigned.length === groupedTracks.length
      const allManual =
        allAssigned && groupedTracks.every(track => track.identity_source === 'manual')
      const allPropagated =
        allAssigned && groupedTracks.every(track => track.identity_source === 'propagated')
      const status: IdentityStatusView =
        rosterEntryIds.length > 1
          ? { label: '有 Local 覆寫', tone: 'suggested' }
          : !assigned.length
            ? { label: '待指派', tone: 'required' }
            : !allAssigned
              ? { label: `已套用 ${assigned.length}/${groupedTracks.length}`, tone: 'required' }
              : allManual
                ? { label: '人工確認', tone: 'manual' }
                : allPropagated
                  ? { label: '沿用先前確認', tone: 'propagated' }
                  : { label: '已套用到全部 Local', tone: 'suggested' }
      return {
        gidId,
        gidLabel: gidLabel(groupedTracks[0]!),
        slotIndex: groupedTracks[0]!.gid_slot_index ?? null,
        teamId: groupedTracks[0]!.gid_team_id ?? null,
        tracks: groupedTracks,
        trackIds: groupedTracks.map(track => track.track_id),
        representativeTrackId: groupedTracks[0]!.track_id,
        rosterEntryId: rosterEntryIds.length === 1 ? rosterEntryIds[0]! : null,
        assignedCount: assigned.length,
        active: groupedTracks.some(track => activeTrackIds.has(track.track_id)),
        confidence: confidenceSamples.length
          ? confidenceSamples.reduce((sum, value) => sum + value, 0) / confidenceSamples.length
          : null,
        status,
      }
    })
    .sort(
      (left, right) =>
        (left.teamId ?? '').localeCompare(right.teamId ?? '') ||
        (left.slotIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.slotIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.gidLabel.localeCompare(right.gidLabel),
    )

  function playersForTeam(teamId: string | null) {
    return players.filter(player => !teamId || player.team_id === teamId)
  }

  function conflictFor(trackId: number, rosterEntryId: string) {
    return conflictForTracks([trackId], rosterEntryId)
  }

  function conflictForTracks(trackIds: number[], rosterEntryId: string) {
    const excluded = new Set(trackIds)
    const selectedTracks = tracks.filter(track => excluded.has(track.track_id))
    return (
      tracks.find(
        track =>
          !excluded.has(track.track_id) &&
          selectedTracks.some(selected => tracksShareObservedFrame(selected, track)) &&
          track.roster_entry_id === rosterEntryId,
      ) ?? null
    )
  }

  function optionsForTrack(request: TrackOptionRequest): PlayerComboboxOption[] {
    const current = trackById.get(request.trackId) ?? tracks[0]
    const memberTrackIds = request.trackIds ?? [request.trackId]
    const previousByRoster = new Map<string, IdentityTrack>()
    const historicalTracks = allTracks
      .filter(
        track => track.analysis_run_id !== input.analysisRunId && isEarlierTrack(track, current),
      )
      .sort(
        (left, right) =>
          right.set_number - left.set_number || right.rally_ordinal - left.rally_ordinal,
      )
    for (const track of historicalTracks) {
      if (track.roster_entry_id && !previousByRoster.has(track.roster_entry_id)) {
        previousByRoster.set(track.roster_entry_id, track)
      }
    }

    return [
      { value: '', label: '清除球員指派', description: '此片段改為待人工確認' },
      ...playersForTeam(request.teamId).map(player => {
        const occupiedTrack = conflictForTracks(memberTrackIds, player.roster_entry_id)
        const previousTrack = previousByRoster.get(player.roster_entry_id)
        return {
          value: player.roster_entry_id,
          label: `#${player.jersey_number} ${player.name}`,
          description: occupiedTrack
            ? `目前由 ${formatReidTrackId(occupiedTrack.track_id)} · ${gidLabel(occupiedTrack)} 使用，選擇後可取代`
            : previousTrack
              ? `最近出現在第 ${previousTrack.set_number} 局 · 回合 ${previousTrack.rally_ordinal}`
              : '尚無過往片段',
          tone: occupiedTrack ? ('occupied' as const) : ('default' as const),
        }
      }),
    ]
  }

  return {
    tracks,
    gidGroups,
    ungroupedTrackCount: tracks.filter(track => !track.gid_id).length,
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
      conflictForTracks,
      status: identityStatus,
      gidLabel,
      tidLabel: (track: IdentityTrack) => formatReidTrackId(track.track_id),
    },
    options: {
      forTrack: optionsForTrack,
    },
  }
}
