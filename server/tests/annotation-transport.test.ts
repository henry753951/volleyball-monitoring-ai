import {
  parseAnnotationCommand,
  parseAnnotationCommandResponse,
  parseAnnotationServerMessage,
  parseAnnotationSoftLockIntent,
  type AnnotationCommandResponse,
} from '@volleyball-monitoring/contracts'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { createYoga } from 'graphql-yoga'
import { afterEach, describe, expect, it } from 'vitest'
import { annotationWebSocketRoutes } from '../src/realtime/annotation-ws.js'
import { parseAnnotationRoomId } from '../src/domain/annotation/room.js'
import type { AnnotationPresenceService } from '../src/realtime/annotation-presence.js'
import type { AnnotationCommandService } from '../src/services/annotation-command.js'

type AnnotationCommandAck = Extract<AnnotationCommandResponse, { type: 'command_ack' }>

const userId = '83000000-0000-4000-8000-000000000001'
const deviceSessionId = '83000000-0000-4000-8000-000000000002'
const matchId = '83000000-0000-4000-8000-abcdef000003'
const captureId = '83000000-0000-4000-8000-abcdef000004'
const rallyId = '83000000-0000-4000-8000-000000000005'
const commandId = '83000000-0000-4000-8000-000000000006'
const keyPointId = '83000000-0000-4000-8000-000000000007'
const epochId = '83000000-0000-4000-8000-000000000008'
const windowId = '83000000-0000-4000-8000-000000000009'
const roomId = `match:${matchId}:capture:${captureId}`
const identity = { deviceSessionId, role: 'OPERATOR' as const, userId }

const command = parseAnnotationCommand({
  schema_version: '2.0.0',
  base_revision: '0',
  command_id: commandId,
  kind: 'CREATE_SERVICE_KEY_POINT',
  payload: {
    playback_cursor: {
      cursor_status: 'ready',
      mapping_version: 1,
      observation_source: 'request_video_frame_callback',
      playback_window_id: windowId,
      player_media_time_us: '1',
      seek_generation: 0,
    },
  },
  rally_id: rallyId,
  room_id: roomId,
})

const contactCommand = parseAnnotationCommand({
  ...command,
  command_id: '83000000-0000-4000-8000-000000000010',
  kind: 'CREATE_CONTACT_KEY_POINT',
})

const closeCommand = parseAnnotationCommand({
  ...command,
  command_id: '83000000-0000-4000-8000-000000000011',
  kind: 'CLOSE_RALLY',
  payload: {
    target_key_point_id: keyPointId,
    score_resolution: 'unknown',
    scoring_court_side: null,
  },
})

const mismatchCommand = parseAnnotationCommand({
  ...contactCommand,
  room_id: `match:${matchId.slice(0, -1)}4:capture:${captureId}`,
})

const failureCommand = parseAnnotationCommand({
  ...command,
  schema_version: '4.0.0',
  command_id: '83000000-0000-4000-8000-000000000013',
  kind: 'SET_BALL_EVENT',
  payload: {
    key_point_id: keyPointId,
    event: { kind: 'RECEIVE', result: 'FAILURE' },
  },
})

const response: AnnotationCommandResponse = parseAnnotationCommandResponse({
  schema_version: '2.0.0',
  type: 'command_ack',
  command_id: commandId,
  effects: { created_key_point_id: keyPointId },
  operation_kind: 'CREATE_SERVICE_KEY_POINT',
  rally_id: rallyId,
  resolved_anchor: {
    capture_epoch_id: epochId,
    capture_frame_index: '1',
    capture_session_id: captureId,
    capture_time_us: '1',
    mapping_version: 1,
    playback_window_id: windowId,
    resolved_player_media_time_us: '1',
    source_pts: '1',
    source_time_base: { den: 60, num: 1 },
    timing_precision: 'frame_exact',
  },
  result_revision: '1',
  room_id: roomId,
  server_sequence: '11',
})
const rallySnapshot = parseAnnotationServerMessage({
  schema_version: '2.0.0',
  type: 'rally_snapshot',
  room_id: roomId,
  rally_id: rallyId,
  revision: '1',
  server_sequence: '11',
  snapshot: {
    annotation_status: 'open',
    side_assignment_id: '83000000-0000-4000-8000-000000000012',
    score_resolution: 'pending',
    scoring_court_side: null,
    processing_status: 'idle',
    key_points: [
      {
        key_point_id: keyPointId,
        sequence_index: 0,
        marker_kind: 'service',
        is_terminal: false,
        capture_time_us: '1',
        capture_frame_index: '1',
        timing_precision: 'frame_exact',
        possible_duplicate: false,
      },
    ],
  },
})

