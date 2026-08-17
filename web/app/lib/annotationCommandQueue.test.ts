import { describe, expect, it } from 'vitest'
import type {
  AnnotationCommand,
  AnnotationCommandAck,
  AnnotationRallySnapshot,
} from '@volleyball-monitoring/contracts'
import {
  annotationCommandConverged,
  annotationDraftOwnedByClient,
  shouldAdoptInspectedAnnotationSnapshot,
  applyAnnotationAckLocally,
  projectAnnotationSnapshot,
  rebaseQueuedAnnotationCommand,
  shouldAcceptAnnotationBroadcast,
} from './annotationCommandQueue'
import { enqueueAnnotationCommand } from './annotationOutbox'

const room =
  'match:00000000-0000-4000-8000-000000000001:capture:00000000-0000-4000-8000-000000000002'
const rally = '00000000-0000-4000-8000-000000000003'
const cursor = {
  playback_window_id: 'window',
  mapping_version: 1,
  player_media_time_us: '100',
  observation_source: 'current_time_fallback' as const,
  presented_frames: null,
  seek_generation: 1,
  cursor_status: 'ready' as const,
}

const contact = (id: string): AnnotationCommand => ({
  schema_version: '2.0.0',
  command_id: id,
  room_id: room,
  base_revision: '1',
  rally_id: rally,
  kind: 'CREATE_CONTACT_KEY_POINT',
  payload: { playback_cursor: cursor },
})
const terminal = (id: string): AnnotationCommand => ({
  schema_version: '2.0.0',
  command_id: id,
  room_id: room,
  base_revision: '1',
  rally_id: rally,
  kind: 'CREATE_CONTACT_KEY_POINT',
  payload: { playback_cursor: cursor, terminal_outcome: 'unknown' },
})
const service = (id: string, rallyId = rally): AnnotationCommand => ({
  schema_version: '2.0.0',
  command_id: id,
  room_id: room,
  base_revision: '0',
  rally_id: rallyId,
  kind: 'CREATE_SERVICE_KEY_POINT',
  payload: { playback_cursor: cursor },
})
const start = (id: string, rallyId = rally): AnnotationCommand => ({
  schema_version: '3.0.0',
  command_id: id,
  room_id: room,
  base_revision: '0',
  rally_id: rallyId,
  kind: 'START_RALLY',
  payload: { playback_cursor: cursor },
})
const end = (id: string): AnnotationCommand => ({
  schema_version: '3.0.0',
  command_id: id,
  room_id: room,
  base_revision: '1',
  rally_id: rally,
  kind: 'END_RALLY',
  payload: { playback_cursor: cursor },
})
const snapshot: AnnotationRallySnapshot = {
  schema_version: '2.0.0',
  type: 'rally_snapshot',
  room_id: room,
  rally_id: rally,
  revision: '1',
  server_sequence: '1',
  snapshot: {
    annotation_status: 'open',
    side_assignment_id: 'side',
    score_resolution: 'pending',
    scoring_court_side: null,
    processing_status: 'idle',
    key_points: [
      {
        key_point_id: 'service',
        sequence_index: 0,
        marker_kind: 'service',
        is_terminal: false,
        capture_time_us: '1000',
        capture_frame_index: '10',
        timing_precision: 'frame_exact',
        possible_duplicate: false,
      },
    ],
  },
}

describe('shouldAdoptInspectedAnnotationSnapshot', () => {
  it('keeps another client moving OPEN draft separate from the operational draft', () => {
    expect(shouldAdoptInspectedAnnotationSnapshot(snapshot, rally)).toBe(true)
    expect(
      shouldAdoptInspectedAnnotationSnapshot(snapshot, '00000000-0000-4000-8000-000000000099'),
    ).toBe(false)
  })

  it('adopts an explicitly inspected READY draft so it remains editable before submission', () => {
    const ready = structuredClone(snapshot)
    ready.snapshot.annotation_status = 'ready'
    ready.snapshot.boundaries = [
      {
        kind: 'start',
        capture_time_us: '1000',
        capture_frame_index: '10',
        timing_precision: 'frame_exact',
      },
      {
        kind: 'end',
        capture_time_us: '2000',
        capture_frame_index: '20',
        timing_precision: 'frame_exact',
      },
    ]
    expect(
      shouldAdoptInspectedAnnotationSnapshot(ready, '00000000-0000-4000-8000-000000000099'),
    ).toBe(true)
  })

  it('adopts correction drafts through their active submission lineage', () => {
    const correction = structuredClone(snapshot)
    correction.snapshot.active_submission_id = '00000000-0000-4000-8000-000000000088'
    expect(shouldAdoptInspectedAnnotationSnapshot(correction, null)).toBe(true)
  })
})

