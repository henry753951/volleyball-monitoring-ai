import { describe, expect, it } from 'vitest'
import { runWorkerLifecycle } from '../src/lifecycle.js'

describe('runWorkerLifecycle', () => {
  it('logs readiness once and waits for cancellation', async () => {
    const controller = new AbortController()
    const logs: string[] = []
    const running = runWorkerLifecycle({
      role: 'workflow',
      signal: controller.signal,
      log: message => logs.push(message),
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('role=workflow')

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
      log: message => logs.push(message),
    })

    expect(logs).toHaveLength(0)
  })

  it('awaits media-indexer cleanup and surfaces cleanup failures', async () => {
    const controller = new AbortController()
    let releaseCleanup: (() => void) | undefined
    const cleanup = new Promise<void>(resolve => {
      releaseCleanup = resolve
    })
    const running = runWorkerLifecycle({
      role: 'media-indexer',
      signal: controller.signal,
      log: () => undefined,
      start: async () => undefined,
      stop: () => cleanup,
    })

    controller.abort()
    let settled = false
    void running.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseCleanup!()
    await running

    const failedController = new AbortController()
    const failed = runWorkerLifecycle({
      role: 'media-indexer',
      signal: failedController.signal,
      log: () => undefined,
      start: async () => undefined,
      stop: async () => {
        throw new Error('cleanup failed')
      },
    })
    failedController.abort()
    await expect(failed).rejects.toThrow('cleanup failed')
  })
})
