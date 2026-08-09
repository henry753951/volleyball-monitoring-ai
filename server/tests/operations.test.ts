import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  operationsRoutes,
  renderPrometheusMetrics,
  type OperationsSnapshot,
} from '../src/routes/operations.js'

const snapshot: OperationsSnapshot = {
  generatedAt: '2026-08-08T00:00:00.000Z',
  process: { heapUsedBytes: 512, residentBytes: 1024, uptimeSeconds: 12.5 },
  database: {
    aiCallbacks: [{ count: 2, labels: { kind: 'COMPLETED' } }],
    aiJobs: [{ count: 1, labels: { status: 'COMPLETED' } }],
    annotationOperations: { lastAt: '2026-08-07T23:59:30.000Z', total: 7 },
    annotationReceipts: [{ count: 6, labels: { accepted: 'true' } }, { count: 1, labels: { accepted: 'false' } }],
    captures: [{ count: 1, labels: { health: 'HEALTHY', status: 'LIVE' } }],
    clipJobs: [{ count: 1, labels: { status: 'COMPLETED' } }],
    mediaAssets: [{ count: 3, labels: { kind: 'OVERLAY_CHUNK', state: 'READY' } }],
    outboxEvents: [{ count: 4, labels: { status: 'PENDING' } }],
    rallies: [{ count: 1, labels: { annotation_status: 'SUBMITTED', processing_status: 'COMPLETED' } }],
  },
  aiWorkers: [{
    id: 'worker-1',
    instanceKey: 'analysis-1',
    providerBuildId: 'analysis/0.1.0',
    sdkVersion: '0.2.0',
    maxConcurrency: 2,
    activeJobs: 1,
    utilization: 0.5,
    connectedAt: '2026-08-07T23:58:00.000Z',
    lastSeenAt: '2026-08-08T00:00:00.000Z',
    disconnectedAt: null,
    status: 'online',
  }],
  aiWork: [],
  hostStorage: {
    available: true,
    freeBytes: '3000',
    path: '/var/lib/volleyball/media-recordings',
    totalBytes: '5000',
    usedBytes: '2000',
  },
  matchMedia: [{
    activeCaptureCount: 1,
    captureCount: 1,
    failedCaptureCount: 0,
    gapSegmentCount: 0,
    indexedDurationUs: '1800000000',
    matchId: 'match-1',
    readySegmentCount: 507,
    segmentCount: 507,
    storedBytes: '2048',
  }],
  streams: [{
    captureSessionId: 'capture-1',
    matchId: 'match-1',
    matchTitle: 'JPN vs IND',
    sourceKind: 'FILE',
    sourceLabel: 'Demo archive',
    status: 'LIVE',
    health: 'HEALTHY',
    startedAt: '2026-08-07T23:30:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    epochCount: 1,
    program: {
      id: 'program-1',
      status: 'LIVE',
      playlistRevision: '507',
      liveEdgeUs: '1800000000',
      durationUs: '1800000000',
      fps: { numerator: 60, denominator: 1 },
      timeBase: { numerator: 1, denominator: 60000 },
      segmentCount: 507,
      readySegmentCount: 507,
      gapSegmentCount: 0,
      frameCount: '108000',
      indexedDurationUs: '1800000000',
    },
  }],
}

describe('operations routes', () => {
  it('renders bounded aggregate Prometheus metrics without payload data', () => {
    const metrics = renderPrometheusMetrics(snapshot)
    expect(metrics).toContain('vmai_process_resident_memory_bytes 1024')
    expect(metrics).toContain('vmai_host_storage_free_bytes 3000')
    expect(metrics).toContain('vmai_rallies_total{annotation_status="SUBMITTED",processing_status="COMPLETED"} 1')
    expect(metrics).toContain('vmai_annotation_command_receipts_total{accepted="false"} 1')
    expect(metrics).toContain('vmai_annotation_operations_total 7')
    expect(metrics).toContain('vmai_ai_provider_worker_active_jobs{build="analysis/0.1.0",instance="analysis-1"} 1')
    expect(metrics).not.toContain('requestJson')
    expect(metrics.endsWith('\n')).toBe(true)
  })

  it('serves metrics only from the internal route with no-store semantics', async () => {
    const app = Fastify()
    await app.register(operationsRoutes(async () => snapshot))
    const response = await app.inject({ method: 'GET', url: '/internal/metrics' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.body).toContain('vmai_ai_callback_receipts_total{kind="COMPLETED"} 2')
    await app.close()
  })

  it('serves a payload-free aggregate audit summary for internal collectors', async () => {
    const app = Fastify()
    await app.register(operationsRoutes(async () => snapshot))
    const response = await app.inject({ method: 'GET', url: '/internal/audit/summary' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual(snapshot)
    expect(response.body).not.toContain('requestJson')
    await app.close()
  })

  it('serves an authenticated operations dashboard snapshot to operators', async () => {
    const app = Fastify()
    let collectedFor: { role: string; userId: string } | undefined
    await app.register(operationsRoutes(async identity => {
      collectedFor = identity
      return snapshot
    }, {
      authenticate: async () => ({ role: 'OPERATOR', userId: 'operator-1' }),
      collectReadiness: async () => ({
        status: 'ready',
        checks: { minio: 'ok', postgres: 'ok', redis: 'ok' },
      }),
    }))
    const response = await app.inject({ method: 'GET', url: '/api/v1/operations/summary' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      operations: snapshot,
      readiness: { status: 'ready', checks: { minio: 'ok', postgres: 'ok', redis: 'ok' } },
    })
    expect(collectedFor).toEqual({ role: 'OPERATOR', userId: 'operator-1' })
    await app.close()
  })

  it('rejects dashboard access for non-operations roles', async () => {
    const app = Fastify()
    await app.register(operationsRoutes(async () => snapshot, {
      authenticate: async () => ({ role: 'COACH', userId: 'coach-1' }),
      collectReadiness: async () => ({ status: 'ready', checks: {} }),
    }))
    const response = await app.inject({ method: 'GET', url: '/api/v1/operations/summary' })
    expect(response.statusCode).toBe(403)
    await app.close()
  })
})