describe('annotation optimistic command queue', () => {
  it('does not let another client broadcast replace the local draft', () => {
    const peerRally = '00000000-0000-4000-8000-000000000099'
    expect(shouldAcceptAnnotationBroadcast({ currentRallyId: rally, nextRallyId: peerRally })).toBe(
      false,
    )
    expect(shouldAcceptAnnotationBroadcast({ currentRallyId: rally, nextRallyId: rally })).toBe(
      true,
    )
    expect(
      shouldAcceptAnnotationBroadcast({ nextRallyId: peerRally, pendingRallyIds: [peerRally] }),
    ).toBe(true)
    expect(
      shouldAcceptAnnotationBroadcast({ nextRallyId: peerRally, rememberedRallyId: peerRally }),
    ).toBe(true)
  })

  it('keeps an explicitly viewed peer draft read-only', () => {
    expect(annotationDraftOwnedByClient(snapshot, rally)).toBe(true)
    expect(annotationDraftOwnedByClient(snapshot, '00000000-0000-4000-8000-000000000099')).toBe(
      false,
    )
  })

  it('projects v3 Z presses as start/end boundaries without creating key points', () => {
    const started = enqueueAnnotationCommand(
      [],
      start('00000000-0000-4000-8000-000000000030'),
      new Date(),
      { observation: { capture_time_us: '1000', capture_frame_index: '10' } },
    )
    const open = projectAnnotationSnapshot(null, room, started)
    expect(open).toMatchObject({
      schema_version: '3.0.0',
      snapshot: {
        annotation_status: 'open',
        key_points: [],
        boundaries: [{ kind: 'start', capture_time_us: '1000' }],
      },
    })

    const ended = enqueueAnnotationCommand(
      [],
      end('00000000-0000-4000-8000-000000000031'),
      new Date(),
      { observation: { capture_time_us: '2000', capture_frame_index: '20' } },
    )
    const ready = projectAnnotationSnapshot(open, room, ended)
    expect(ready).toMatchObject({
      snapshot: {
        annotation_status: 'ready',
        score_resolution: 'pending',
        key_points: [],
        boundaries: [
          { kind: 'start', capture_time_us: '1000' },
          { kind: 'end', capture_time_us: '2000' },
        ],
      },
    })
  })

  it('projects the second Z as a terminal READY boundary before the acknowledgement', () => {
    const entries = enqueueAnnotationCommand(
      [],
      terminal('00000000-0000-4000-8000-000000000099'),
      new Date(),
      { observation: { capture_time_us: '2000', capture_frame_index: '20' } },
    )
    const projected = projectAnnotationSnapshot(snapshot, room, entries)
    expect(projected?.snapshot).toMatchObject({
      annotation_status: 'ready',
      score_resolution: 'unknown',
    })
    expect(projected?.snapshot.key_points.at(-1)).toMatchObject({
      marker_kind: 'contact',
      is_terminal: true,
      capture_time_us: '2000',
    })
  })
  it('shows a new service rally immediately over the previously submitted snapshot', () => {
    const nextRally = '00000000-0000-4000-8000-000000000009'
    const submitted = structuredClone(snapshot)
    submitted.snapshot.annotation_status = 'submitted'
    const entries = enqueueAnnotationCommand(
      [],
      service('00000000-0000-4000-8000-000000000010', nextRally),
      new Date(),
      { observation: { capture_time_us: '2100', capture_frame_index: '21' } },
    )
    const projected = projectAnnotationSnapshot(submitted, room, entries)
    expect(projected).toMatchObject({
      rally_id: nextRally,
      snapshot: { annotation_status: 'open' },
    })
    expect(projected?.snapshot.key_points).toEqual([
      expect.objectContaining({ marker_kind: 'service', capture_time_us: '2100' }),
    ])
  })

  it('renders rapid contacts immediately while keeping them pending', () => {
    const first = enqueueAnnotationCommand(
      [],
      contact('00000000-0000-4000-8000-000000000004'),
      new Date(),
      { observation: { capture_time_us: '1100', capture_frame_index: '11' } },
    )
    const entries = enqueueAnnotationCommand(
      first,
      contact('00000000-0000-4000-8000-000000000005'),
      new Date(),
      { observation: { capture_time_us: '1200', capture_frame_index: '12' } },
    )
    const projected = projectAnnotationSnapshot(snapshot, room, entries)
    expect(
      projected?.snapshot.key_points.map(point => [point.key_point_id, point.capture_time_us]),
    ).toEqual([
      ['service', '1000'],
      ['pending:00000000-0000-4000-8000-000000000004', '1100'],
      ['pending:00000000-0000-4000-8000-000000000005', '1200'],
    ])
  })

  it('projects and replays at most one contact for the same observed frame', () => {
    const observation = { capture_time_us: '1100', capture_frame_index: '11' }
    const first = enqueueAnnotationCommand(
      [],
      contact('00000000-0000-4000-8000-000000000040'),
      new Date(),
      { observation },
    )
    const entries = enqueueAnnotationCommand(
      first,
      contact('00000000-0000-4000-8000-000000000041'),
      new Date(),
      { observation },
    )
    expect(entries).toHaveLength(1)
    expect(projectAnnotationSnapshot(snapshot, room, entries)?.snapshot.key_points).toHaveLength(2)

    const confirmed = structuredClone(snapshot)
    confirmed.snapshot.key_points.push({
      key_point_id: 'contact-11',
      sequence_index: 1,
      marker_kind: 'contact',
      is_terminal: false,
      capture_time_us: '1100',
      capture_frame_index: '11',
      timing_precision: 'frame_exact',
      possible_duplicate: false,
    })
    expect(annotationCommandConverged(entries[0]!.command, confirmed, observation)).toBe(true)
    expect(rebaseQueuedAnnotationCommand(entries[0]!.command, confirmed, observation)).toBeNull()

    const classified = {
      ...contact('00000000-0000-4000-8000-000000000042'),
      schema_version: '4.0.0',
      payload: { playback_cursor: cursor, ball_event: { kind: 'SPIKE', result: null } },
    } as AnnotationCommand
    expect(rebaseQueuedAnnotationCommand(classified, confirmed, observation)).toMatchObject({
      kind: 'SET_BALL_EVENT',
      payload: { key_point_id: 'contact-11', event: { kind: 'SPIKE', result: null } },
    })
  })

  it('rebases each queued command to the latest confirmed revision', () => {
    const rebased = rebaseQueuedAnnotationCommand(contact('00000000-0000-4000-8000-000000000004'), {
      ...snapshot,
      revision: '8',
    })
    expect(rebased?.base_revision).toBe('8')
  })

  it('keeps a new START_RALLY queued when the previous segment is READY', () => {
    const ready = structuredClone(snapshot)
    ready.snapshot.annotation_status = 'ready'
    expect(
      rebaseQueuedAnnotationCommand(
        start('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000033'),
        ready,
      ),
    ).toMatchObject({ kind: 'START_RALLY' })
  })

  it('recognizes an END whose acknowledgement was lost after the boundary committed', () => {
    const ready = structuredClone(snapshot)
    ready.schema_version = '3.0.0'
    ready.snapshot.annotation_status = 'ready'
    ready.snapshot.boundaries = [
      {
        kind: 'start',
        capture_time_us: '1000',
        capture_frame_index: '10',
        timing_precision: 'frame_exact',
      },
      {
        kind: 'end',
        capture_time_us: '2000',
        capture_frame_index: '20',
        timing_precision: 'frame_exact',
      },
    ]
    expect(annotationCommandConverged(end('00000000-0000-4000-8000-000000000034'), ready)).toBe(
      true,
    )
  })

  it('replaces a pending point with the canonical ACK anchor', () => {
    const command = contact('00000000-0000-4000-8000-000000000004')
    const ack = {
      schema_version: '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: room,
      rally_id: rally,
      operation_kind: command.kind,
      result_revision: '2',
      server_sequence: '2',
      effects: {
        annotation_status: 'open',
        created_key_point_id: 'canonical',
        score_resolution: 'pending',
        scoring_court_side: null,
      },
      resolved_anchor: {
        playback_window_id: 'window',
        capture_session_id: 'capture',
        capture_epoch_id: 'epoch',
        dvr_segment_id: 'segment',
        source_pts: '42',
        source_time_base: { num: 1, den: 60 },
        capture_time_us: '1199',
        capture_frame_index: '12',
        resolved_player_media_time_us: '100',
        mapping_version: 1,
        snap_distance_us: '1',
        timing_precision: 'frame_exact',
      },
    } as AnnotationCommandAck
    expect(
      applyAnnotationAckLocally(snapshot, command, ack)?.snapshot.key_points.at(-1),
    ).toMatchObject({
      key_point_id: 'canonical',
      capture_time_us: '1199',
      capture_frame_index: '12',
    })
  })

  it('materializes a service ACK locally without a GraphQL round trip', () => {
    const command = service('00000000-0000-4000-8000-000000000011')
    const ack = {
      schema_version: '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: room,
      rally_id: rally,
      operation_kind: command.kind,
      result_revision: '1',
      server_sequence: '2',
      effects: {
        annotation_status: 'open',
        created_key_point_id: 'canonical-service',
        score_resolution: 'pending',
        scoring_court_side: null,
      },
      resolved_anchor: {
        playback_window_id: 'window',
        capture_session_id: 'capture',
        capture_epoch_id: 'epoch',
        dvr_segment_id: 'segment',
        source_pts: '42',
        source_time_base: { num: 1, den: 60 },
        capture_time_us: '999',
        capture_frame_index: '10',
        resolved_player_media_time_us: '100',
        mapping_version: 1,
        snap_distance_us: '1',
        timing_precision: 'frame_exact',
      },
    } as AnnotationCommandAck
    expect(applyAnnotationAckLocally(snapshot, command, ack)).toMatchObject({
      rally_id: rally,
      revision: '1',
      snapshot: {
        annotation_status: 'open',
        key_points: [{ key_point_id: 'canonical-service', capture_time_us: '999' }],
      },
    })
  })

  it('enters correction edit mode from the REOPEN_RALLY ACK', () => {
    const correction = structuredClone(snapshot)
    correction.revision = '8'
    correction.snapshot.annotation_status = 'ready'
    correction.snapshot.active_submission_id = '00000000-0000-4000-8000-000000000020'
    correction.snapshot.score_resolution = 'resolved'
    correction.snapshot.scoring_court_side = 'left'
    correction.snapshot.key_points[0]!.is_terminal = true
    const command: AnnotationCommand = {
      schema_version: '2.0.0',
      command_id: '00000000-0000-4000-8000-000000000021',
      room_id: room,
      base_revision: '8',
      rally_id: rally,
      kind: 'REOPEN_RALLY',
      payload: {},
    }
    const ack = {
      schema_version: '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: room,
      rally_id: rally,
      operation_kind: command.kind,
      result_revision: '9',
      server_sequence: '9',
      effects: {
        annotation_status: 'open',
        score_resolution: 'resolved',
        scoring_court_side: 'left',
      },
      resolved_anchor: null,
    } as AnnotationCommandAck

    expect(applyAnnotationAckLocally(correction, command, ack)).toMatchObject({
      revision: '9',
      snapshot: {
        annotation_status: 'open',
        active_submission_id: correction.snapshot.active_submission_id,
        score_resolution: 'resolved',
        scoring_court_side: 'left',
        key_points: [{ is_terminal: true }],
      },
    })
  })

  it('applies a MOVE_KEY_POINT ACK to the visible marker without waiting for a snapshot refetch', () => {
    const correction = structuredClone(snapshot)
    correction.revision = '9'
    correction.snapshot.active_submission_id = '00000000-0000-4000-8000-000000000020'
    correction.snapshot.key_points.push({
      key_point_id: 'contact',
      sequence_index: 1,
      marker_kind: 'contact',
      is_terminal: false,
      capture_time_us: '2000',
      capture_frame_index: '20',
      timing_precision: 'frame_exact',
      possible_duplicate: false,
    })
    const command: AnnotationCommand = {
      schema_version: '2.0.0',
      command_id: '00000000-0000-4000-8000-000000000022',
      room_id: room,
      base_revision: '9',
      rally_id: rally,
      kind: 'MOVE_KEY_POINT',
      payload: { key_point_id: 'contact', playback_cursor: cursor },
    }
    const ack = {
      schema_version: '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: room,
      rally_id: rally,
      operation_kind: command.kind,
      result_revision: '10',
      server_sequence: '10',
      effects: { annotation_status: 'open' },
      resolved_anchor: {
        playback_window_id: 'window',
        capture_session_id: 'capture',
        capture_epoch_id: 'epoch',
        dvr_segment_id: 'segment',
        source_pts: '42',
        source_time_base: { num: 1, den: 60 },
        capture_time_us: '2033',
        capture_frame_index: '21',
        resolved_player_media_time_us: '100',
        mapping_version: 1,
        snap_distance_us: '1',
        timing_precision: 'frame_exact',
      },
    } as AnnotationCommandAck

    expect(
      applyAnnotationAckLocally(correction, command, ack)?.snapshot.key_points[1],
    ).toMatchObject({
      key_point_id: 'contact',
      capture_time_us: '2033',
      capture_frame_index: '21',
      sequence_index: 1,
    })
  })

  it('projects v4 typed events and applies server auto-corrections without a refetch', () => {
    const current: AnnotationRallySnapshot = {
      ...structuredClone(snapshot),
      schema_version: '4.0.0',
      revision: '4',
      snapshot: {
        ...structuredClone(snapshot.snapshot),
        boundaries: [
          {
            kind: 'start',
            capture_time_us: '900',
            capture_frame_index: '9',
            timing_precision: 'frame_exact',
          },
          {
            kind: 'end',
            capture_time_us: '1400',
            capture_frame_index: '14',
            timing_precision: 'frame_exact',
          },
        ],
        key_points: [
          {
            key_point_id: 'serve',
            sequence_index: 0,
            marker_kind: 'contact',
            is_terminal: false,
            capture_time_us: '1000',
            capture_frame_index: '10',
            timing_precision: 'frame_exact',
            possible_duplicate: false,
            ball_event: { kind: 'SERVE', result: 'SUCCESS' },
          },
          {
            key_point_id: 'receive',
            sequence_index: 1,
            marker_kind: 'contact',
            is_terminal: false,
            capture_time_us: '1100',
            capture_frame_index: '11',
            timing_precision: 'frame_exact',
            possible_duplicate: false,
            ball_event: { kind: 'RECEIVE', result: 'SUCCESS' },
          },
          {
            key_point_id: 'spike',
            sequence_index: 2,
            marker_kind: 'contact',
            is_terminal: false,
            capture_time_us: '1200',
            capture_frame_index: '12',
            timing_precision: 'frame_exact',
            possible_duplicate: false,
            ball_event: { kind: 'SPIKE', result: null },
          },
          {
            key_point_id: 'late',
            sequence_index: 3,
            marker_kind: 'contact',
            is_terminal: false,
            capture_time_us: '1300',
            capture_frame_index: '13',
            timing_precision: 'frame_exact',
            possible_duplicate: false,
            ball_event: { kind: 'CONTACT', result: null },
          },
          {
            key_point_id: 'outside',
            sequence_index: 4,
            marker_kind: 'contact',
            is_terminal: false,
            capture_time_us: '1500',
            capture_frame_index: '15',
            timing_precision: 'frame_exact',
            possible_duplicate: false,
            ball_event: { kind: 'CONTACT', result: null },
          },
        ],
      },
    }
    const command: AnnotationCommand = {
      schema_version: '4.0.0',
      command_id: '00000000-0000-4000-8000-000000000040',
      room_id: room,
      base_revision: '4',
      rally_id: rally,
      kind: 'SET_BALL_EVENT',
      payload: { key_point_id: 'spike', event: { kind: 'SPIKE', result: 'SUCCESS' } },
    }
    const ack = {
      schema_version: '4.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: room,
      rally_id: rally,
      operation_kind: command.kind,
      result_revision: '5',
      server_sequence: '5',
      effects: {
        annotation_status: 'ready',
        auto_corrections: [
          {
            code: 'OUTSIDE_END_TOMBSTONED',
            key_point_id: 'outside',
            action: 'tombstone',
            before: { sequence_index: 4, event: { kind: 'CONTACT', result: null } },
            after: null,
          },
        ],
      },
      resolved_anchor: null,
    } as AnnotationCommandAck

    const next = applyAnnotationAckLocally(current, command, ack)
    expect(next?.snapshot.key_points.map(point => point.key_point_id)).toEqual([
      'serve',
      'receive',
      'spike',
      'late',
    ])
    expect(next?.snapshot.key_points[2]?.ball_event).toEqual({
      kind: 'SPIKE',
      result: 'SUCCESS',
    })
    expect(annotationCommandConverged(command, next)).toBe(true)
  })

  it('projects and converges a human actor assignment independently of event semantics', () => {
    const current: AnnotationRallySnapshot = {
      ...structuredClone(snapshot),
      schema_version: '4.0.0',
      snapshot: {
        ...structuredClone(snapshot.snapshot),
        key_points: [
          {
            ...structuredClone(snapshot.snapshot.key_points[0]!),
            ball_event: { kind: 'SERVE', result: 'SUCCESS' },
          },
        ],
      },
    }
    const command: AnnotationCommand = {
      schema_version: '4.0.0',
      command_id: '00000000-0000-4000-8000-000000000041',
      room_id: room,
      base_revision: '1',
      rally_id: rally,
      kind: 'SET_BALL_EVENT_ACTOR',
      payload: { key_point_id: 'service', actor_roster_entry_id: 'roster-11' },
    }
    const entries = enqueueAnnotationCommand([], command, new Date())
    const projected = projectAnnotationSnapshot(current, room, entries)

    expect(projected?.snapshot.key_points[0]).toMatchObject({
      ball_event: { kind: 'SERVE', result: 'SUCCESS' },
      ball_event_actor_roster_entry_id: 'roster-11',
    })
    expect(annotationCommandConverged(command, projected)).toBe(true)
  })
})
