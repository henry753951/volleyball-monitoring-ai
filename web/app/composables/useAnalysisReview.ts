import {
  ANALYSIS_REVIEW_SCHEMA_VERSION,
  type AnalysisFrameBBox,
  type AnalysisReviewAction,
  type AnalysisReviewOperation,
  type AnalysisReviewRevisionEvent,
  type AnalysisReviewState,
} from '@volleyball-monitoring/contracts'
import type { MaybeRefOrGetter } from 'vue'

export type BallOverride = { state: 'position'; position: { x: number; y: number } } | { state: 'missing' }

function operationKey(operation: AnalysisReviewOperation) {
  if (operation.op === 'set_ball_position' || operation.op === 'mark_ball_missing' || operation.op === 'clear_ball_override') return `ball:${operation.frame_index}`
  if (operation.op === 'set_action' || operation.op === 'clear_action_override') return `action:${operation.frame_index}:${operation.track_id}`
  if (operation.op === 'set_player_bbox' || operation.op === 'clear_player_bbox_override') return `bbox:${operation.frame_index}:${operation.track_id}`
  return `actor:${operation.key_point_id}`
}

export function useAnalysisReview(analysisRunId: MaybeRefOrGetter<string | null>) {
  const { analysisReviewWsUrl } = usePublicEndpoints()
  const revision = ref('0')
  const ballCorrections = shallowRef(new Map<string, BallOverride>())
  const actionCorrections = shallowRef(new Map<string, AnalysisReviewAction>())
  const playerBBoxCorrections = shallowRef(new Map<string, AnalysisFrameBBox>())
  const contactActorCorrections = shallowRef(new Map<string, number | null>())
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)
  const connection = ref<'idle' | 'connecting' | 'ready' | 'offline'>('idle')
  const queued = new Map<string, AnalysisReviewOperation>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let flushing = false

  function frameTrackKey(frameIndex: string | number, trackId: number) { return `${frameIndex}:${trackId}` }

  function replace(state: AnalysisReviewState) {
    const balls = new Map(state.ball_corrections.map(item => [item.frame_index, item.state === 'position' ? { state: 'position' as const, position: item.frame_pos } : { state: 'missing' as const }]))
    const actions = new Map(state.action_corrections.map(item => [frameTrackKey(item.frame_index, item.track_id), item.action]))
    const bboxes = new Map(state.player_bbox_corrections.map(item => [frameTrackKey(item.frame_index, item.track_id), item.frame_bbox]))
    const actors = new Map(state.contact_actor_corrections.map(item => [item.key_point_id, item.track_id]))
    // A remote invalidation may arrive while this client still has an unsent
    // optimistic edit. Reapply the compact local queue after replacing state.
    for (const operation of queued.values()) {
      if (operation.op === 'set_ball_position') balls.set(operation.frame_index, { state: 'position', position: operation.frame_pos })
      else if (operation.op === 'mark_ball_missing') balls.set(operation.frame_index, { state: 'missing' })
      else if (operation.op === 'clear_ball_override') balls.delete(operation.frame_index)
      else if (operation.op === 'set_action') actions.set(frameTrackKey(operation.frame_index, operation.track_id), operation.action)
      else if (operation.op === 'clear_action_override') actions.delete(frameTrackKey(operation.frame_index, operation.track_id))
      else if (operation.op === 'set_player_bbox') bboxes.set(frameTrackKey(operation.frame_index, operation.track_id), operation.frame_bbox)
      else if (operation.op === 'clear_player_bbox_override') bboxes.delete(frameTrackKey(operation.frame_index, operation.track_id))
      else if (operation.op === 'set_contact_actor') actors.set(operation.key_point_id, operation.track_id)
      else actors.delete(operation.key_point_id)
    }
    ballCorrections.value = balls
    actionCorrections.value = actions
    playerBBoxCorrections.value = bboxes
    contactActorCorrections.value = actors
    revision.value = state.revision
  }

  async function refresh(currentGeneration = generation) {
    const id = toValue(analysisRunId)
    if (!id) return
    const response = await fetch(`/api/v1/analysis-runs/${encodeURIComponent(id)}/review`, { credentials: 'include' })
    if (!response.ok) throw new Error(`分析修正同步失敗 (${response.status})`)
    const state = await response.json() as AnalysisReviewState
    if (currentGeneration === generation && state.analysis_run_id === id) replace(state)
  }

  function connect(currentGeneration: number) {
    const id = toValue(analysisRunId)
    if (!id || !import.meta.client) return
    socket?.close()
    connection.value = 'connecting'
    socket = new WebSocket(analysisReviewWsUrl(id))
    socket.addEventListener('open', () => { if (currentGeneration === generation) connection.value = 'ready' })
    socket.addEventListener('message', (event) => {
      if (currentGeneration !== generation) return
      let message: AnalysisReviewRevisionEvent
      try { message = JSON.parse(String(event.data)) as AnalysisReviewRevisionEvent }
      catch { return }
      if (message.type !== 'analysis_review_revision' || message.analysis_run_id !== id || BigInt(message.revision) <= BigInt(revision.value)) return
      void refresh(currentGeneration).catch(cause => { error.value = cause instanceof Error ? cause : new Error('分析修正同步失敗') })
    })
    socket.addEventListener('close', () => {
      if (currentGeneration !== generation) return
      connection.value = 'offline'
      reconnectTimer = setTimeout(() => connect(currentGeneration), 1_000)
    })
  }

  function queue(operation: AnalysisReviewOperation) {
    queued.set(operationKey(operation), operation)
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush() }, 70)
  }

  async function flush() {
    const id = toValue(analysisRunId)
    if (!id || flushing || !queued.size) return
    flushing = true
    pending.value = true
    const operations = [...queued.values()].slice(0, 32)
    operations.forEach(operation => queued.delete(operationKey(operation)))
    try {
      const response = await fetch(`/api/v1/analysis-runs/${encodeURIComponent(id)}/review`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION, client_patch_id: crypto.randomUUID(), base_revision: revision.value, operations }),
      })
      if (!response.ok) throw new Error(`分析修正儲存失敗 (${response.status})`)
      const result = await response.json() as { revision: string }
      revision.value = result.revision
      error.value = null
    }
    catch (cause) {
      operations.forEach(operation => queued.set(operationKey(operation), operation))
      error.value = cause instanceof Error ? cause : new Error('分析修正儲存失敗')
    }
    finally {
      flushing = false
      pending.value = false
      if (queued.size && !flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush() }, 180)
    }
  }

  function setBallPosition(frameIndex: number, position: { x: number; y: number }) {
    ballCorrections.value = new Map(ballCorrections.value).set(String(frameIndex), { state: 'position', position })
    queue({ op: 'set_ball_position', frame_index: String(frameIndex), frame_pos: position })
  }
  function markBallMissing(frameIndex: number) {
    ballCorrections.value = new Map(ballCorrections.value).set(String(frameIndex), { state: 'missing' })
    queue({ op: 'mark_ball_missing', frame_index: String(frameIndex) })
  }
  function clearBallOverride(frameIndex: number) {
    const next = new Map(ballCorrections.value); next.delete(String(frameIndex)); ballCorrections.value = next
    queue({ op: 'clear_ball_override', frame_index: String(frameIndex) })
  }
  function setAction(frameIndex: number, trackId: number, action: AnalysisReviewAction) {
    actionCorrections.value = new Map(actionCorrections.value).set(frameTrackKey(frameIndex, trackId), action)
    queue({ op: 'set_action', frame_index: String(frameIndex), track_id: trackId, action })
  }
  function clearActionOverride(frameIndex: number, trackId: number) {
    const next = new Map(actionCorrections.value); next.delete(frameTrackKey(frameIndex, trackId)); actionCorrections.value = next
    queue({ op: 'clear_action_override', frame_index: String(frameIndex), track_id: trackId })
  }
  function setPlayerBBox(frameIndex: number, trackId: number, frameBBox: AnalysisFrameBBox) {
    playerBBoxCorrections.value = new Map(playerBBoxCorrections.value).set(frameTrackKey(frameIndex, trackId), frameBBox)
    queue({ op: 'set_player_bbox', frame_index: String(frameIndex), track_id: trackId, frame_bbox: frameBBox })
  }
  function clearPlayerBBoxOverride(frameIndex: number, trackId: number) {
    const next = new Map(playerBBoxCorrections.value); next.delete(frameTrackKey(frameIndex, trackId)); playerBBoxCorrections.value = next
    queue({ op: 'clear_player_bbox_override', frame_index: String(frameIndex), track_id: trackId })
  }
  function setContactActor(keyPointId: string, trackId: number | null) {
    contactActorCorrections.value = new Map(contactActorCorrections.value).set(keyPointId, trackId)
    queue({ op: 'set_contact_actor', key_point_id: keyPointId, track_id: trackId })
  }
  function clearContactActorOverride(keyPointId: string) {
    const next = new Map(contactActorCorrections.value); next.delete(keyPointId); contactActorCorrections.value = next
    queue({ op: 'clear_contact_actor_override', key_point_id: keyPointId })
  }

  watch(() => toValue(analysisRunId), async (id) => {
    generation += 1
    const currentGeneration = generation
    if (flushTimer) clearTimeout(flushTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    flushTimer = null
    reconnectTimer = null
    socket?.close()
    socket = null
    queued.clear()
    revision.value = '0'
    ballCorrections.value = new Map()
    actionCorrections.value = new Map()
    playerBBoxCorrections.value = new Map()
    contactActorCorrections.value = new Map()
    error.value = null
    connection.value = id ? 'connecting' : 'idle'
    if (!id) return
    try { await refresh(currentGeneration); connect(currentGeneration) }
    catch (cause) { if (currentGeneration === generation) { error.value = cause instanceof Error ? cause : new Error('分析修正載入失敗'); connection.value = 'offline' } }
  }, { immediate: true })

  onBeforeUnmount(() => {
    generation += 1
    if (flushTimer) clearTimeout(flushTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    socket?.close()
  })

  return {
    actionCorrections: readonly(actionCorrections),
    ballCorrections: readonly(ballCorrections),
    connection: readonly(connection),
    contactActorCorrections: readonly(contactActorCorrections),
    error: readonly(error),
    pending: readonly(pending),
    playerBBoxCorrections: readonly(playerBBoxCorrections),
    revision: readonly(revision),
    clearActionOverride,
    clearBallOverride,
    clearContactActorOverride,
    clearPlayerBBoxOverride,
    markBallMissing,
    setAction,
    setBallPosition,
    setContactActor,
    setPlayerBBox,
  }
}
