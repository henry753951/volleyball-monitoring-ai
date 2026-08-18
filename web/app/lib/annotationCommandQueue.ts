import {
  normalizeBallEventKeyPoints,
  parseAnnotationCommand,
  type AnnotationCommand,
  type AnnotationCommandAck,
  type AnnotationKeyPoint,
  type AnnotationRallySnapshot,
} from '@volleyball-monitoring/contracts'
import type { AnnotationOutboxEntry } from './annotationOutbox'

export interface AnnotationClientObservation {
  capture_time_us: string
  capture_frame_index: string | null
}

function stateOf(snapshot: AnnotationRallySnapshot | null) {
  return snapshot?.snapshot.annotation_status ?? null
}

export function shouldAcceptAnnotationBroadcast(input: {
  nextRallyId: string
  currentRallyId?: string | null
  pendingRallyIds?: Iterable<string>
  rememberedRallyId?: string | null
}) {
  return (
    input.currentRallyId === input.nextRallyId ||
    input.rememberedRallyId === input.nextRallyId ||
    new Set(input.pendingRallyIds).has(input.nextRallyId)
  )
}

export function annotationDraftOwnedByClient(
  snapshot: AnnotationRallySnapshot | null,
  rememberedRallyId: string | null,
) {
  if (!snapshot) return false
  return snapshot.snapshot.active_submission_id != null || snapshot.rally_id === rememberedRallyId
}

/**
 * OPEN is a client-local boundary workflow: inspecting another client's moving
 * draft must never replace this tab's operational draft. READY has a fixed END
 * boundary, so an operator explicitly selecting that unsubmitted draft may
 * continue its durable point/outcome/submission work from this tab.
 */
export function shouldAdoptInspectedAnnotationSnapshot(
  snapshot: AnnotationRallySnapshot | null,
  rememberedRallyId: string | null,
) {
  if (!snapshot || !['open', 'ready'].includes(snapshot.snapshot.annotation_status)) return false
  return (
    snapshot.snapshot.annotation_status === 'ready' ||
    snapshot.snapshot.active_submission_id != null ||
    snapshot.rally_id === rememberedRallyId
  )
}

export function rebaseQueuedAnnotationCommand(
  command: AnnotationCommand,
  snapshot: AnnotationRallySnapshot | null,
  observation?: AnnotationClientObservation,
): AnnotationCommand | null {
  if (command.kind === 'START_RALLY') {
    return snapshot && stateOf(snapshot) === 'open' && !snapshot.snapshot.active_submission_id
      ? null
      : command
  }
  if (command.kind === 'CREATE_SERVICE_KEY_POINT') {
    return snapshot && ['open', 'ready'].includes(stateOf(snapshot) ?? '') ? null : command
  }
  if (!snapshot || snapshot.rally_id !== command.rally_id) return null
  if (command.kind === 'CREATE_CONTACT_KEY_POINT' && observation?.capture_frame_index) {
    const existing = snapshot.snapshot.key_points.find(
      point =>
        point.marker_kind === 'contact' &&
        point.capture_frame_index === observation.capture_frame_index,
    )
    if (existing) {
      if (
        command.payload.ball_event &&
        (existing.ball_event?.kind !== command.payload.ball_event.kind ||
          existing.ball_event?.result !== command.payload.ball_event.result)
      ) {
        return parseAnnotationCommand({
          ...command,
          base_revision: snapshot.revision,
          kind: 'SET_BALL_EVENT',
          payload: {
            key_point_id: existing.key_point_id,
            event: command.payload.ball_event,
          },
        })
      }
      return null
    }
  }
  const base = { ...command, base_revision: snapshot.revision }
  if (command.kind !== 'CLOSE_RALLY') return parseAnnotationCommand(base)
  const target = snapshot.snapshot.key_points.at(-1)
  if (!target) return null
  return parseAnnotationCommand({
    ...base,
    payload: { ...command.payload, target_key_point_id: target.key_point_id },
  })
}

