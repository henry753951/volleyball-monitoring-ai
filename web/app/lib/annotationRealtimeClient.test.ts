import { parseAnnotationSoftLockIntent } from '@volleyball-monitoring/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnnotationRealtimeClient } from './annotationRealtimeClient'

const roomId = 'match:84000000-0000-4000-8000-000000000001:capture:84000000-0000-4000-8000-000000000002'

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  readyState = FakeWebSocket.OPEN
  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }
  send(value: string) { this.sent.push(value) }
  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}

describe('annotation realtime soft-lock client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('replays edit intent after ready, refreshes it, and releases it explicitly', () => {
    const states: string[] = []
    const client = createAnnotationRealtimeClient(roomId, { onState: state => states.push(state) })
    client.connect()
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toContain(encodeURIComponent(roomId))
    expect(client.setEditingKeyPoint('key-point-1')).toBe(false)

    socket.receive({
      schema_version: '2.0.0', type: 'connection_ready', room_id: roomId, server_sequence: '0',
      authenticated_user_id: 'user-1', device_session_id: 'device-1',
    })
    expect(client.ready()).toBe(true)
    expect(parseAnnotationSoftLockIntent(JSON.parse(socket.sent[0]!)).editing_key_point_id).toBe('key-point-1')

    vi.advanceTimersByTime(5_000)
    expect(parseAnnotationSoftLockIntent(JSON.parse(socket.sent[1]!)).editing_key_point_id).toBe('key-point-1')
    expect(client.setEditingKeyPoint(null)).toBe(true)
    expect(parseAnnotationSoftLockIntent(JSON.parse(socket.sent[2]!)).editing_key_point_id).toBeNull()

    client.disconnect()
    expect(parseAnnotationSoftLockIntent(JSON.parse(socket.sent[3]!)).editing_key_point_id).toBeNull()
    expect(states).toEqual(['connecting', 'ready', 'closed'])
  })
})
