export type PlaybackContinuationDecision =
  | 'extend-window'
  | 'idle'
  | 'recover-buffer'
  | 'terminal'

export function decidePlaybackContinuation(input: {
  availabilityComplete: boolean
  browserBufferedSeconds: number
  currentCaptureTimeUs: string
  ended: boolean
  paused: boolean
  playbackHasStarted: boolean
  refreshLeadSeconds: number
  seekPreviewActive: boolean
  windowEndCaptureTimeUs: string
}): PlaybackContinuationDecision {
  if (
    !input.playbackHasStarted
    || input.seekPreviewActive
    || input.paused && !input.ended
  ) return 'idle'

  if (
    !input.ended
    && input.browserBufferedSeconds > input.refreshLeadSeconds
  ) return 'idle'

  const current = BigInt(input.currentCaptureTimeUs)
  const windowEnd = BigInt(input.windowEndCaptureTimeUs)
  const mappedHeadroomUs = windowEnd > current ? windowEnd - current : 0n
  const refreshLeadUs = BigInt(Math.max(0, Math.ceil(input.refreshLeadSeconds * 1_000_000)))

  // A browser-buffer starvation inside an already-authorized server window is
  // an HLS/MSE recovery concern. Extending the server descriptor cannot add
  // anything in this state and used to create a stream of no-progress 409s.
  if (mappedHeadroomUs > refreshLeadUs) return 'recover-buffer'
  if (input.availabilityComplete) return 'terminal'

  // The source is still ingesting or draining. Asking for continuation is safe
  // even when the page's GraphQL timeline is briefly stale: the endpoint is
  // idempotent and is the authority for newly READY media.
  return 'extend-window'
}
