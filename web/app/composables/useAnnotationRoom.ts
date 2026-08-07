import {
  parseAnnotationCommand,
  parseAnnotationServerMessage,
  type AnnotationCommand,
  type AnnotationCommandResponse,
  type AnnotationPresenceSnapshot,
  type AnnotationRallySnapshot,
} from '@volleyball-monitoring/contracts'
import { createAnnotationRealtimeClient, type AnnotationConnectionState, type AnnotationRealtimeClient } from '../lib/annotationRealtimeClient'
import {
  enqueueAnnotationCommand,
  readAnnotationOutbox,
  requireAnnotationOutboxConfirmation,
  resolveAnnotationOutboxEntry,
  writeAnnotationOutbox,
  type AnnotationOutboxEntry,
} from '../lib/annotationOutbox'
import { createGraphQLTransport } from '../lib/coreDomain'
import type { PlaybackCursorInput } from '../lib/mediaModel'
import type { AnnotationAction } from '../utils/annotationHotkeys'

const ACTIVE_SNAPSHOT_QUERY = `query ActiveAnnotationRally($roomId: String!) {
  activeAnnotationRallySnapshot(roomId: $roomId)
}`
const SNAPSHOT_QUERY = `query AnnotationRally($roomId: String!, $rallyId: ID!) {
  annotationRallySnapshot(roomId: $roomId, rallyId: $rallyId)
}`
const CREATE_CORRECTION_DRAFT = `mutation CreateCorrectionDraft($submissionId: ID!) {
  createCorrectionDraft(submissionId: $submissionId) { id }
}`

function asSnapshot(value: unknown): AnnotationRallySnapshot | null {
  if (value === null) return null
  const parsed = parseAnnotationServerMessage(value)
  if (parsed.type !== 'rally_snapshot') throw new TypeError('Expected rally snapshot')
  return parsed
}