function fakeService(seen: unknown[]): AnnotationCommandService {
  return {
    async activeRoomRallyIds() {
      return []
    },
    async apply(value, annotationIdentity) {
      seen.push({ annotationIdentity, value })
      if (value.kind === 'CLOSE_RALLY')
        return parseAnnotationCommandResponse({
          ...response,
          command_id: value.command_id,
          operation_kind: 'CLOSE_RALLY',
          resolved_anchor: null,
          effects: {
            terminal_key_point_id: keyPointId,
            annotation_status: 'ready',
            score_resolution: 'unknown',
            scoring_court_side: null,
          },
        })
      if (value.kind === 'CREATE_CONTACT_KEY_POINT')
        return parseAnnotationCommandResponse({
          ...response,
          command_id: value.command_id,
          operation_kind: 'CREATE_CONTACT_KEY_POINT',
        })
      if (value.kind === 'SET_BALL_EVENT')
        return parseAnnotationCommandResponse({
          ...response,
          schema_version: value.schema_version,
          command_id: value.command_id,
          operation_kind: 'SET_BALL_EVENT',
          resolved_anchor: null,
        })
      return parseAnnotationCommandResponse({ ...response, command_id: value.command_id })
    },
    async authorizeRoom(value) {
      try {
        const parsed = parseAnnotationRoomId(value)
        return parsed.roomId === roomId ? parsed : null
      } catch {
        return null
      }
    },
    async recoverAbandonedDraft() {
      return null
    },
    async roomChangesAfter(_roomId, afterSequence) {
      return {
        currentSequence: 10n,
        hasMore: false,
        rallyIds: [],
        throughSequence: afterSequence > 10n ? 10n : afterSequence,
      }
    },
    async roomSequence() {
      return 10n
    },
  }
}

function fakePresence(onEditing: (keyPointId: string | null) => void): AnnotationPresenceService {
  const member = {
    user_id: userId,
    device_session_id: deviceSessionId,
    display_name: 'Operator',
    editing_key_point_id: null as string | null,
  }
  return {
    async join() {
      return member
    },
    async touch() {},
    async setEditing(_roomId, current, keyPointId) {
      onEditing(keyPointId)
      return { ...current, editing_key_point_id: keyPointId }
    },
    async leave() {},
    async snapshot() {
      const message = parseAnnotationServerMessage({
        schema_version: '2.0.0',
        type: 'presence_snapshot',
        room_id: roomId,
        members: [member],
      })
      if (message.type !== 'presence_snapshot') throw new TypeError('presence fixture mismatch')
      return message
    },
    async subscribe() {
      return () => undefined
    },
    close() {},
  }
}

