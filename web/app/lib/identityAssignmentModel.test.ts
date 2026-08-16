import { describe, expect, it } from 'vitest'
import type { CoachMatchAnalytics } from '~/lib/coachDomain'
import { createIdentityAssignmentModel } from './identityAssignmentModel'

function track(
  trackId: number,
  rosterEntryId: string | null,
  observedFrameRanges: Array<{ start: string; end: string }>,
) {
  return {
    analysis_run_id: 'run-1',
    track_id: trackId,
    rally_id: `rally-${trackId}`,
    set_number: 1,
    rally_ordinal: trackId,
    court_side: 'left',
    first_frame_index: '0',
    last_frame_index: '100',
    observed_frame_ranges: observedFrameRanges,
    roster_entry_id: rosterEntryId,
    identity_mapping_completed: false,
    gid_id: null,
    gid_team_id: null,
    gid_slot_index: null,
    gid_label: null,
    identity_source: rosterEntryId ? 'manual' : null,
    identity_confidence: null,
    identity_revision: null,
    manual_required: false,
    identity_preview_url: null,
    reid_model: null,
  }
}

function modelWithTracks(...tracks: ReturnType<typeof track>[]) {
  return createIdentityAssignmentModel({
    analytics: {
      tracks,
      players: [],
    } as unknown as CoachMatchAnalytics,
    analysisRunId: 'run-1',
    currentFrame: 10,
  })
}

describe('identity assignment model', () => {
  it('does not report a conflict for two local ids that never coexist in a frame', () => {
    const model = modelWithTracks(
      track(1, null, [{ start: '0', end: '10' }]),
      track(2, 'roster-1', [{ start: '11', end: '100' }]),
    )

    expect(model.track.conflictFor(1, 'roster-1')).toBeNull()
  })

  it('reports a conflict when both local ids are present in the same frame', () => {
    const model = modelWithTracks(
      track(1, null, [{ start: '0', end: '10' }]),
      track(2, 'roster-1', [{ start: '10', end: '100' }]),
    )

    expect(model.track.conflictFor(1, 'roster-1')?.track_id).toBe(2)
  })
})
