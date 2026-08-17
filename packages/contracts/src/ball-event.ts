export const BALL_EVENT_KINDS = ['SERVE', 'RECEIVE', 'CONTACT', 'SPIKE'] as const
export type BallEventKind = (typeof BALL_EVENT_KINDS)[number]

export const SERVE_STYLES = ['JUMP', 'STANDING'] as const
export type ServeStyle = (typeof SERVE_STYLES)[number]

export const BALL_EVENT_RESULTS = ['SUCCESS', 'FAILURE'] as const
export type BallEventResult = (typeof BALL_EVENT_RESULTS)[number]
export type BallEventShortcut = 'C'
export type BallEventResultChoice = 'SUCCESS' | 'FAILURE'

export interface BallEventValue {
  kind: BallEventKind
  result: BallEventResult | null
  /** Only meaningful for SERVE. Missing values normalize to JUMP. */
  serve_style?: ServeStyle | null
}

export const RECEIVE_CONTEXTS = ['SERVE_RECEIVE', 'SPIKE_RECEIVE', 'RECEIVE'] as const
export type ReceiveContext = (typeof RECEIVE_CONTEXTS)[number]

/**
 * RECEIVE is the persisted, generic human event. Its user-facing subtype is a
 * deterministic projection of the immediately preceding ball event.
 */
export function receiveContextForPreviousEvent(
  previousEvent: BallEventValue | null | undefined,
): ReceiveContext {
  if (previousEvent?.kind === 'SERVE') return 'SERVE_RECEIVE'
  if (previousEvent?.kind === 'SPIKE') return 'SPIKE_RECEIVE'
  return 'RECEIVE'
}

export interface BallEventRuleAnchor {
  capture_time_us: string
  capture_frame_index: string
}

export interface BallEventRulePoint extends BallEventRuleAnchor {
  key_point_id: string
  sequence_index: number
  event: BallEventValue | null
}

export interface BallEventRuleBoundary extends BallEventRuleAnchor {
  kind: 'start' | 'end'
}

export const BALL_EVENT_REPAIR_CODES = [
  'OUTSIDE_START_TOMBSTONED',
  'OUTSIDE_END_TOMBSTONED',
  'EVENT_KIND_NORMALIZED',
  'EVENT_RESULT_CLEARED',
  'SERVE_STYLE_DEFAULTED',
  'SERVE_STYLE_CLEARED',
  'SERVE_SUCCESS_INFERRED',
  'SECOND_POINT_RECEIVE_INFERRED',
  'SPIKE_SUCCESS_DOWNGRADED',
  'SEQUENCE_REINDEXED',
] as const

export type BallEventRepairCode = (typeof BALL_EVENT_REPAIR_CODES)[number]

export interface BallEventRepair {
  code: BallEventRepairCode
  key_point_id: string
  action: 'tombstone' | 'update'
  before: { sequence_index: number; event: BallEventValue | null }
  after: { sequence_index: number; event: BallEventValue | null } | null
}

export interface NormalizedBallEventPoint extends BallEventRulePoint {
  event: BallEventValue
}

export interface BallEventNormalization {
  points: NormalizedBallEventPoint[]
  tombstoned_key_point_ids: string[]
  repairs: BallEventRepair[]
}

export type BallEventShortcutReason =
  | 'NO_TARGET_POINT'
  | 'SPIKE_REQUIRES_THIRD_POINT'
  | 'OUTSIDE_RALLY_BOUNDARY'

export type BallEventShortcutDecision =
  | {
      allowed: true
      mode: 'create' | 'update'
      key_point_id: string | null
      ordinal: number
      event: BallEventValue
    }
  | {
      allowed: false
      mode: 'create' | 'update'
      key_point_id: string | null
      ordinal: number | null
      reason: BallEventShortcutReason
    }

const UINT = /^\d+$/

function integer(value: string, field: string): bigint {
  if (!UINT.test(value)) throw new TypeError(`invalid ${field}`)
  return BigInt(value)
}

function compareAnchor(left: BallEventRuleAnchor, right: BallEventRuleAnchor): number {
  const leftTime = integer(left.capture_time_us, 'capture_time_us')
  const rightTime = integer(right.capture_time_us, 'capture_time_us')
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1
  const leftFrame = integer(left.capture_frame_index, 'capture_frame_index')
  const rightFrame = integer(right.capture_frame_index, 'capture_frame_index')
  return leftFrame === rightFrame ? 0 : leftFrame < rightFrame ? -1 : 1
}

function comparePoint(left: BallEventRulePoint, right: BallEventRulePoint): number {
  return (
    compareAnchor(left, right) ||
    left.sequence_index - right.sequence_index ||
    left.key_point_id.localeCompare(right.key_point_id)
  )
}

export function isBallEventResultValid(
  kind: BallEventKind,
  result: BallEventResult | null,
): boolean {
  if (kind === 'CONTACT') return result === null
  return result === null || BALL_EVENT_RESULTS.includes(result)
}

function requiredKind(index: number, current: BallEventKind | null): BallEventKind {
  if (index === 0) return 'SERVE'
  if (index === 1 && current === 'SPIKE') return 'CONTACT'
  if (current === 'SPIKE' || current === 'RECEIVE' || current === 'CONTACT') return current
  return 'CONTACT'
}

export function resultForBallEventChoice(
  kind: BallEventKind,
  choice: BallEventResultChoice,
): BallEventResult | null {
  if (kind === 'CONTACT') return null
  return choice
}

