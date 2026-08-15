export const CONTRACT_VERSIONS = {
  mediaPlaybackWindowRequest: '1.0.0',
  mediaPlaybackWindowDescriptor: '1.0.0',
  mediaPlaybackWindowExtendRequest: '1.0.0',
  mediaPlaybackCursor: '1.0.0',
  mediaResolvedAnchor: '1.0.0',
  mediaFrameStepRequest: '1.1.0',
  mediaCanonicalFrameAnchor: '1.0.0',
  mediaApiError: '1.0.0',
  annotationRealtime: '3.0.0',
  aiCapabilities: '2.0.0',
  aiJob: '3.0.0',
  aiJobAccepted: '1.0.0',
  aiCallback: '2.0.0',
  aiProviderRealtime: '2.0.0',
  providerAnalysisData: 'flatbuffers_analysis_data_v1',
  browserAnalysisFrameChunk: 'flatbuffers_analysis_frame_chunk_v1',
  analysisReview: '1.3.0',
} as const

export type MediaMode = 'live' | 'archive'
export type MediaTimingPrecision = 'frame_exact' | 'pts_exact' | 'estimated'
export const MEDIA_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'MAPPING_STALE',
  'MEDIA_NOT_READY',
  'WINDOW_BOUNDARY',
  'WINDOW_EXPIRED',
  'CURSOR_NOT_READY',
  'CAPTURE_GAP',
  'SAMPLE_NOT_FOUND',
] as const
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number]
export interface PlaybackWindowRequest {
  schema_version: '1.0.0'
  capture_session_id: string
  mode: MediaMode
  target_capture_time_us?: string
  requested_back_us?: string
  requested_forward_us?: string
}
export interface PlaybackWindowExtendRequest {
  schema_version: '1.0.0'
  target_capture_time_us: string
  requested_forward_us?: string
}
export interface PlaybackWindowDescriptor {
  schema_version: '1.0.0'
  playback_window_id: string
  capture_session_id: string
  mode: MediaMode
  mapping_version: number
  timeline_capture_start_us: string
  timeline_capture_end_us: string
  window_capture_start_us: string
  window_capture_end_us: string
  presentation_origin_capture_us: string
  target_player_media_time_us: string
  manifest_url: string
  expires_at: string
  live_edge_capture_time_us?: string | null
  has_more_before: boolean
  has_more_after: boolean
}
export interface PlaybackCursor {
  schema_version: '1.0.0'
  playback_window_id: string
  mapping_version: number
  player_media_time_us: string
  observation_source: 'request_video_frame_callback' | 'current_time_fallback'
  presented_frames?: string | null
  seek_generation: number
  cursor_status: 'ready' | 'seeking' | 'stale' | 'gap'
}
export interface ResolvedMediaAnchor {
  schema_version: '1.0.0'
  playback_window_id: string
  capture_session_id: string
  capture_epoch_id: string
  dvr_segment_id?: string | null
  source_pts: string
  source_time_base: { num: number; den: number }
  capture_time_us: string
  capture_frame_index: string
  resolved_player_media_time_us: string
  mapping_version: number
  snap_distance_us?: string | null
  timing_precision: MediaTimingPrecision
}
export interface FrameStepRequest {
  schema_version: '1.1.0'
  capture_session_id: string
  playback_window_id: string
  mapping_version: number
  capture_frame_index: string
  direction: 'previous' | 'next'
  count: number
}
export type CanonicalFrameAnchor = Omit<
  ResolvedMediaAnchor,
  'resolved_player_media_time_us' | 'snap_distance_us'
> & { player_media_time_us: string }
export interface MediaApiError {
  schema_version: '1.0.0'
  code: MediaErrorCode
  message: string
  request_id: string
  details?: Record<string, unknown> | null
}

const UINT = /^\d+$/
const INT = /^-?\d+$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  if (
    !isRecord(value) ||
    required.some(key => !(key in value)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
  )
    throw new TypeError('invalid media object shape')
}
const stringField = (value: Record<string, unknown>, key: string, pattern = /^.+$/): void => {
  if (typeof value[key] !== 'string' || !pattern.test(value[key]))
    throw new TypeError(`invalid ${key}`)
}
const uintField = (value: Record<string, unknown>, key: string): void =>
  stringField(value, key, UINT)
