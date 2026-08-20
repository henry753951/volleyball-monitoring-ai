import { describe, expect, it } from 'vitest'
import type { CanonicalFrameAnchor, PlaybackCursorInput } from '~/lib/mediaModel'
import { createPresentedFrameBaseline, projectedPresentedFrameIndex } from './presentedFrameIndex'

const anchor = {
  playback_window_id: 'window',
  mapping_version: 3,
  capture_frame_index: '9007199254740993',
} as CanonicalFrameAnchor
const cursor: PlaybackCursorInput = {
  schema_version: '1.0.0',
  playback_window_id: 'window',
  mapping_version: 3,
  player_media_time_us: '1000000',
  observation_source: 'request_video_frame_callback',
  presented_frames: '500',
  seek_generation: 4,
  cursor_status: 'ready',
}

describe('presented frame index projection', () => {
  it('advances a bigint canonical frame index from presented-frame deltas', () => {
    const baseline = createPresentedFrameBaseline(anchor, cursor)
    expect(projectedPresentedFrameIndex(baseline, { ...cursor, presented_frames: '507' })).toBe(
      '9007199254741000',
    )
  })

  it('rejects observations from another seek generation', () => {
    const baseline = createPresentedFrameBaseline(anchor, cursor)
    expect(projectedPresentedFrameIndex(baseline, { ...cursor, seek_generation: 5 })).toBeNull()
  })
})
