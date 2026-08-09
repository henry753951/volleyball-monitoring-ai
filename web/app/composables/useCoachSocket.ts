type CoachSocketState = 'connecting' | 'online' | 'offline'

export function useCoachSocket() {
  const state = useState<CoachSocketState>('coach-socket-state', () => 'connecting')
  const latencyMs = useState<number | null>('coach-socket-latency', () => null)
  const subscribers = useState('coach-socket-subscribers', () => 0)
  let socket: WebSocket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function stopTimers() {
    if (pingTimer) clearInterval(pingTimer)
    if (retryTimer) clearTimeout(retryTimer)
    pingTimer = null
    retryTimer = null
  }

  function sendPing() {
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'ping', client_time_ms: performance.now() }))
  }

  function connect() {
    if (import.meta.server || socket || subscribers.value < 1) return
    state.value = 'connecting'
    const { coachWsUrl } = usePublicEndpoints()
    socket = new WebSocket(coachWsUrl.value)
    socket.addEventListener('open', () => {
      state.value = 'online'
      sendPing()
      pingTimer = setInterval(sendPing, 5_000)
    })
    socket.addEventListener('message', (event) => {
      try {
        const value = JSON.parse(String(event.data)) as { type?: string; client_time_ms?: number; match_id?: string; reason?: string }
        if (value.type === 'pong' && typeof value.client_time_ms === 'number') latencyMs.value = Math.max(0, Math.round(performance.now() - value.client_time_ms))
        if (value.type === 'match_state_invalidated' && typeof value.match_id === 'string') {
          window.dispatchEvent(new CustomEvent('vollyai:match-state-invalidated', { detail: value }))
        }
      }
      catch { /* Ignore non-ping service messages. */ }
    })
    socket.addEventListener('close', () => {
      socket = null
      stopTimers()
      state.value = 'offline'
      latencyMs.value = null
      if (subscribers.value > 0) retryTimer = setTimeout(connect, 2_000)
    })
    socket.addEventListener('error', () => socket?.close())
  }

  onMounted(() => {
    subscribers.value += 1
    connect()
  })
  onBeforeUnmount(() => {
    subscribers.value = Math.max(0, subscribers.value - 1)
    if (subscribers.value > 0) return
    stopTimers()
    socket?.close()
    socket = null
  })

  return { state: readonly(state), latencyMs: readonly(latencyMs) }
}