export function annotationCommandConverged(
  command: AnnotationCommand,
  snapshot: AnnotationRallySnapshot | null,
  observation?: AnnotationClientObservation,
) {
  if (!snapshot || snapshot.rally_id !== command.rally_id) return false
  const state = stateOf(snapshot)
  if (command.kind === 'START_RALLY' || command.kind === 'CREATE_SERVICE_KEY_POINT') {
    return ['open', 'ready', 'submitted'].includes(state ?? '')
  }
  if (command.kind === 'END_RALLY') {
    return snapshot.snapshot.boundaries?.some(boundary => boundary.kind === 'end') === true
  }
  if (command.kind === 'CREATE_CONTACT_KEY_POINT') {
    if (!observation?.capture_frame_index) return false
    const existing = snapshot.snapshot.key_points.find(
      point =>
        point.marker_kind === 'contact' &&
        point.capture_frame_index === observation.capture_frame_index,
    )
    if (!existing) return false
    return command.payload.ball_event
      ? existing.ball_event?.kind === command.payload.ball_event.kind &&
          existing.ball_event?.result === command.payload.ball_event.result
      : true
  }
  if (command.kind === 'SET_RALLY_OUTCOME') {
    return (
      snapshot.snapshot.score_resolution === command.payload.score_resolution &&
      snapshot.snapshot.scoring_court_side === command.payload.scoring_court_side
    )
  }
  if (command.kind === 'DELETE_KEY_POINT') {
    return !snapshot.snapshot.key_points.some(
      point => point.key_point_id === command.payload.key_point_id,
    )
  }
  if (command.kind === 'SET_BALL_EVENT') {
    const point = snapshot.snapshot.key_points.find(
      candidate => candidate.key_point_id === command.payload.key_point_id,
    )
    const normalized = normalizeBallEventKeyPoints({
      points: snapshot.snapshot.key_points.map(candidate => ({
        key_point_id: candidate.key_point_id,
        sequence_index: candidate.sequence_index,
        capture_time_us: candidate.capture_time_us,
        capture_frame_index: candidate.capture_frame_index,
        event:
          candidate.key_point_id === command.payload.key_point_id
            ? command.payload.event
            : (candidate.ball_event ?? null),
      })),
      boundaries: snapshot.snapshot.boundaries,
    }).points.find(candidate => candidate.key_point_id === command.payload.key_point_id)
    if (!point?.ball_event || !normalized) return false
    return (
      point.ball_event.kind === normalized.event.kind &&
      point.ball_event.result === normalized.event.result &&
      (point.ball_event.kind !== 'SERVE' ||
        point.ball_event.serve_style === normalized.event.serve_style)
    )
  }
  if (command.kind === 'SET_BALL_EVENT_ACTOR') {
    const point = snapshot.snapshot.key_points.find(
      candidate => candidate.key_point_id === command.payload.key_point_id,
    )
    return point?.ball_event_actor_roster_entry_id === command.payload.actor_roster_entry_id
  }
  if (command.kind === 'REOPEN_RALLY') return state === 'open'
  if (command.kind === 'VOID_RALLY') return state === 'voided'
  if (command.kind === 'SUBMIT_RALLY') return state === 'submitted'
  return false
}

function pendingPoint(
  entry: AnnotationOutboxEntry,
  sequenceIndex: number,
): AnnotationKeyPoint | null {
  if (!['CREATE_SERVICE_KEY_POINT', 'CREATE_CONTACT_KEY_POINT'].includes(entry.command.kind))
    return null
  const observation = entry.observation
  if (!observation) return null
  return {
    key_point_id: `pending:${entry.command.command_id}`,
    sequence_index: sequenceIndex,
    marker_kind: entry.command.kind === 'CREATE_SERVICE_KEY_POINT' ? 'service' : 'contact',
    is_terminal:
      entry.command.kind === 'CREATE_CONTACT_KEY_POINT' &&
      entry.command.payload.terminal_outcome === 'unknown',
    capture_time_us: observation.capture_time_us,
    capture_frame_index: observation.capture_frame_index ?? '0',
    timing_precision: 'estimated',
    possible_duplicate: false,
    ...(entry.command.kind === 'CREATE_CONTACT_KEY_POINT' && entry.command.payload.ball_event
      ? { ball_event: entry.command.payload.ball_event }
      : {}),
  }
}

function normalizeProjectedBallEvents(snapshot: AnnotationRallySnapshot) {
  if (snapshot.schema_version !== '4.0.0') return snapshot
  const normalization = normalizeBallEventKeyPoints({
    points: snapshot.snapshot.key_points.map(point => ({
      key_point_id: point.key_point_id,
      sequence_index: point.sequence_index,
      capture_time_us: point.capture_time_us,
      capture_frame_index: point.capture_frame_index,
      event: point.ball_event ?? null,
    })),
    boundaries: snapshot.snapshot.boundaries,
  })
  const currentById = new Map(
    snapshot.snapshot.key_points.map(point => [point.key_point_id, point]),
  )
  snapshot.snapshot.key_points = normalization.points.map(point => ({
    ...currentById.get(point.key_point_id)!,
    sequence_index: point.sequence_index,
    ball_event: point.event,
  }))
  return snapshot
}

