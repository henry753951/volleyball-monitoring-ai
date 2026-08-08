import type { PlaybackWindowDescriptor } from '../composables/usePlaybackCursor'

type CaptureTime = bigint | string
type PlayerMediaTime = bigint | string

/** Return true when a canonical capture time falls inside the inclusive window. */
export function isCaptureTimeWithinWindow(
  captureTimeUs: CaptureTime,
  descriptor: Pick<PlaybackWindowDescriptor, 'window_capture_start_us' | 'window_capture_end_us'>,
): boolean {
  const capture = typeof captureTimeUs === 'bigint' ? captureTimeUs : BigInt(captureTimeUs)
  return capture >= BigInt(descriptor.window_capture_start_us)
    && capture <= BigInt(descriptor.window_capture_end_us)
}

/** Convert a bounded canonical capture time to the player-local seconds offset. */
export function captureTimeToPlayerSeconds(
  captureTimeUs: CaptureTime,
  descriptor: Pick<PlaybackWindowDescriptor, 'window_capture_start_us' | 'window_capture_end_us' | 'presentation_origin_capture_us'>,
): number {
  if (!isCaptureTimeWithinWindow(captureTimeUs, descriptor)) {
    throw new RangeError('capture time is outside the bounded playback window')
  }

  const capture = typeof captureTimeUs === 'bigint' ? captureTimeUs : BigInt(captureTimeUs)
  // Only this bounded local delta becomes a Number; canonical 64-bit values stay bigint.
  return Number(capture - BigInt(descriptor.presentation_origin_capture_us)) / 1_000_000
}

/** Return true when a player-local observation still maps into this bounded window. */
export function isPlayerMediaTimeWithinWindow(
  playerMediaTimeUs: PlayerMediaTime,
  descriptor: Pick<PlaybackWindowDescriptor, 'window_capture_start_us' | 'window_capture_end_us' | 'presentation_origin_capture_us'>,
): boolean {
  const player = typeof playerMediaTimeUs === 'bigint' ? playerMediaTimeUs : BigInt(playerMediaTimeUs)
  if (player < 0n) return false
  return isCaptureTimeWithinWindow(BigInt(descriptor.presentation_origin_capture_us) + player, descriptor)
}
