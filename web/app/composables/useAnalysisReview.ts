import {
  ANALYSIS_REVIEW_SCHEMA_VERSION,
  type AnalysisContactActorProjection,
  type AnalysisFrameBBox,
  type AnalysisReviewAction,
  type AnalysisReviewOperation,
  type AnalysisReviewRevisionEvent,
  type AnalysisReviewState,
} from '@volleyball-monitoring/contracts'
import type { MaybeRefOrGetter } from 'vue'
import {
  browserAllowsRealtimeConnection,
  createRealtimeReconnectScheduler,
  type RealtimeReconnectScheduler,
} from '~/lib/realtimeReconnect'

export type BallOverride =
  | { state: 'position'; position: { x: number; y: number } }
  | { state: 'missing' }

function operationKey(operation: AnalysisReviewOperation) {
  if (
    operation.op === 'set_ball_position' ||
    operation.op === 'mark_ball_missing' ||
    operation.op === 'clear_ball_override'
  )
    return `ball:${operation.frame_index}`
  if (operation.op === 'set_action' || operation.op === 'clear_action_override')
    return `action:${operation.frame_index}:${operation.track_id}`
  if (operation.op === 'set_player_bbox' || operation.op === 'clear_player_bbox_override')
    return `bbox:${operation.frame_index}:${operation.track_id}`
  if (operation.op === 'set_contact_actor' || operation.op === 'clear_contact_actor_override')
    return `actor:${operation.key_point_id}`
  if (
    operation.op === 'add_contact' ||
    operation.op === 'delete_contact' ||
    operation.op === 'restore_contact'
  )
    return `contact-edit:${operation.contact_id}`
  return `contact-time:${operation.key_point_id}`
}

