import {
  parseAnnotationServerMessage,
  type AnnotationCommand,
  type AnnotationCommandResponse,
  type AnnotationPresenceSnapshot,
  type AnnotationRallyProcessingUpdate,
  type AnnotationRallySnapshot,
  type BallEventRepair,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'
import {
  computed,
  readonly,
  ref,
  shallowReadonly,
  shallowRef,
  toValue,
  type MaybeRefOrGetter,
} from 'vue'
import {
  createAnnotationRealtimeClient,
  type AnnotationCursorStatus,
  type AnnotationConnectionState,
  type AnnotationRealtimeClient,
} from '~/lib/annotationRealtimeClient'
import {
  enqueueAnnotationCommand,
  compactAnnotationOutbox,
  markAnnotationOutboxAttempted,
  readAnnotationOutbox,
  replaceAnnotationOutboxCommand,
  resolveAnnotationOutboxKeyPointReference,
  resolveAnnotationOutboxEntry,
  writeAnnotationOutbox,
  type AnnotationOutboxEntry,
} from '~/lib/annotationOutbox'
import {
  annotationCommandConverged,
  annotationDraftOwnedByClient,
  applyAnnotationAckLocally,
  projectAnnotationSnapshot,
  rebaseQueuedAnnotationCommand,
  shouldAdoptInspectedAnnotationSnapshot,
  shouldAcceptAnnotationBroadcast,
  type AnnotationClientObservation,
} from '~/lib/annotationCommandQueue'
import { createGraphQLTransport, GraphQLRequestError } from '~/lib/coreDomain'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import type { AnnotationAction } from '~/utils/annotationHotkeys'
import { createAnnotationCommandService } from './annotation-command.service'

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
const PRESENCE_NICKNAME_STORAGE_KEY = 'vollyai.annotation-presence-nickname.v1'
const DEFAULT_PRESENCE_NICKNAME = '標記者'
const MAX_PRESENCE_NICKNAME_LENGTH = 24
const ACTIVE_RALLY_STORAGE_PREFIX = 'vollyai.annotation-active-rally.v1:'
const SERVER_SEQUENCE_STORAGE_PREFIX = 'vollyai.annotation-server-sequence.v1:'

function asSnapshot(value: unknown): AnnotationRallySnapshot | null {
  if (value === null) return null
  const parsed = parseAnnotationServerMessage(value)
  if (parsed.type !== 'rally_snapshot') throw new TypeError('Expected rally snapshot')
  return parsed
}

export function createAnnotationRoomService(annotationWsUrl: MaybeRefOrGetter<string>) {
  const snapshot = shallowRef<AnnotationRallySnapshot | null>(null)
  const roomSnapshots = shallowRef<Record<string, AnnotationRallySnapshot>>({})
  const connection = ref<AnnotationConnectionState>('closed')
  const latencyMs = ref<number | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)
  const roomId = ref<string | null>(null)
  const selfDeviceSessionId = ref<string | null>(null)
  const outbox = shallowRef<AnnotationOutboxEntry[]>([])
  const presence = shallowRef<AnnotationPresenceSnapshot['members']>([])
  const presenceNickname = ref(DEFAULT_PRESENCE_NICKNAME)
  const processing = shallowRef<Record<string, AnnotationRallyProcessingUpdate>>({})
  const lastAutoCorrections = shallowRef<BallEventRepair[]>([])
  const resolvedKeyPointIds = shallowRef<Record<string, string>>({})
  const transport = createGraphQLTransport('/graphql')
  let realtime: AnnotationRealtimeClient | null = null
  let flushPromise: Promise<void> | null = null
  let flushScheduled = false
  let rallySelectionGeneration = 0
  let deviceSessionHint: string | null = null
  const rememberedRallyIdState = ref<string | null>(null)

  const state = computed<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'>(() => {
    const status = snapshot.value?.snapshot.annotation_status
    return status ? (status.toUpperCase() as 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED') : 'IDLE'
  })
  const lastKeyPoint = computed(() => snapshot.value?.snapshot.key_points.at(-1) ?? null)
  const pendingCount = computed(() => outbox.value.length)
  const activeRoomSnapshots = computed(() => Object.values(roomSnapshots.value))
  const viewSnapshot = computed(() =>
    projectAnnotationSnapshot(snapshot.value, roomId.value, outbox.value),
  )
  const viewState = computed<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'>(() => {
    const status = viewSnapshot.value?.snapshot.annotation_status
    return status ? (status.toUpperCase() as 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED') : 'IDLE'
  })
  const draftOwnedByClient = computed(() =>
    annotationDraftOwnedByClient(viewSnapshot.value, rememberedRallyId()),
  )
  const outboxNeedsConfirmation = computed(() =>
    outbox.value.some(entry => entry.status === 'needs_confirmation'),
  )
  const remoteEditorsByKeyPoint = computed<Record<string, string[]>>(() => {
    const editors: Record<string, string[]> = {}
    for (const member of presence.value) {
      if (!member.editing_key_point_id || member.device_session_id === selfDeviceSessionId.value)
        continue
      const names = editors[member.editing_key_point_id] ?? []
      if (!names.includes(member.display_name)) names.push(member.display_name)
      editors[member.editing_key_point_id] = names
    }
    return editors
  })
  const remoteCursors = computed(() =>
    presence.value.flatMap(member => {
      if (member.device_session_id === selfDeviceSessionId.value) return []
      const captureTimeUs = member.cursor_capture_time_us
      if (!captureTimeUs || !/^\d+$/.test(captureTimeUs)) return []
      return [
        {
          deviceSessionId: member.device_session_id,
          displayName: member.display_name,
          captureTimeUs,
          status: member.cursor_status ?? 'ready',
        },
      ]
    }),
  )

  // sessionStorage survives reloads while keeping separate tabs, cursors and
  // pending commands independent from one another.
  function storage() {
    return typeof window === 'undefined' ? null : window.sessionStorage
  }
  function activeRallyStorageKey() {
    return roomId.value ? `${ACTIVE_RALLY_STORAGE_PREFIX}${roomId.value}` : null
  }
  function serverSequenceStorageKey(targetRoomId = roomId.value) {
    return targetRoomId ? `${SERVER_SEQUENCE_STORAGE_PREFIX}${targetRoomId}` : null
  }
  function readServerSequence(targetRoomId = roomId.value) {
    const target = storage()
    const key = serverSequenceStorageKey(targetRoomId)
    const value = target && key ? target.getItem(key) : null
    return value && /^\d+$/.test(value) ? value : null
  }
  function recordServerSequence(value: string, targetRoomId = roomId.value) {
    if (!/^\d+$/.test(value)) return
    const target = storage()
    const key = serverSequenceStorageKey(targetRoomId)
    if (!target || !key) return
    const current = readServerSequence(targetRoomId)
    if (current !== null && BigInt(value) <= BigInt(current)) return
    try {
      target.setItem(key, value)
    } catch {
      /* durable commands remain recoverable from the local outbox */
    }
  }
  function rememberedRallyId() {
    return rememberedRallyIdState.value
  }
  function rememberRallyId(rallyId: string | null) {
    rememberedRallyIdState.value = rallyId
    const target = storage()
    const key = activeRallyStorageKey()
    if (!target || !key) return
    if (rallyId) target.setItem(key, rallyId)
    else target.removeItem(key)
  }

  const commandService = createAnnotationCommandService({
    roomId: () => roomId.value,
    viewSnapshot: () => viewSnapshot.value,
    confirmedSnapshot: () => snapshot.value,
    outbox: () => outbox.value,
    rememberedRallyId,
  })
  function loadDeviceSessionHint() {
    if (deviceSessionHint) return deviceSessionHint
    const target = storage()
    const stored = target?.getItem(DEVICE_SESSION_STORAGE_KEY)
    deviceSessionHint = stored ?? crypto.randomUUID()
    try {
      target?.setItem(DEVICE_SESSION_STORAGE_KEY, deviceSessionHint)
    } catch {
      /* this tab still keeps the in-memory identity */
    }
    return deviceSessionHint
  }
  function normalizePresenceNickname(value: string) {
    const normalized = Array.from(value)
      .filter(character => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint >= 0x20 && codePoint !== 0x7f
      })
      .join('')
      .trim()
      .replace(/\s+/gu, ' ')
    return Array.from(normalized).slice(0, MAX_PRESENCE_NICKNAME_LENGTH).join('')
  }
  function loadPresenceNickname() {
    const stored = storage()?.getItem(PRESENCE_NICKNAME_STORAGE_KEY)
    presenceNickname.value = normalizePresenceNickname(stored ?? '') || DEFAULT_PRESENCE_NICKNAME
    return presenceNickname.value
  }
  function setPresenceNickname(value: string) {
    const next = normalizePresenceNickname(value) || DEFAULT_PRESENCE_NICKNAME
    const changed = presenceNickname.value !== next
    presenceNickname.value = next
    try {
      storage()?.setItem(PRESENCE_NICKNAME_STORAGE_KEY, next)
    } catch {
      /* the in-memory nickname still applies to this connection */
    }
    if (changed) realtime?.reconnect()
    return next
  }
  function replaceOutbox(entries: AnnotationOutboxEntry[]) {
    outbox.value = entries
    const target = storage()
    if (!target || !roomId.value) return
    try {
      writeAnnotationOutbox(target, roomId.value, entries)
    } catch {
      error.value = '無法保存本機待送出標註；請保持此頁開啟'
    }
  }
  function loadOutbox() {
    const target = storage()
    outbox.value =
      target && roomId.value
        ? compactAnnotationOutbox(readAnnotationOutbox(target, roomId.value))
        : []
    if (target && roomId.value) {
      try {
        writeAnnotationOutbox(target, roomId.value, outbox.value)
      } catch {
        error.value = '無法整理本機待同步標註；請保持此頁開啟'
      }
    }
  }
  function discardPending() {
    replaceOutbox([])
    error.value = null
    void refreshActive()
  }

  function rememberRoomSnapshot(next: AnnotationRallySnapshot) {
    const current = roomSnapshots.value[next.rally_id]
    if (
      current &&
      (BigInt(next.server_sequence) < BigInt(current.server_sequence) ||
        (next.server_sequence === current.server_sequence &&
          BigInt(next.revision) < BigInt(current.revision)))
    )
      return
    const updated = { ...roomSnapshots.value }
    if (['open', 'ready'].includes(next.snapshot.annotation_status)) updated[next.rally_id] = next
    else Reflect.deleteProperty(updated, next.rally_id)
    roomSnapshots.value = updated
  }

  function removeRoomSnapshot(rallyId: string) {
    if (!roomSnapshots.value[rallyId]) return
    const updated = { ...roomSnapshots.value }
    Reflect.deleteProperty(updated, rallyId)
    roomSnapshots.value = updated
  }

  function acceptSnapshot(
    next: AnnotationRallySnapshot | null,
    options: { remember?: boolean } = {},
  ) {
    if (!next) return
    rememberRoomSnapshot(next)
    const current = snapshot.value
    if (
      current &&
      current.rally_id === next.rally_id &&
      BigInt(next.server_sequence) < BigInt(current.server_sequence)
    )
      return
    snapshot.value = next
    if (options.remember) {
      if (['open', 'ready'].includes(next.snapshot.annotation_status))
        rememberRallyId(next.rally_id)
      else if (rememberedRallyId() === next.rally_id) rememberRallyId(null)
    }
  }

  function acceptBroadcastSnapshot(next: AnnotationRallySnapshot) {
    rememberRoomSnapshot(next)
    const currentRallyId = snapshot.value?.rally_id
    const pendingRally = outbox.value.some(entry => entry.command.rally_id === next.rally_id)
    const restoredRally = rememberedRallyId() === next.rally_id
    if (
      !shouldAcceptAnnotationBroadcast({
        currentRallyId,
        nextRallyId: next.rally_id,
        pendingRallyIds: outbox.value.map(entry => entry.command.rally_id),
        rememberedRallyId: restoredRally ? next.rally_id : null,
      })
    )
      return
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
    // A deliberate timeline selection is local editing intent. Remember both
    // OPEN and READY targets so commands and reconnects stay on the selected
    // draft; passive broadcasts still cannot activate another Rally.
    if (shouldAdoptInspectedAnnotationSnapshot(next)) acceptSnapshot(next, { remember: true })
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
        if (!outbox.value.some(entry => entry.command.rally_id === preferredRallyId))
          rememberRallyId(null)
      }
      const result = await transport.request<{ activeAnnotationRallySnapshot: unknown }>(
        ACTIVE_SNAPSHOT_QUERY,
        {
          deviceSessionId: selfDeviceSessionId.value,
          roomId: roomId.value,
        },
      )
      const active = asSnapshot(result.activeAnnotationRallySnapshot)
      if (active) acceptSnapshot(active, { remember: true })
      error.value = null
      return true
    } catch (cause) {
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
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '無法重新同步標註狀態'
      throw cause
    } finally {
      busy.value = false
    }
  }

  async function reconcileQueuedCommand(entry: AnnotationOutboxEntry) {
    let latest: AnnotationRallySnapshot | null
    try {
      latest = await requestSnapshot(entry.command.rally_id)
    } catch {
      return false
    }
    if (latest) acceptSnapshot(latest, { remember: true })
    if (annotationCommandConverged(entry.command, latest, entry.observation)) {
      replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, entry.command.command_id))
      error.value = null
      return true
    }
    if ((entry.retry_count ?? 0) >= 3) {
      replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, entry.command.command_id))
      error.value = null
      return true
    }
    const retry = rebaseQueuedAnnotationCommand(
      {
        ...entry.command,
        command_id: crypto.randomUUID(),
      } as AnnotationCommand,
      latest,
      entry.observation,
    )
    if (!retry) {
      replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, entry.command.command_id))
      error.value = null
      return true
    }
    replaceOutbox(
      outbox.value.map(candidate =>
        candidate.command.command_id === entry.command.command_id
          ? {
              ...candidate,
              attempted_at: undefined,
              command: retry,
              reason: null,
              retry_count: (candidate.retry_count ?? 0) + 1,
              status: 'pending' as const,
            }
          : candidate,
      ),
    )
    return true
  }

  function flushOutbox() {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      while (outbox.value.length) {
        const queued = outbox.value[0]!
        if (!realtime?.ready()) return
        if (queued.status === 'needs_confirmation') {
          if (!(await reconcileQueuedCommand(queued))) return
          continue
        }
        const rebased = queued.attempted_at
          ? queued.command
          : rebaseQueuedAnnotationCommand(queued.command, snapshot.value, queued.observation)
        if (!rebased) {
          if (annotationCommandConverged(queued.command, snapshot.value, queued.observation)) {
            replaceOutbox(resolveAnnotationOutboxEntry(outbox.value, queued.command.command_id))
            continue
          }
          if (!(await reconcileQueuedCommand(queued))) return
          continue
        }
        if (
          rebased.base_revision !== queued.command.base_revision ||
          JSON.stringify(rebased.payload) !== JSON.stringify(queued.command.payload)
        ) {
          replaceOutbox(
            replaceAnnotationOutboxCommand(outbox.value, queued.command.command_id, rebased),
          )
        }
        let response: AnnotationCommandResponse
        replaceOutbox(markAnnotationOutboxAttempted(outbox.value, rebased.command_id))
        try {
          response = await realtime.send(rebased)
        } catch {
          return
        }
        if (response.type === 'command_rejected') {
          if (
            response.snapshot_refetch_required ||
            ['COMMAND_ID_REUSED', 'RALLY_ALREADY_READY', 'RALLY_NOT_OPEN'].includes(response.code)
          ) {
            const currentEntry =
              outbox.value.find(entry => entry.command.command_id === rebased.command_id) ?? queued
            if (!(await reconcileQueuedCommand(currentEntry))) return
            continue
          }
          const rejectedNewRally =
            rebased.kind === 'START_RALLY' || rebased.kind === 'CREATE_SERVICE_KEY_POINT'
          replaceOutbox(
            rejectedNewRally
              ? outbox.value.filter(entry => entry.command.rally_id !== rebased.rally_id)
              : resolveAnnotationOutboxEntry(outbox.value, rebased.command_id),
          )
          if (rejectedNewRally) {
            removeRoomSnapshot(rebased.rally_id)
            if (snapshot.value?.rally_id === rebased.rally_id) snapshot.value = null
            if (rememberedRallyId() === rebased.rally_id) rememberRallyId(null)
          }
          error.value = response.message ?? '標註命令被拒絕'
          continue
        }
        let remaining = resolveAnnotationOutboxEntry(outbox.value, rebased.command_id)
        if (
          (rebased.kind === 'CREATE_SERVICE_KEY_POINT' ||
            rebased.kind === 'CREATE_CONTACT_KEY_POINT') &&
          response.effects.created_key_point_id
        ) {
          resolvedKeyPointIds.value = {
            ...resolvedKeyPointIds.value,
            [`pending:${rebased.command_id}`]: response.effects.created_key_point_id,
          }
          remaining = resolveAnnotationOutboxKeyPointReference(
            remaining,
            `pending:${rebased.command_id}`,
            response.effects.created_key_point_id,
          )
        }
        replaceOutbox(remaining)
        error.value = null
        lastAutoCorrections.value = response.effects.auto_corrections ?? []
        acceptSnapshot(applyAnnotationAckLocally(snapshot.value, rebased, response), {
          remember: true,
        })
      }
    })().finally(() => {
      flushPromise = null
    })
    return flushPromise
  }

  function connect(nextRoomId: string) {
    if (roomId.value === nextRoomId && realtime) return
    realtime?.disconnect()
    roomId.value = nextRoomId
    const target = storage()
    const key = activeRallyStorageKey()
    rememberedRallyIdState.value = target && key ? target.getItem(key) : null
    snapshot.value = null
    roomSnapshots.value = {}
    presence.value = []
    processing.value = {}
    resolvedKeyPointIds.value = {}
    selfDeviceSessionId.value = null
    error.value = null
    loadOutbox()
    loadPresenceNickname()
    realtime = createAnnotationRealtimeClient(
      nextRoomId,
      {
        onState: value => {
          connection.value = value
        },
        onLatency: value => {
          latencyMs.value = value
        },
        onError: cause => {
          if (
            ![
              'Annotation WebSocket unavailable',
              'Annotation connection closed before acknowledgement',
            ].includes(cause.message)
          )
            error.value = cause.message
        },
        resumeFromServerSequence: () => readServerSequence(nextRoomId),
        presenceNickname: () => presenceNickname.value,
        onServerSequence: value => recordServerSequence(value, nextRoomId),
        onMessage: message => {
          if (message.type === 'connection_ready') {
            selfDeviceSessionId.value = message.device_session_id
            scheduleOutboxFlush()
            void refreshActive().then(() => scheduleOutboxFlush())
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
      },
      toValue(annotationWsUrl),
      loadDeviceSessionHint(),
    )
    realtime.connect()
  }

  function buildCommand(
    action: AnnotationAction,
    cursor: PlaybackCursorInput | null,
    options: {
      observation?: AnnotationClientObservation
      selectedKeyPointId?: string | null
    } = {},
  ): AnnotationCommand {
    return commandService.buildActionCommand(action, cursor, options)
  }

  function buildEditCommand(
    kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT' | 'REOPEN_RALLY' | 'VOID_RALLY',
    options: { keyPointId?: string; cursor?: PlaybackCursorInput | null; reason?: string } = {},
  ): AnnotationCommand {
    return commandService.buildEditCommand(kind, options)
  }

  async function flushQueuedCommand(commandId: string) {
    await flushOutbox()
    // A command can be enqueued while an existing flush is leaving its loop but
    // before flushPromise is cleared. In that narrow window the first await
    // resolves without having seen the new entry, so give this command one
    // fresh pass instead of leaving it stranded until another WS event occurs.
    if (
      realtime?.ready() &&
      outbox.value.some(
        entry => entry.command.command_id === commandId && entry.status === 'pending',
      )
    ) {
      await flushOutbox()
    }
  }

  function scheduleOutboxFlush(commandId?: string) {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      const task = commandId ? flushQueuedCommand(commandId) : flushOutbox()
      void task.catch(cause => {
        error.value = cause instanceof Error ? cause.message : '背景同步標註失敗'
      })
    })
  }

  function sendCommand(command: AnnotationCommand, observation?: AnnotationClientObservation) {
    if (command.kind === 'START_RALLY' || command.kind === 'CREATE_SERVICE_KEY_POINT') {
      rememberRallyId(command.rally_id)
    }
    replaceOutbox(
      enqueueAnnotationCommand(outbox.value, command, new Date(), {
        ...(observation ? { observation } : {}),
      }),
    )
    if (realtime?.ready()) scheduleOutboxFlush(command.command_id)
    return Promise.resolve()
  }

  async function dispatch(
    action: AnnotationAction,
    cursor: PlaybackCursorInput | null,
    observation?: AnnotationClientObservation,
    selectedKeyPointId?: string | null,
  ) {
    error.value = null
    try {
      return await sendCommand(
        buildCommand(action, cursor, { observation, selectedKeyPointId }),
        observation,
      )
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '標註命令失敗'
      throw cause
    }
  }

  async function edit(
    kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT' | 'REOPEN_RALLY' | 'VOID_RALLY',
    options: {
      keyPointId?: string
      cursor?: PlaybackCursorInput | null
      reason?: string
      observation?: AnnotationClientObservation
    } = {},
  ) {
    error.value = null
    try {
      return await sendCommand(buildEditCommand(kind, options), options.observation)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '標註編輯失敗'
      throw cause
    }
  }

  async function setBallEvent(keyPointId: string, event: BallEventValue) {
    error.value = null
    try {
      return await sendCommand(commandService.buildSetBallEventCommand(keyPointId, event))
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '球種更新失敗'
      throw cause
    }
  }

  async function setBallEventActor(keyPointId: string, actorRosterEntryId: string | null) {
    error.value = null
    try {
      return await sendCommand(
        commandService.buildSetBallEventActorCommand(keyPointId, actorRosterEntryId),
      )
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '球員關聯更新失敗'
      throw cause
    }
  }

  async function createCorrection(
    targetSubmissionId?: string,
    options: {
      preserveAnalysisContacts?: boolean
      regenerateAnalysisContacts?: boolean
      reverseCourtSides?: boolean
    } = {},
  ) {
    const submissionId = targetSubmissionId ?? snapshot.value?.snapshot.active_submission_id
    if (!submissionId) throw new Error('目前沒有可修正的已送出片段')
    if (!targetSubmissionId && (state.value === 'OPEN' || state.value === 'READY'))
      throw new Error('請先完成目前的標記片段')
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
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '無法建立修正草稿'
      throw cause
    } finally {
      busy.value = false
    }
  }

  async function submitCorrection() {
    if (state.value !== 'OPEN' && state.value !== 'READY')
      throw new Error('目前沒有可送出的修正草稿')
    error.value = null
    try {
      return await sendCommand(buildCommand('submit', null))
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '無法送出修正草稿'
      throw cause
    }
  }

  async function cancelCorrection(targetRallyId?: string) {
    const rallyId = targetRallyId ?? snapshot.value?.rally_id
    const failedSubmittedCorrection =
      state.value === 'SUBMITTED' && snapshot.value?.snapshot.processing_status === 'failed'
    const currentSnapshotCanCancel = Boolean(
      snapshot.value?.snapshot.active_submission_id &&
      (['OPEN', 'READY'].includes(state.value) || failedSubmittedCorrection),
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
      const result = await transport.request<{ cancelCorrectionDraft: { id: string } }>(
        CANCEL_CORRECTION_DRAFT,
        { rallyId },
      )
      const restored = await fetchSnapshot(rallyId)
      if (restored) return restored
      await refreshActive()
      return result.cancelCorrectionDraft
    } catch (cause) {
      if (cause instanceof GraphQLRequestError && cause.code === 'NOT_FOUND') {
        forgetRally(rallyId)
        await refreshActive()
        error.value = null
        return null
      }
      error.value = cause instanceof Error ? cause.message : '無法取消修正版草稿'
      throw cause
    } finally {
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
    } catch (cause) {
      if (cause instanceof GraphQLRequestError && cause.code === 'NOT_FOUND') {
        forgetRally(rallyId)
        await refreshActive()
        error.value = null
        return null
      }
      error.value = cause instanceof Error ? cause.message : '無法刪除處理中片段'
      throw cause
    } finally {
      busy.value = false
    }
  }

  function setEditingKeyPoint(keyPointId: string | null) {
    realtime?.setEditingKeyPoint(keyPointId)
  }

  function setPlaybackCursor(captureTimeUs: string | null, status: AnnotationCursorStatus) {
    realtime?.setPlaybackCursor(captureTimeUs, status)
  }

  function forgetRally(rallyId: string) {
    // A hard-deleted Rally must not retain offline commands. Otherwise a later
    // reconnect can replay them against the deleted id and surface a misleading
    // `Rally was not found` after the deletion already succeeded.
    replaceOutbox(outbox.value.filter(entry => entry.command.rally_id !== rallyId))
    if (snapshot.value?.rally_id === rallyId) snapshot.value = null
    removeRoomSnapshot(rallyId)
    if (rememberedRallyId() === rallyId) rememberRallyId(null)
    const remaining = { ...processing.value }
    Reflect.deleteProperty(remaining, rallyId)
    processing.value = remaining
  }

  function dispose() {
    realtime?.disconnect()
    realtime = null
  }

  return {
    activeRoomSnapshots,
    busy: readonly(busy),
    connection: readonly(connection),
    latencyMs: readonly(latencyMs),
    lastAutoCorrections: shallowReadonly(lastAutoCorrections),
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
    resolvedKeyPointIds: shallowReadonly(resolvedKeyPointIds),
    pendingCount,
    presence: shallowReadonly(presence),
    presenceNickname: readonly(presenceNickname),
    processing: shallowReadonly(processing),
    remoteEditorsByKeyPoint,
    remoteCursors,
    resync,
    selectRally,
    setEditingKeyPoint,
    setPlaybackCursor,
    setPresenceNickname,
    setBallEvent,
    setBallEventActor,
    submitCorrection,
    discardPending,
    refreshActive,
    snapshot: shallowReadonly(snapshot),
    state,
    viewSnapshot,
    viewState,
    dispose,
  }
}
