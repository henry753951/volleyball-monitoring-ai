import { describe, expect, it, vi } from 'vitest'
import { fetchOperationsSnapshot, visibleStreamsForMatches, type StreamSnapshot } from './operationsMonitor'

describe('operations monitor client', () => {
  it('keeps dashboard media sources scoped to visible matches', () => {
    const stream = (matchId: string): StreamSnapshot => ({
      captureSessionId: `capture-${matchId}`,
      matchId,
      matchTitle: matchId,
      sourceKind: 'RTMP',
      sourceLabel: null,
      status: 'LIVE',
      health: 'HEALTHY',
      startedAt: null,
      updatedAt: '2026-08-08T00:00:00.000Z',
      epochCount: 0,
      program: null,
    })
    expect(visibleStreamsForMatches([stream('visible'), stream('smoke-fixture')], new Set(['visible'])))
      .toEqual([stream('visible')])
  })

  it('loads the same-origin operations summary without caching credentials elsewhere', async () => {
    const payload = {
      readiness: { status: 'ready', checks: { postgres: 'ok' } },
      operations: { generatedAt: '2026-08-08T00:00:00.000Z', process: {}, database: {}, streams: [] },
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })) as unknown as typeof fetch
    await expect(fetchOperationsSnapshot('/api/v1/', fetchImpl)).resolves.toEqual(payload)
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/operations/summary', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
  })

  it('surfaces access control failures clearly', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch
    await expect(fetchOperationsSnapshot('/api/v1', fetchImpl)).rejects.toThrow('目前帳號沒有系統監控權限')
  })
})
