import { describe, expect, it } from 'vitest'
import { createMediaIndexerLifecycle } from '../src/composition'

interface HarnessFailures {
  queueStart?: boolean
  queueStop?: boolean
  scannerStart?: boolean
  scannerStop?: boolean
  disconnect?: boolean
}

function harness(failures: HarnessFailures = {}) {
  const calls: string[] = []
  const step = async (name: string, fail = false) => {
    calls.push(name)
    if (fail) throw new Error(`${name} failed`)
  }
  return {
    calls,
    ports: {
      queue: {
        start: () => step('queue.start', failures.queueStart),
        stop: () => step('queue.stop', failures.queueStop),
      },
      scanner: {
        start: () => step('scanner.start', failures.scannerStart),
        stop: () => step('scanner.stop', failures.scannerStop),
      },
      disconnect: () => step('disconnect', failures.disconnect),
    },
  }
}

describe('composition lifecycle', () => {
  it('disconnects after queue startup failure and becomes terminal', async () => {
    const test = harness({ queueStart: true })
    const lifecycle = createMediaIndexerLifecycle(test.ports)
    await expect(lifecycle.start()).rejects.toThrow('queue.start failed')
    await lifecycle.stop()
    await expect(lifecycle.start()).rejects.toThrow('already started or stopped')
    expect(test.calls).toEqual(['queue.start', 'disconnect'])
  })

  it('stops queue then disconnects after scanner startup failure', async () => {
    const test = harness({ scannerStart: true })
    const lifecycle = createMediaIndexerLifecycle(test.ports)
    await expect(lifecycle.start()).rejects.toThrow('scanner.start failed')
    await lifecycle.stop()
    expect(test.calls).toEqual([
      'queue.start',
      'scanner.start',
      'queue.stop',
      'disconnect',
    ])
  })

  it('stops scanner, queue and database once in reverse order', async () => {
    const test = harness()
    const lifecycle = createMediaIndexerLifecycle(test.ports)
    await lifecycle.start()
    await lifecycle.stop()
    await lifecycle.stop()
    expect(test.calls).toEqual([
      'queue.start',
      'scanner.start',
      'scanner.stop',
      'queue.stop',
      'disconnect',
    ])
  })

  it('rejects repeated start without duplicating resources', async () => {
    const test = harness()
    const lifecycle = createMediaIndexerLifecycle(test.ports)
    await lifecycle.start()
    await expect(lifecycle.start()).rejects.toThrow('already started or stopped')
    expect(test.calls).toEqual(['queue.start', 'scanner.start'])
  })

  it('attempts every shutdown step when an earlier step fails', async () => {
    const test = harness({ scannerStop: true, queueStop: true })
    const lifecycle = createMediaIndexerLifecycle(test.ports)
    await lifecycle.start()
    await expect(lifecycle.stop()).rejects.toThrow('cleanup failed')
    expect(test.calls).toEqual([
      'queue.start',
      'scanner.start',
      'scanner.stop',
      'queue.stop',
      'disconnect',
    ])
  })

  it('still disconnects when queue cleanup fails during startup', async () => {
    const test = harness({ scannerStart: true, queueStop: true })
    const lifecycle = createMediaIndexerLifecycle(test.ports)
    await expect(lifecycle.start()).rejects.toThrow('startup and cleanup failed')
    expect(test.calls).toEqual([
      'queue.start',
      'scanner.start',
      'queue.stop',
      'disconnect',
    ])
  })

  it('preserves receiver binding for stateful lifecycle ports', async () => {
    const calls: string[] = []
    const queue = {
      started: false,
      async start() {
        this.started = true
        calls.push('queue.start')
      },
      async stop() {
        if (!this.started) throw new Error('queue receiver was lost')
        calls.push('queue.stop')
      },
    }
    const scanner = {
      started: false,
      async start() {
        this.started = true
        calls.push('scanner.start')
      },
      async stop() {
        if (!this.started) throw new Error('scanner receiver was lost')
        calls.push('scanner.stop')
      },
    }
    const lifecycle = createMediaIndexerLifecycle({
      queue,
      scanner,
      disconnect: async () => { calls.push('disconnect') },
    })

    await lifecycle.start()
    await lifecycle.stop()

    expect(calls).toEqual([
      'queue.start',
      'scanner.start',
      'scanner.stop',
      'queue.stop',
      'disconnect',
    ])
  })
})