export function normalizeBallEventKeyPoints(input: {
  points: readonly BallEventRulePoint[]
  boundaries?: readonly BallEventRuleBoundary[]
}): BallEventNormalization {
  const start = input.boundaries?.find(boundary => boundary.kind === 'start')
  const end = input.boundaries?.find(boundary => boundary.kind === 'end')
  const repairs: BallEventRepair[] = []
  const retained: BallEventRulePoint[] = []
  const tombstoned: string[] = []

  for (const point of [...input.points].sort(comparePoint)) {
    const outsideStart = start ? compareAnchor(point, start) < 0 : false
    const outsideEnd = end ? compareAnchor(point, end) > 0 : false
    if (outsideStart || outsideEnd) {
      tombstoned.push(point.key_point_id)
      repairs.push({
        code: outsideStart ? 'OUTSIDE_START_TOMBSTONED' : 'OUTSIDE_END_TOMBSTONED',
        key_point_id: point.key_point_id,
        action: 'tombstone',
        before: { sequence_index: point.sequence_index, event: point.event },
        after: null,
      })
      continue
    }
    retained.push(point)
  }

  const points = retained.map<NormalizedBallEventPoint>((point, index) => {
    const kind = requiredKind(index, point.event?.kind ?? null)
    const result =
      point.event?.kind === kind && isBallEventResultValid(kind, point.event.result)
        ? point.event.result
        : null
    const serveStyle = kind === 'SERVE' ? (point.event?.serve_style ?? 'JUMP') : null
    const event: BallEventValue = { kind, result, serve_style: serveStyle }

    if (point.event?.kind !== kind) {
      repairs.push({
        code: 'EVENT_KIND_NORMALIZED',
        key_point_id: point.key_point_id,
        action: 'update',
        before: { sequence_index: point.sequence_index, event: point.event },
        after: { sequence_index: index, event },
      })
    } else if (point.event && point.event.result !== result) {
      repairs.push({
        code: 'EVENT_RESULT_CLEARED',
        key_point_id: point.key_point_id,
        action: 'update',
        before: { sequence_index: point.sequence_index, event: point.event },
        after: { sequence_index: index, event },
      })
    } else if (kind === 'SERVE' && point.event?.serve_style == null) {
      repairs.push({
        code: 'SERVE_STYLE_DEFAULTED',
        key_point_id: point.key_point_id,
        action: 'update',
        before: { sequence_index: point.sequence_index, event: point.event },
        after: { sequence_index: index, event },
      })
    } else if (kind !== 'SERVE' && point.event?.serve_style != null) {
      repairs.push({
        code: 'SERVE_STYLE_CLEARED',
        key_point_id: point.key_point_id,
        action: 'update',
        before: { sequence_index: point.sequence_index, event: point.event },
        after: { sequence_index: index, event },
      })
    }

    if (point.sequence_index !== index) {
      const duplicate = repairs.some(
        repair =>
          repair.key_point_id === point.key_point_id &&
          repair.action === 'update' &&
          repair.after?.sequence_index === index,
      )
      if (!duplicate) {
        repairs.push({
          code: 'SEQUENCE_REINDEXED',
          key_point_id: point.key_point_id,
          action: 'update',
          before: { sequence_index: point.sequence_index, event: point.event },
          after: { sequence_index: index, event },
        })
      }
    }

    return { ...point, sequence_index: index, event }
  })

  return { points, tombstoned_key_point_ids: tombstoned, repairs }
}

function shortcutEvent(_shortcut: BallEventShortcut): BallEventValue {
  return { kind: 'SPIKE', result: null, serve_style: null }
}

export function decideBallEventShortcut(input: {
  shortcut: BallEventShortcut
  points: readonly BallEventRulePoint[]
  boundaries?: readonly BallEventRuleBoundary[]
  selected_key_point_id?: string | null
  candidate_anchor?: BallEventRuleAnchor | null
}): BallEventShortcutDecision {
  const normalized = normalizeBallEventKeyPoints(
    input.boundaries
      ? { points: input.points, boundaries: input.boundaries }
      : { points: input.points },
  )
  const selectedId = input.selected_key_point_id ?? null
  const selectedIndex = selectedId
    ? normalized.points.findIndex(point => point.key_point_id === selectedId)
    : -1
  const mode = selectedId ? 'update' : 'create'

  let ordinal: number | null
  if (selectedId) {
    if (selectedIndex < 0) {
      return {
        allowed: false,
        mode,
        key_point_id: selectedId,
        ordinal: null,
        reason: 'NO_TARGET_POINT',
      }
    }
    ordinal = selectedIndex + 1
  } else {
    const candidate = input.candidate_anchor
    if (!candidate) {
      return {
        allowed: false,
        mode,
        key_point_id: null,
        ordinal: null,
        reason: 'NO_TARGET_POINT',
      }
    }
    const start = input.boundaries?.find(boundary => boundary.kind === 'start')
    const end = input.boundaries?.find(boundary => boundary.kind === 'end')
    if (
      (start && compareAnchor(candidate, start) < 0) ||
      (end && compareAnchor(candidate, end) > 0)
    ) {
      return {
        allowed: false,
        mode,
        key_point_id: null,
        ordinal: null,
        reason: 'OUTSIDE_RALLY_BOUNDARY',
      }
    }
    ordinal = normalized.points.filter(point => compareAnchor(point, candidate) <= 0).length + 1
  }

  if (input.shortcut === 'C' && ordinal < 3) {
    return {
      allowed: false,
      mode,
      key_point_id: selectedId,
      ordinal,
      reason: 'SPIKE_REQUIRES_THIRD_POINT',
    }
  }
  return {
    allowed: true,
    mode,
    key_point_id: selectedId,
    ordinal,
    event: shortcutEvent(input.shortcut),
  }
}
