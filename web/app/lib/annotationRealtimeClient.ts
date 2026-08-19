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
export type AnnotationCursorStatus = 'ready' | 'seeking' | 'stale' | 'gap' | null

interface AnnotationRealtimeHandlers {
  onMessage?: (message: AnnotationServerMessage) => void
  onState?: (state: AnnotationConnectionState) => void
  onLatency?: (latencyMs: number | null) => void
  onError?: (error: Error) => void
  onServerSequence?: (serverSequence: string) => void
  resumeFromServerSequence?: () => string | null
}

export interface AnnotationRealtimeClient {
  connect(): void
  disconnect(): void
  reconnect(): void
  send(command: AnnotationCommand): Promise<AnnotationCommandResponse>
  setEditingKeyPoint(keyPointId: string | null): boolean
  setPlaybackCursor(captureTimeUs: string | null, status: AnnotationCursorStatus): boolean
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
  let cursorPresenceTimer: ReturnType<typeof setInterval> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let connectionReady = false
  let editingKeyPointId: string | null = null
  let cursorCaptureTimeUs: string | null = null
  let cursorStatus: AnnotationCursorStatus = null
  let heartbeatStartedAt: number | null = null
  let currentState: AnnotationConnectionState = 'closed'
  const pending = new Map<
    string,
    {
      resolve: (response: AnnotationCommandResponse) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
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
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  const clearHandshakeTimer = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = null
  }
  const clearSoftLockTimer = () => {
    if (softLockTimer) clearInterval(softLockTimer)
    softLockTimer = null
  }
  const clearCursorPresenceTimer = () => {
    if (cursorPresenceTimer) clearInterval(cursorPresenceTimer)
    cursorPresenceTimer = null
  }
  const sendSoftLock = (
    keyPointId = editingKeyPointId,
    nextCursorCaptureTimeUs = cursorCaptureTimeUs,
    nextCursorStatus = cursorStatus,
  ) => {
    if (!connectionReady || socket?.readyState !== WebSocket.OPEN) return false
    const intent = parseAnnotationSoftLockIntent({
      schema_version: '2.1.0',
      type: 'soft_lock_intent',
      room_id: roomId,
      editing_key_point_id: keyPointId,
      cursor_capture_time_us: nextCursorCaptureTimeUs,
      cursor_status: nextCursorStatus,
    })
    heartbeatStartedAt = performance.now()
    socket.send(JSON.stringify(intent))
    return true
  }
  const ensureCursorPresenceTimer = () => {
    if (cursorPresenceTimer || cursorCaptureTimeUs === null) return
    cursorPresenceTimer = setInterval(() => {
      sendSoftLock()
    }, 750)
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
    const resumeSequence = handlers.resumeFromServerSequence?.()
    if (resumeSequence && /^\d+$/.test(resumeSequence))
      url.searchParams.set('last_server_sequence', resumeSequence)
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
    clearHandshakeTimer()
    handshakeTimer = setTimeout(() => {
      if (socket !== nextSocket || connectionReady || stopped) return
      nextSocket.close(4001, 'annotation handshake timeout')
    }, 12_000)
    nextSocket.addEventListener('message', event => {
      if (socket !== nextSocket || stopped) return
      try {
        const message = parseAnnotationServerMessage(JSON.parse(String(event.data)))
        if (
          message.type === 'connection_ready' ||
          message.type === 'command_ack' ||
          message.type === 'rally_snapshot'
        )
          handlers.onServerSequence?.(message.server_sequence)
        if (message.type === 'connection_ready') {
          connectionReady = true
          clearHandshakeTimer()
          reconnectScheduler.connected()
          setState('ready')
          clearSoftLockTimer()
          sendSoftLock()
          softLockTimer = setInterval(() => {
            sendSoftLock()
          }, 5_000)
          ensureCursorPresenceTimer()
        }
        if (message.type === 'presence_snapshot' && heartbeatStartedAt !== null) {
          handlers.onLatency?.(Math.max(0, Math.round(performance.now() - heartbeatStartedAt)))
          heartbeatStartedAt = null
        }
        if (message.type === 'command_ack' || message.type === 'command_rejected') {
          const request = pending.get(message.command_id)
          if (request) clearTimeout(request.timer)
          request?.resolve(message)
          pending.delete(message.command_id)
        }
        handlers.onMessage?.(message)
      } catch (cause) {
        handlers.onError?.(cause instanceof Error ? cause : new Error('Invalid annotation message'))
      }
    })
    nextSocket.addEventListener('error', () => {
      if (socket !== nextSocket || stopped) return
      handlers.onError?.(new Error('Annotation WebSocket unavailable'))
    })
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return
      connectionReady = false
      clearHandshakeTimer()
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
      sendSoftLock(null, null, null)
      connectionReady = false
      clearHandshakeTimer()
      clearSoftLockTimer()
      clearCursorPresenceTimer()
      reconnectScheduler.dispose()
      rejectPending(new Error('Annotation client disconnected'))
      socket?.close(1000, 'client unmounted')
      socket = null
      setState('closed')
    },
    reconnect() {
      if (stopped) return
      connectionReady = false
      clearHandshakeTimer()
      clearSoftLockTimer()
      clearCursorPresenceTimer()
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
    setPlaybackCursor(captureTimeUs, status) {
      cursorCaptureTimeUs = captureTimeUs
      cursorStatus = status
      if (captureTimeUs === null) clearCursorPresenceTimer()
      else ensureCursorPresenceTimer()
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
        const currentSocket = socket
        const timer = setTimeout(() => {
          const request = pending.get(command.command_id)
          if (!request) return
          pending.delete(command.command_id)
          request.reject(new Error('Annotation command acknowledgement timed out'))
          if (socket === currentSocket) currentSocket?.close(4002, 'annotation ack timeout')
        }, 12_000)
        pending.set(command.command_id, { resolve, reject, timer })
        socket?.send(JSON.stringify(command))
      })
    },
  }
}
