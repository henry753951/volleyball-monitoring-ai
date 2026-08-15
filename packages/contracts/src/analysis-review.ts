export const ANALYSIS_REVIEW_SCHEMA_VERSION = '1.4.0' as const

export type AnalysisReviewStatus = 'editing' | 'ready' | 'approved'

export const ANALYSIS_REVIEW_ACTIONS = [
  'Waiting',
  'Setting',
  'Digging',
  'Falling',
  'Spiking',
  'Blocking',
  'Jumping',
  'Moving',
  'Standing',
] as const

export type AnalysisReviewAction = (typeof ANALYSIS_REVIEW_ACTIONS)[number]
export interface AnalysisFramePoint {
  x: number
  y: number
}
export interface AnalysisFrameBBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type AnalysisBallCorrection =
  | { frame_index: string; state: 'position'; frame_pos: AnalysisFramePoint; revision: string }
  | { frame_index: string; state: 'missing'; frame_pos: null; revision: string }

export interface AnalysisActionCorrection {
  frame_index: string
  track_id: number
  action: AnalysisReviewAction
  revision: string
}

export interface AnalysisPlayerBBoxCorrection {
  frame_index: string
  track_id: number
  frame_bbox: AnalysisFrameBBox
  revision: string
}

export interface AnalysisContactActorCorrection {
  key_point_id: string
  track_id: number | null
  revision: string
}

export interface AnalysisContactTimeCorrection {
  key_point_id: string
  frame_index: string
  revision: string
}

export type AnalysisContactActorProjectionStatus = 'pending' | 'running' | 'ready' | 'failed'
export type AnalysisContactActorProjectionSource =
  | 'pose_hand'
  | 'bbox_action'
  | 'bbox_spatial'
  | 'unresolved'

export interface AnalysisContactActorProjection {
  key_point_id: string
  frame_index: string
  status: AnalysisContactActorProjectionStatus
  track_id: number | null
  observation_frame_index: string | null
  source: AnalysisContactActorProjectionSource | null
  confidence: number | null
  algorithm_namespace: string
  pose_recipe_namespace: string | null
  fallback_reason: string | null
  revision: string
}

export interface AnalysisContactEdit {
  contact_id: string
  base_key_point_id: string | null
  frame_index: string
  track_id: number | null
  deleted: boolean
  revision: string
}

export interface AnalysisReviewState {
  schema_version: typeof ANALYSIS_REVIEW_SCHEMA_VERSION
  analysis_run_id: string
  revision: string
  status: AnalysisReviewStatus
  computed_revision: string | null
  approved_revision: string | null
  ball_corrections: AnalysisBallCorrection[]
  action_corrections: AnalysisActionCorrection[]
  player_bbox_corrections: AnalysisPlayerBBoxCorrection[]
  contact_actor_corrections: AnalysisContactActorCorrection[]
  contact_actor_projections: AnalysisContactActorProjection[]
  contact_time_corrections: AnalysisContactTimeCorrection[]
  contact_edits: AnalysisContactEdit[]
}

export type AnalysisReviewOperation =
  | { op: 'set_ball_position'; frame_index: string; frame_pos: AnalysisFramePoint }
  | { op: 'mark_ball_missing'; frame_index: string }
  | { op: 'clear_ball_override'; frame_index: string }
  | { op: 'set_action'; frame_index: string; track_id: number; action: AnalysisReviewAction }
  | { op: 'clear_action_override'; frame_index: string; track_id: number }
  | { op: 'set_player_bbox'; frame_index: string; track_id: number; frame_bbox: AnalysisFrameBBox }
  | { op: 'clear_player_bbox_override'; frame_index: string; track_id: number }
  | { op: 'set_contact_actor'; key_point_id: string; track_id: number | null }
  | { op: 'clear_contact_actor_override'; key_point_id: string }
  | { op: 'set_contact_time'; key_point_id: string; frame_index: string }
  | { op: 'clear_contact_time_override'; key_point_id: string }
  | { op: 'add_contact'; contact_id: string; frame_index: string; track_id: number | null }
  | { op: 'delete_contact'; contact_id: string }
  | { op: 'restore_contact'; contact_id: string }

export interface AnalysisReviewPatch {
  schema_version: typeof ANALYSIS_REVIEW_SCHEMA_VERSION
  client_patch_id: string
  base_revision: string
  operations: AnalysisReviewOperation[]
}

