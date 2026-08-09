import type { AnalysisReviewOperation, AnalysisReviewRevisionEvent, AnalysisReviewState, AnalysisReviewAction } from '@volleyball-monitoring/contracts'
import type { MaybeRefOrGetter } from 'vue'

const operationKey = (operation: AnalysisReviewOperation) => operation.op === 'set_ball_position'
  ? `ball:${operation.frame_index}`
  : `action:${operation.frame_index}:${operation.track_id}`

export function useAnalysisReview(analysisRunId: MaybeRefOrGetter<string | null>) {
  const { analysisReviewWsUrl } = usePublicEndpoints()
  const revision = ref('0')
  const ballCorrections = shallowRef(new Map<string, { x: number; y: number }>())
  const actionCorrections = shallowRef(new Map<string, AnalysisReviewAction>())
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)
  const connection = ref<'idle' | 'connecting' | 'ready' | 'offline'>('idle')
  const queued = new Map<string, AnalysisReviewOperation>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let flushing = false

  function actionKey(frameIndex: string | number, trackId: number) { return `${frameIndex}:${trackId}` }

  function merge(state: AnalysisReviewState, replace = false) {
    const balls = replace ? new Map<string, { x: number; y: number }>() : new Map(ballCorrections.value)
    const actions = replace ? new Map<string, AnalysisReviewAction>() : new Map(actionCorrections.value)
    for (const item of state.ball_corrections) balls.set(item.frame_index, item.frame_pos)
    for (const item of state.action_corrections) actions.set(actionKey(item.frame_index, item.track_id), item.action)
    ballCorrections.value = balls
    actionCorrections.value = actions
    revision.value = state.revision
  }

  async function refresh(afterRevision?: string, currentGeneration = generation) {
    const id = toValue(analysisRunId)
    if (!id) return
    const query = afterRevision === undefined ? '' : `?after_revision=${encodeURIComponent(afterRevision)}`
    const response = await fetch(`/api/v1/analysis-runs/${encodeURIComponent(id)}/review${query}`, { credentials: 'include' })
    if (!response.ok) throw new Error(`分析修正同步失敗 (${response.status})`)
    const state = await response.json() as AnalysisReviewState
    if (currentGeneration === generation && state.analysis_run_id === id) merge(state, afterRevision === undefined)
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
      void refresh(revision.value, currentGeneration).catch(cause => { error.value = cause instanceof Error ? cause : new Error('分析修正同步失敗') })
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
        body: JSON.stringify({ schema_version: '1.0.0', client_patch_id: crypto.randomUUID(), base_revision: revision.value, operations }),
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
    ballCorrections.value = new Map(ballCorrections.value).set(String(frameIndex), position)
    queue({ op: 'set_ball_position', frame_index: String(frameIndex), frame_pos: position })
  }

  function setAction(frameIndex: number, trackId: number, action: AnalysisReviewAction) {
    actionCorrections.value = new Map(actionCorrections.value).set(actionKey(frameIndex, trackId), action)
    queue({ op: 'set_action', frame_index: String(frameIndex), track_id: trackId, action })
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
    error.value = null
    connection.value = id ? 'connecting' : 'idle'
    if (!id) return
    try { await refresh(undefined, currentGeneration); connect(currentGeneration) }
    catch (cause) { if (currentGeneration === generation) { error.value = cause instanceof Error ? cause : new Error('分析修正載入失敗'); connection.value = 'offline' } }
  }, { immediate: true })

  onBeforeUnmount(() => {
    generation += 1
    if (flushTimer) clearTimeout(flushTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    socket?.close()
  })

  return { actionCorrections: readonly(actionCorrections), ballCorrections: readonly(ballCorrections), connection: readonly(connection), error: readonly(error), pending: readonly(pending), revision: readonly(revision), setAction, setBallPosition }
}