function annotationCursor(cursor: PlaybackCursorInput) {
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

export function useAnnotationRoom() {
  const snapshot = shallowRef<AnnotationRallySnapshot | null>(null)
  const connection = ref<AnnotationConnectionState>('closed')
  const busy = ref(false)
  const error = ref<string | null>(null)
  const roomId = ref<string | null>(null)
  const selfDeviceSessionId = ref<string | null>(null)
  const outbox = shallowRef<AnnotationOutboxEntry[]>([])
  const presence = shallowRef<AnnotationPresenceSnapshot['members']>([])
  const transport = createGraphQLTransport('/graphql')
  let realtime: AnnotationRealtimeClient | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let flushPromise: Promise<void> | null = null

  const state = computed<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'>(() => {
    const status = snapshot.value?.snapshot.annotation_status
    return status ? status.toUpperCase() as 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED' : 'IDLE'
  })
  const lastKeyPoint = computed(() => snapshot.value?.snapshot.key_points.at(-1) ?? null)
  const pendingCount = computed(() => outbox.value.length)
  const outboxNeedsConfirmation = computed(() => outbox.value.some(entry => entry.status === 'needs_confirmation'))
  const remoteEditorsByKeyPoint = computed<Record<string, string[]>>(() => {
    const editors: Record<string, string[]> = {}
    for (const member of presence.value) {
      if (!member.editing_key_point_id || member.device_session_id === selfDeviceSessionId.value) continue
      const names = editors[member.editing_key_point_id] ?? []
      if (!names.includes(member.display_name)) names.push(member.display_name)
      editors[member.editing_key_point_id] = names
    }
    return editors
  })

  function storage() { return typeof window === 'undefined' ? null : window.localStorage }
  function replaceOutbox(entries: AnnotationOutboxEntry[]) {
    outbox.value = entries
    const target = storage()
    if (!target || !roomId.value) return
    try { writeAnnotationOutbox(target, roomId.value, entries) }
    catch { error.value = '無法保存本機待送出標註；請保持此頁開啟' }
  }
  function loadOutbox() {
    const target = storage()
    outbox.value = target && roomId.value ? readAnnotationOutbox(target, roomId.value) : []
  }
  function discardPending() {
    replaceOutbox([])
    error.value = null
    void refreshActive()
  }

  function acceptSnapshot(next: AnnotationRallySnapshot | null) {
    if (!next) return
    const current = snapshot.value
    if (
      current
      && current.rally_id === next.rally_id
      && BigInt(next.server_sequence) < BigInt(current.server_sequence)
    ) return
    snapshot.value = next
  }

  async function fetchSnapshot(rallyId: string) {
    if (!roomId.value) return null
    const result = await transport.request<{ annotationRallySnapshot: unknown }>(SNAPSHOT_QUERY, {
      roomId: roomId.value,
      rallyId,
    })
    const next = asSnapshot(result.annotationRallySnapshot)
    acceptSnapshot(next)
    return next
  }

  async function refreshActive() {
    if (!roomId.value) return
    try {
      const result = await transport.request<{ activeAnnotationRallySnapshot: unknown }>(ACTIVE_SNAPSHOT_QUERY, {
        roomId: roomId.value,
      })
      const active = asSnapshot(result.activeAnnotationRallySnapshot)
      if (active) acceptSnapshot(active)
      else if (snapshot.value && state.value !== 'SUBMITTED') await fetchSnapshot(snapshot.value.rally_id)
    }
    catch (cause) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        error.value = null
        return
      }
      error.value = cause instanceof Error ? cause.message : '無法同步標註狀態'
    }
  }

  function commandMatchesCurrentRevision(command: AnnotationCommand) {
    const current = snapshot.value
    if (command.kind === 'CREATE_SERVICE_KEY_POINT') return !current || ['SUBMITTED', 'VOIDED'].includes(state.value)
    return Boolean(current && current.rally_id === command.rally_id && current.revision === command.base_revision)
  }

  function markForConfirmation(entry: AnnotationOutboxEntry, reason: string) {
    replaceOutbox(requireAnnotationOutboxConfirmation(outbox.value, entry.command.command_id, reason))
  }

  function flushOutbox() {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      for (const queued of [...outbox.value]) {
        if (!realtime?.ready() || queued.status === 'needs_confirmation') return
        if (!commandMatchesCurrentRevision(queued.command)) {
          markForConfirmation(queued, '伺服器 revision 已變更；請捨棄後在目前畫格重新操作')
          return
        }
        let response: AnnotationCommandResponse
        try { response = await realtime.send(queued.command) }
        catch { return }
        if (response.type === 'command_rejected') {
          if (response.snapshot_refetch_required) {
            if (snapshot.value) await fetchSnapshot(snapshot.value.rally_id).catch(() => null)
            markForConfirmation(queued, response.message ?? '伺服器狀態已變更；請確認後重新操作')
            return
          }
          replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, queued.command.command_id))
          error.value = response.message ?? '標註命令被拒絕'
          return
        }
        replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, queued.command.command_id))
        error.value = null
        await fetchSnapshot(response.rally_id).catch(() => refreshActive())
      }
    })().finally(() => { flushPromise = null })
    return flushPromise
  }

  function connect(nextRoomId: string) {
    if (roomId.value === nextRoomId && realtime) return
    realtime?.disconnect()
    if (refreshTimer) clearInterval(refreshTimer)
    roomId.value = nextRoomId
    snapshot.value = null
    presence.value = []
    selfDeviceSessionId.value = null
    error.value = null
    loadOutbox()
    realtime = createAnnotationRealtimeClient(nextRoomId, {
      onState: value => { connection.value = value },
      onError: (cause) => {
        if (!['Annotation WebSocket unavailable', 'Annotation connection closed before acknowledgement'].includes(cause.message)) error.value = cause.message
      },
      onMessage: (message) => {
        if (message.type === 'connection_ready') {
          selfDeviceSessionId.value = message.device_session_id
          void refreshActive().then(() => flushOutbox())
        }
        if (message.type === 'rally_snapshot') acceptSnapshot(message)
        if (message.type === 'presence_snapshot') presence.value = message.members
      },
    })
    realtime.connect()
    void refreshActive()
    refreshTimer = setInterval(() => { void refreshActive() }, 2_000)
  }

  function buildCommand(action: AnnotationAction, cursor: PlaybackCursorInput | null): AnnotationCommand {
    if (!roomId.value) throw new Error('Annotation room is not selected')
    const current = snapshot.value
    if (action === 'service') {
      if (!cursor || cursor.cursor_status !== 'ready') throw new Error('伺服器尚未取得可解析的播放游標')
      return parseAnnotationCommand({
        schema_version: '2.0.0',
        command_id: crypto.randomUUID(),
        room_id: roomId.value,
        base_revision: '0',
        rally_id: crypto.randomUUID(),
        kind: 'CREATE_SERVICE_KEY_POINT',
        payload: { playback_cursor: annotationCursor(cursor) },
      })
    }
    if (!current) throw new Error('目前沒有可操作的 Rally')
    const base = {
      schema_version: '2.0.0',
      command_id: crypto.randomUUID(),
      room_id: roomId.value,
      base_revision: current.revision,
      rally_id: current.rally_id,
    } as const
    if (action === 'contact') {
      if (!cursor || cursor.cursor_status !== 'ready') throw new Error('伺服器尚未取得可解析的播放游標')
      return parseAnnotationCommand({ ...base, kind: 'CREATE_CONTACT_KEY_POINT', payload: { playback_cursor: annotationCursor(cursor) } })
    }
    if (action === 'submit') return parseAnnotationCommand({ ...base, kind: 'SUBMIT_RALLY', payload: {} })
    const target = lastKeyPoint.value
    if (!target) throw new Error('沒有伺服器確認的最後 key point')
    if (action === 'close_unknown') {
      return parseAnnotationCommand({ ...base, kind: 'CLOSE_RALLY', payload: { target_key_point_id: target.key_point_id, score_resolution: 'unknown', scoring_court_side: null } })
    }
    return parseAnnotationCommand({
      ...base,
      kind: 'CLOSE_RALLY',
      payload: {
        target_key_point_id: target.key_point_id,
        score_resolution: 'resolved',
        scoring_court_side: action === 'close_left' ? 'left' : 'right',
      },
    })
  }

  function buildEditCommand(
    kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT' | 'REOPEN_RALLY' | 'VOID_RALLY',
    options: { keyPointId?: string; cursor?: PlaybackCursorInput | null; reason?: string } = {},
  ): AnnotationCommand {
    if (!roomId.value || !snapshot.value) throw new Error('目前沒有可編輯的 Rally')
    const base = {
      schema_version: '2.0.0',
      command_id: crypto.randomUUID(),
      room_id: roomId.value,
      base_revision: snapshot.value.revision,
      rally_id: snapshot.value.rally_id,
    } as const
    if (kind === 'REOPEN_RALLY') return parseAnnotationCommand({ ...base, kind, payload: {} })
    if (kind === 'VOID_RALLY') return parseAnnotationCommand({ ...base, kind, payload: { reason: options.reason?.trim() || 'operator_voided' } })
    if (!options.keyPointId) throw new Error('請先選擇 key point')
    if (kind === 'DELETE_KEY_POINT') return parseAnnotationCommand({ ...base, kind, payload: { key_point_id: options.keyPointId } })
    if (!options.cursor || options.cursor.cursor_status !== 'ready') throw new Error('伺服器尚未取得可解析的播放游標')
    return parseAnnotationCommand({ ...base, kind, payload: { key_point_id: options.keyPointId, playback_cursor: annotationCursor(options.cursor) } })
  }

  async function sendCommand(command: AnnotationCommand) {
    replaceOutbox(enqueueAnnotationCommand(outbox.value, command))
    if (realtime?.ready()) await flushOutbox()
  }

  async function dispatch(action: AnnotationAction, cursor: PlaybackCursorInput | null) {
    busy.value = true
    error.value = null
    try {
      return await sendCommand(buildCommand(action, cursor))
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '標註命令失敗'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  async function edit(
    kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT' | 'REOPEN_RALLY' | 'VOID_RALLY',
    options: { keyPointId?: string; cursor?: PlaybackCursorInput | null; reason?: string } = {},
  ) {
    busy.value = true
    error.value = null
    try {
      return await sendCommand(buildEditCommand(kind, options))
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '標註編輯失敗'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  async function createCorrection() {
    const submissionId = snapshot.value?.snapshot.active_submission_id
    if (!submissionId) throw new Error('目前沒有可修正的 immutable submission')
    if (state.value !== 'SUBMITTED') throw new Error('目前已經有修正草稿')
    busy.value = true
    error.value = null
    try {
      const result = await transport.request<{
        createCorrectionDraft: { id: string }
      }>(CREATE_CORRECTION_DRAFT, { submissionId })
      return await fetchSnapshot(result.createCorrectionDraft.id)
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '無法建立修正草稿'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  function setEditingKeyPoint(keyPointId: string | null) {
    realtime?.setEditingKeyPoint(keyPointId)
  }

  onBeforeUnmount(() => {
    realtime?.disconnect()
    realtime = null
    if (refreshTimer) clearInterval(refreshTimer)
  })

  return {
    busy: readonly(busy),
    connection: readonly(connection),
    connect,
    createCorrection,
    dispatch,
    edit,
    error: readonly(error),
    lastKeyPoint,
    outboxNeedsConfirmation,
    pendingCommands: shallowReadonly(outbox),
    pendingCount,
    presence: shallowReadonly(presence),
    remoteEditorsByKeyPoint,
    setEditingKeyPoint,
    discardPending,
    refreshActive,
    snapshot: shallowReadonly(snapshot),
    state,
  }
}
