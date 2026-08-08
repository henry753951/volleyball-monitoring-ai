import {
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

export function rebaseQueuedAnnotationCommand(
  command: AnnotationCommand,
  snapshot: AnnotationRallySnapshot | null,
): AnnotationCommand | null {
  if (command.kind === 'CREATE_SERVICE_KEY_POINT') {
    return snapshot && ['open', 'ready'].includes(stateOf(snapshot) ?? '') ? null : command
  }
  if (!snapshot || snapshot.rally_id !== command.rally_id) return null
  const base = { ...command, base_revision: snapshot.revision }
  if (command.kind !== 'CLOSE_RALLY') return parseAnnotationCommand(base)
  const target = snapshot.snapshot.key_points.at(-1)
  if (!target) return null
  return parseAnnotationCommand({
    ...base,
    payload: { ...command.payload, target_key_point_id: target.key_point_id },
  })
}

function pendingPoint(entry: AnnotationOutboxEntry, sequenceIndex: number): AnnotationKeyPoint | null {
  if (!['CREATE_SERVICE_KEY_POINT', 'CREATE_CONTACT_KEY_POINT'].includes(entry.command.kind)) return null
  const observation = entry.observation
  if (!observation) return null
  return {
    key_point_id: `pending:${entry.command.command_id}`,
    sequence_index: sequenceIndex,
    marker_kind: entry.command.kind === 'CREATE_SERVICE_KEY_POINT' ? 'service' : 'contact',
    is_terminal: false,
    capture_time_us: observation.capture_time_us,
    capture_frame_index: observation.capture_frame_index ?? '0',
    timing_precision: 'estimated',
    possible_duplicate: false,
  }
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
      command.kind === 'CREATE_SERVICE_KEY_POINT'
      && (
        !projected
        || projected.rally_id !== command.rally_id
        || ['submitted', 'voided'].includes(projected.snapshot.annotation_status)
      )
    ) {
      const point = pendingPoint(entry, 0)
      if (!point || !roomId) continue
      projected = {
        schema_version: '2.0.0',
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
          key_points: [point],
        },
      }
      continue
    }
    if (!projected || projected.rally_id !== command.rally_id) continue
    if (command.kind === 'CREATE_CONTACT_KEY_POINT') {
      const point = pendingPoint(entry, projected.snapshot.key_points.length)
      if (point) projected.snapshot.key_points.push(point)
    }
    else if (command.kind === 'CLOSE_RALLY') {
      const target = projected.snapshot.key_points.at(-1)
      if (target) target.is_terminal = true
      projected.snapshot.annotation_status = 'ready'
      projected.snapshot.score_resolution = command.payload.score_resolution
      projected.snapshot.scoring_court_side = command.payload.scoring_court_side
    }
    else if (command.kind === 'SUBMIT_RALLY') projected.snapshot.annotation_status = 'submitted'
  }
  return projected
}

export function applyAnnotationAckLocally(
  confirmed: AnnotationRallySnapshot | null,
  command: AnnotationCommand,
  ack: AnnotationCommandAck,
): AnnotationRallySnapshot | null {
  if (command.kind === 'CREATE_SERVICE_KEY_POINT' && ack.resolved_anchor && ack.effects.created_key_point_id) {
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
        key_points: [{
          key_point_id: ack.effects.created_key_point_id,
          sequence_index: 0,
          marker_kind: 'service',
          is_terminal: false,
          capture_time_us: ack.resolved_anchor.capture_time_us,
          capture_frame_index: ack.resolved_anchor.capture_frame_index,
          timing_precision: ack.resolved_anchor.timing_precision,
          possible_duplicate: false,
        }],
      },
    }
  }
  if (!confirmed || confirmed.rally_id !== ack.rally_id || BigInt(confirmed.revision) >= BigInt(ack.result_revision)) return confirmed
  const next = structuredClone(confirmed)
  next.revision = ack.result_revision
  next.server_sequence = ack.server_sequence
  if (command.kind === 'CREATE_CONTACT_KEY_POINT' && ack.resolved_anchor && ack.effects.created_key_point_id) {
    next.snapshot.key_points.push({
      key_point_id: ack.effects.created_key_point_id,
      sequence_index: next.snapshot.key_points.length,
      marker_kind: 'contact',
      is_terminal: false,
      capture_time_us: ack.resolved_anchor.capture_time_us,
      capture_frame_index: ack.resolved_anchor.capture_frame_index,
      timing_precision: ack.resolved_anchor.timing_precision,
      possible_duplicate: next.snapshot.key_points.some(point => point.capture_frame_index === ack.resolved_anchor?.capture_frame_index),
    })
  }
  else if (command.kind === 'CLOSE_RALLY') {
    const target = next.snapshot.key_points.at(-1)
    if (target) target.is_terminal = true
    next.snapshot.annotation_status = 'ready'
    next.snapshot.score_resolution = command.payload.score_resolution
    next.snapshot.scoring_court_side = command.payload.scoring_court_side
  }
  else if (command.kind === 'SUBMIT_RALLY') next.snapshot.annotation_status = 'submitted'
  return next
}
