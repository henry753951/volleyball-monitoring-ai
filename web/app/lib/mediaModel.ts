export type MediaMode = 'live' | 'archive'
export type ObservationSource = 'request_video_frame_callback' | 'current_time_fallback'
export type CursorStatus = 'ready' | 'seeking' | 'stale' | 'gap'
export type TimingPrecision = 'frame_exact' | 'pts_exact' | 'estimated'

export interface PlaybackWindowDescriptor {
  schema_version: '1.0.0'; playback_window_id: string; capture_session_id: string
  mode: MediaMode; mapping_version: number
  timeline_capture_start_us: string; timeline_capture_end_us: string
  window_capture_start_us: string; window_capture_end_us: string
  presentation_origin_capture_us: string; target_player_media_time_us: string
  manifest_url: string; expires_at: string
  live_edge_capture_time_us?: string | null
  has_more_before: boolean; has_more_after: boolean
}
export interface PlaybackWindowRequest { schema_version: '1.0.0'; capture_session_id: string; mode: MediaMode; target_capture_time_us?: string; requested_back_us?: string; requested_forward_us?: string }
export interface PlaybackCursorInput { schema_version: '1.0.0'; playback_window_id: string; mapping_version: number; player_media_time_us: string; observation_source: ObservationSource; presented_frames: string | null; seek_generation: number; cursor_status: CursorStatus }
export interface SourceTimeBase { num: number; den: number }
export interface CanonicalFrameAnchor { schema_version: '1.0.0'; capture_session_id: string; playback_window_id: string; mapping_version: number; capture_epoch_id: string; dvr_segment_id?: string | null; source_pts: string; source_time_base: SourceTimeBase; capture_time_us: string; capture_frame_index: string; player_media_time_us: string; timing_precision: TimingPrecision }
export interface ResolvedMediaAnchor { schema_version: '1.0.0'; playback_window_id: string; capture_session_id: string; capture_epoch_id: string; dvr_segment_id?: string | null; source_pts: string; source_time_base: SourceTimeBase; capture_time_us: string; capture_frame_index: string; resolved_player_media_time_us: string; mapping_version: number; snap_distance_us?: string | null; timing_precision: TimingPrecision }
export interface FrameStepRequest { schema_version: '1.0.0'; capture_session_id: string; playback_window_id: string; mapping_version: number; capture_frame_index: string; direction: 'previous' | 'next' }
export interface CaptureTimelineRange { startUs: string; endUs: string; discontinuity: number }
export interface CaptureTimeline { captureSessionId: string; timelineVersion: string; captureStartTimeUs: string; liveEdgeCaptureTimeUs?: string | null; availableRanges: CaptureTimelineRange[] }

export const MEDIA_ERROR_CODES = ['BAD_REQUEST','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','MAPPING_STALE','MEDIA_NOT_READY','WINDOW_BOUNDARY','WINDOW_EXPIRED','CURSOR_NOT_READY','CAPTURE_GAP','SAMPLE_NOT_FOUND'] as const
export type MediaErrorCode = typeof MEDIA_ERROR_CODES[number]
export type MediaErrorClassification = 'recreate_window' | 'recenter_retry' | 'block'
export class MediaApiError extends Error {
  readonly code: MediaErrorCode | 'UNKNOWN'
  readonly status: number
  readonly details: unknown
  constructor(code: MediaErrorCode | 'UNKNOWN', message: string, status: number, details?: unknown) { super(message); this.name = 'MediaApiError'; this.code = code; this.status = status; this.details = details }
}
export function classifyMediaError(error: Pick<MediaApiError, 'code'>): MediaErrorClassification {
  if (error.code === 'WINDOW_BOUNDARY') return 'recenter_retry'
  if (error.code === 'CAPTURE_GAP' || error.code === 'SAMPLE_NOT_FOUND') return 'block'
  return 'recreate_window'
}
