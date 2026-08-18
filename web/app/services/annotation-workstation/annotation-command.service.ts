import {
  decideBallEventShortcut,
  parseAnnotationCommand,
  resultForBallEventChoice,
  type AnnotationCommand,
  type AnnotationRallySnapshot,
  type BallEventShortcut,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'
import {
  annotationDraftOwnedByClient,
  type AnnotationClientObservation,
} from '~/lib/annotationCommandQueue'
import type { AnnotationOutboxEntry } from '~/lib/annotationOutbox'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import type { AnnotationAction } from '~/utils/annotationHotkeys'

export interface AnnotationCommandServiceContext {
  roomId: () => string | null
  viewSnapshot: () => AnnotationRallySnapshot | null
  confirmedSnapshot: () => AnnotationRallySnapshot | null
  outbox: () => readonly AnnotationOutboxEntry[]
  rememberedRallyId: () => string | null
  createId?: () => string
}

export interface AnnotationActionCommandOptions {
  observation?: AnnotationClientObservation
  selectedKeyPointId?: string | null
}

export interface AnnotationEditCommandOptions {
  keyPointId?: string
  cursor?: PlaybackCursorInput | null
  reason?: string
}

function resolvedCursor(cursor: PlaybackCursorInput) {
  if (cursor.schema_version === '2.0.0') {
    return {
      media_backend: cursor.media_backend,
      capture_session_id: cursor.capture_session_id,
      presentation_anchor_sequence: cursor.presentation_anchor_sequence,
      program_date_time: cursor.program_date_time,
      player_media_time_us: cursor.player_media_time_us,
      observation_source: cursor.observation_source,
      presented_frames: cursor.presented_frames ?? null,
      seek_generation: cursor.seek_generation,
      cursor_status: cursor.cursor_status,
    }
  }
  return {
    playback_window_id: cursor.playback_window_id,
    mapping_version: cursor.mapping_version,
    player_media_time_us: cursor.player_media_time_us,
    observation_source: cursor.observation_source,
    presented_frames: cursor.presented_frames ?? null,
    seek_generation: cursor.seek_generation,
    cursor_status: cursor.cursor_status,
  }
}

function requireResolvedCursor(cursor: PlaybackCursorInput | null) {
  if (!cursor || cursor.cursor_status !== 'ready') {
    throw new Error('伺服器尚未取得可解析的播放游標')
  }
  return resolvedCursor(cursor)
}

export function createAnnotationCommandService(context: AnnotationCommandServiceContext) {
  const createId = context.createId ?? (() => crypto.randomUUID())

  function requireRoomId() {
    const roomId = context.roomId()
    if (!roomId) throw new Error('Annotation room is not selected')
    return roomId
  }

  function assertClientOwned(snapshot: AnnotationRallySnapshot | null) {
    if (
      snapshot &&
      ['open', 'ready'].includes(snapshot.snapshot.annotation_status) &&
      !annotationDraftOwnedByClient(snapshot, context.rememberedRallyId())
    ) {
      throw new Error('這個片段屬於另一個標註客戶端，只能檢視')
    }
  }

  function actionBase() {
    const roomId = requireRoomId()
    const current = context.viewSnapshot()
    assertClientOwned(current)
    const pendingStart = context
      .outbox()
      .find(
        entry =>
          entry.status === 'pending' &&
          ['START_RALLY', 'CREATE_SERVICE_KEY_POINT'].includes(entry.command.kind),
      )?.command
    const rallyId = current?.rally_id ?? pendingStart?.rally_id
    if (!rallyId) throw new Error('目前沒有可操作的 Rally')
    return {
      current,
      base: {
        schema_version: '4.0.0',
        command_id: createId(),
        room_id: roomId,
        base_revision: current?.revision ?? '0',
        rally_id: rallyId,
      } as const,
    }
  }

  function buildActionCommand(
    action: AnnotationAction,
    cursor: PlaybackCursorInput | null,
    options: AnnotationActionCommandOptions = {},
  ): AnnotationCommand {
    const roomId = requireRoomId()
    const current = context.viewSnapshot()
    if (action === 'service') {
      const playbackCursor = requireResolvedCursor(cursor)
      const boundaries = current?.snapshot.boundaries ?? []
      const hasActiveLocalSegment =
        current?.snapshot.annotation_status === 'open' &&
        !current.snapshot.active_submission_id &&
        annotationDraftOwnedByClient(current, context.rememberedRallyId()) &&
        boundaries.some(boundary => boundary.kind === 'start') &&
        !boundaries.some(boundary => boundary.kind === 'end')
      if (hasActiveLocalSegment) {
        return parseAnnotationCommand({
          schema_version: '4.0.0',
          command_id: createId(),
          room_id: roomId,
          base_revision: current.revision,
          rally_id: current.rally_id,
          kind: 'END_RALLY',
          payload: { playback_cursor: playbackCursor },
        })
      }
      return parseAnnotationCommand({
        schema_version: '4.0.0',
        command_id: createId(),
        room_id: roomId,
        base_revision: '0',
        rally_id: createId(),
        kind: 'START_RALLY',
        payload: { playback_cursor: playbackCursor },
      })
    }

    const { current: editable, base } = actionBase()
    if (action === 'contact') {
      return parseAnnotationCommand({
        ...base,
        kind: 'CREATE_CONTACT_KEY_POINT',
        payload: { playback_cursor: requireResolvedCursor(cursor) },
      })
    }
    if (action === 'spike') {
      const shortcut: BallEventShortcut = 'C'
      const observation = options.observation
      const decision = decideBallEventShortcut({
        shortcut,
        points:
          editable?.snapshot.key_points.map(point => ({
            key_point_id: point.key_point_id,
            sequence_index: point.sequence_index,
            capture_time_us: point.capture_time_us,
            capture_frame_index: point.capture_frame_index,
            event: point.ball_event ?? null,
          })) ?? [],
        boundaries: editable?.snapshot.boundaries,
        selected_key_point_id: options.selectedKeyPointId,
        candidate_anchor:
          observation?.capture_frame_index && observation.capture_time_us
            ? {
                capture_time_us: observation.capture_time_us,
                capture_frame_index: observation.capture_frame_index,
              }
            : null,
      })
      if (!decision.allowed) {
        const reasons = {
          NO_TARGET_POINT: '請先選擇擊球點，或等待目前畫格確認',
          SPIKE_REQUIRES_THIRD_POINT: '殺球只能標在第三球以後',
          OUTSIDE_RALLY_BOUNDARY: '目前畫格不在片段範圍內',
        } as const
        throw new Error(reasons[decision.reason])
      }
      if (decision.mode === 'update' && decision.key_point_id) {
        return parseAnnotationCommand({
          ...base,
          kind: 'SET_BALL_EVENT',
          payload: { key_point_id: decision.key_point_id, event: decision.event },
        })
      }
      return parseAnnotationCommand({
        ...base,
        kind: 'CREATE_CONTACT_KEY_POINT',
        payload: {
          playback_cursor: requireResolvedCursor(cursor),
          ball_event: decision.event,
        },
      })
    }
    if (action === 'event_success' || action === 'event_failure') {
      const keyPointId = options.selectedKeyPointId
      if (!keyPointId) throw new Error('請先選擇要標記結果的球點')
      const point = editable?.snapshot.key_points.find(item => item.key_point_id === keyPointId)
      const event = point?.ball_event
      if (!event) throw new Error('所選球點尚未建立球種資料')
      if (event.kind === 'CONTACT') throw new Error('請先將球點改為發球、接球或殺球')
      const nextResult = resultForBallEventChoice(
        event.kind,
        action === 'event_success' ? 'SUCCESS' : 'FAILURE',
      )
      return parseAnnotationCommand({
        ...base,
        kind: 'SET_BALL_EVENT',
        payload: {
          key_point_id: keyPointId,
          event: {
            ...event,
            result: event.result === nextResult ? null : nextResult,
          },
        },
      })
    }
    if (action === 'submit') {
      return parseAnnotationCommand({ ...base, kind: 'SUBMIT_RALLY', payload: {} })
    }
    if (action === 'close_unknown') {
      return parseAnnotationCommand({
        ...base,
        kind: 'SET_RALLY_OUTCOME',
        payload: { score_resolution: 'unknown', scoring_court_side: null },
      })
    }
    return parseAnnotationCommand({
      ...base,
      kind: 'SET_RALLY_OUTCOME',
      payload: {
        score_resolution: 'resolved',
        scoring_court_side: action === 'close_left' ? 'left' : 'right',
      },
    })
  }

  function buildEditCommand(
    kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT' | 'REOPEN_RALLY' | 'VOID_RALLY',
    options: AnnotationEditCommandOptions = {},
  ): AnnotationCommand {
    const roomId = requireRoomId()
    const snapshot = context.confirmedSnapshot()
    if (!snapshot) throw new Error('目前沒有可編輯的 Rally')
    assertClientOwned(snapshot)
    const base = {
      schema_version: '4.0.0',
      command_id: createId(),
      room_id: roomId,
      base_revision: snapshot.revision,
      rally_id: snapshot.rally_id,
    } as const
    if (kind === 'REOPEN_RALLY') return parseAnnotationCommand({ ...base, kind, payload: {} })
    if (kind === 'VOID_RALLY') {
      return parseAnnotationCommand({
        ...base,
        kind,
        payload: { reason: options.reason?.trim() || 'operator_voided' },
      })
    }
    if (!options.keyPointId) throw new Error('請先選擇 key point')
    if (kind === 'DELETE_KEY_POINT') {
      return parseAnnotationCommand({
        ...base,
        kind,
        payload: { key_point_id: options.keyPointId },
      })
    }
    return parseAnnotationCommand({
      ...base,
      kind,
      payload: {
        key_point_id: options.keyPointId,
        playback_cursor: requireResolvedCursor(options.cursor ?? null),
      },
    })
  }

  function buildSetBallEventCommand(keyPointId: string, event: BallEventValue) {
    const roomId = requireRoomId()
    const snapshot = context.confirmedSnapshot()
    if (!snapshot) throw new Error('目前沒有可編輯的 Rally')
    assertClientOwned(snapshot)
    return parseAnnotationCommand({
      schema_version: '4.0.0',
      command_id: createId(),
      room_id: roomId,
      base_revision: snapshot.revision,
      rally_id: snapshot.rally_id,
      kind: 'SET_BALL_EVENT',
      payload: { key_point_id: keyPointId, event },
    })
  }

  function buildSetBallEventActorCommand(keyPointId: string, actorRosterEntryId: string | null) {
    const roomId = requireRoomId()
    const snapshot = context.confirmedSnapshot()
    if (!snapshot) throw new Error('目前沒有可編輯的 Rally')
    assertClientOwned(snapshot)
    return parseAnnotationCommand({
      schema_version: '4.0.0',
      command_id: createId(),
      room_id: roomId,
      base_revision: snapshot.revision,
      rally_id: snapshot.rally_id,
      kind: 'SET_BALL_EVENT_ACTOR',
      payload: {
        key_point_id: keyPointId,
        actor_roster_entry_id: actorRosterEntryId,
      },
    })
  }

  return {
    buildActionCommand,
    buildEditCommand,
    buildSetBallEventCommand,
    buildSetBallEventActorCommand,
  }
}
