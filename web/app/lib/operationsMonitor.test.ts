import { describe, expect, it, vi } from 'vitest'
import {
  activeAiWorkForDashboard,
  deleteAiWorker,
  deleteAiWorkerToken,
  fetchOperationsSnapshot,
  visibleStreamsForMatches,
  type AiWorkSnapshot,
  type StreamSnapshot,
} from './operationsMonitor'

describe('operations monitor client', () => {
  it('keeps the match dashboard focused on jobs that are still actionable', () => {
    const job = (status: string, id = status): AiWorkSnapshot => ({
      id,
      matchId: 'match-1',
      matchTitle: 'TPE vs PUR',
      rallyId: 'rally-1',
      status,
      progress: null,
      stage: null,
      workerInstanceKey: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    })

    expect(
      activeAiWorkForDashboard([
        job('SUPERSEDED'),
        job('RUNNING'),
        job('CANCELLED'),
        job('QUEUED'),
        job('COMPLETED'),
      ]),
    ).toEqual([job('RUNNING'), job('QUEUED')])
  })

  it('keeps dashboard media sources scoped to visible matches', () => {
    const stream = (matchId: string): StreamSnapshot => ({
      captureSessionId: `capture-${matchId}`,
      matchId,
      matchTitle: matchId,
      sourceKind: 'RTMP',
      sourceLabel: null,
      sourceDurationUs: null,
      status: 'LIVE',
      health: 'HEALTHY',
      startedAt: null,
      updatedAt: '2026-08-08T00:00:00.000Z',
      completionExpectedSegments: null,
      completionRequestedAt: null,
      epochCount: 0,
      sourceWork: null,
      program: null,
    })
    expect(
      visibleStreamsForMatches([stream('visible'), stream('smoke-fixture')], new Set(['visible'])),
    ).toEqual([stream('visible')])
  })

  it('loads the same-origin operations summary without caching credentials elsewhere', async () => {
    const payload = {
      readiness: { status: 'ready', checks: { postgres: 'ok' } },
      operations: {
        generatedAt: '2026-08-08T00:00:00.000Z',
        process: {},
        database: {},
        streams: [],
      },
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    ) as unknown as typeof fetch
    await expect(fetchOperationsSnapshot('/api/v1/', fetchImpl)).resolves.toEqual(payload)
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/operations/summary', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
  })

  it('surfaces access control failures clearly', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch
    await expect(fetchOperationsSnapshot('/api/v1', fetchImpl)).rejects.toThrow(
      '目前帳號沒有系統監控權限',
    )
  })

  it('deletes an inactive worker through the same-origin control route', async () => {
    const payload = {
      schema_version: '1.0.0',
      deleted_worker: { id: 'worker-1', instance_key: 'analysis-worker-01' },
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    ) as unknown as typeof fetch
    await expect(deleteAiWorker('/api/v1/', 'worker-1', fetchImpl)).resolves.toEqual(payload)
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/operations/ai-workers/worker-1', {
      credentials: 'include',
      headers: { accept: 'application/json' },
      method: 'DELETE',
    })
  })

  it('permanently deletes a worker token through the control route', async () => {
    const payload = {
      schema_version: '1.0.0',
      deleted_token: { id: 'token-1' },
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    ) as unknown as typeof fetch

    await expect(deleteAiWorkerToken('/api/v1/', 'token-1', fetchImpl)).resolves.toEqual(payload)
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/operations/ai-worker-tokens/token-1', {
      credentials: 'include',
      headers: { accept: 'application/json' },
      method: 'DELETE',
    })
  })

  it('explains when a stale worker recovered before deletion', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'AI_WORKER_ONLINE' }), {
          headers: { 'content-type': 'application/json' },
          status: 409,
        }),
    ) as unknown as typeof fetch
    await expect(deleteAiWorker('/api/v1', 'worker-1', fetchImpl)).rejects.toThrow(
      'Worker 已恢復連線，無法刪除',
    )
  })
})
