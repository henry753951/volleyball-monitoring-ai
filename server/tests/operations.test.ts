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
}

describe('operations routes', () => {
  it('renders bounded aggregate Prometheus metrics without payload data', () => {
    const metrics = renderPrometheusMetrics(snapshot)
    expect(metrics).toContain('vmai_process_resident_memory_bytes 1024')
    expect(metrics).toContain('vmai_rallies_total{annotation_status="SUBMITTED",processing_status="COMPLETED"} 1')
    expect(metrics).toContain('vmai_annotation_command_receipts_total{accepted="false"} 1')
    expect(metrics).toContain('vmai_annotation_operations_total 7')
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
})
