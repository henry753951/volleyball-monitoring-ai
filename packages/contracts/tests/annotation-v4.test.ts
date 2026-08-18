import { describe, expect, it } from 'vitest'
import {
  parseAnnotationCommand,
  parseAnnotationCommandResponse,
  parseAnnotationServerMessage,
} from '../src/annotation.js'

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const room = `match:${uuid(1)}:capture:${uuid(2)}`

describe('annotation realtime v4 BallEvent contract', () => {
  it('parses selected-point BallEvent changes with unified results', () => {
    const command = {
      schema_version: '4.0.0',
      command_id: uuid(3),
      room_id: room,
      base_revision: '4',
      rally_id: uuid(4),
      kind: 'SET_BALL_EVENT',
      payload: {
        key_point_id: uuid(5),
        event: { kind: 'RECEIVE', result: 'FAILURE' },
      },
    }

    expect(parseAnnotationCommand(command)).toEqual(command)
    expect(() =>
      parseAnnotationCommand({
        ...command,
        payload: { ...command.payload, event: { kind: 'CONTACT', result: 'SUCCESS' } },
      }),
    ).toThrow()
  })

  it('parses typed keypoint creation', () => {
    const command = {
      schema_version: '4.0.0',
      command_id: uuid(3),
      room_id: room,
      base_revision: '2',
      rally_id: uuid(4),
      kind: 'CREATE_CONTACT_KEY_POINT',
      payload: {
        playback_cursor: {
          playback_window_id: 'window-1',
          mapping_version: 1,
          player_media_time_us: '1000',
          observation_source: 'request_video_frame_callback',
          seek_generation: 0,
          cursor_status: 'ready',
        },
        ball_event: { kind: 'SPIKE', result: null },
      },
    }

    expect(parseAnnotationCommand(command)).toEqual(command)
  })

  it('parses a human actor assignment or explicit clear for a selected event', () => {
    const command = {
      schema_version: '4.0.0',
      command_id: uuid(3),
      room_id: room,
      base_revision: '5',
      rally_id: uuid(4),
      kind: 'SET_BALL_EVENT_ACTOR',
      payload: {
        key_point_id: uuid(5),
        actor_roster_entry_id: uuid(7),
      },
    }

    expect(parseAnnotationCommand(command)).toEqual(command)
    expect(
      parseAnnotationCommand({
        ...command,
        payload: { ...command.payload, actor_roster_entry_id: null },
      }),
    ).toMatchObject({ payload: { actor_roster_entry_id: null } })
  })

  it('requires BallEvent semantics on every v4 snapshot keypoint', () => {
    const snapshot = {
      schema_version: '4.0.0',
      type: 'rally_snapshot',
      room_id: room,
      rally_id: uuid(4),
      revision: '3',
      server_sequence: '8',
      snapshot: {
        annotation_status: 'ready',
        side_assignment_id: uuid(6),
        score_resolution: 'pending',
        scoring_court_side: null,
        processing_status: 'idle',
        active_submission_id: null,
        boundaries: [],
        key_points: [
          {
            key_point_id: uuid(5),
            sequence_index: 0,
            marker_kind: 'contact',
            is_terminal: false,
            capture_time_us: '1000',
            capture_frame_index: '25',
            timing_precision: 'frame_exact',
            possible_duplicate: false,
            ball_event: { kind: 'SERVE', result: 'SUCCESS' },
            ball_event_actor_roster_entry_id: uuid(7),
          },
        ],
      },
    }

    expect(parseAnnotationServerMessage(snapshot)).toEqual(snapshot)
    const missing = structuredClone(snapshot)
    delete (missing.snapshot.key_points[0] as { ball_event?: unknown }).ball_event
    expect(() => parseAnnotationServerMessage(missing)).toThrow()
  })

  it('keeps an OPEN draft reconnectable after the operator selects an outcome', () => {
    expect(
      parseAnnotationServerMessage({
        schema_version: '4.0.0',
        type: 'rally_snapshot',
        room_id: room,
        rally_id: uuid(4),
        revision: '2',
        server_sequence: '9',
        snapshot: {
          annotation_status: 'open',
          side_assignment_id: uuid(6),
          score_resolution: 'unknown',
          scoring_court_side: null,
          processing_status: 'idle',
          active_submission_id: null,
          boundaries: [
            {
              kind: 'start',
              capture_time_us: '1000',
              capture_frame_index: '25',
              timing_precision: 'estimated',
            },
          ],
          key_points: [],
        },
      }),
    ).toMatchObject({ snapshot: { annotation_status: 'open', score_resolution: 'unknown' } })
  })

  it('carries deterministic automatic corrections in acknowledgements', () => {
    const response = {
      schema_version: '4.0.0',
      type: 'command_ack',
      command_id: uuid(3),
      room_id: room,
      rally_id: uuid(4),
      operation_kind: 'SET_BALL_EVENT',
      result_revision: '4',
      server_sequence: '9',
      effects: {
        auto_corrections: [
          {
            code: 'EVENT_KIND_NORMALIZED',
            key_point_id: uuid(5),
            action: 'update',
            before: { sequence_index: 2, event: { kind: 'RECEIVE', result: 'SUCCESS' } },
            after: { sequence_index: 2, event: { kind: 'CONTACT', result: null } },
          },
        ],
      },
    }

    expect(parseAnnotationCommandResponse(response)).toEqual(response)
  })
})
