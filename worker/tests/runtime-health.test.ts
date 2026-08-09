import { describe, expect, it } from 'vitest'
import { createWorkerHealthDocument, type WorkerComponentHealth } from '../src/runtime-health.js'

const component = (overrides: Partial<WorkerComponentHealth> = {}): WorkerComponentHealth => ({
  name: 'clip',
  critical: true,
  status: 'healthy',
  activeWork: 0,
  failedJobs: 0,
  backlog: 0,
  lastHeartbeatAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorName: null,
  ...overrides,
})

describe('worker health aggregation', () => {
  it('keeps a maintenance failure degraded without declaring the process unhealthy', () => {
    const document = createWorkerHealthDocument('workflow', [
      component(),
      component({ name: 'playback-cleanup', critical: false, status: 'unhealthy' }),
    ])
    expect(document.status).toBe('degraded')
  })

  it('declares a stopped critical loop unhealthy', () => {
    const document = createWorkerHealthDocument('media', [
      component({ name: 'media-indexer', status: 'unhealthy' }),
    ])
    expect(document.status).toBe('unhealthy')
  })
})