export function useAnalysisReview(analysisRunId: MaybeRefOrGetter<string | null>) {
  const { analysisReviewWsUrl } = usePublicEndpoints()
  const revision = ref('0')
  const ballCorrections = shallowRef(new Map<string, BallOverride>())
  const actionCorrections = shallowRef(new Map<string, AnalysisReviewAction>())
  const playerBBoxCorrections = shallowRef(new Map<string, AnalysisFrameBBox>())
  const contactActorCorrections = shallowRef(new Map<string, number | null>())
  const contactActorProjections = shallowRef(new Map<string, AnalysisContactActorProjection>())
  const contactTimeCorrections = shallowRef(new Map<string, number>())
  const contactEdits = shallowRef(new Map<string, AnalysisReviewState['contact_edits'][number]>())
  const status = ref<AnalysisReviewState['status']>('editing')
  const computedRevision = ref<string | null>(null)
  const approvedRevision = ref<string | null>(null)
  const dirtyCount = ref(0)
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)
  const connection = ref<'idle' | 'connecting' | 'ready' | 'offline'>('idle')
  const loadedAnalysisRunId = ref<string | null>(null)
  const queued = new Map<string, AnalysisReviewOperation>()
  let socket: WebSocket | null = null
  let reconnect: RealtimeReconnectScheduler | null = null
  let generation = 0
  let flushing = false
  let projectionPoll: ReturnType<typeof setTimeout> | null = null

  function frameTrackKey(frameIndex: string | number, trackId: number) {
    return `${frameIndex}:${trackId}`
  }

  function replace(state: AnalysisReviewState) {
    const balls = new Map(
      state.ball_corrections.map(item => [
        item.frame_index,
        item.state === 'position'
          ? { state: 'position' as const, position: item.frame_pos }
          : { state: 'missing' as const },
      ]),
    )
    const actions = new Map(
      state.action_corrections.map(item => [
        frameTrackKey(item.frame_index, item.track_id),
        item.action,
      ]),
    )
    const bboxes = new Map(
      state.player_bbox_corrections.map(item => [
        frameTrackKey(item.frame_index, item.track_id),
        item.frame_bbox,
      ]),
    )
    const actors = new Map(
      state.contact_actor_corrections.map(item => [item.key_point_id, item.track_id]),
    )
    const actorProjections = new Map(
      state.contact_actor_projections.map(item => [item.key_point_id, item]),
    )
    const contactTimes = new Map(
      state.contact_time_corrections.map(item => [item.key_point_id, Number(item.frame_index)]),
    )
    const edits = new Map(state.contact_edits.map(item => [item.contact_id, item]))
    // A remote invalidation may arrive while this client still has an unsent
    // optimistic edit. Reapply the compact local queue after replacing state.
    for (const operation of queued.values()) {
      if (operation.op === 'set_ball_position')
        balls.set(operation.frame_index, { state: 'position', position: operation.frame_pos })
      else if (operation.op === 'mark_ball_missing')
        balls.set(operation.frame_index, { state: 'missing' })
      else if (operation.op === 'clear_ball_override') balls.delete(operation.frame_index)
      else if (operation.op === 'set_action')
        actions.set(frameTrackKey(operation.frame_index, operation.track_id), operation.action)
      else if (operation.op === 'clear_action_override')
        actions.delete(frameTrackKey(operation.frame_index, operation.track_id))
      else if (operation.op === 'set_player_bbox')
        bboxes.set(frameTrackKey(operation.frame_index, operation.track_id), operation.frame_bbox)
      else if (operation.op === 'clear_player_bbox_override')
        bboxes.delete(frameTrackKey(operation.frame_index, operation.track_id))
      else if (operation.op === 'set_contact_actor')
        actors.set(operation.key_point_id, operation.track_id)
      else if (operation.op === 'clear_contact_actor_override')
        actors.delete(operation.key_point_id)
      else if (operation.op === 'set_contact_time')
        contactTimes.set(operation.key_point_id, Number(operation.frame_index))
      else if (operation.op === 'clear_contact_time_override')
        contactTimes.delete(operation.key_point_id)
      else if (operation.op === 'add_contact')
        edits.set(operation.contact_id, {
          contact_id: operation.contact_id,
          base_key_point_id: null,
          frame_index: operation.frame_index,
          track_id: operation.track_id,
          deleted: false,
          revision: state.revision,
        })
      else if (operation.op === 'delete_contact') {
        const current = edits.get(operation.contact_id)
        if (current) edits.set(operation.contact_id, { ...current, deleted: true })
      } else if (operation.op === 'restore_contact') {
        const current = edits.get(operation.contact_id)
        if (current) edits.set(operation.contact_id, { ...current, deleted: false })
      }
    }
    ballCorrections.value = balls
    actionCorrections.value = actions
    playerBBoxCorrections.value = bboxes
    contactActorCorrections.value = actors
    contactActorProjections.value = actorProjections
    contactTimeCorrections.value = contactTimes
    contactEdits.value = edits
    revision.value = state.revision
    status.value = state.status
    computedRevision.value = state.computed_revision
    approvedRevision.value = state.approved_revision
    loadedAnalysisRunId.value = state.analysis_run_id
    scheduleProjectionPoll(state.analysis_run_id, actorProjections)
  }

  function scheduleProjectionPoll(
    analysisId: string,
    projections = contactActorProjections.value,
    delayMs = 750,
  ) {
    if (projectionPoll !== null) clearTimeout(projectionPoll)
    projectionPoll = null
    if (
      ![...projections.values()].some(
        item => item.status === 'pending' || item.status === 'running',
      )
    )
      return
    const currentGeneration = generation
    projectionPoll = setTimeout(() => {
      projectionPoll = null
      if (currentGeneration !== generation || toValue(analysisRunId) !== analysisId) return
      void refresh(currentGeneration).catch(cause => {
        if (currentGeneration !== generation) return
        error.value = cause instanceof Error ? cause : new Error('擊球者關聯同步失敗')
        scheduleProjectionPoll(analysisId, contactActorProjections.value, 2_000)
      })
    }, delayMs)
  }

  async function refresh(currentGeneration = generation) {
    const id = toValue(analysisRunId)
    if (!id) return
    const response = await fetch(`/api/v1/analysis-runs/${encodeURIComponent(id)}/review`, {
      credentials: 'include',
    })
    if (!response.ok) throw new Error(`分析修正同步失敗 (${response.status})`)
    const state = (await response.json()) as AnalysisReviewState
    if (currentGeneration === generation && state.analysis_run_id === id) replace(state)
  }

  function connect(currentGeneration: number) {
    const id = toValue(analysisRunId)
    if (!id || !import.meta.client) return
    if (!browserAllowsRealtimeConnection()) {
      connection.value = 'offline'
      reconnect?.schedule()
      return
    }
    if (socket && socket.readyState <= WebSocket.OPEN) return
    connection.value = 'connecting'
    let nextSocket: WebSocket
    try {
      nextSocket = new WebSocket(analysisReviewWsUrl(id))
      socket = nextSocket
    } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error('分析修正即時連線失敗')
      connection.value = 'offline'
      reconnect?.schedule()
      return
    }
    nextSocket.addEventListener('open', () => {
      if (currentGeneration !== generation || socket !== nextSocket) return
      reconnect?.connected()
      connection.value = 'ready'
      if (error.value) void refresh(currentGeneration).catch(() => undefined)
    })
    nextSocket.addEventListener('message', event => {
      if (currentGeneration !== generation) return
      let message: AnalysisReviewRevisionEvent
      try {
        message = JSON.parse(String(event.data)) as AnalysisReviewRevisionEvent
      } catch {
        return
      }
      if (
        message.type !== 'analysis_review_revision' ||
        message.analysis_run_id !== id ||
        BigInt(message.revision) <= BigInt(revision.value)
      )
        return
      void refresh(currentGeneration).catch(cause => {
        error.value = cause instanceof Error ? cause : new Error('分析修正同步失敗')
      })
    })
    nextSocket.addEventListener('close', () => {
      if (currentGeneration !== generation || socket !== nextSocket) return
      socket = null
      connection.value = 'offline'
      reconnect?.schedule()
    })
  }

  function queue(operation: AnalysisReviewOperation) {
    queued.set(operationKey(operation), operation)
    dirtyCount.value = queued.size
    status.value = 'editing'
    computedRevision.value = null
    approvedRevision.value = null
    loadedAnalysisRunId.value = null
  }

  async function flush() {
    const id = toValue(analysisRunId)
    if (!id || flushing || !queued.size || !browserAllowsRealtimeConnection()) return
    flushing = true
    pending.value = true
    const operations = [...queued.values()].slice(0, 32)
    operations.forEach(operation => queued.delete(operationKey(operation)))
    try {
      const response = await fetch(`/api/v1/analysis-runs/${encodeURIComponent(id)}/review`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION,
          client_patch_id: crypto.randomUUID(),
          base_revision: revision.value,
          operations,
        }),
      })
      if (!response.ok) throw new Error(`分析修正儲存失敗 (${response.status})`)
      const result = (await response.json()) as { revision: string }
      revision.value = result.revision
      error.value = null
      dirtyCount.value = queued.size
    } catch (cause) {
      operations.forEach(operation => queued.set(operationKey(operation), operation))
      dirtyCount.value = queued.size
      error.value = cause instanceof Error ? cause : new Error('分析修正儲存失敗')
      throw error.value
    } finally {
      flushing = false
      pending.value = false
    }
  }

  async function applyChanges() {
    while (queued.size) await flush()
    await refresh()
  }

  async function discardChanges() {
    queued.clear()
    dirtyCount.value = 0
    await refresh()
  }

  async function reviewAction(action: 'recalculate' | 'approve') {
    const id = toValue(analysisRunId)
    if (!id || queued.size) throw new Error('請先套用目前修改')
    pending.value = true
    try {
      const response = await fetch(
        `/api/v1/analysis-runs/${encodeURIComponent(id)}/review/${action}`,
        { method: 'POST', credentials: 'include' },
      )
      if (!response.ok)
        throw new Error(
          `${action === 'recalculate' ? '重新分析' : '審核發布'}失敗 (${response.status})`,
        )
      await refresh()
    } finally {
      pending.value = false
    }
  }

  const recalculate = () => reviewAction('recalculate')
  const approve = () => reviewAction('approve')

  function setBallPosition(frameIndex: number, position: { x: number; y: number }) {
    ballCorrections.value = new Map(ballCorrections.value).set(String(frameIndex), {
      state: 'position',
      position,
    })
    queue({ op: 'set_ball_position', frame_index: String(frameIndex), frame_pos: position })
  }
  function markBallMissing(frameIndex: number) {
    ballCorrections.value = new Map(ballCorrections.value).set(String(frameIndex), {
      state: 'missing',
    })
    queue({ op: 'mark_ball_missing', frame_index: String(frameIndex) })
  }
  function clearBallOverride(frameIndex: number) {
    const next = new Map(ballCorrections.value)
    next.delete(String(frameIndex))
    ballCorrections.value = next
    queue({ op: 'clear_ball_override', frame_index: String(frameIndex) })
  }
  function setAction(frameIndex: number, trackId: number, action: AnalysisReviewAction) {
    actionCorrections.value = new Map(actionCorrections.value).set(
      frameTrackKey(frameIndex, trackId),
      action,
    )
    queue({ op: 'set_action', frame_index: String(frameIndex), track_id: trackId, action })
  }
  function clearActionOverride(frameIndex: number, trackId: number) {
    const next = new Map(actionCorrections.value)
    next.delete(frameTrackKey(frameIndex, trackId))
    actionCorrections.value = next
    queue({ op: 'clear_action_override', frame_index: String(frameIndex), track_id: trackId })
  }
  function setPlayerBBox(frameIndex: number, trackId: number, frameBBox: AnalysisFrameBBox) {
    playerBBoxCorrections.value = new Map(playerBBoxCorrections.value).set(
      frameTrackKey(frameIndex, trackId),
      frameBBox,
    )
    queue({
      op: 'set_player_bbox',
      frame_index: String(frameIndex),
      track_id: trackId,
      frame_bbox: frameBBox,
    })
  }
  function clearPlayerBBoxOverride(frameIndex: number, trackId: number) {
    const next = new Map(playerBBoxCorrections.value)
    next.delete(frameTrackKey(frameIndex, trackId))
    playerBBoxCorrections.value = next
    queue({ op: 'clear_player_bbox_override', frame_index: String(frameIndex), track_id: trackId })
  }
  function setContactActor(keyPointId: string, trackId: number | null) {
    contactActorCorrections.value = new Map(contactActorCorrections.value).set(keyPointId, trackId)
    queue({ op: 'set_contact_actor', key_point_id: keyPointId, track_id: trackId })
  }
  function clearContactActorOverride(keyPointId: string) {
    const next = new Map(contactActorCorrections.value)
    next.delete(keyPointId)
    contactActorCorrections.value = next
    const projection = contactActorProjections.value.get(keyPointId)
    if (projection)
      contactActorProjections.value = new Map(contactActorProjections.value).set(keyPointId, {
        ...projection,
        status: 'pending',
        track_id: null,
        observation_frame_index: null,
        source: null,
        confidence: null,
        fallback_reason: null,
      })
    queue({ op: 'clear_contact_actor_override', key_point_id: keyPointId })
  }
  function setContactTime(keyPointId: string, frameIndex: number) {
    contactTimeCorrections.value = new Map(contactTimeCorrections.value).set(keyPointId, frameIndex)
    const projection = contactActorProjections.value.get(keyPointId)
    contactActorProjections.value = new Map(contactActorProjections.value).set(keyPointId, {
      key_point_id: keyPointId,
      frame_index: String(frameIndex),
      status: 'pending',
      track_id: null,
      observation_frame_index: null,
      source: null,
      confidence: null,
      algorithm_namespace:
        projection?.algorithm_namespace ?? 'contact-association/coco17-pose-first-v1',
      pose_recipe_namespace: projection?.pose_recipe_namespace ?? null,
      fallback_reason: null,
      revision: revision.value,
    })
    queue({ op: 'set_contact_time', key_point_id: keyPointId, frame_index: String(frameIndex) })
  }
  function clearContactTimeOverride(keyPointId: string) {
    const next = new Map(contactTimeCorrections.value)
    next.delete(keyPointId)
    contactTimeCorrections.value = next
    const projections = new Map(contactActorProjections.value)
    projections.delete(keyPointId)
    contactActorProjections.value = projections
    queue({ op: 'clear_contact_time_override', key_point_id: keyPointId })
  }
  function addContact(frameIndex: number, trackId: number | null = null) {
    const contactId = crypto.randomUUID()
    contactEdits.value = new Map(contactEdits.value).set(contactId, {
      contact_id: contactId,
      base_key_point_id: null,
      frame_index: String(frameIndex),
      track_id: trackId,
      deleted: false,
      revision: revision.value,
    })
    queue({
      op: 'add_contact',
      contact_id: contactId,
      frame_index: String(frameIndex),
      track_id: trackId,
    })
    return contactId
  }
  function deleteContact(contactId: string, frameIndex: number) {
    const current = contactEdits.value.get(contactId)
    contactEdits.value = new Map(contactEdits.value).set(
      contactId,
      current
        ? { ...current, deleted: true }
        : {
            contact_id: contactId,
            base_key_point_id: contactId,
            frame_index: String(frameIndex),
            track_id: null,
            deleted: true,
            revision: revision.value,
          },
    )
    queue({ op: 'delete_contact', contact_id: contactId })
  }
  function restoreContact(contactId: string) {
    const current = contactEdits.value.get(contactId)
    if (current)
      contactEdits.value = new Map(contactEdits.value).set(contactId, {
        ...current,
        deleted: false,
      })
    queue({ op: 'restore_contact', contact_id: contactId })
  }

  watch(
    () => toValue(analysisRunId),
    async id => {
      generation += 1
      const currentGeneration = generation
      reconnect?.dispose()
      reconnect = null
      socket?.close()
      socket = null
      queued.clear()
      revision.value = '0'
      ballCorrections.value = new Map()
      actionCorrections.value = new Map()
      playerBBoxCorrections.value = new Map()
      contactActorCorrections.value = new Map()
      contactActorProjections.value = new Map()
      contactTimeCorrections.value = new Map()
      contactEdits.value = new Map()
      dirtyCount.value = 0
      status.value = 'editing'
      computedRevision.value = null
      approvedRevision.value = null
      error.value = null
      connection.value = id ? 'connecting' : 'idle'
      if (projectionPoll !== null) clearTimeout(projectionPoll)
      projectionPoll = null
      if (!id) return
      reconnect = createRealtimeReconnectScheduler(() => connect(currentGeneration))
      try {
        await refresh(currentGeneration)
      } catch (cause) {
        if (currentGeneration === generation)
          error.value = cause instanceof Error ? cause : new Error('分析修正載入失敗')
      }
      if (currentGeneration === generation) connect(currentGeneration)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    generation += 1
    reconnect?.dispose()
    socket?.close()
    if (projectionPoll !== null) clearTimeout(projectionPoll)
  })

  return {
    actionCorrections: readonly(actionCorrections),
    ballCorrections: readonly(ballCorrections),
    connection: readonly(connection),
    contactActorCorrections: readonly(contactActorCorrections),
    contactActorProjections: readonly(contactActorProjections),
    contactTimeCorrections: readonly(contactTimeCorrections),
    contactEdits: readonly(contactEdits),
    status: readonly(status),
    computedRevision: readonly(computedRevision),
    approvedRevision: readonly(approvedRevision),
    dirtyCount: readonly(dirtyCount),
    error: readonly(error),
    loadedAnalysisRunId: readonly(loadedAnalysisRunId),
    pending: readonly(pending),
    playerBBoxCorrections: readonly(playerBBoxCorrections),
    revision: readonly(revision),
    applyChanges,
    addContact,
    approve,
    clearActionOverride,
    clearBallOverride,
    clearContactActorOverride,
    clearContactTimeOverride,
    clearPlayerBBoxOverride,
    discardChanges,
    deleteContact,
    markBallMissing,
    recalculate,
    restoreContact,
    setAction,
    setBallPosition,
    setContactActor,
    setContactTime,
    setPlayerBBox,
  }
}
