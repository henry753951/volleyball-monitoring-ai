import { describe, expect, it } from 'vitest'
import { runWorkerLifecycle } from '../src/lifecycle.js'

describe('runWorkerLifecycle', () => {
  it('logs readiness once and waits for cancellation', async () => {
    const controller = new AbortController()
    const logs: string[] = []
    const running = runWorkerLifecycle({
      role: 'clip-worker',
      signal: controller.signal,
      log: (message) => logs.push(message),
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('role=clip-worker')

    controller.abort()
    await running
  })

  it('returns immediately when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const logs: string[] = []

    await runWorkerLifecycle({
      role: 'media-indexer',
      signal: controller.signal,
      log: (message) => logs.push(message),
    })

    expect(logs).toHaveLength(0)
  })
})
