import { parseAnnotationSoftLockIntent } from '@volleyball-monitoring/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnnotationRealtimeClient } from './annotationRealtimeClient'

const roomId =
  'match:84000000-0000-4000-8000-000000000001:capture:84000000-0000-4000-8000-000000000002'

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  readyState = FakeWebSocket.OPEN
  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }
  send(value: string) {
    this.sent.push(value)
  }
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
    const deviceSessionId = '84000000-0000-4000-8000-000000000003'
    const client = createAnnotationRealtimeClient(
      roomId,
      { onState: state => states.push(state) },
      undefined,
      deviceSessionId,
    )
    client.connect()
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toContain(encodeURIComponent(roomId))
    expect(socket.url).toContain(`device_session_id=${deviceSessionId}`)
    expect(client.setEditingKeyPoint('key-point-1')).toBe(false)

    socket.receive({
      schema_version: '2.0.0',
      type: 'connection_ready',
      room_id: roomId,
      server_sequence: '0',
      authenticated_user_id: 'user-1',
      device_session_id: 'device-1',
    })
    expect(client.ready()).toBe(true)
    expect(parseAnnotationSoftLockIntent(JSON.parse(socket.sent[0]!)).editing_key_point_id).toBe(
      'key-point-1',
    )

    vi.advanceTimersByTime(5_000)
    expect(parseAnnotationSoftLockIntent(JSON.parse(socket.sent[1]!)).editing_key_point_id).toBe(
      'key-point-1',
    )
    expect(client.setEditingKeyPoint(null)).toBe(true)
    expect(
      parseAnnotationSoftLockIntent(JSON.parse(socket.sent[2]!)).editing_key_point_id,
    ).toBeNull()

    client.disconnect()
    expect(
      parseAnnotationSoftLockIntent(JSON.parse(socket.sent[3]!)).editing_key_point_id,
    ).toBeNull()
    expect(states).toEqual(['connecting', 'ready', 'closed'])
  })

  it('reports WebSocket round-trip latency from the keepalive response', () => {
    const latency: Array<number | null> = []
    const client = createAnnotationRealtimeClient(roomId, {
      onLatency: value => latency.push(value),
    })
    client.connect()
    const socket = FakeWebSocket.instances[0]!

    socket.receive({
      schema_version: '2.0.0',
      type: 'connection_ready',
      room_id: roomId,
      server_sequence: '0',
      authenticated_user_id: 'user-1',
      device_session_id: 'device-1',
    })
    vi.advanceTimersByTime(37)
    socket.receive({
      schema_version: '2.0.0',
      type: 'presence_snapshot',
      room_id: roomId,
      members: [
        {
          device_session_id: 'device-1',
          user_id: 'user-1',
          display_name: 'Operator',
          editing_key_point_id: null,
        },
      ],
    })

    expect(latency).toEqual([null, 37])
    client.disconnect()
    expect(latency.at(-1)).toBeNull()
  })

  it('restarts the socket immediately and restores the current edit intent', () => {
    const states: string[] = []
    const client = createAnnotationRealtimeClient(roomId, { onState: state => states.push(state) })
    client.connect()
    const first = FakeWebSocket.instances[0]!
    first.receive({
      schema_version: '2.0.0',
      type: 'connection_ready',
      room_id: roomId,
      server_sequence: '0',
      authenticated_user_id: 'user-1',
      device_session_id: 'device-1',
    })
    client.setEditingKeyPoint('key-point-2')

    client.reconnect()

    expect(first.readyState).toBe(3)
    expect(client.ready()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = FakeWebSocket.instances[1]!
    second.receive({
      schema_version: '2.0.0',
      type: 'connection_ready',
      room_id: roomId,
      server_sequence: '1',
      authenticated_user_id: 'user-1',
      device_session_id: 'device-2',
    })
    expect(client.ready()).toBe(true)
    expect(parseAnnotationSoftLockIntent(JSON.parse(second.sent[0]!)).editing_key_point_id).toBe(
      'key-point-2',
    )
    expect(states).toEqual(['connecting', 'ready', 'reconnecting', 'ready'])
    client.disconnect()
  })

  it('ignores late messages from a socket that was replaced during resync', () => {
    const states: string[] = []
    const client = createAnnotationRealtimeClient(roomId, { onState: state => states.push(state) })
    client.connect()
    const first = FakeWebSocket.instances[0]!

    client.reconnect()
    const second = FakeWebSocket.instances[1]!
    first.receive({
      schema_version: '2.0.0',
      type: 'connection_ready',
      room_id: roomId,
      server_sequence: '0',
      authenticated_user_id: 'user-1',
      device_session_id: 'stale-device',
    })

    expect(client.ready()).toBe(false)
    expect(second.sent).toEqual([])
    expect(states).toEqual(['connecting', 'reconnecting'])
    client.disconnect()
  })

  it('abandons a socket that never completes the room handshake and retries', () => {
    const client = createAnnotationRealtimeClient(roomId)
    client.connect()
    const first = FakeWebSocket.instances[0]!

    vi.advanceTimersByTime(12_000)
    expect(first.readyState).toBe(3)
    vi.advanceTimersByTime(1_000)
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    client.disconnect()
  })
})
