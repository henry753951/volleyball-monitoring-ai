import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateReadiness } from '../src/health/readiness.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('evaluateReadiness', () => {
  it('reports ready only when every dependency probe succeeds', async () => {
    const result = await evaluateReadiness([
      { name: 'postgres', check: async () => undefined },
      { name: 'redis', check: async () => undefined },
    ])

    expect(result).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    })
  })

  it('reports failed dependencies without exposing their errors', async () => {
    const result = await evaluateReadiness([
      { name: 'postgres', check: async () => undefined },
      { name: 'minio', check: async () => { throw new Error('secret endpoint detail') } },
    ])

    expect(result).toEqual({
      status: 'unavailable',
      checks: { postgres: 'ok', minio: 'failed' },
    })
  })

  it('bounds a stalled dependency probe and aborts its signal', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const resultPromise = evaluateReadiness([{
      name: 'redis',
      check: async (probeSignal) => {
        signal = probeSignal
        await new Promise(() => undefined)
      },
    }], 100)

    await vi.advanceTimersByTimeAsync(100)

    await expect(resultPromise).resolves.toEqual({
      status: 'unavailable',
      checks: { redis: 'failed' },
    })
    expect(signal?.aborted).toBe(true)
  })
})
