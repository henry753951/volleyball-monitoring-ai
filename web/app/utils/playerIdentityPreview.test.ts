import { describe, expect, it } from 'vitest'
import { previewFrameSeconds, selectPlayerPreviewTracks } from './playerIdentityPreview'

const track = (overrides: Record<string, unknown>) =>
  ({
    analysis_run_id: 'run-current',
    track_id: 1,
    rally_id: 'rally-current',
    set_number: 1,
    rally_ordinal: 3,
    court_side: 'left',
    first_frame_index: '0',
    last_frame_index: '90',
    roster_entry_id: 'roster-1',
    identity_mapping_completed: true,
    ...overrides,
  }) as never

describe('player identity preview', () => {
  it('selects the latest distinct clips and excludes the current analysis run', () => {
    const selected = selectPlayerPreviewTracks(
      [
        track({}),
        track({ track_id: 15, roster_entry_id: 'roster-1' }),
        track({ analysis_run_id: 'run-2', track_id: 8, rally_id: 'rally-2', rally_ordinal: 2 }),
        track({ analysis_run_id: 'run-2', track_id: 9, rally_id: 'rally-2', rally_ordinal: 2 }),
        track({ analysis_run_id: 'run-1', track_id: 4, rally_id: 'rally-1', rally_ordinal: 1 }),
        track({
          analysis_run_id: 'run-future',
          track_id: 7,
          rally_id: 'rally-future',
          rally_ordinal: 4,
        }),
        track({
          analysis_run_id: 'other',
          track_id: 3,
          rally_id: 'other',
          roster_entry_id: 'roster-2',
        }),
      ],
      'roster-1',
      { analysisRunId: 'run-current', trackId: 1 },
    )
    expect(selected.map(item => item.rally_id)).toEqual(['rally-2', 'rally-1'])
  })

  it('does not present an unconfirmed automatic assignment as prior identity evidence', () => {
    const selected = selectPlayerPreviewTracks(
      [
        track({
          analysis_run_id: 'run-confirmed',
          rally_id: 'rally-confirmed',
          rally_ordinal: 1,
        }),
        track({
          analysis_run_id: 'run-pending',
          rally_id: 'rally-pending',
          rally_ordinal: 2,
          identity_mapping_completed: false,
          identity_source: 'ai',
        }),
      ],
      'roster-1',
      { analysisRunId: 'run-current', trackId: 1 },
    )

    expect(selected.map(item => item.rally_id)).toEqual(['rally-confirmed'])
  })

  it('keeps a manually confirmed track usable before its whole run is mapped', () => {
    const selected = selectPlayerPreviewTracks(
      [
        track({
          analysis_run_id: 'run-manual',
          rally_id: 'rally-manual',
          rally_ordinal: 1,
          identity_mapping_completed: false,
          identity_source: 'manual',
        }),
      ],
      'roster-1',
      { analysisRunId: 'run-current', trackId: 1 },
    )

    expect(selected.map(item => item.rally_id)).toEqual(['rally-manual'])
  })

  it('samples three stable points inside a tracked frame range', () => {
    expect(
      previewFrameSeconds({
        firstFrameIndex: '30',
        lastFrameIndex: '90',
        fps: { num: 30, den: 1 },
        durationUs: '5000000',
      }),
    ).toEqual([1.4, 2, 2.6])
  })

  it('clamps absolute frame indexes to the available clip instead of seeking past its end', () => {
    expect(
      previewFrameSeconds({
        firstFrameIndex: '3000',
        lastFrameIndex: '3600',
        fps: { num: 60, den: 1 },
        durationUs: '5000000',
      }),
    ).toEqual([4.96])
  })
})
