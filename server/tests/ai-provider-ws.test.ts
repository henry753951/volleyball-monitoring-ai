import type { PrismaClient } from '@volleyball-monitoring/db'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  aiProviderWebSocketRoutes,
  compatible,
  isActiveProviderDelivery,
  recoverExpiredRunningAiJobs,
} from '../src/realtime/ai-provider-ws.js'

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
    schema_version: '2.0.0',
    provider_name: 'fixture-worker',
    provider_build_id: 'fixture-v1',
    supported_job_schema_versions: ['3.0.0'],
    supported_analysis_data_versions: ['1.0.0'],
    supported_analysis_modules: ['court', 'tracking', 'reid', 'contacts'],
    supports_selective_rerun: true,
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
  it('accepts only providers that implement Job 3 and every AnalysisData module', () => {
    expect(
      compatible({
        ...hello.capabilities,
        supported_job_schema_versions: ['3.0.0'],
        supported_analysis_data_versions: [...hello.capabilities.supported_analysis_data_versions],
        supported_analysis_modules: [...hello.capabilities.supported_analysis_modules],
        action_taxonomies: [...hello.capabilities.action_taxonomies],
      }),
    ).toBe(true)
    expect(
      compatible({
        ...hello.capabilities,
        supports_selective_rerun: false,
        supported_job_schema_versions: ['3.0.0'],
        supported_analysis_data_versions: [...hello.capabilities.supported_analysis_data_versions],
        supported_analysis_modules: [...hello.capabilities.supported_analysis_modules],
        action_taxonomies: [...hello.capabilities.action_taxonomies],
      }),
    ).toBe(true)
    expect(
      compatible({
        ...hello.capabilities,
        supported_job_schema_versions: ['0.9.0'],
        supported_analysis_data_versions: [...hello.capabilities.supported_analysis_data_versions],
        supported_analysis_modules: [...hello.capabilities.supported_analysis_modules],
        action_taxonomies: [...hello.capabilities.action_taxonomies],
      }),
    ).toBe(false)
  })

  it('does not let an expired queued or running lease occupy provider capacity', () => {
    const now = new Date('2026-08-10T00:00:00.000Z')

    expect(
      isActiveProviderDelivery(
        {
          status: 'QUEUED',
          leasedUntil: new Date(now.getTime() - 1),
        },
        now,
      ),
    ).toBe(false)
    expect(
      isActiveProviderDelivery(
        {
          status: 'QUEUED',
          leasedUntil: new Date(now.getTime() + 1),
        },
        now,
      ),
    ).toBe(true)
    expect(isActiveProviderDelivery({ status: 'RUNNING', leasedUntil: null }, now)).toBe(false)
    expect(
      isActiveProviderDelivery(
        {
          status: 'RUNNING',
          leasedUntil: new Date(now.getTime() + 1),
        },
        now,
      ),
    ).toBe(true)
  })

  it('requeues an expired running job so another Worker can resume it', async () => {
    const now = new Date('2026-08-14T01:30:00.000Z')
    const updateJob = vi.fn(async () => ({ count: 1 }))
    const updateRally = vi.fn(async () => ({ count: 1 }))
    const expiredJob = {
      id: '00000000-0000-4000-8000-000000000909',
      attemptCount: 1,
      maxAttempts: 5,
      submission: {
        id: '00000000-0000-4000-8000-000000000910',
        rally: {
          id: '00000000-0000-4000-8000-000000000911',
          matchId: '00000000-0000-4000-8000-000000000912',
          program: { captureSessionId: '00000000-0000-4000-8000-000000000913' },
        },
      },
    }
    const database = {
      aiJob: { findMany: async () => [expiredJob] },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          aiJob: { updateMany: updateJob },
          rally: { updateMany: updateRally },
        }),
    } as unknown as PrismaClient

    await expect(recoverExpiredRunningAiJobs(database, now)).resolves.toEqual([
      { job: expiredJob, terminal: false },
    ])
    expect(updateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryId: null,
          providerInstanceId: null,
          stage: 'worker_lease_expired',
          status: 'QUEUED',
        }),
        where: expect.objectContaining({ id: expiredJob.id, status: 'RUNNING' }),
      }),
    )
    expect(updateRally).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'AI_QUEUED' },
      }),
    )
  })

  it('buffers an immediate provider hello while token authentication is pending', async () => {
    let releaseAuthentication!: () => void
    const authGate = new Promise<void>(resolve => {
      releaseAuthentication = resolve
    })
    const updateProviderInstance = vi.fn(async () => ({ id: instanceId }))
    const database = {
      aiWorkerAccessToken: {
        updateMany: async () => {
          await authGate
          return { count: 1 }
        },
      },
      aiProviderInstance: {
        upsert: async () => ({ id: instanceId }),
        update: updateProviderInstance,
      },
      aiJob: {
        findMany: async () => [],
      },
      outboxEvent: { findMany: async () => [] },
      $queryRaw: async () => [],
    } as unknown as PrismaClient

    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      aiProviderWebSocketRoutes({
        database,
        presign: async () => 'https://example.invalid/clip',
        transportPingIntervalMs: 20,
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ai/providers/ws`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket open timeout')), 5_000)
      client.once('error', reject)
      client.once('open', () => {
        clearTimeout(timeout)
        client.send(JSON.stringify(hello))
        setTimeout(releaseAuthentication, 10)
        resolve()
      })
    })

    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('connection ready timeout')), 5_000)
      client.once('message', raw => {
        clearTimeout(timeout)
        try {
          resolve(JSON.parse(raw.toString()) as Record<string, unknown>)
        } catch (error) {
          reject(error)
        }
      })
    })
    expect(ready).toMatchObject({
      schema_version: '1.0.0',
      type: 'connection_ready',
      heartbeat_interval_seconds: 10,
      lease_seconds: 60,
    })
    await vi.waitFor(
      () => {
        expect(updateProviderInstance).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              latencyMs: expect.any(Number),
              lastPongAt: expect.any(Date),
            }),
            where: { id: instanceId },
          }),
        )
      },
      { timeout: 1_000 },
    )
    client.close()
  })

  it('revokes a deleted token on heartbeat, requeues work, and removes the worker record', async () => {
    const authenticate = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 })
    const requeueJobs = vi.fn(async () => ({ count: 1 }))
    const requeueRallies = vi.fn(async () => ({ count: 1 }))
    const deleteProviderInstance = vi.fn(async () => ({ count: 1 }))
    const activeJob = {
      id: '00000000-0000-4000-8000-000000000904',
      status: 'RUNNING',
      submission: {
        id: '00000000-0000-4000-8000-000000000905',
        rally: {
          id: '00000000-0000-4000-8000-000000000906',
          matchId: '00000000-0000-4000-8000-000000000907',
          program: { captureSessionId: '00000000-0000-4000-8000-000000000908' },
        },
      },
    }
    const database = {
      aiWorkerAccessToken: { updateMany: authenticate },
      aiProviderInstance: {
        upsert: async () => ({ id: instanceId }),
        update: async () => ({ id: instanceId }),
      },
      aiJob: {
        findMany: async (args: { where?: { providerInstanceId?: string } }) =>
          args.where?.providerInstanceId === instanceId ? [activeJob] : [],
      },
      outboxEvent: { findMany: async () => [] },
      $queryRaw: async () => [],
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          aiJob: { updateMany: requeueJobs },
          aiProviderInstance: { deleteMany: deleteProviderInstance },
          rally: { updateMany: requeueRallies },
        }),
    } as unknown as PrismaClient

    const app = Fastify({ logger: false })
    await app.register(websocket)
    await app.register(
      aiProviderWebSocketRoutes({
        database,
        presign: async () => 'https://example.invalid/clip',
        transportPingIntervalMs: 5_000,
      }),
    )
    await app.listen({ host: '127.0.0.1', port: 0 })
    closeApp = () => app.close()
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ai/providers/ws`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('open', resolve)
    })
    const readyMessage = new Promise<Record<string, unknown>>(resolve => {
      client.once('message', raw => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
    })
    client.send(JSON.stringify(hello))
    await expect(readyMessage).resolves.toMatchObject({ type: 'connection_ready' })

    const revokedMessage = new Promise<Record<string, unknown>>(resolve => {
      client.once('message', raw => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
    })
    client.send(
      JSON.stringify({
        schema_version: '1.0.0',
        type: 'heartbeat',
        instance_id: hello.instance_id,
        active_jobs: [],
      }),
    )

    await expect(revokedMessage).resolves.toMatchObject({
      type: 'protocol_error',
      code: 'AUTHORIZATION_REVOKED',
      retryable: false,
    })
    await vi.waitFor(() =>
      expect(deleteProviderInstance).toHaveBeenCalledWith({ where: { id: instanceId } }),
    )
    expect(requeueJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryId: null,
          providerInstanceId: null,
          status: 'QUEUED',
        }),
      }),
    )
    expect(requeueRallies).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'AI_QUEUED' },
      }),
    )
  })
})
