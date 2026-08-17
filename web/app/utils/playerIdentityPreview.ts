import type { CoachMatchAnalytics } from '~/lib/coachDomain'

export type IdentityPreviewTrack = CoachMatchAnalytics['tracks'][number]

export function selectPlayerPreviewTracks(
  tracks: IdentityPreviewTrack[],
  rosterEntryId: string,
  excluded?: { analysisRunId: string | null; trackId: number | null },
  limit = 2,
) {
  const seenRallies = new Set<string>()
  const current = excluded?.analysisRunId
    ? (tracks.find(
        track =>
          track.analysis_run_id === excluded.analysisRunId &&
          (excluded.trackId === null || track.track_id === excluded.trackId),
      ) ?? tracks.find(track => track.analysis_run_id === excluded.analysisRunId))
    : null
  return tracks
    .filter(
      track =>
        track.roster_entry_id === rosterEntryId &&
        (track.identity_mapping_completed || track.identity_source === 'manual') &&
        (!excluded?.analysisRunId || track.analysis_run_id !== excluded.analysisRunId) &&
        (!current ||
          track.set_number < current.set_number ||
          (track.set_number === current.set_number && track.rally_ordinal < current.rally_ordinal)),
    )
    .sort(
      (left, right) =>
        right.set_number - left.set_number ||
        right.rally_ordinal - left.rally_ordinal ||
        Number(right.last_frame_index) - Number(left.last_frame_index),
    )
    .filter(track => {
      if (seenRallies.has(track.rally_id)) return false
      seenRallies.add(track.rally_id)
      return true
    })
    .slice(0, Math.max(0, limit))
}

export function previewFrameSeconds(input: {
  firstFrameIndex: string
  lastFrameIndex: string
  fps: { num: number; den: number }
  durationUs: string
}) {
  const fps = input.fps.den > 0 ? input.fps.num / input.fps.den : 0
  const duration = Number(input.durationUs) / 1_000_000
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) return []
  const mediaEnd = Math.max(0, duration - 0.04)
  const first = Math.min(mediaEnd, Math.max(0, Number(input.firstFrameIndex) / fps))
  const last = Math.min(Math.max(first, Number(input.lastFrameIndex) / fps), mediaEnd)
  const span = Math.max(0, last - first)
  return [0.2, 0.5, 0.8]
    .map(portion => Math.min(duration - 0.04, first + span * portion))
    .filter(
      (value, index, values) =>
        value >= 0 && (index === 0 || Math.abs(value - values[index - 1]!) >= 0.04),
    )
}