const idField = (value: Record<string, unknown>, key: string): void => {
  stringField(value, key, /^.{1,128}$/)
}
const intField = (value: Record<string, unknown>, key: string): void => {
  if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 1)
    throw new TypeError(`invalid ${key}`)
}
const nonNegativeIntField = (value: Record<string, unknown>, key: string): void => {
  if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0)
    throw new TypeError(`invalid ${key}`)
}
const optionalField = (
  value: Record<string, unknown>,
  key: string,
  check: (key: string) => void,
): void => {
  if (key in value) {
    if (value[key] === undefined) throw new TypeError(`invalid ${key}`)
    check(key)
  }
}
const boolField = (value: Record<string, unknown>, key: string): void => {
  if (typeof value[key] !== 'boolean') throw new TypeError(`invalid ${key}`)
}
const parse = <T>(input: unknown, check: (value: Record<string, unknown>) => void): T => {
  if (!isRecord(input)) throw new TypeError('invalid media payload')
  check(input)
  return input as T
}
const validUriReference = (value: string): boolean => {
  if (/\s/.test(value)) return false
  try {
    new URL(value, 'https://contracts.invalid/')
    return value.length > 0
  } catch {
    return false
  }
}
export const parsePlaybackWindowRequest = (input: unknown): PlaybackWindowRequest =>
  parse(input, v => {
    exact(
      v,
      ['schema_version', 'capture_session_id', 'mode'],
      ['target_capture_time_us', 'requested_back_us', 'requested_forward_us'],
    )
    if (
      v.schema_version !== '1.0.0' ||
      !['live', 'archive'].includes(String(v.mode)) ||
      (v.mode === 'archive' && typeof v.target_capture_time_us !== 'string')
    )
      throw new TypeError('invalid playback window request')
    idField(v, 'capture_session_id')
    ;['target_capture_time_us', 'requested_back_us', 'requested_forward_us'].forEach(k =>
      optionalField(v, k, () => uintField(v, k)),
    )
  })
export const parsePlaybackWindowExtendRequest = (input: unknown): PlaybackWindowExtendRequest =>
  parse(input, v => {
    exact(v, ['schema_version', 'target_capture_time_us'], ['requested_forward_us'])
    if (v.schema_version !== '1.0.0') throw new TypeError('invalid playback window extend request')
    uintField(v, 'target_capture_time_us')
    optionalField(v, 'requested_forward_us', () => uintField(v, 'requested_forward_us'))
  })
export const parsePlaybackWindowDescriptor = (input: unknown): PlaybackWindowDescriptor =>
  parse(input, v => {
    exact(
      v,
      [
        'schema_version',
        'playback_window_id',
        'capture_session_id',
        'mode',
        'mapping_version',
        'timeline_capture_start_us',
        'timeline_capture_end_us',
        'window_capture_start_us',
        'window_capture_end_us',
        'presentation_origin_capture_us',
        'target_player_media_time_us',
        'manifest_url',
        'expires_at',
        'has_more_before',
        'has_more_after',
      ],
      ['live_edge_capture_time_us'],
    )
    if (v.schema_version !== '1.0.0' || !['live', 'archive'].includes(String(v.mode)))
      throw new TypeError('invalid descriptor')
    idField(v, 'playback_window_id')
    idField(v, 'capture_session_id')
    intField(v, 'mapping_version')
    ;[
      'timeline_capture_start_us',
      'timeline_capture_end_us',
      'window_capture_start_us',
      'window_capture_end_us',
      'presentation_origin_capture_us',
      'target_player_media_time_us',
    ].forEach(k => uintField(v, k))
    optionalField(v, 'live_edge_capture_time_us', () => {
      if (v.live_edge_capture_time_us !== null) uintField(v, 'live_edge_capture_time_us')
    })
    stringField(v, 'manifest_url')
    if (!validUriReference(String(v.manifest_url))) throw new TypeError('invalid manifest_url')
    stringField(v, 'expires_at')
    if (!String(v.expires_at).includes('T') || Number.isNaN(Date.parse(String(v.expires_at))))
      throw new TypeError('invalid expires_at')
    boolField(v, 'has_more_before')
    boolField(v, 'has_more_after')
  })
