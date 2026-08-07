export const CONTRACT_VERSIONS = {
  mediaPlaybackWindowRequest: '1.0.0',
  mediaPlaybackWindowDescriptor: '1.0.0',
  mediaPlaybackCursor: '1.0.0',
  mediaResolvedAnchor: '1.0.0',
  mediaFrameStepRequest: '1.0.0',
  mediaCanonicalFrameAnchor: '1.0.0',
  mediaApiError: '1.0.0',
  annotationRealtime: '1.1.0',
  aiCapabilities: '1.0.0',
  aiJob: '1.1.0',
  aiJobAccepted: '1.0.0',
  aiResult: '1.0.0',
  aiCallback: '1.0.0',
  providerOverlay: 'flatbuffers_v1',
  browserOverlayChunk: 'flatbuffers_chunk_v1',
} as const

export type MediaMode = 'live' | 'archive'
export type MediaTimingPrecision = 'frame_exact' | 'pts_exact' | 'estimated'
export type MediaErrorCode = 'BAD_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'MAPPING_STALE' | 'MEDIA_NOT_READY' | 'WINDOW_BOUNDARY' | 'WINDOW_EXPIRED' | 'CURSOR_NOT_READY' | 'CAPTURE_GAP' | 'SAMPLE_NOT_FOUND'
export interface PlaybackWindowRequest { schema_version: '1.0.0'; capture_session_id: string; mode: MediaMode; target_capture_time_us?: string; requested_back_us?: string; requested_forward_us?: string }
export interface PlaybackWindowDescriptor { schema_version: '1.0.0'; playback_window_id: string; capture_session_id: string; mode: MediaMode; mapping_version: number; timeline_capture_start_us: string; timeline_capture_end_us: string; window_capture_start_us: string; window_capture_end_us: string; presentation_origin_capture_us: string; target_player_media_time_us: string; manifest_url: string; expires_at: string; live_edge_capture_time_us?: string | null; has_more_before: boolean; has_more_after: boolean }
export interface PlaybackCursor { schema_version: '1.0.0'; playback_window_id: string; mapping_version: number; player_media_time_us: string; observation_source: 'request_video_frame_callback' | 'current_time_fallback'; presented_frames?: string | null; seek_generation: number; cursor_status: 'ready' | 'seeking' | 'stale' | 'gap' }
export interface ResolvedMediaAnchor { schema_version: '1.0.0'; playback_window_id: string; capture_session_id: string; capture_epoch_id: string; dvr_segment_id?: string | null; source_pts: string; source_time_base: { num: number; den: number }; capture_time_us: string; capture_frame_index: string; resolved_player_media_time_us: string; mapping_version: number; snap_distance_us?: string | null; timing_precision: MediaTimingPrecision }
export interface FrameStepRequest { schema_version: '1.0.0'; capture_session_id: string; playback_window_id: string; mapping_version: number; capture_frame_index: string; direction: 'previous' | 'next' }
export type CanonicalFrameAnchor = Omit<ResolvedMediaAnchor, 'resolved_player_media_time_us' | 'snap_distance_us'> & { player_media_time_us: string }
export interface MediaApiError { schema_version: '1.0.0'; code: MediaErrorCode; message: string; request_id: string; details?: Record<string, unknown> | null }