function normalizeKeyPointOrder(points: AnnotationKeyPoint[]) {
  const ordered = [...points].sort((left, right) => {
    if (left.marker_kind === 'service') return right.marker_kind === 'service' ? 0 : -1
    if (right.marker_kind === 'service') return 1
    const timeDifference = BigInt(left.capture_time_us) - BigInt(right.capture_time_us)
    if (timeDifference !== 0n) return timeDifference < 0n ? -1 : 1
    const frameDifference = BigInt(left.capture_frame_index) - BigInt(right.capture_frame_index)
    return frameDifference < 0n
      ? -1
      : frameDifference > 0n
        ? 1
        : left.key_point_id.localeCompare(right.key_point_id)
  })
  return ordered.map((point, sequenceIndex) => ({
    ...point,
    sequence_index: sequenceIndex,
    possible_duplicate:
      point.marker_kind === 'contact' &&
      ordered.some(
        other =>
          other.key_point_id !== point.key_point_id &&
          other.marker_kind === 'contact' &&
          other.capture_frame_index === point.capture_frame_index,
      ),
  }))
}

export function projectAnnotationSnapshot(
  confirmed: AnnotationRallySnapshot | null,
  roomId: string | null,
  entries: readonly AnnotationOutboxEntry[],
): AnnotationRallySnapshot | null {
  let projected = confirmed ? structuredClone(confirmed) : null
  for (const entry of entries) {
    const command = entry.command
    if (entry.status !== 'pending') continue
    if (
      (command.kind === 'START_RALLY' || command.kind === 'CREATE_SERVICE_KEY_POINT') &&
      (!projected ||
        projected.rally_id !== command.rally_id ||
        ['submitted', 'voided'].includes(projected.snapshot.annotation_status))
    ) {
      const point = command.kind === 'CREATE_SERVICE_KEY_POINT' ? pendingPoint(entry, 0) : null
      if ((!point && command.kind === 'CREATE_SERVICE_KEY_POINT') || !entry.observation || !roomId)
        continue
      projected = {
        schema_version: command.schema_version,
        type: 'rally_snapshot',
        room_id: roomId,
        rally_id: command.rally_id,
        revision: '0',
        server_sequence: '0',
        snapshot: {
          annotation_status: 'open',
          side_assignment_id: 'pending',
          score_resolution: 'pending',
          scoring_court_side: null,
          processing_status: 'idle',
          ...(command.kind === 'START_RALLY'
            ? {
                boundaries: [
                  {
                    kind: 'start' as const,
                    capture_time_us: entry.observation.capture_time_us,
                    capture_frame_index: entry.observation.capture_frame_index ?? '0',
                    timing_precision: 'estimated' as const,
                  },
                ],
              }
            : {}),
          key_points: point ? [point] : [],
        },
      }
      continue
    }
    if (!projected || projected.rally_id !== command.rally_id) continue
    if (command.kind === 'END_RALLY' && entry.observation) {
      projected.snapshot.boundaries = [
        ...(projected.snapshot.boundaries ?? []).filter(boundary => boundary.kind !== 'end'),
        {
          kind: 'end',
          capture_time_us: entry.observation.capture_time_us,
          capture_frame_index: entry.observation.capture_frame_index ?? '0',
          timing_precision: 'estimated',
        },
      ]
      projected.snapshot.annotation_status = 'ready'
    } else if (command.kind === 'CREATE_CONTACT_KEY_POINT') {
      const point = pendingPoint(entry, projected.snapshot.key_points.length)
      const alreadyProjected = point
        ? projected.snapshot.key_points.some(
            candidate =>
              candidate.marker_kind === 'contact' &&
              candidate.capture_frame_index === point.capture_frame_index,
          )
        : false
      if (point && !alreadyProjected) {
        projected.snapshot.key_points.push(point)
        if (command.payload.terminal_outcome === 'unknown') {
          projected.snapshot.annotation_status = 'ready'
          projected.snapshot.score_resolution = 'unknown'
          projected.snapshot.scoring_court_side = null
        }
      }
    } else if (command.kind === 'SET_BALL_EVENT') {
      const point = projected.snapshot.key_points.find(
        candidate => candidate.key_point_id === command.payload.key_point_id,
      )
      if (point) point.ball_event = command.payload.event
    } else if (command.kind === 'SET_BALL_EVENT_ACTOR') {
      const point = projected.snapshot.key_points.find(
        candidate => candidate.key_point_id === command.payload.key_point_id,
      )
      if (point) point.ball_event_actor_roster_entry_id = command.payload.actor_roster_entry_id
    } else if (command.kind === 'MOVE_KEY_POINT' && entry.observation) {
      projected.snapshot.key_points = normalizeKeyPointOrder(
        projected.snapshot.key_points.map(point =>
          point.key_point_id === command.payload.key_point_id
            ? {
                ...point,
                capture_time_us: entry.observation!.capture_time_us,
                capture_frame_index:
                  entry.observation!.capture_frame_index ?? point.capture_frame_index,
                timing_precision: 'estimated' as const,
              }
            : point,
        ),
      )
    } else if (command.kind === 'DELETE_KEY_POINT') {
      projected.snapshot.key_points = normalizeKeyPointOrder(
        projected.snapshot.key_points.filter(
          point => point.key_point_id !== command.payload.key_point_id,
        ),
      )
    } else if (command.kind === 'SET_RALLY_OUTCOME') {
      projected.snapshot.score_resolution = command.payload.score_resolution
      projected.snapshot.scoring_court_side = command.payload.scoring_court_side
    } else if (command.kind === 'CLOSE_RALLY') {
      const target = projected.snapshot.key_points.at(-1)
      if (target) target.is_terminal = true
      projected.snapshot.annotation_status = 'ready'
      projected.snapshot.score_resolution = command.payload.score_resolution
      projected.snapshot.scoring_court_side = command.payload.scoring_court_side
    } else if (command.kind === 'REOPEN_RALLY') {
      projected.snapshot.annotation_status = 'open'
      const target = projected.snapshot.key_points.at(-1)
      if (target) target.is_terminal = false
    } else if (command.kind === 'VOID_RALLY') {
      projected.snapshot.annotation_status = 'voided'
    } else if (command.kind === 'SUBMIT_RALLY') projected.snapshot.annotation_status = 'submitted'
    normalizeProjectedBallEvents(projected)
  }
  return projected
}

