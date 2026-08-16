export const BALL_EVENT_KINDS = ['SERVE', 'RECEIVE', 'CONTACT', 'SPIKE'] as const
export type BallEventKind = (typeof BALL_EVENT_KINDS)[number]

export const SERVE_RESULTS = ['POINT_SCORED', 'SUCCESS', 'ERROR'] as const
export type ServeResult = (typeof SERVE_RESULTS)[number]

export const RECEIVE_RESULTS = ['SUCCESS', 'ERROR', 'POINT_LOST'] as const
export type ReceiveResult = (typeof RECEIVE_RESULTS)[number]

export const SPIKE_RESULTS = ['SUCCESS', 'FAILURE'] as const
export type SpikeResult = (typeof SPIKE_RESULTS)[number]

export type BallEventResult = ServeResult | ReceiveResult | SpikeResult
export type BallEventShortcut = 'C' | 'V' | 'B'

export interface BallEventValue {
  kind: BallEventKind
  result: BallEventResult | null
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
  'SERVE_SUCCESS_INFERRED',
  'RECEIVE_POINT_LOST_DOWNGRADED',
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
  | 'RECEIVE_REQUIRES_SECOND_POINT'
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
  if (result === null) return true
  if (kind === 'SERVE') return SERVE_RESULTS.includes(result as ServeResult)
  if (kind === 'RECEIVE') return RECEIVE_RESULTS.includes(result as ReceiveResult)
  return SPIKE_RESULTS.includes(result as SpikeResult)
}

function requiredKind(index: number, current: BallEventKind | null): BallEventKind {
  if (index === 0) return 'SERVE'
  if (index === 1) return 'RECEIVE'
  return current === 'SPIKE' ? 'SPIKE' : 'CONTACT'
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
    const event: BallEventValue = { kind, result }

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

  const serve = points[0]
  if (points.length > 1 && serve?.event.kind === 'SERVE' && serve.event.result !== 'SUCCESS') {
    const before = { ...serve.event }
    serve.event = { kind: 'SERVE', result: 'SUCCESS' }
    repairs.push({
      code: 'SERVE_SUCCESS_INFERRED',
      key_point_id: serve.key_point_id,
      action: 'update',
      before: { sequence_index: serve.sequence_index, event: before },
      after: { sequence_index: serve.sequence_index, event: serve.event },
    })
  }
  const receive = points[1]
  if (
    points.length > 2 &&
    receive?.event.kind === 'RECEIVE' &&
    receive.event.result === 'POINT_LOST'
  ) {
    const before = { ...receive.event }
    receive.event = { kind: 'RECEIVE', result: 'ERROR' }
    repairs.push({
      code: 'RECEIVE_POINT_LOST_DOWNGRADED',
      key_point_id: receive.key_point_id,
      action: 'update',
      before: { sequence_index: receive.sequence_index, event: before },
      after: { sequence_index: receive.sequence_index, event: receive.event },
    })
  }
  // A later key point does not prove that an earlier spike failed. The later
  // observation can be the ball landing, a block touch, or another automatic
  // contact without an assigned actor. Preserve the operator's explicit spike
  // result; rally outcome and actor/pose evidence can evaluate it separately.

  return { points, tombstoned_key_point_ids: tombstoned, repairs }
}

function shortcutEvent(shortcut: BallEventShortcut): BallEventValue {
  if (shortcut === 'C') return { kind: 'SPIKE', result: null }
  if (shortcut === 'V') return { kind: 'RECEIVE', result: 'SUCCESS' }
  return { kind: 'RECEIVE', result: 'ERROR' }
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
  if (input.shortcut !== 'C' && ordinal !== 2) {
    return {
      allowed: false,
      mode,
      key_point_id: selectedId,
      ordinal,
      reason: 'RECEIVE_REQUIRES_SECOND_POINT',
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