async function openAnnotationSocket(seen: unknown[]) {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  await app.register(
    annotationWebSocketRoutes({
      authenticate: async () => identity,
      service: fakeService(seen),
    }),
  )
  await app.listen({ host: '127.0.0.1', port: 0 })
  closeApp = () => app.close()
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('missing test listener')
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(roomId)}`,
  )
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket ready timeout')), 5_000)
    client.addEventListener('error', () => reject(new Error('websocket error')))
    client.addEventListener('message', event => {
      try {
        const ready = JSON.parse(String(event.data)) as { type?: string }
        if (ready.type === 'connection_ready') {
          clearTimeout(timeout)
          resolvePromise()
        }
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
      }
    })
  })
  return client
}

let closeApp: (() => Promise<void>) | null = null

afterEach(async () => {
  await closeApp?.()
  closeApp = null
})

describe('annotation transport adapters', () => {
  it('passes strict JSON through the GraphQL fallback to the shared handler', async () => {
    const seen: unknown[] = []
    process.env.DATABASE_URL ??=
      'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
    const [{ configureAnnotationGraphQL }, { schema }] = await Promise.all([
      import('../src/graphql/annotation-mutations.js'),
      import('../src/graphql/schema.js'),
    ])
    configureAnnotationGraphQL(fakeService(seen))
    const yoga = createYoga({
      context: () => ({
        deviceSessionId,
        request: new Request('http://localhost/graphql'),
        user: { id: userId, role: 'OPERATOR' },
      }),
      logging: false,
      maskedErrors: false,
      schema,
    })
    const fetchResult = await Promise.resolve(
      yoga.fetch('http://localhost/graphql', {
        body: JSON.stringify({
          query: 'mutation Apply($command: JSON!) { applyAnnotationCommand(command: $command) }',
          variables: { command },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const result = (await fetchResult.json()) as { data: { applyAnnotationCommand: unknown } }
    expect(result.data.applyAnnotationCommand).toEqual(response)
    expect(seen).toEqual([{ annotationIdentity: identity, value: command }])

    const invalidFetch = await Promise.resolve(
      yoga.fetch('http://localhost/graphql', {
        body: JSON.stringify({
          query: 'mutation Apply($command: JSON!) { applyAnnotationCommand(command: $command) }',
          variables: { command: { ...command, unexpected: true } },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const invalid = (await invalidFetch.json()) as {
      errors: Array<{ extensions: { code: string } }>
    }
    expect(invalid.errors[0]?.extensions.code).toBe('BAD_USER_INPUT')
    expect(seen).toHaveLength(1)

    const noncanonicalFetch = await Promise.resolve(
      yoga.fetch('http://localhost/graphql', {
        body: JSON.stringify({
          query: 'mutation Apply($command: JSON!) { applyAnnotationCommand(command: $command) }',
          variables: { command: { ...command, room_id: roomId.replace('abcdef', 'ABCDEF') } },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const noncanonical = (await noncanonicalFetch.json()) as {
      errors: Array<{ extensions: { code: string } }>
    }
    expect(noncanonical.errors[0]?.extensions.code).toBe('BAD_USER_INPUT')
    expect(seen).toHaveLength(1)

    for (const variant of [
      { ...command, kind: 'CREATE_CONTACT_KEY_POINT', base_revision: '1' as const },
      {
        ...command,
        kind: 'CLOSE_RALLY',
        base_revision: '1' as const,
        payload: {
          target_key_point_id: keyPointId,
          score_resolution: 'unknown' as const,
          scoring_court_side: null,
        },
      },
    ]) {
      const r = await Promise.resolve(
        yoga.fetch('http://localhost/graphql', {
          body: JSON.stringify({
            query: 'mutation Apply($command: JSON!) { applyAnnotationCommand(command: $command) }',
            variables: { command: variant },
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      )
      const body = (await r.json()) as { data: { applyAnnotationCommand: AnnotationCommandAck } }
      expect(body.data.applyAnnotationCommand.operation_kind).toBe(variant.kind)
      if (variant.kind === 'CLOSE_RALLY')
        expect(body.data.applyAnnotationCommand.resolved_anchor).toBeNull()
    }
    expect(seen).toHaveLength(3)
  })

  it('authorizes the WS room before ready and sends the same committed response', async () => {
    const seen: unknown[] = []
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      annotationWebSocketRoutes({
        authenticate: async () => identity,
        service: fakeService(seen),
        snapshot: async () => (rallySnapshot.type === 'rally_snapshot' ? rallySnapshot : null),
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(roomId)}`,
    )
    const messages: unknown[] = []
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 5_000)
      client.addEventListener('error', () => reject(new Error('websocket error')))
      client.addEventListener('message', event => {
        messages.push(JSON.parse(String(event.data)))
        if (messages.length === 1) client.send(JSON.stringify(command))
        if (messages.length === 3) {
          clearTimeout(timeout)
          resolvePromise()
        }
      })
    })
    client.close()
    expect(messages[0]).toMatchObject({
      type: 'connection_ready',
      room_id: roomId,
      server_sequence: '10',
      authenticated_user_id: userId,
      device_session_id: deviceSessionId,
    })
    expect(messages[1]).toEqual(response)
    expect(messages[2]).toEqual(rallySnapshot)
    expect(seen).toEqual([{ annotationIdentity: identity, value: command }])
  })

  it('sends every active room rally snapshot before connection_ready', async () => {
    const activeLoads: string[] = []
    const service: AnnotationCommandService = {
      ...fakeService([]),
      async activeRoomRallyIds(room) {
        activeLoads.push(room.roomId)
        return [rallyId]
      },
      async roomSequence() {
        return 11n
      },
    }
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      annotationWebSocketRoutes({
        authenticate: async () => identity,
        reconcileIntervalMs: 60_000,
        service,
        snapshot: async () => (rallySnapshot.type === 'rally_snapshot' ? rallySnapshot : null),
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(roomId)}`,
    )
    const messages: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket projection timeout')), 5_000)
      client.addEventListener('error', () => reject(new Error('websocket error')))
      client.addEventListener('message', event => {
        messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
        if (messages.some(message => message.type === 'connection_ready')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    client.close()
    expect(activeLoads).toEqual([roomId])
    expect(messages.map(message => message.type)).toEqual(['rally_snapshot', 'connection_ready'])
    expect(messages[1]).toMatchObject({ server_sequence: '11' })
  })

  it('replays committed rally snapshots after the client resume sequence before ready', async () => {
    const seenAfter: bigint[] = []
    const service: AnnotationCommandService = {
      ...fakeService([]),
      async roomChangesAfter(_roomId, afterSequence) {
        seenAfter.push(afterSequence)
        return {
          currentSequence: 11n,
          hasMore: false,
          rallyIds: [rallyId],
          throughSequence: 11n,
        }
      },
      async roomSequence() {
        return 11n
      },
    }
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      annotationWebSocketRoutes({
        authenticate: async () => identity,
        reconcileIntervalMs: 60_000,
        service,
        snapshot: async () => (rallySnapshot.type === 'rally_snapshot' ? rallySnapshot : null),
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(roomId)}&last_server_sequence=7`,
    )
    const messages: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket replay timeout')), 5_000)
      client.addEventListener('error', () => reject(new Error('websocket error')))
      client.addEventListener('message', event => {
        messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
        if (messages.some(message => message.type === 'connection_ready')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    client.close()
    expect(seenAfter).toEqual([7n])
    expect(messages.map(message => message.type)).toEqual(['rally_snapshot', 'connection_ready'])
    expect(messages[1]).toMatchObject({ server_sequence: '11' })
  })

  it('round-trips a strict contact command after connection_ready', async () => {
    const seen: unknown[] = []
    const client = await openAnnotationSocket(seen)
    const ackPromise = new Promise<AnnotationCommandAck>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket ack timeout')), 5_000)
      client.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as AnnotationCommandAck
        clearTimeout(timeout)
        resolve(message)
      })
    })
    client.send(JSON.stringify(contactCommand))
    const ack = await ackPromise
    expect(seen).toEqual([{ annotationIdentity: identity, value: contactCommand }])
    expect(ack).toMatchObject({
      command_id: contactCommand.command_id,
      operation_kind: 'CREATE_CONTACT_KEY_POINT',
    })
    expect(ack.resolved_anchor).not.toBeNull()
    client.close()
  })

  it('round-trips a strict unknown close command after connection_ready', async () => {
    const seen: unknown[] = []
    const client = await openAnnotationSocket(seen)
    const ackPromise = new Promise<AnnotationCommandAck>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket ack timeout')), 5_000)
      client.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as AnnotationCommandAck
        clearTimeout(timeout)
        resolve(message)
      })
    })
    client.send(JSON.stringify(closeCommand))
    const ack = await ackPromise
    expect(seen).toEqual([{ annotationIdentity: identity, value: closeCommand }])
    expect(ack).toMatchObject({
      command_id: closeCommand.command_id,
      operation_kind: 'CLOSE_RALLY',
      resolved_anchor: null,
    })
    expect(ack.effects).toMatchObject({ score_resolution: 'unknown' })
    client.close()
  })

  it('round-trips a FAILURE ball-event edit without reconnecting', async () => {
    const seen: unknown[] = []
    const client = await openAnnotationSocket(seen)
    const ackPromise = new Promise<AnnotationCommandAck>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket ack timeout')), 5_000)
      client.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as AnnotationCommandAck
        clearTimeout(timeout)
        resolve(message)
      })
    })
    client.send(JSON.stringify(failureCommand))
    const ack = await ackPromise
    expect(seen).toEqual([{ annotationIdentity: identity, value: failureCommand }])
    expect(ack).toMatchObject({
      type: 'command_ack',
      command_id: failureCommand.command_id,
      operation_kind: 'SET_BALL_EVENT',
    })
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.close()
  })

  it('rejects a schema-invalid durable command without disconnecting the socket', async () => {
    const seen: unknown[] = []
    const client = await openAnnotationSocket(seen)
    const messages: Array<Record<string, unknown>> = []
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket response timeout')), 5_000)
      client.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        messages.push(message)
        if (messages.length === 1) client.send(JSON.stringify(contactCommand))
        if (messages.length === 2) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    client.send(
      JSON.stringify({
        ...failureCommand,
        payload: { key_point_id: keyPointId, event: { kind: 'RECEIVE', result: 'BROKEN' } },
      }),
    )
    await completed
    expect(messages[0]).toMatchObject({
      type: 'command_rejected',
      command_id: failureCommand.command_id,
      code: 'INVALID_COMMAND',
      snapshot_refetch_required: false,
    })
    expect(messages[1]).toMatchObject({
      type: 'command_ack',
      command_id: contactCommand.command_id,
    })
    expect(seen).toEqual([{ annotationIdentity: identity, value: contactCommand }])
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.close()
  })

  it('accepts an authenticated v2.1 soft-lock intent without invoking the durable command handler', async () => {
    const seen: unknown[] = []
    let resolveEditing: ((value: string | null) => void) | null = null
    const editing = new Promise<string | null>(resolve => {
      resolveEditing = resolve
    })
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      annotationWebSocketRoutes({
        authenticate: async () => identity,
        presence: fakePresence(value => resolveEditing?.(value)),
        service: fakeService(seen),
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(roomId)}`,
    )
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket ready timeout')), 5_000)
      client.addEventListener('error', () => reject(new Error('websocket error')))
      client.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { type?: string }
        if (message.type !== 'connection_ready') return
        clearTimeout(timeout)
        resolve()
      })
    })
    const intent = parseAnnotationSoftLockIntent({
      schema_version: '2.1.0',
      type: 'soft_lock_intent',
      room_id: roomId,
      editing_key_point_id: keyPointId,
    })
    client.send(JSON.stringify(intent))
    expect(await editing).toBe(keyPointId)
    expect(seen).toHaveLength(0)
    client.close()
  })

  it('closes malformed JSON and room-mismatched commands without invoking the handler', async () => {
    for (const malformed of ['not-json', JSON.stringify(mismatchCommand)]) {
      const seen: unknown[] = []
      const client = await openAnnotationSocket(seen)
      const closeEvent = new Promise<CloseEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('websocket close timeout')), 5_000)
        client.addEventListener('error', () => undefined)
        client.addEventListener('close', event => {
          clearTimeout(timeout)
          resolve(event)
        })
      })
      client.send(malformed)
      const event = await closeEvent
      expect(event.code).toBe(malformed === 'not-json' ? 1003 : 1008)
      expect(seen).toHaveLength(0)
      await closeApp?.()
      closeApp = null
    }
  })

  it('rejects a noncanonical WS room before connection_ready', async () => {
    const seen: unknown[] = []
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      annotationWebSocketRoutes({
        authenticate: async () => identity,
        service: fakeService(seen),
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')
    const noncanonicalRoom = roomId.replace('abcdef', 'ABCDEF')
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(noncanonicalRoom)}`,
    )
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 5_000)
      client.addEventListener('message', () =>
        reject(new Error('noncanonical room received a message')),
      )
      client.addEventListener('error', () => undefined)
      client.addEventListener('close', event => {
        clearTimeout(timeout)
        try {
          expect(event.code).toBe(1008)
          resolvePromise()
        } catch (error) {
          reject(error)
        }
      })
    })
    expect(seen).toHaveLength(0)
  })
})
