import { describe, expect, it } from 'vitest'
import {
  composeWorkflowLifecycles,
  type NamedWorkflowLifecycle,
  type WorkflowModuleName,
} from '../src/workflow-composition.js'

const moduleLifecycle = (
  name: WorkflowModuleName,
  events: string[],
  options: { startError?: Error; stopError?: Error } = {},
): NamedWorkflowLifecycle => ({
  name,
  lifecycle: {
    async start() {
      events.push(`start:${name}`)
      if (options.startError) throw options.startError
    },
    async stop() {
      events.push(`stop:${name}`)
      if (options.stopError) throw options.stopError
    },
  },
})

describe('workflow composition', () => {
  it('starts every module, stops in reverse, and disconnects once', async () => {
    const events: string[] = []
    const composition = composeWorkflowLifecycles([
      moduleLifecycle('clip', events),
      moduleLifecycle('playback-cleanup', events),
      moduleLifecycle('analysis-convergence', events),
      moduleLifecycle('outbox', events),
    ], async () => { events.push('disconnect') })

    await composition.start()
    expect(composition.snapshot().map(module => module.state)).toEqual([
      'running',
      'running',
      'running',
      'running',
    ])
    await composition.stop()

    expect(events).toEqual([
      'start:clip',
      'start:playback-cleanup',
      'start:analysis-convergence',
      'start:outbox',
      'stop:outbox',
      'stop:analysis-convergence',
      'stop:playback-cleanup',
      'stop:clip',
      'disconnect',
    ])
    expect(composition.snapshot().map(module => module.state)).toEqual([
      'stopped',
      'stopped',
      'stopped',
      'stopped',
    ])
  })

  it('rolls back started modules and disconnects after a startup failure', async () => {
    const events: string[] = []
    const composition = composeWorkflowLifecycles([
      moduleLifecycle('clip', events),
      moduleLifecycle('outbox', events, { startError: new Error('publisher unavailable') }),
    ], async () => { events.push('disconnect') })

    await expect(composition.start()).rejects.toThrow('publisher unavailable')
    expect(events).toEqual([
      'start:clip',
      'start:outbox',
      'stop:clip',
      'disconnect',
    ])
    expect(composition.snapshot()).toMatchObject([
      { name: 'clip', state: 'stopped' },
      { name: 'outbox', state: 'failed', lastErrorName: 'Error' },
    ])
  })

  it('stops healthy siblings, disconnects, and aggregates shutdown failures', async () => {
    const events: string[] = []
    const composition = composeWorkflowLifecycles([
      moduleLifecycle('clip', events, { stopError: new Error('ffmpeg shutdown failed') }),
      moduleLifecycle('playback-cleanup', events),
    ], async () => { events.push('disconnect') })

    await composition.start()
    await expect(composition.stop()).rejects.toThrow('workflow shutdown failed')
    expect(events).toContain('stop:playback-cleanup')
    expect(events).toContain('stop:clip')
    expect(events.at(-1)).toBe('disconnect')
    expect(composition.snapshot()).toMatchObject([
      { name: 'clip', state: 'failed', lastErrorName: 'Error' },
      { name: 'playback-cleanup', state: 'stopped' },
    ])
  })
})
