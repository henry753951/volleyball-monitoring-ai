export const ANALYSIS_REVIEW_SCHEMA_VERSION = '1.0.0' as const

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

export type AnalysisReviewAction = typeof ANALYSIS_REVIEW_ACTIONS[number]

export interface AnalysisBallCorrection {
  frame_index: string
  frame_pos: { x: number; y: number }
  revision: string
}

export interface AnalysisActionCorrection {
  frame_index: string
  track_id: number
  action: AnalysisReviewAction
  revision: string
}

export interface AnalysisReviewState {
  schema_version: typeof ANALYSIS_REVIEW_SCHEMA_VERSION
  analysis_run_id: string
  revision: string
  ball_corrections: AnalysisBallCorrection[]
  action_corrections: AnalysisActionCorrection[]
}

export type AnalysisReviewOperation =
  | { op: 'set_ball_position'; frame_index: string; frame_pos: { x: number; y: number } }
  | { op: 'set_action'; frame_index: string; track_id: number; action: AnalysisReviewAction }

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
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseAnalysisReviewPatch(value: unknown): AnalysisReviewPatch {
  if (!record(value)
    || value.schema_version !== ANALYSIS_REVIEW_SCHEMA_VERSION
    || typeof value.client_patch_id !== 'string'
    || !UUID.test(value.client_patch_id)
    || typeof value.base_revision !== 'string'
    || !UINT.test(value.base_revision)
    || !Array.isArray(value.operations)
    || value.operations.length < 1
    || value.operations.length > 32) throw new TypeError('invalid analysis review patch')

  for (const operation of value.operations) {
    if (!record(operation) || typeof operation.frame_index !== 'string' || !UINT.test(operation.frame_index)) throw new TypeError('invalid analysis review operation')
    if (operation.op === 'set_ball_position') {
      if (!record(operation.frame_pos)
        || typeof operation.frame_pos.x !== 'number'
        || typeof operation.frame_pos.y !== 'number'
        || !Number.isFinite(operation.frame_pos.x)
        || !Number.isFinite(operation.frame_pos.y)
        || operation.frame_pos.x < 0
        || operation.frame_pos.y < 0) throw new TypeError('invalid ball position correction')
      continue
    }
    if (operation.op === 'set_action') {
      if (!Number.isSafeInteger(operation.track_id)
        || Number(operation.track_id) < 0
        || !ANALYSIS_REVIEW_ACTIONS.includes(operation.action as AnalysisReviewAction)) throw new TypeError('invalid action correction')
      continue
    }
    throw new TypeError('unsupported analysis review operation')
  }
  return value as unknown as AnalysisReviewPatch
}
