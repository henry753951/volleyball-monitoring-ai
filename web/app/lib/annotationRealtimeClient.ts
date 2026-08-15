import {
  parseAnnotationServerMessage,
  parseAnnotationSoftLockIntent,
  type AnnotationCommand,
  type AnnotationCommandResponse,
  type AnnotationServerMessage,
} from '@volleyball-monitoring/contracts'
import {
  browserAllowsRealtimeConnection,
  createRealtimeReconnectScheduler,
} from './realtimeReconnect'

export type AnnotationConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed'

interface AnnotationRealtimeHandlers {
  onMessage?: (message: AnnotationServerMessage) => void
  onState?: (state: AnnotationConnectionState) => void
  onLatency?: (latencyMs: number | null) => void
  onError?: (error: Error) => void
}

export interface AnnotationRealtimeClient {
  connect(): void
  disconnect(): void
  reconnect(): void
  send(command: AnnotationCommand): Promise<AnnotationCommandResponse>
  setEditingKeyPoint(keyPointId: string | null): boolean
  ready(): boolean
}

export function createAnnotationRealtimeClient(
  roomId: string,
  handlers: AnnotationRealtimeHandlers = {},
  endpoint?: string,
  deviceSessionId?: string,
): AnnotationRealtimeClient {
  let socket: WebSocket | null = null
  let stopped = false
  let softLockTimer: ReturnType<typeof setInterval> | null = null
  let connectionReady = false
  let editingKeyPointId: string | null = null
  let heartbeatStartedAt: number | null = null
  let currentState: AnnotationConnectionState = 'closed'
  const pending = new Map<
    string,
    {
      resolve: (response: AnnotationCommandResponse) => void
      reject: (error: Error) => void
    }
  >()
  const reconnectScheduler = createRealtimeReconnectScheduler(open)

  const setState = (state: AnnotationConnectionState) => {
    if (state === currentState) return
    currentState = state
    if (state !== 'ready') {
      heartbeatStartedAt = null
      handlers.onLatency?.(null)
    }
    handlers.onState?.(state)
  }
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const clearSoftLockTimer = () => {
    if (softLockTimer) clearInterval(softLockTimer)
    softLockTimer = null
  }
  const sendSoftLock = (keyPointId = editingKeyPointId) => {
    if (!connectionReady || socket?.readyState !== WebSocket.OPEN) return false
    const intent = parseAnnotationSoftLockIntent({
      schema_version: '2.1.0',
      type: 'soft_lock_intent',
      room_id: roomId,
      editing_key_point_id: keyPointId,
    })
    heartbeatStartedAt = performance.now()
    socket.send(JSON.stringify(intent))
    return true
  }

  function scheduleReconnect() {
    if (stopped) return
    setState('reconnecting')
    reconnectScheduler.schedule()
  }

  function open() {
    if (stopped || socket || typeof window === 'undefined') return
    if (!browserAllowsRealtimeConnection()) {
      scheduleReconnect()
      return
    }
    connectionReady = false
    setState(currentState === 'closed' ? 'connecting' : 'reconnecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(endpoint ?? `${protocol}//${window.location.host}/ws/annotations`)
    url.searchParams.set('room_id', roomId)
    if (deviceSessionId) url.searchParams.set('device_session_id', deviceSessionId)
    let nextSocket: WebSocket
    try {
      nextSocket = new WebSocket(url.toString())
      socket = nextSocket
    } catch (cause) {
      handlers.onError?.(
        cause instanceof Error ? cause : new Error('Annotation WebSocket unavailable'),
      )
      scheduleReconnect()
      return
    }
    nextSocket.addEventListener('message', event => {
      try {
        const message = parseAnnotationServerMessage(JSON.parse(String(event.data)))
        if (message.type === 'connection_ready') {
          connectionReady = true
          reconnectScheduler.connected()
          setState('ready')
          clearSoftLockTimer()
          sendSoftLock()
          softLockTimer = setInterval(() => {
            sendSoftLock()
          }, 5_000)
        }
        if (message.type === 'presence_snapshot' && heartbeatStartedAt !== null) {
          handlers.onLatency?.(Math.max(0, Math.round(performance.now() - heartbeatStartedAt)))
          heartbeatStartedAt = null
        }
        if (message.type === 'command_ack' || message.type === 'command_rejected') {
          pending.get(message.command_id)?.resolve(message)
          pending.delete(message.command_id)
        }
        handlers.onMessage?.(message)
      } catch (cause) {
        handlers.onError?.(cause instanceof Error ? cause : new Error('Invalid annotation message'))
      }
    })
    nextSocket.addEventListener('error', () => {
      handlers.onError?.(new Error('Annotation WebSocket unavailable'))
    })
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return
      connectionReady = false
      clearSoftLockTimer()
      rejectPending(new Error('Annotation connection closed before acknowledgement'))
      socket = null
      if (!stopped) scheduleReconnect()
      else setState('closed')
    })
  }

  return {
    connect() {
      if (socket || stopped) return
      open()
    },
    disconnect() {
      stopped = true
      sendSoftLock(null)
      connectionReady = false
      clearSoftLockTimer()
      reconnectScheduler.dispose()
      rejectPending(new Error('Annotation client disconnected'))
      socket?.close(1000, 'client unmounted')
      socket = null
      setState('closed')
    },
    reconnect() {
      if (stopped) return
      connectionReady = false
      clearSoftLockTimer()
      reconnectScheduler.connected()
      rejectPending(new Error('Annotation connection restarted before acknowledgement'))
      const previousSocket = socket
      socket = null
      previousSocket?.close(4000, 'manual resync')
      setState('reconnecting')
      open()
    },
    ready: () => connectionReady && socket?.readyState === WebSocket.OPEN,
    setEditingKeyPoint(keyPointId) {
      editingKeyPointId = keyPointId
      return sendSoftLock()
    },
    send(command) {
      if (!connectionReady || socket?.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('Annotation connection is not ready'))
      }
      if (pending.has(command.command_id)) {
        return Promise.reject(new Error('Annotation command is already pending'))
      }
      return new Promise<AnnotationCommandResponse>((resolve, reject) => {
        pending.set(command.command_id, { resolve, reject })
        socket?.send(JSON.stringify(command))
      })
    },
  }
}