const UINT = /^\d+$/
const INT = /^-?\d+$/
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): void => {
  if (!isRecord(value) || required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError('invalid media object shape')
}
const stringField = (value: Record<string, unknown>, key: string, pattern = /^.+$/): void => { if (typeof value[key] !== 'string' || !pattern.test(value[key])) throw new TypeError(`invalid ${key}`) }
const uintField = (value: Record<string, unknown>, key: string): void => stringField(value, key, UINT)
const parse = <T>(input: unknown, check: (value: Record<string, unknown>) => void): T => { if (!isRecord(input)) throw new TypeError('invalid media payload'); check(input); return input as T }
export const parsePlaybackWindowRequest = (input: unknown): PlaybackWindowRequest => parse(input, (v) => { exact(v, ['schema_version', 'capture_session_id', 'mode'], ['target_capture_time_us', 'requested_back_us', 'requested_forward_us']); if (v.schema_version !== '1.0.0' || typeof v.capture_session_id !== 'string' || !['live', 'archive'].includes(String(v.mode)) || (v.mode === 'archive' && typeof v.target_capture_time_us !== 'string')) throw new TypeError('invalid playback window request'); ['target_capture_time_us', 'requested_back_us', 'requested_forward_us'].forEach((k) => { if (k in v && v[k] !== undefined) uintField(v, k) }) })
export const parsePlaybackWindowDescriptor = (input: unknown): PlaybackWindowDescriptor => parse(input, (v) => { exact(v, ['schema_version', 'playback_window_id', 'capture_session_id', 'mode', 'mapping_version', 'timeline_capture_start_us', 'timeline_capture_end_us', 'window_capture_start_us', 'window_capture_end_us', 'presentation_origin_capture_us', 'target_player_media_time_us', 'manifest_url', 'expires_at', 'has_more_before', 'has_more_after'], ['live_edge_capture_time_us']); if (v.schema_version !== '1.0.0' || !['live', 'archive'].includes(String(v.mode)) || typeof v.mapping_version !== 'number') throw new TypeError('invalid descriptor'); ['timeline_capture_start_us', 'timeline_capture_end_us', 'window_capture_start_us', 'window_capture_end_us', 'presentation_origin_capture_us', 'target_player_media_time_us'].forEach((k) => uintField(v, k)); if ('live_edge_capture_time_us' in v && v.live_edge_capture_time_us !== null) uintField(v, 'live_edge_capture_time_us') })
export const parsePlaybackCursor = (input: unknown): PlaybackCursor => parse(input, (v) => { exact(v, ['schema_version', 'playback_window_id', 'mapping_version', 'player_media_time_us', 'observation_source', 'seek_generation', 'cursor_status'], ['presented_frames']); if (v.schema_version !== '1.0.0' || typeof v.mapping_version !== 'number' || !['request_video_frame_callback', 'current_time_fallback'].includes(String(v.observation_source)) || !['ready', 'seeking', 'stale', 'gap'].includes(String(v.cursor_status))) throw new TypeError('invalid cursor'); uintField(v, 'player_media_time_us'); if ('presented_frames' in v && v.presented_frames !== null) uintField(v, 'presented_frames') })
const parseAnchor = <T>(input: unknown, resolved: boolean): T => parse(input, (v) => { const required = ['schema_version', 'playback_window_id', 'capture_session_id', 'capture_epoch_id', 'source_pts', 'source_time_base', 'capture_time_us', 'capture_frame_index', 'mapping_version', 'timing_precision', resolved ? 'resolved_player_media_time_us' : 'player_media_time_us']; exact(v, required, ['dvr_segment_id', ...(resolved ? ['snap_distance_us'] : [])]); if (v.schema_version !== '1.0.0' || typeof v.mapping_version !== 'number' || !['frame_exact', 'pts_exact', 'estimated'].includes(String(v.timing_precision)) || !isRecord(v.source_time_base) || typeof v.source_time_base.num !== 'number' || typeof v.source_time_base.den !== 'number') throw new TypeError('invalid anchor'); stringField(v, 'source_pts', INT); uintField(v, 'capture_time_us'); uintField(v, 'capture_frame_index'); uintField(v, resolved ? 'resolved_player_media_time_us' : 'player_media_time_us'); if (resolved && v.snap_distance_us !== null) uintField(v, 'snap_distance_us') })
export const parseResolvedMediaAnchor = (input: unknown): ResolvedMediaAnchor => parseAnchor<ResolvedMediaAnchor>(input, true)
export const parseFrameStepRequest = (input: unknown): FrameStepRequest => parse(input, (v) => { exact(v, ['schema_version', 'capture_session_id', 'playback_window_id', 'mapping_version', 'capture_frame_index', 'direction']); if (v.schema_version !== '1.0.0' || typeof v.mapping_version !== 'number' || !['previous', 'next'].includes(String(v.direction))) throw new TypeError('invalid frame step'); uintField(v, 'capture_frame_index') })
export const parseCanonicalFrameAnchor = (input: unknown): CanonicalFrameAnchor => parseAnchor<CanonicalFrameAnchor>(input, false)
export const parseMediaApiError = (input: unknown): MediaApiError => parse(input, (v) => { exact(v, ['schema_version', 'code', 'message', 'request_id'], ['details']); if (v.schema_version !== '1.0.0' || !['BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'MAPPING_STALE', 'MEDIA_NOT_READY', 'WINDOW_BOUNDARY', 'WINDOW_EXPIRED', 'CURSOR_NOT_READY', 'CAPTURE_GAP', 'SAMPLE_NOT_FOUND'].includes(String(v.code)) || typeof v.message !== 'string' || typeof v.request_id !== 'string') throw new TypeError('invalid media error') })
