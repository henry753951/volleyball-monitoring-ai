import type { PrismaClient } from '@volleyball-monitoring/db'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { aiProviderWebSocketRoutes } from '../src/realtime/ai-provider-ws.js'

const integrationId = '00000000-0000-4000-8000-000000000901'
const instanceId = '00000000-0000-4000-8000-000000000902'
const token = 'provider-token-long-enough'

const hello = {
  schema_version: '1.0.0',
  type: 'provider_hello',
  instance_id: 'fixture-worker-01',
  sdk_version: '0.2.0',
  provider_build_id: 'fixture-v1',
  max_concurrency: 1,
  capabilities: {
    schema_version: '1.0.0',
    provider_name: 'fixture-worker',
    provider_build_id: 'fixture-v1',
    supported_job_schema_versions: ['1.1.0'],
    supported_result_schema_versions: ['1.0.0'],
    supported_overlay_formats: ['flatbuffers_v1'],
    optional_extensions: {
      action: false,
      group_phase: false,
      confidence: false,
    },
    action_taxonomies: [],
  },
  active_jobs: [],
} as const

let closeApp: (() => Promise<void>) | null = null

afterEach(async () => {
  await closeApp?.()
  closeApp = null
  delete process.env.AI_PROVIDER_WS_TOKEN
})

describe('AI provider websocket startup', () => {
  it('buffers an immediate provider hello while integration authentication is pending', async () => {
    let releaseIntegration!: () => void
    const authGate = new Promise<void>(resolve => { releaseIntegration = resolve })
    const database = {
      aiIntegration: {
        findUnique: async () => {
          await authGate
          return {
            id: integrationId,
            enabled: true,
            transportMode: 'WS_AGENT',
            authSecretRef: 'env:AI_PROVIDER_WS_TOKEN',
            jobSchemaVersion: '1.1.0',
            resultSchemaVersion: '1.0.0',
            overlayFormat: 'flatbuffers_v1',
          }
        },
      },
      aiProviderInstance: {
        upsert: async () => ({ id: instanceId }),
        update: async () => ({ id: instanceId }),
      },
      aiJob: {
        findMany: async () => [],
      },
      $queryRaw: async () => [],
    } as unknown as PrismaClient

    process.env.AI_PROVIDER_WS_TOKEN = token
    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(aiProviderWebSocketRoutes({
      database,
      presign: async () => 'https://example.invalid/clip',
    }))
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/ai/providers/ws?integration_id=${integrationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket open timeout')), 5_000)
      client.once('error', reject)
      client.once('open', () => {
        clearTimeout(timeout)
        client.send(JSON.stringify(hello))
        setTimeout(releaseIntegration, 10)
        resolve()
      })
    })

    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('connection ready timeout')), 5_000)
      client.once('message', raw => {
        clearTimeout(timeout)
        try { resolve(JSON.parse(raw.toString()) as Record<string, unknown>) }
        catch (error) { reject(error) }
      })
    })
    expect(ready).toMatchObject({
      schema_version: '1.0.0',
      type: 'connection_ready',
      heartbeat_interval_seconds: 10,
      lease_seconds: 60,
    })
    client.close()
  })
})