export interface AnalysisReviewRevisionEvent {
  schema_version: typeof ANALYSIS_REVIEW_SCHEMA_VERSION
  type: 'analysis_review_revision'
  analysis_run_id: string
  revision: string
}

const UINT = /^(0|[1-9][0-9]*)$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const validTrackId = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const validFrameIndex = (value: unknown) => typeof value === 'string' && UINT.test(value)
const validPoint = (value: unknown): value is AnalysisFramePoint =>
  record(value) &&
  typeof value.x === 'number' &&
  typeof value.y === 'number' &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  value.x >= 0 &&
  value.y >= 0
const validBBox = (value: unknown): value is AnalysisFrameBBox =>
  record(value) &&
  typeof value.x1 === 'number' &&
  typeof value.y1 === 'number' &&
  typeof value.x2 === 'number' &&
  typeof value.y2 === 'number' &&
  [value.x1, value.y1, value.x2, value.y2].every(item => Number.isFinite(item) && item >= 0) &&
  value.x2 > value.x1 &&
  value.y2 > value.y1

export function parseAnalysisReviewPatch(value: unknown): AnalysisReviewPatch {
  if (
    !record(value) ||
    value.schema_version !== ANALYSIS_REVIEW_SCHEMA_VERSION ||
    typeof value.client_patch_id !== 'string' ||
    !UUID.test(value.client_patch_id) ||
    typeof value.base_revision !== 'string' ||
    !UINT.test(value.base_revision) ||
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > 32
  )
    throw new TypeError('invalid analysis review patch')

  for (const operation of value.operations) {
    if (!record(operation) || typeof operation.op !== 'string')
      throw new TypeError('invalid analysis review operation')
    if (operation.op === 'add_contact') {
      if (
        typeof operation.contact_id !== 'string' ||
        !UUID.test(operation.contact_id) ||
        !validFrameIndex(operation.frame_index) ||
        !(operation.track_id === null || validTrackId(operation.track_id))
      )
        throw new TypeError('invalid added contact')
      continue
    }
    if (operation.op === 'delete_contact' || operation.op === 'restore_contact') {
      if (typeof operation.contact_id !== 'string' || !UUID.test(operation.contact_id))
        throw new TypeError('invalid contact edit')
      continue
    }
    if (operation.op === 'set_contact_actor') {
      if (
        typeof operation.key_point_id !== 'string' ||
        !UUID.test(operation.key_point_id) ||
        !(operation.track_id === null || validTrackId(operation.track_id))
      )
        throw new TypeError('invalid contact actor correction')
      continue
    }
    if (operation.op === 'clear_contact_actor_override') {
      if (typeof operation.key_point_id !== 'string' || !UUID.test(operation.key_point_id))
        throw new TypeError('invalid contact actor correction')
      continue
    }
    if (operation.op === 'set_contact_time') {
      if (
        typeof operation.key_point_id !== 'string' ||
        !UUID.test(operation.key_point_id) ||
        !validFrameIndex(operation.frame_index)
      )
        throw new TypeError('invalid contact time correction')
      continue
    }
    if (operation.op === 'clear_contact_time_override') {
      if (typeof operation.key_point_id !== 'string' || !UUID.test(operation.key_point_id))
        throw new TypeError('invalid contact time correction')
      continue
    }
    if (!validFrameIndex(operation.frame_index))
      throw new TypeError('invalid analysis review operation')
    if (operation.op === 'set_ball_position') {
      if (!validPoint(operation.frame_pos)) throw new TypeError('invalid ball position correction')
      continue
    }
    if (operation.op === 'mark_ball_missing' || operation.op === 'clear_ball_override') continue
    if (operation.op === 'set_action') {
      if (
        !validTrackId(operation.track_id) ||
        !ANALYSIS_REVIEW_ACTIONS.includes(operation.action as AnalysisReviewAction)
      )
        throw new TypeError('invalid action correction')
      continue
    }
    if (operation.op === 'clear_action_override' || operation.op === 'clear_player_bbox_override') {
      if (!validTrackId(operation.track_id)) throw new TypeError('invalid track correction')
      continue
    }
    if (operation.op === 'set_player_bbox') {
      if (!validTrackId(operation.track_id) || !validBBox(operation.frame_bbox))
        throw new TypeError('invalid player bbox correction')
      continue
    }
    throw new TypeError('unsupported analysis review operation')
  }
  return value as unknown as AnalysisReviewPatch
}