export function applyAnnotationAckLocally(
  confirmed: AnnotationRallySnapshot | null,
  command: AnnotationCommand,
  ack: AnnotationCommandAck,
): AnnotationRallySnapshot | null {
  if (
    command.kind === 'START_RALLY' &&
    ack.resolved_anchor &&
    ack.effects.boundary_kind === 'start'
  ) {
    return {
      schema_version: command.schema_version,
      type: 'rally_snapshot',
      room_id: command.room_id,
      rally_id: ack.rally_id,
      revision: ack.result_revision,
      server_sequence: ack.server_sequence,
      snapshot: {
        annotation_status: 'open',
        side_assignment_id: 'pending',
        score_resolution: 'pending',
        scoring_court_side: null,
        processing_status: 'idle',
        boundaries: [
          {
            kind: 'start',
            capture_time_us: ack.resolved_anchor.capture_time_us,
            capture_frame_index: ack.resolved_anchor.capture_frame_index,
            timing_precision: ack.resolved_anchor.timing_precision,
          },
        ],
        key_points: [],
      },
    }
  }
  if (
    command.kind === 'CREATE_SERVICE_KEY_POINT' &&
    ack.resolved_anchor &&
    ack.effects.created_key_point_id
  ) {
    return {
      schema_version: '2.0.0',
      type: 'rally_snapshot',
      room_id: command.room_id,
      rally_id: ack.rally_id,
      revision: ack.result_revision,
      server_sequence: ack.server_sequence,
      snapshot: {
        annotation_status: 'open',
        side_assignment_id: 'pending',
        score_resolution: 'pending',
        scoring_court_side: null,
        processing_status: 'idle',
        key_points: [
          {
            key_point_id: ack.effects.created_key_point_id,
            sequence_index: 0,
            marker_kind: 'service',
            is_terminal: false,
            capture_time_us: ack.resolved_anchor.capture_time_us,
            capture_frame_index: ack.resolved_anchor.capture_frame_index,
            timing_precision: ack.resolved_anchor.timing_precision,
            possible_duplicate: false,
          },
        ],
      },
    }
  }
  if (
    !confirmed ||
    confirmed.rally_id !== ack.rally_id ||
    BigInt(confirmed.revision) >= BigInt(ack.result_revision)
  )
    return confirmed
  const next = structuredClone(confirmed)
  if (command.schema_version === '4.0.0') next.schema_version = '4.0.0'
  next.revision = ack.result_revision
  next.server_sequence = ack.server_sequence
  if (ack.effects.annotation_status) next.snapshot.annotation_status = ack.effects.annotation_status
  if (ack.effects.score_resolution) next.snapshot.score_resolution = ack.effects.score_resolution
  if (ack.effects.scoring_court_side !== undefined)
    next.snapshot.scoring_court_side = ack.effects.scoring_court_side
  if (command.kind === 'END_RALLY' && ack.resolved_anchor && ack.effects.boundary_kind === 'end') {
    next.schema_version = command.schema_version === '4.0.0' ? '4.0.0' : '3.0.0'
    next.snapshot.boundaries = [
      ...(next.snapshot.boundaries ?? []).filter(boundary => boundary.kind !== 'end'),
      {
        kind: 'end',
        capture_time_us: ack.resolved_anchor.capture_time_us,
        capture_frame_index: ack.resolved_anchor.capture_frame_index,
        timing_precision: ack.resolved_anchor.timing_precision,
      },
    ]
  } else if (
    command.kind === 'CREATE_CONTACT_KEY_POINT' &&
    ack.resolved_anchor &&
    ack.effects.created_key_point_id
  ) {
    const existing = next.snapshot.key_points.find(
      point => point.key_point_id === ack.effects.created_key_point_id,
    )
    if (existing) {
      if (command.payload.ball_event) existing.ball_event = command.payload.ball_event
    } else
      next.snapshot.key_points.push({
        key_point_id: ack.effects.created_key_point_id,
        sequence_index: next.snapshot.key_points.length,
        marker_kind: 'contact',
        is_terminal:
          command.payload.terminal_outcome === 'unknown' ||
          ack.effects.terminal_key_point_id === ack.effects.created_key_point_id,
        capture_time_us: ack.resolved_anchor.capture_time_us,
        capture_frame_index: ack.resolved_anchor.capture_frame_index,
        timing_precision: ack.resolved_anchor.timing_precision,
        possible_duplicate: next.snapshot.key_points.some(
          point => point.capture_frame_index === ack.resolved_anchor?.capture_frame_index,
        ),
        ...(command.payload.ball_event ? { ball_event: command.payload.ball_event } : {}),
      })
  } else if (command.kind === 'CLOSE_RALLY') {
    const target = next.snapshot.key_points.at(-1)
    if (target) target.is_terminal = true
  } else if (command.kind === 'MOVE_KEY_POINT' && ack.resolved_anchor) {
    next.snapshot.key_points = normalizeKeyPointOrder(
      next.snapshot.key_points.map(point =>
        point.key_point_id === command.payload.key_point_id
          ? {
              ...point,
              capture_time_us: ack.resolved_anchor!.capture_time_us,
              capture_frame_index: ack.resolved_anchor!.capture_frame_index,
              timing_precision: ack.resolved_anchor!.timing_precision,
            }
          : point,
      ),
    )
  } else if (command.kind === 'DELETE_KEY_POINT') {
    next.snapshot.key_points = normalizeKeyPointOrder(
      next.snapshot.key_points.filter(point => point.key_point_id !== command.payload.key_point_id),
    )
  } else if (command.kind === 'SET_BALL_EVENT') {
    const point = next.snapshot.key_points.find(
      candidate => candidate.key_point_id === command.payload.key_point_id,
    )
    if (point) point.ball_event = command.payload.event
  } else if (command.kind === 'SET_BALL_EVENT_ACTOR') {
    const point = next.snapshot.key_points.find(
      candidate => candidate.key_point_id === command.payload.key_point_id,
    )
    if (point) point.ball_event_actor_roster_entry_id = command.payload.actor_roster_entry_id
  }
  for (const repair of ack.effects.auto_corrections ?? []) {
    if (repair.action === 'tombstone') {
      next.snapshot.key_points = next.snapshot.key_points.filter(
        point => point.key_point_id !== repair.key_point_id,
      )
      continue
    }
    const point = next.snapshot.key_points.find(
      candidate => candidate.key_point_id === repair.key_point_id,
    )
    if (!point || !repair.after) continue
    point.sequence_index = repair.after.sequence_index
    if (repair.after.event) point.ball_event = repair.after.event
  }
  next.snapshot.key_points.sort(
    (left, right) =>
      left.sequence_index - right.sequence_index ||
      left.key_point_id.localeCompare(right.key_point_id),
  )
  return normalizeProjectedBallEvents(next)
}
