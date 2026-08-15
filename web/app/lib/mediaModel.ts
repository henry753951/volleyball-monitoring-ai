import {
  MEDIA_ERROR_CODES,
  type CanonicalFrameAnchor,
  type FrameStepRequest,
  type MediaErrorCode,
  type MediaTimingPrecision,
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
export type PlaybackCursorInput = PlaybackCursor

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
  'recreate_window' | 'recenter_retry' | 'retry_later' | 'block' | 'fatal'
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
