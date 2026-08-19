import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import type { AnnotationOutboxEntry } from '~/lib/annotationOutbox'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import { createAnnotationCommandService } from './annotation-command.service'

const roomId =
  'match:00000000-0000-4000-8000-000000000001:capture:00000000-0000-4000-8000-000000000002'
const rallyId = '00000000-0000-4000-8000-000000000003'
const cursor: PlaybackCursorInput = {
  schema_version: '1.0.0',
  playback_window_id: 'window',
  mapping_version: 1,
  player_media_time_us: '100',
  observation_source: 'current_time_fallback',
  presented_frames: null,
  seek_generation: 1,
  cursor_status: 'ready',
}

function snapshot(status: 'open' | 'ready' = 'open'): AnnotationRallySnapshot {
  return {
    schema_version: '4.0.0',
    type: 'rally_snapshot',
    room_id: roomId,
    rally_id: rallyId,
    revision: '3',
    server_sequence: '3',
    snapshot: {
      annotation_status: status,
      side_assignment_id: 'side',
      score_resolution: 'pending',
      scoring_court_side: null,
      processing_status: 'idle',
      boundaries: [
        {
          kind: 'start',
          capture_time_us: '1000',
          capture_frame_index: '10',
          timing_precision: 'frame_exact',
        },
      ],
      key_points: [
        {
          key_point_id: 'first',
          sequence_index: 0,
          marker_kind: 'contact',
          is_terminal: false,
          capture_time_us: '1100',
          capture_frame_index: '11',
          timing_precision: 'frame_exact',
          possible_duplicate: false,
          ball_event: { kind: 'SERVE', result: null },
        },
        {
          key_point_id: 'second',
          sequence_index: 1,
          marker_kind: 'contact',
          is_terminal: false,
          capture_time_us: '1200',
          capture_frame_index: '12',
          timing_precision: 'frame_exact',
          possible_duplicate: false,
          ball_event: { kind: 'RECEIVE', result: null },
        },
      ],
    },
  }
}

function service(current: AnnotationRallySnapshot | null, remembered = rallyId) {
  let sequence = 0
  return createAnnotationCommandService({
    roomId: () => roomId,
    viewSnapshot: () => current,
    confirmedSnapshot: () => current,
    outbox: () => [] as AnnotationOutboxEntry[],
    rememberedRallyId: () => remembered,
    createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  })
}

describe('createAnnotationCommandService', () => {
  it('treats Z as END for the selected open draft regardless of editor', () => {
    const command = service(snapshot()).buildActionCommand('service', cursor)
    expect(command.kind).toBe('END_RALLY')

    const peerCommand = service(snapshot(), 'peer-rally').buildActionCommand('service', cursor)
    expect(peerCommand.kind).toBe('END_RALLY')
    expect(peerCommand.rally_id).toBe(rallyId)
  })

  it('keeps READY drafts editable for contacts and ball-event changes', () => {
    const commandService = service(snapshot('ready'))
    expect(commandService.buildActionCommand('contact', cursor).kind).toBe(
      'CREATE_CONTACT_KEY_POINT',
    )
    expect(
      commandService.buildSetBallEventCommand('second', {
        kind: 'RECEIVE',
        result: 'SUCCESS',
      }),
    ).toMatchObject({
      kind: 'SET_BALL_EVENT',
      payload: { key_point_id: 'second' },
    })
  })

  it('uses V/B only for the selected typed event and keeps C ordinal validation', () => {
    const current = snapshot()
    current.snapshot.key_points.push({
      key_point_id: 'third',
      sequence_index: 2,
      marker_kind: 'contact',
      is_terminal: false,
      capture_time_us: '1300',
      capture_frame_index: '13',
      timing_precision: 'frame_exact',
      possible_duplicate: false,
      ball_event: { kind: 'SPIKE', result: null },
    })
    const commandService = service(current)
    expect(
      commandService.buildActionCommand('event_success', cursor, {
        selectedKeyPointId: 'second',
      }),
    ).toMatchObject({
      kind: 'SET_BALL_EVENT',
      payload: {
        key_point_id: 'second',
        event: { kind: 'RECEIVE', result: 'SUCCESS' },
      },
    })
    expect(() =>
      commandService.buildActionCommand('spike', cursor, { selectedKeyPointId: 'second' }),
    ).toThrow('殺球只能標在第三球以後')
    expect(
      commandService.buildActionCommand('event_failure', cursor, {
        selectedKeyPointId: 'third',
      }),
    ).toMatchObject({
      kind: 'SET_BALL_EVENT',
      payload: {
        key_point_id: 'third',
        event: { kind: 'SPIKE', result: 'FAILURE' },
      },
    })
    expect(() =>
      commandService.buildActionCommand('event_failure', cursor, { selectedKeyPointId: null }),
    ).toThrow('請先選擇要標記結果的球點')
  })

  it('allows edits against a peer-owned editable draft', () => {
    expect(
      service(snapshot(), 'peer-rally').buildEditCommand('DELETE_KEY_POINT', {
        keyPointId: 'second',
      }),
    ).toMatchObject({
      kind: 'DELETE_KEY_POINT',
      rally_id: rallyId,
    })
  })
})
