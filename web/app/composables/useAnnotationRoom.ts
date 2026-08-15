import {
  parseAnnotationCommand,
  parseAnnotationServerMessage,
  type AnnotationCommand,
  type AnnotationCommandResponse,
  type AnnotationPresenceSnapshot,
  type AnnotationRallyProcessingUpdate,
  type AnnotationRallySnapshot,
} from '@volleyball-monitoring/contracts'
import { createAnnotationRealtimeClient, type AnnotationConnectionState, type AnnotationRealtimeClient } from '../lib/annotationRealtimeClient'
import {
  enqueueAnnotationCommand,
  markAnnotationOutboxAttempted,
  readAnnotationOutbox,
  replaceAnnotationOutboxCommand,
  resolveAnnotationOutboxEntry,
  writeAnnotationOutbox,
  type AnnotationOutboxEntry,
} from '../lib/annotationOutbox'
import {
  annotationCommandConverged,
  annotationDraftOwnedByClient,
  applyAnnotationAckLocally,
  projectAnnotationSnapshot,
  rebaseQueuedAnnotationCommand,
  shouldAcceptAnnotationBroadcast,
  type AnnotationClientObservation,
} from '../lib/annotationCommandQueue'
import { createGraphQLTransport, GraphQLRequestError } from '../lib/coreDomain'
import type { PlaybackCursorInput } from '../lib/mediaModel'
import type { AnnotationAction } from '../utils/annotationHotkeys'

