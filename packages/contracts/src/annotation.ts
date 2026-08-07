import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import realtimeSchema from '../annotation/realtime.schema.json'

export const ANNOTATION_COMMAND_KINDS = [
  'CREATE_SERVICE_KEY_POINT',
  'CREATE_CONTACT_KEY_POINT',
  'CLOSE_RALLY',
  'MOVE_KEY_POINT',
  'DELETE_KEY_POINT',
  'REOPEN_RALLY',
  'VOID_RALLY',
  'SUBMIT_RALLY',
] as const

export type AnnotationCommandKind = typeof ANNOTATION_COMMAND_KINDS[number]

export interface AnnotationPlaybackCursor {
  playback_window_id: string
  mapping_version: number
  player_media_time_us: string
  observation_source: 'request_video_frame_callback' | 'current_time_fallback'
  presented_frames?: string | null
  seek_generation: number
  cursor_status: 'ready' | 'seeking' | 'stale' | 'gap'
}

interface AnnotationCommandBase<K extends AnnotationCommandKind, P> {
  schema_version: '2.0.0'
  command_id: string
  room_id: string
  base_revision: string
  rally_id: string
  kind: K
  payload: P
}

export type CreateServiceKeyPointCommand = AnnotationCommandBase<
  'CREATE_SERVICE_KEY_POINT',
  { playback_cursor: AnnotationPlaybackCursor }
>

export type AnnotationCommand =
  | CreateServiceKeyPointCommand
  | AnnotationCommandBase<'CREATE_CONTACT_KEY_POINT', { playback_cursor: AnnotationPlaybackCursor }>
  | AnnotationCommandBase<'CLOSE_RALLY',
    | { target_key_point_id: string; score_resolution: 'resolved'; scoring_court_side: 'left' | 'right' }
    | { target_key_point_id: string; score_resolution: 'unknown'; scoring_court_side: null }
  >
  | AnnotationCommandBase<'MOVE_KEY_POINT', { key_point_id: string; playback_cursor: AnnotationPlaybackCursor }>
  | AnnotationCommandBase<'DELETE_KEY_POINT', { key_point_id: string }>
  | AnnotationCommandBase<'REOPEN_RALLY', Record<string, never>>
  | AnnotationCommandBase<'VOID_RALLY', { reason: string }>
  | AnnotationCommandBase<'SUBMIT_RALLY', Record<string, never>>

export interface AnnotationResolvedAnchor {
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
  timing_precision: 'frame_exact' | 'pts_exact' | 'estimated'
}

export interface AnnotationCommandAck {
  schema_version: '2.0.0'
  type: 'command_ack'
  command_id: string
  room_id: string
  rally_id: string
  operation_kind: AnnotationCommandKind
  result_revision: string
  server_sequence: string
  effects: {
    created_key_point_id?: string | null
    terminal_key_point_id?: string | null
    deleted_key_point_id?: string | null
    submission_id?: string | null
    annotation_status?: 'open' | 'ready' | 'submitted' | 'voided'
    score_resolution?: 'pending' | 'resolved' | 'unknown'
    scoring_court_side?: 'left' | 'right' | null
  }
  resolved_anchor?: AnnotationResolvedAnchor | null
}

export interface AnnotationCommandRejected {
  schema_version: '2.0.0'
  type: 'command_rejected'
  command_id: string
  room_id: string
  rally_id: string
  code: string
  message?: string | null
  expected_revision?: string | null
  actual_revision?: string | null
  snapshot_refetch_required: boolean
}

export interface AnnotationConnectionReady {
  schema_version: '2.0.0'
  type: 'connection_ready'
  room_id: string
  server_sequence: string
  authenticated_user_id: string
  device_session_id: string
}

export type AnnotationProcessingStatus =
  | 'idle'
  | 'clip_queued'
  | 'clipping'
  | 'ai_queued'
  | 'ai_processing'
  | 'artifact_ingesting'
  | 'completed'
  | 'failed'
  | 'superseded'

export interface AnnotationKeyPoint {
  key_point_id: string
  sequence_index: number
  marker_kind: 'service' | 'contact'
  is_terminal: boolean
  capture_time_us: string
  capture_frame_index: string
  timing_precision: 'frame_exact' | 'pts_exact' | 'estimated'
  possible_duplicate: boolean
}

export interface AnnotationRallySnapshot {
  schema_version: '2.0.0'
  type: 'rally_snapshot'
  room_id: string
  rally_id: string
  revision: string
  server_sequence: string
  snapshot: {
    annotation_status: 'open' | 'ready' | 'submitted' | 'voided'
    score_resolution: 'pending' | 'resolved' | 'unknown'
    scoring_court_side: 'left' | 'right' | null
    processing_status: AnnotationProcessingStatus
    active_submission_id?: string | null
    key_points: AnnotationKeyPoint[]
  }
}

export interface AnnotationPresenceSnapshot {
  schema_version: '2.0.0'
  type: 'presence_snapshot'
  room_id: string
  members: Array<{
    user_id: string
    device_session_id: string
    display_name: string
    editing_key_point_id?: string | null
  }>
}

export interface AnnotationRallyProcessingUpdate {
  schema_version: '2.0.0'
  type: 'rally_processing_update'
  room_id: string
  rally_id: string
  submission_id: string
  processing_status: AnnotationProcessingStatus
  analysis_id?: string | null
  overlay_version?: string | null
  error?: Record<string, unknown> | null
}

export type AnnotationCommandResponse = AnnotationCommandAck | AnnotationCommandRejected
export type AnnotationServerMessage =
  | AnnotationConnectionReady
  | AnnotationCommandResponse
  | AnnotationRallySnapshot
  | AnnotationPresenceSnapshot
  | AnnotationRallyProcessingUpdate
export type AnnotationRealtimeMessage = AnnotationCommand | AnnotationServerMessage

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validateRealtime: ValidateFunction = ajv.compile(realtimeSchema)
const COMMAND_KINDS = new Set<string>(ANNOTATION_COMMAND_KINDS)
const SERVER_TYPES = new Set([
  'connection_ready',
  'command_ack',
  'command_rejected',
  'rally_snapshot',
  'presence_snapshot',
  'rally_processing_update',
])

function assertRealtime(input: unknown): Record<string, unknown> {
  if (!validateRealtime(input) || typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(ajv.errorsText(validateRealtime.errors, { separator: '; ' }))
  }
  return input as Record<string, unknown>
}

export function parseAnnotationRealtimeMessage(input: unknown): AnnotationRealtimeMessage {
  return assertRealtime(input) as unknown as AnnotationRealtimeMessage
}

export function parseAnnotationCommand(input: unknown): AnnotationCommand {
  const value = assertRealtime(input)
  if (typeof value.kind !== 'string' || !COMMAND_KINDS.has(value.kind)) {
    throw new TypeError('annotation message is not a command')
  }
  return value as unknown as AnnotationCommand
}

export function parseAnnotationServerMessage(input: unknown): AnnotationServerMessage {
  const value = assertRealtime(input)
  if (typeof value.type !== 'string' || !SERVER_TYPES.has(value.type)) {
    throw new TypeError('annotation message is not a supported server message')
  }
  return value as unknown as AnnotationServerMessage
}

export function parseAnnotationCommandResponse(input: unknown): AnnotationCommandResponse {
  const value = parseAnnotationServerMessage(input)
  if (value.type === 'command_ack' || value.type === 'command_rejected') return value
  throw new TypeError('annotation message is not a command response')
}
