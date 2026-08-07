import {
  parseAnnotationCommand,
  parseAnnotationCommandResponse,
  type AnnotationCommandResponse,
} from '@volleyball-monitoring/contracts'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { createYoga } from 'graphql-yoga'
import { afterEach, describe, expect, it } from 'vitest'
import { annotationWebSocketRoutes } from '../src/realtime/annotation-ws.js'
import type { AnnotationCommandService } from '../src/services/annotation-command.js'

const userId = '83000000-0000-4000-8000-000000000001'
const deviceSessionId = '83000000-0000-4000-8000-000000000002'
const matchId = '83000000-0000-4000-8000-000000000003'
const captureId = '83000000-0000-4000-8000-000000000004'
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
  payload: { playback_cursor: {
    cursor_status: 'ready', mapping_version: 1,
    observation_source: 'request_video_frame_callback', playback_window_id: windowId,
    player_media_time_us: '1', seek_generation: 0,
  } },
  rally_id: rallyId,
  room_id: roomId,
})

const response: AnnotationCommandResponse = parseAnnotationCommandResponse({
  schema_version: '2.0.0',
  type: 'command_ack',
  command_id: commandId,
  effects: { created_key_point_id: keyPointId },
  operation_kind: 'CREATE_SERVICE_KEY_POINT',
  rally_id: rallyId,
  resolved_anchor: {
    capture_epoch_id: epochId, capture_frame_index: '1', capture_session_id: captureId,
    capture_time_us: '1', mapping_version: 1, playback_window_id: windowId,
    resolved_player_media_time_us: '1', source_pts: '1', source_time_base: { den: 60, num: 1 },
    timing_precision: 'frame_exact',
  },
  result_revision: '1',
  room_id: roomId,
  server_sequence: '11',
})

function fakeService(seen: unknown[]): AnnotationCommandService {
  return {
    async apply(value, annotationIdentity) {
      seen.push({ annotationIdentity, value })
      return response
    },
    async authorizeRoom(value) {
      return value === roomId ? { captureSessionId: captureId, matchId, roomId } : null
    },
    async roomSequence() {
      return 10n
    },
  }
}

let closeApp: (() => Promise<void>) | null = null

afterEach(async () => {
  await closeApp?.()
  closeApp = null
})

describe('annotation transport adapters', () => {
  it('passes strict JSON through the GraphQL fallback to the shared handler', async () => {
    const seen: unknown[] = []
    process.env.DATABASE_URL ??= 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
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
    const fetchResult = await Promise.resolve(yoga.fetch('http://localhost/graphql', {
      body: JSON.stringify({
        query: 'mutation Apply($command: JSON!) { applyAnnotationCommand(command: $command) }',
        variables: { command },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }))
    const result = await fetchResult.json() as { data: { applyAnnotationCommand: unknown } }
    expect(result.data.applyAnnotationCommand).toEqual(response)
    expect(seen).toEqual([{ annotationIdentity: identity, value: command }])

    const invalidFetch = await Promise.resolve(yoga.fetch('http://localhost/graphql', {
      body: JSON.stringify({
        query: 'mutation Apply($command: JSON!) { applyAnnotationCommand(command: $command) }',
        variables: { command: { ...command, unexpected: true } },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }))
    const invalid = await invalidFetch.json() as { errors: Array<{ extensions: { code: string } }> }
    expect(invalid.errors[0]?.extensions.code).toBe('BAD_USER_INPUT')
    expect(seen).toHaveLength(1)
  })

  it('authorizes the WS room before ready and sends the same committed response', async () => {
    const seen: unknown[] = []
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(annotationWebSocketRoutes({
      authenticate: async () => identity,
      service: fakeService(seen),
    }))
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/annotations?room_id=${encodeURIComponent(roomId)}`)
    const messages: unknown[] = []
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 5_000)
      client.addEventListener('error', () => reject(new Error('websocket error')))
      client.addEventListener('message', (event) => {
        messages.push(JSON.parse(String(event.data)))
        if (messages.length === 1) client.send(JSON.stringify(command))
        if (messages.length === 2) {
          clearTimeout(timeout)
          resolvePromise()
        }
      })
    })
    client.close()
    expect(messages[0]).toMatchObject({
      type: 'connection_ready', room_id: roomId, server_sequence: '10',
      authenticated_user_id: userId, device_session_id: deviceSessionId,
    })
    expect(messages[1]).toEqual(response)
    expect(seen).toEqual([{ annotationIdentity: identity, value: command }])
  })
})