export const parsePlaybackCursor = (input: unknown): PlaybackCursor =>
  parse(input, v => {
    exact(
      v,
      [
        'schema_version',
        'playback_window_id',
        'mapping_version',
        'player_media_time_us',
        'observation_source',
        'seek_generation',
        'cursor_status',
      ],
      ['presented_frames'],
    )
    if (
      v.schema_version !== '1.0.0' ||
      !['request_video_frame_callback', 'current_time_fallback'].includes(
        String(v.observation_source),
      ) ||
      !['ready', 'seeking', 'stale', 'gap'].includes(String(v.cursor_status))
    )
      throw new TypeError('invalid cursor')
    idField(v, 'playback_window_id')
    intField(v, 'mapping_version')
    nonNegativeIntField(v, 'seek_generation')
    uintField(v, 'player_media_time_us')
    optionalField(v, 'presented_frames', () => {
      if (v.presented_frames !== null) uintField(v, 'presented_frames')
    })
  })
const parseAnchor = <T>(input: unknown, resolved: boolean): T =>
  parse(input, v => {
    const required = [
      'schema_version',
      'playback_window_id',
      'capture_session_id',
      'capture_epoch_id',
      'source_pts',
      'source_time_base',
      'capture_time_us',
      'capture_frame_index',
      'mapping_version',
      'timing_precision',
      resolved ? 'resolved_player_media_time_us' : 'player_media_time_us',
    ]
    exact(v, required, ['dvr_segment_id', ...(resolved ? ['snap_distance_us'] : [])])
    if (
      v.schema_version !== '1.0.0' ||
      !['frame_exact', 'pts_exact', 'estimated'].includes(String(v.timing_precision)) ||
      !isRecord(v.source_time_base)
    )
      throw new TypeError('invalid anchor')
    exact(v.source_time_base, ['num', 'den'])
    ;['playback_window_id', 'capture_session_id', 'capture_epoch_id'].forEach(k => idField(v, k))
    intField(v, 'mapping_version')
    if (
      typeof v.source_time_base.num !== 'number' ||
      !Number.isInteger(v.source_time_base.num) ||
      v.source_time_base.num < 1 ||
      typeof v.source_time_base.den !== 'number' ||
      !Number.isInteger(v.source_time_base.den) ||
      v.source_time_base.den < 1
    )
      throw new TypeError('invalid source_time_base')
    stringField(v, 'source_pts', INT)
    uintField(v, 'capture_time_us')
    uintField(v, 'capture_frame_index')
    uintField(v, resolved ? 'resolved_player_media_time_us' : 'player_media_time_us')
    optionalField(v, 'dvr_segment_id', () => {
      if (v.dvr_segment_id !== null) idField(v, 'dvr_segment_id')
    })
    if (resolved)
      optionalField(v, 'snap_distance_us', () => {
        if (v.snap_distance_us !== null) uintField(v, 'snap_distance_us')
      })
  })
export const parseResolvedMediaAnchor = (input: unknown): ResolvedMediaAnchor =>
  parseAnchor<ResolvedMediaAnchor>(input, true)
export const parseFrameStepRequest = (input: unknown): FrameStepRequest =>
  parse(input, v => {
    exact(v, [
      'schema_version',
      'capture_session_id',
      'playback_window_id',
      'mapping_version',
      'capture_frame_index',
      'direction',
      'count',
    ])
    if (v.schema_version !== '1.1.0' || !['previous', 'next'].includes(String(v.direction)))
      throw new TypeError('invalid frame step')
    idField(v, 'capture_session_id')
    idField(v, 'playback_window_id')
    intField(v, 'mapping_version')
    uintField(v, 'capture_frame_index')
    intField(v, 'count')
    if (Number(v.count) > 120) throw new TypeError('invalid count')
  })
export const parseCanonicalFrameAnchor = (input: unknown): CanonicalFrameAnchor =>
  parseAnchor<CanonicalFrameAnchor>(input, false)
export const parseMediaApiError = (input: unknown): MediaApiError =>
  parse(input, v => {
    exact(v, ['schema_version', 'code', 'message', 'request_id'], ['details'])
    if (
      v.schema_version !== '1.0.0' ||
      !MEDIA_ERROR_CODES.includes(String(v.code) as MediaErrorCode)
    )
      throw new TypeError('invalid media error')
    stringField(v, 'message', /^.{1,512}$/)
    idField(v, 'request_id')
    optionalField(v, 'details', () => {
      if (v.details !== null && !isRecord(v.details)) throw new TypeError('invalid details')
    })
  })

export * from './annotation.js'
export * from './ai-provider-realtime.js'
export * from './analysis-data-flatbuffers.js'
export * from './analysis-review.js'
