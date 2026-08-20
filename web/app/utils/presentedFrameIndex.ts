import type { CanonicalFrameAnchor, PlaybackCursorInput } from '~/lib/mediaModel'

export type PresentedFrameBaseline = {
  captureFrameIndex: bigint
  key: string
  presentedFrames: bigint
}

function cursorKey(cursor: Extract<PlaybackCursorInput, { schema_version: '1.0.0' }>) {
  return `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}`
}

export function createPresentedFrameBaseline(
  anchor: Pick<
    CanonicalFrameAnchor,
    'capture_frame_index' | 'mapping_version' | 'playback_window_id'
  >,
  cursor: PlaybackCursorInput,
): PresentedFrameBaseline | null {
  if (
    cursor.schema_version !== '1.0.0' ||
    cursor.presented_frames == null ||
    anchor.playback_window_id !== cursor.playback_window_id ||
    anchor.mapping_version !== cursor.mapping_version
  )
    return null
  return {
    captureFrameIndex: BigInt(anchor.capture_frame_index),
    key: cursorKey(cursor),
    presentedFrames: BigInt(cursor.presented_frames),
  }
}

export function projectedPresentedFrameIndex(
  baseline: PresentedFrameBaseline | null,
  cursor: PlaybackCursorInput | null,
): string | null {
  if (
    !baseline ||
    !cursor ||
    cursor.schema_version !== '1.0.0' ||
    cursor.presented_frames == null ||
    cursorKey(cursor) !== baseline.key
  )
    return null
  const delta = BigInt(cursor.presented_frames) - baseline.presentedFrames
  if (delta < 0n) return null
  return (baseline.captureFrameIndex + delta).toString()
}
