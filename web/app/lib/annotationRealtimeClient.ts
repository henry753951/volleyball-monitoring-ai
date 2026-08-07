import {
  parseAnnotationServerMessage,
  parseAnnotationSoftLockIntent,
  type AnnotationCommand,
  type AnnotationCommandResponse,
  type AnnotationServerMessage,
} from '@volleyball-monitoring/contracts'

export type AnnotationConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed'

interface AnnotationRealtimeHandlers {
  onMessage?: (message: AnnotationServerMessage) => void
  onState?: (state: AnnotationConnectionState) => void
  onError?: (error: Error) => void
}

export interface AnnotationRealtimeClient {
  connect(): void
  disconnect(): void
  send(command: AnnotationCommand): Promise<AnnotationCommandResponse>
  setEditingKeyPoint(keyPointId: string | null): boolean
  ready(): boolean
}

export function createAnnotationRealtimeClient(
  roomId: string,
  handlers: AnnotationRealtimeHandlers = {},
  endpoint?: string,
): AnnotationRealtimeClient {
  let socket: WebSocket | null = null
  let stopped = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let softLockTimer: ReturnType<typeof setInterval> | null = null
  let connectionReady = false
  let editingKeyPointId: string | null = null
  let currentState: AnnotationConnectionState = 'closed'
  const pending = new Map<string, {
    resolve: (response: AnnotationCommandResponse) => void
    reject: (error: Error) => void
  }>()

  const setState = (state: AnnotationConnectionState) => {
    if (state === currentState) return
    currentState = state
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
    socket.send(JSON.stringify(intent))
    return true
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    setState('reconnecting')
    const delay = Math.min(5_000, 400 * (2 ** reconnectAttempt))
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, delay)
  }

  function open() {
    if (stopped || typeof window === 'undefined') return
    connectionReady = false
    setState(reconnectAttempt ? 'reconnecting' : 'connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(endpoint ?? `${protocol}//${window.location.host}/ws/annotations`)
    url.searchParams.set('room_id', roomId)
    socket = new WebSocket(url.toString())
    socket.addEventListener('message', (event) => {
      try {
        const message = parseAnnotationServerMessage(JSON.parse(String(event.data)))
        if (message.type === 'connection_ready') {
          connectionReady = true
          reconnectAttempt = 0
          setState('ready')
          clearSoftLockTimer()
          sendSoftLock()
          softLockTimer = setInterval(() => { sendSoftLock() }, 5_000)
        }
        if (message.type === 'command_ack' || message.type === 'command_rejected') {
          pending.get(message.command_id)?.resolve(message)
          pending.delete(message.command_id)
        }
        handlers.onMessage?.(message)
      }
      catch (cause) {
        handlers.onError?.(cause instanceof Error ? cause : new Error('Invalid annotation message'))
      }
    })
    socket.addEventListener('error', () => {
      handlers.onError?.(new Error('Annotation WebSocket unavailable'))
    })
    socket.addEventListener('close', () => {
      connectionReady = false
      clearSoftLockTimer()
      rejectPending(new Error('Annotation connection closed before acknowledgement'))
      if (socket) socket = null
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
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      rejectPending(new Error('Annotation client disconnected'))
      socket?.close(1000, 'client unmounted')
      socket = null
      setState('closed')
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