const ACTIVE_SNAPSHOT_QUERY = `query ActiveAnnotationRally($roomId: String!, $deviceSessionId: ID!) {
  activeAnnotationRallySnapshot(roomId: $roomId, deviceSessionId: $deviceSessionId)
}`
const SNAPSHOT_QUERY = `query AnnotationRally($roomId: String!, $rallyId: ID!) {
  annotationRallySnapshot(roomId: $roomId, rallyId: $rallyId)
}`
const CREATE_CORRECTION_DRAFT = `mutation CreateCorrectionDraft($submissionId: ID!, $preserveAnalysisContacts: Boolean, $regenerateAnalysisContacts: Boolean, $reverseCourtSides: Boolean) {
  createCorrectionDraft(submissionId: $submissionId, preserveAnalysisContacts: $preserveAnalysisContacts, regenerateAnalysisContacts: $regenerateAnalysisContacts, reverseCourtSides: $reverseCourtSides) { id }
}`
const CANCEL_CORRECTION_DRAFT = `mutation CancelCorrectionDraft($rallyId: ID!) {
  cancelCorrectionDraft(rallyId: $rallyId) { id }
}`
const DELETE_PROCESSING_RALLY = `mutation DeleteProcessingRally($rallyId: ID!) {
  deleteProcessingRally(rallyId: $rallyId) { id processingStatus voidedAt }
}`
const DEVICE_SESSION_STORAGE_KEY = 'vollyai.annotation-device-session.v1'
const ACTIVE_RALLY_STORAGE_PREFIX = 'vollyai.annotation-active-rally.v1:'

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
  const latencyMs = ref<number | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)
  const roomId = ref<string | null>(null)
  const selfDeviceSessionId = ref<string | null>(null)
  const outbox = shallowRef<AnnotationOutboxEntry[]>([])
  const presence = shallowRef<AnnotationPresenceSnapshot['members']>([])
  const processing = shallowRef<Record<string, AnnotationRallyProcessingUpdate>>({})
  const transport = createGraphQLTransport('/graphql')
  const { annotationWsUrl } = usePublicEndpoints()
  let realtime: AnnotationRealtimeClient | null = null
  let flushPromise: Promise<void> | null = null
  let rallySelectionGeneration = 0
  let deviceSessionHint: string | null = null

  const state = computed<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'>(() => {
    const status = snapshot.value?.snapshot.annotation_status
    return status ? status.toUpperCase() as 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED' : 'IDLE'
  })
  const lastKeyPoint = computed(() => snapshot.value?.snapshot.key_points.at(-1) ?? null)
  const pendingCount = computed(() => outbox.value.length)
  const viewSnapshot = computed(() => projectAnnotationSnapshot(snapshot.value, roomId.value, outbox.value))
  const viewState = computed<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'>(() => {
    const status = viewSnapshot.value?.snapshot.annotation_status
    return status ? status.toUpperCase() as 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED' : 'IDLE'
  })
  const draftOwnedByClient = computed(() => annotationDraftOwnedByClient(viewSnapshot.value, rememberedRallyId()))
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

  // sessionStorage survives reloads while keeping separate tabs, cursors and
  // pending commands independent from one another.
  function storage() { return typeof window === 'undefined' ? null : window.sessionStorage }
  function activeRallyStorageKey() { return roomId.value ? `${ACTIVE_RALLY_STORAGE_PREFIX}${roomId.value}` : null }
  function rememberedRallyId() {
    const target = storage()
    const key = activeRallyStorageKey()
    return target && key ? target.getItem(key) : null
  }
  function rememberRallyId(rallyId: string | null) {
    const target = storage()
    const key = activeRallyStorageKey()
    if (!target || !key) return
    if (rallyId) target.setItem(key, rallyId)
    else target.removeItem(key)
  }
  function loadDeviceSessionHint() {
    if (deviceSessionHint) return deviceSessionHint
    const target = storage()
    const stored = target?.getItem(DEVICE_SESSION_STORAGE_KEY)
    deviceSessionHint = stored ?? crypto.randomUUID()
    try { target?.setItem(DEVICE_SESSION_STORAGE_KEY, deviceSessionHint) }
    catch { /* this tab still keeps the in-memory identity */ }
    return deviceSessionHint
  }
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

  function acceptSnapshot(next: AnnotationRallySnapshot | null, options: { remember?: boolean } = {}) {
    if (!next) return
    const current = snapshot.value
    if (
      current
      && current.rally_id === next.rally_id
      && BigInt(next.server_sequence) < BigInt(current.server_sequence)
    ) return
    snapshot.value = next
    if (options.remember) {
      if (['open', 'ready'].includes(next.snapshot.annotation_status)) rememberRallyId(next.rally_id)
      else if (rememberedRallyId() === next.rally_id) rememberRallyId(null)
    }
  }

  function acceptBroadcastSnapshot(next: AnnotationRallySnapshot) {
    const currentRallyId = snapshot.value?.rally_id
    const pendingRally = outbox.value.some(entry => entry.command.rally_id === next.rally_id)
    const restoredRally = rememberedRallyId() === next.rally_id
    if (!shouldAcceptAnnotationBroadcast({
      currentRallyId,
      nextRallyId: next.rally_id,
      pendingRallyIds: outbox.value.map(entry => entry.command.rally_id),
      rememberedRallyId: restoredRally ? next.rally_id : null,
    })) return
    acceptSnapshot(next, { remember: pendingRally || restoredRally })
  }

  async function requestSnapshot(rallyId: string) {
    if (!roomId.value) return null
    const result = await transport.request<{ annotationRallySnapshot: unknown }>(SNAPSHOT_QUERY, {
      roomId: roomId.value,
      rallyId,
    })
    return asSnapshot(result.annotationRallySnapshot)
  }

  async function fetchSnapshot(rallyId: string, options: { remember?: boolean } = {}) {
    const next = await requestSnapshot(rallyId)
    acceptSnapshot(next, options)
    return next
  }

  async function selectRally(rallyId: string) {
    const generation = ++rallySelectionGeneration
    const next = await requestSnapshot(rallyId)
    if (generation !== rallySelectionGeneration) return null
    acceptSnapshot(next)
    return next
  }

  async function refreshActive() {
    if (!roomId.value || !selfDeviceSessionId.value) return false
    try {
      const preferredRallyId = outbox.value[0]?.command.rally_id ?? rememberedRallyId()
      if (preferredRallyId) {
        const preferred = await requestSnapshot(preferredRallyId)
        if (preferred && ['open', 'ready'].includes(preferred.snapshot.annotation_status)) {
          acceptSnapshot(preferred, { remember: true })
          error.value = null
          return true
        }
        if (!outbox.value.some(entry => entry.command.rally_id === preferredRallyId)) rememberRallyId(null)
      }
      const result = await transport.request<{ activeAnnotationRallySnapshot: unknown }>(ACTIVE_SNAPSHOT_QUERY, {
        deviceSessionId: selfDeviceSessionId.value,
        roomId: roomId.value,
      })
      const active = asSnapshot(result.activeAnnotationRallySnapshot)
      if (active) acceptSnapshot(active, { remember: true })
      error.value = null
      return true
    }
    catch (cause) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        error.value = null
        return false
      }
      error.value = cause instanceof Error ? cause.message : '無法同步標註狀態'
      return false
    }
  }

  async function resync(options: { discardConflicts?: boolean } = {}) {
    if (!roomId.value || !realtime) throw new Error('標註工作區尚未就緒')
    busy.value = true
    error.value = null
    try {
      if (options.discardConflicts) replaceOutbox([])
      realtime.reconnect()
      const refreshed = await refreshActive()
      if (!refreshed) throw new Error(error.value ?? '無法取得最新標註狀態')
      if (realtime.ready()) await flushOutbox()
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '無法重新同步標註狀態'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  async function reconcileQueuedCommand(entry: AnnotationOutboxEntry) {
    let latest: AnnotationRallySnapshot | null
    try { latest = await requestSnapshot(entry.command.rally_id) }
    catch { return false }
    if (latest) acceptSnapshot(latest, { remember: true })
    if (annotationCommandConverged(entry.command, latest)) {
      replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, entry.command.command_id))
      error.value = null
      return true
    }
    if ((entry.retry_count ?? 0) >= 3) {
      replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, entry.command.command_id))
      error.value = null
      return true
    }
    const retry = rebaseQueuedAnnotationCommand({
      ...entry.command,
      command_id: crypto.randomUUID(),
    } as AnnotationCommand, latest)
    if (!retry) {
      replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, entry.command.command_id))
      error.value = null
      return true
    }
    replaceOutbox(outbox.value.map(candidate => candidate.command.command_id === entry.command.command_id
      ? {
          ...candidate,
          attempted_at: undefined,
          command: retry,
          reason: null,
          retry_count: (candidate.retry_count ?? 0) + 1,
          status: 'pending' as const,
        }
      : candidate))
    return true
  }

  function flushOutbox() {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      while (outbox.value.length) {
        const queued = outbox.value[0]!
        if (!realtime?.ready()) return
        if (queued.status === 'needs_confirmation') {
          if (!await reconcileQueuedCommand(queued)) return
          continue
        }
        const rebased = queued.attempted_at
          ? queued.command
          : rebaseQueuedAnnotationCommand(queued.command, snapshot.value)
        if (!rebased) {
          if (annotationCommandConverged(queued.command, snapshot.value)) {
            replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, queued.command.command_id))
            continue
          }
          if (!await reconcileQueuedCommand(queued)) return
          continue
        }
        if (rebased.base_revision !== queued.command.base_revision || JSON.stringify(rebased.payload) !== JSON.stringify(queued.command.payload)) {
          replaceOutbox(replaceAnnotationOutboxCommand(outbox.value, queued.command.command_id, rebased))
        }
        let response: AnnotationCommandResponse
        replaceOutbox(markAnnotationOutboxAttempted(outbox.value, rebased.command_id))
        try { response = await realtime.send(rebased) }
        catch { return }
        if (response.type === 'command_rejected') {
          if (
            response.snapshot_refetch_required
            || ['COMMAND_ID_REUSED', 'RALLY_ALREADY_READY', 'RALLY_NOT_OPEN'].includes(response.code)
          ) {
            const currentEntry = outbox.value.find(entry => entry.command.command_id === rebased.command_id) ?? queued
            if (!await reconcileQueuedCommand(currentEntry)) return
            continue
          }
          replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, rebased.command_id))
          error.value = response.message ?? '標註命令被拒絕'
          continue
        }
        replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, rebased.command_id))
        error.value = null
        acceptSnapshot(applyAnnotationAckLocally(snapshot.value, rebased, response), { remember: true })
      }
    })().finally(() => { flushPromise = null })
    return flushPromise
  }

  function connect(nextRoomId: string) {
    if (roomId.value === nextRoomId && realtime) return
    realtime?.disconnect()
    roomId.value = nextRoomId
    snapshot.value = null
    presence.value = []
    processing.value = {}
    selfDeviceSessionId.value = null
    error.value = null
    loadOutbox()
    realtime = createAnnotationRealtimeClient(nextRoomId, {
      onState: value => { connection.value = value },
      onLatency: value => { latencyMs.value = value },
      onError: (cause) => {
        if (!['Annotation WebSocket unavailable', 'Annotation connection closed before acknowledgement'].includes(cause.message)) error.value = cause.message
      },
      onMessage: (message) => {
        if (message.type === 'connection_ready') {
          selfDeviceSessionId.value = message.device_session_id
          void refreshActive().then(() => flushOutbox())
        }
        if (message.type === 'rally_snapshot') acceptBroadcastSnapshot(message)
        if (message.type === 'presence_snapshot') presence.value = message.members
        if (message.type === 'rally_processing_update') {
          processing.value = { ...processing.value, [message.rally_id]: message }
          if (snapshot.value?.rally_id === message.rally_id) {
            snapshot.value = {
              ...snapshot.value,
              snapshot: {
                ...snapshot.value.snapshot,
                processing_status: message.processing_status,
              },
            }
          }
        }
      },
    }, annotationWsUrl.value, loadDeviceSessionHint())
    realtime.connect()
  }

  function buildCommand(action: AnnotationAction, cursor: PlaybackCursorInput | null): AnnotationCommand {
    if (!roomId.value) throw new Error('Annotation room is not selected')
    const current = viewSnapshot.value
    if (action === 'service') {
      if (!cursor || cursor.cursor_status !== 'ready') throw new Error('伺服器尚未取得可解析的播放游標')
      if (current?.snapshot.annotation_status === 'open' && !current.snapshot.active_submission_id && annotationDraftOwnedByClient(current, rememberedRallyId())) {
        return parseAnnotationCommand({
          schema_version: '3.0.0',
          command_id: crypto.randomUUID(),
          room_id: roomId.value,
          base_revision: current.revision,
          rally_id: current.rally_id,
          kind: 'END_RALLY',
          payload: { playback_cursor: annotationCursor(cursor) },
        })
      }
      return parseAnnotationCommand({
        schema_version: '3.0.0',
        command_id: crypto.randomUUID(),
        room_id: roomId.value,
        base_revision: '0',
        rally_id: crypto.randomUUID(),
        kind: 'START_RALLY',
        payload: { playback_cursor: annotationCursor(cursor) },
      })
    }
    if (current && ['open', 'ready'].includes(current.snapshot.annotation_status) && !annotationDraftOwnedByClient(current, rememberedRallyId())) {
      throw new Error('這個片段屬於另一個標註客戶端，只能檢視')
    }
    const pendingService = outbox.value.find(entry => entry.status === 'pending' && ['START_RALLY', 'CREATE_SERVICE_KEY_POINT'].includes(entry.command.kind))?.command
    const rallyId = current?.rally_id ?? pendingService?.rally_id
    if (!rallyId) throw new Error('目前沒有可操作的 Rally')
    const base = {
      schema_version: '3.0.0',
      command_id: crypto.randomUUID(),
      room_id: roomId.value,
      base_revision: current?.revision ?? '0',
      rally_id: rallyId,
    } as const
    if (action === 'contact') {
      if (!cursor || cursor.cursor_status !== 'ready') throw new Error('伺服器尚未取得可解析的播放游標')
      return parseAnnotationCommand({ ...base, kind: 'CREATE_CONTACT_KEY_POINT', payload: { playback_cursor: annotationCursor(cursor) } })
    }
    if (action === 'submit') return parseAnnotationCommand({ ...base, kind: 'SUBMIT_RALLY', payload: {} })
    if (action === 'close_unknown') {
      return parseAnnotationCommand({ ...base, schema_version: '3.0.0', kind: 'SET_RALLY_OUTCOME', payload: { score_resolution: 'unknown', scoring_court_side: null } })
    }
    return parseAnnotationCommand({
      ...base,
      schema_version: '3.0.0',
      kind: 'SET_RALLY_OUTCOME',
      payload: {
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
    if (!annotationDraftOwnedByClient(snapshot.value, rememberedRallyId())) throw new Error('這個片段屬於另一個標註客戶端，只能檢視')
    const base = {
      schema_version: '3.0.0',
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

  async function flushQueuedCommand(commandId: string) {
    await flushOutbox()
    // A command can be enqueued while an existing flush is leaving its loop but
    // before flushPromise is cleared. In that narrow window the first await
    // resolves without having seen the new entry, so give this command one
    // fresh pass instead of leaving it stranded until another WS event occurs.
    if (realtime?.ready() && outbox.value.some(entry => entry.command.command_id === commandId && entry.status === 'pending')) {
      await flushOutbox()
    }
  }

  function sendCommand(command: AnnotationCommand, observation?: AnnotationClientObservation) {
    if (command.kind === 'START_RALLY' || command.kind === 'CREATE_SERVICE_KEY_POINT') {
      rememberRallyId(command.rally_id)
    }
    replaceOutbox(enqueueAnnotationCommand(outbox.value, command, new Date(), { ...(observation ? { observation } : {}) }))
    return realtime?.ready() ? flushQueuedCommand(command.command_id) : Promise.resolve()
  }

  function dispatch(action: AnnotationAction, cursor: PlaybackCursorInput | null, observation?: AnnotationClientObservation) {
    error.value = null
    try {
      void sendCommand(buildCommand(action, cursor), observation)
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '標註命令失敗'
      throw cause
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

  async function createCorrection(targetSubmissionId?: string, options: { preserveAnalysisContacts?: boolean; regenerateAnalysisContacts?: boolean; reverseCourtSides?: boolean } = {}) {
    const submissionId = targetSubmissionId ?? snapshot.value?.snapshot.active_submission_id
    if (!submissionId) throw new Error('目前沒有可修正的已送出片段')
    if (!targetSubmissionId && (state.value === 'OPEN' || state.value === 'READY')) throw new Error('請先完成目前的標記片段')
    busy.value = true
    error.value = null
    try {
      const result = await transport.request<{
        createCorrectionDraft: { id: string }
      }>(CREATE_CORRECTION_DRAFT, {
        preserveAnalysisContacts: options.preserveAnalysisContacts ?? false,
        regenerateAnalysisContacts: options.regenerateAnalysisContacts ?? false,
        reverseCourtSides: options.reverseCourtSides ?? false,
        submissionId,
      })
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

  async function submitCorrection() {
    if (state.value !== 'OPEN' && state.value !== 'READY') throw new Error('目前沒有可送出的修正草稿')
    busy.value = true
    error.value = null
    try {
      return await sendCommand(buildCommand('submit', null))
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '無法送出修正草稿'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  async function cancelCorrection(targetRallyId?: string) {
    const rallyId = targetRallyId ?? snapshot.value?.rally_id
    const failedSubmittedCorrection = state.value === 'SUBMITTED'
      && snapshot.value?.snapshot.processing_status === 'failed'
    const currentSnapshotCanCancel = Boolean(
      snapshot.value?.snapshot.active_submission_id
      && (['OPEN', 'READY'].includes(state.value) || failedSubmittedCorrection),
    )
    if (!rallyId || (!targetRallyId && !currentSnapshotCanCancel)) {
      throw new Error('目前沒有可取消的修正版草稿')
    }
    // Cancellation is also the recovery path when a correction edit is stuck
    // locally. Discard this Rally's queued commands before deleting the draft
    // so a delayed REOPEN/MOVE cannot revive or mutate it afterward.
    replaceOutbox(outbox.value.filter(entry => entry.command.rally_id !== rallyId))
    busy.value = true
    error.value = null
    try {
      const result = await transport.request<{ cancelCorrectionDraft: { id: string } }>(CANCEL_CORRECTION_DRAFT, { rallyId })
      const restored = await fetchSnapshot(rallyId)
      if (restored) return restored
      await refreshActive()
      return result.cancelCorrectionDraft
    }
    catch (cause) {
      if (cause instanceof GraphQLRequestError && cause.code === 'NOT_FOUND') {
        forgetRally(rallyId)
        await refreshActive()
        error.value = null
        return null
      }
      error.value = cause instanceof Error ? cause.message : '無法取消修正版草稿'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  async function deleteProcessingRally(rallyId: string) {
    busy.value = true
    error.value = null
    try {
      const result = await transport.request<{
        deleteProcessingRally: { id: string; processingStatus: string; voidedAt: string | null }
      }>(DELETE_PROCESSING_RALLY, { rallyId })
      if (snapshot.value?.rally_id === rallyId) snapshot.value = null
      await refreshActive()
      return result.deleteProcessingRally
    }
    catch (cause) {
      if (cause instanceof GraphQLRequestError && cause.code === 'NOT_FOUND') {
        forgetRally(rallyId)
        await refreshActive()
        error.value = null
        return null
      }
      error.value = cause instanceof Error ? cause.message : '無法刪除處理中片段'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  function setEditingKeyPoint(keyPointId: string | null) {
    realtime?.setEditingKeyPoint(keyPointId)
  }

  function forgetRally(rallyId: string) {
    // A hard-deleted Rally must not retain offline commands. Otherwise a later
    // reconnect can replay them against the deleted id and surface a misleading
    // `Rally was not found` after the deletion already succeeded.
    replaceOutbox(outbox.value.filter(entry => entry.command.rally_id !== rallyId))
    if (snapshot.value?.rally_id === rallyId) snapshot.value = null
    const remaining = { ...processing.value }
    delete remaining[rallyId]
    processing.value = remaining
  }

  onBeforeUnmount(() => {
    realtime?.disconnect()
    realtime = null
  })

  return {
    busy: readonly(busy),
    connection: readonly(connection),
    latencyMs: readonly(latencyMs),
    connect,
    cancelCorrection,
    createCorrection,
    deleteProcessingRally,
    dispatch,
    draftOwnedByClient,
    edit,
    error: readonly(error),
    forgetRally,
    lastKeyPoint,
    outboxNeedsConfirmation,
    pendingCommands: shallowReadonly(outbox),
    pendingCount,
    presence: shallowReadonly(presence),
    processing: shallowReadonly(processing),
    remoteEditorsByKeyPoint,
    resync,
    selectRally,
    setEditingKeyPoint,
    submitCorrection,
    discardPending,
    refreshActive,
    snapshot: shallowReadonly(snapshot),
    state,
    viewSnapshot,
    viewState,
  }
}
