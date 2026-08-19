import {
  MEDIA_ERROR_CODES,
  type CanonicalFrameAnchor,
  type FrameStepRequest,
  type MediaErrorCode,
  type MediaTimingPrecision,
  type MediaPlaybackCursor,
  type PlaybackCursor,
  type PlaybackWindowDescriptor,
  type PlaybackWindowRequest,
  type ResolvedMediaAnchor,
} from '@volleyball-monitoring/contracts'

export { MEDIA_ERROR_CODES }
export type {
  CanonicalFrameAnchor,
  FrameStepRequest,
  MediaErrorCode,
  MediaTimingPrecision,
  PlaybackCursor,
  PlaybackWindowDescriptor,
  PlaybackWindowRequest,
  ResolvedMediaAnchor,
}
export type MediaMode = PlaybackWindowRequest['mode']
export type ObservationSource = PlaybackCursor['observation_source']
export type CursorStatus = PlaybackCursor['cursor_status']
export type TimingPrecision = MediaTimingPrecision
export type PlaybackCursorInput = MediaPlaybackCursor

export interface CaptureTimelineRange {
  startUs: string
  endUs: string
  discontinuity: number
}
export interface CaptureTimeline {
  captureSessionId: string
  timelineVersion: string
  captureStartTimeUs: string
  liveEdgeCaptureTimeUs?: string | null
  availableRanges: CaptureTimelineRange[]
  availabilityComplete: boolean
  gapRanges: CaptureTimelineRange[]
  ingestFrontierCaptureTimeUs: string | null
  sourceEndCaptureTimeUs: string | null
}

export type MediaErrorClassification =
  | 'recreate_window'
  | 'recenter_retry'
  | 'retry_later'
  | 'block'
  | 'fatal'
export class MediaApiError extends Error {
  readonly code: MediaErrorCode | 'UNKNOWN'
  readonly status: number
  readonly details: unknown
  constructor(
    code: MediaErrorCode | 'UNKNOWN',
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message)
    this.name = 'MediaApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/**
 * Transport and readiness failures are safe to retry without changing the
 * authoritative cursor. Domain failures such as gaps, permission errors, or
 * missing samples must still surface to the workstation.
 */
export function isTransientMediaError(error: unknown) {
  if (!error) return false
  if (error instanceof TypeError) return true
  if (typeof error !== 'object') return false

  const cause = error as {
    code?: unknown
    status?: unknown
    name?: unknown
    message?: unknown
  }
  if (
    ['MEDIA_NOT_READY', 'CURSOR_NOT_READY', 'TIMEOUT', 'TIMEOUT_ERROR', 'NETWORK_ERROR'].includes(
      String(cause.code ?? ''),
    )
  )
    return true

  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(cause.status))) return true
  if (cause.name === 'AbortError') return true
  return /failed to fetch|network|timeout|timed out|connection|load failed/i.test(
    String(cause.message ?? ''),
  )
}

/**
 * A stale/invalid window can be reported as MEDIA_NOT_READY when the server
 * cannot validate its segment or sample-index mapping. Those failures are
 * recoverable by recreating the bounded window; a generic MEDIA_NOT_READY
 * (for example while an ingest segment is still being published) is not.
 */
export function isRecoverablePlaybackWindowError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const cause = error as { code?: unknown; message?: unknown }
  const code = String(cause.code ?? '')
  if (['NOT_FOUND', 'WINDOW_EXPIRED', 'MAPPING_STALE'].includes(code)) return true
  return (
    code === 'MEDIA_NOT_READY' &&
    /playback window|sample index|mapping/i.test(String(cause.message ?? ''))
  )
}

export function classifyMediaError(error: Pick<MediaApiError, 'code'>): MediaErrorClassification {
  switch (error.code) {
    case 'WINDOW_EXPIRED':
    case 'MAPPING_STALE':
      return 'recreate_window'
    case 'WINDOW_BOUNDARY':
      return 'recenter_retry'
    case 'MEDIA_NOT_READY':
    case 'CURSOR_NOT_READY':
      return 'retry_later'
    case 'CAPTURE_GAP':
    case 'SAMPLE_NOT_FOUND':
      return 'block'
    case 'BAD_REQUEST':
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNKNOWN':
      return 'fatal'
  }
}
