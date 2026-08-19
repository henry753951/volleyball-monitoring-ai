import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  deleteInactiveAiWorker,
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
    annotationReceipts: [
      { count: 6, labels: { accepted: 'true' } },
      { count: 1, labels: { accepted: 'false' } },
    ],
    captures: [{ count: 1, labels: { health: 'HEALTHY', status: 'LIVE' } }],
    clipJobs: [{ count: 1, labels: { status: 'COMPLETED' } }],
    mediaAssets: [{ count: 3, labels: { kind: 'OVERLAY_CHUNK', state: 'READY' } }],
    outboxEvents: [{ count: 4, labels: { status: 'PENDING' } }],
    rallies: [
      { count: 1, labels: { annotation_status: 'SUBMITTED', processing_status: 'COMPLETED' } },
    ],
  },
  aiWorkers: [
    {
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
      latencyMs: 7,
      lastPingAt: '2026-08-07T23:59:59.993Z',
      lastPongAt: '2026-08-08T00:00:00.000Z',
      status: 'online',
      canDelete: false,
      accelerator: 'NVIDIA H100 NVL',
      modelVersion: 'court-canonical-v4',
      modelSha256: 'f45f96ce',
      deploymentStatus: 'ready',
    },
  ],
  aiWorkerAccess: {
    name: 'volleyball-analysis-engine',
    authMode: 'managed',
    workerCount: 1,
    onlineWorkerCount: 1,
    activeJobCount: 1,
    tokens: [
      {
        id: '40000000-0000-4000-8000-000000000001',
        name: 'GPU A',
        tokenPrefix: 'vmai_example',
        enabled: true,
        lastUsedAt: '2026-08-08T00:00:00.000Z',
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
    ],
  },
  aiWork: [],
  providerWork: [],
  deployment: {
    available: true,
    components: [],
    namespace: 'volleyball-monitoring',
    overallStatus: 'ready',
    source: 'kubernetes',
  },
  hostStorage: {
    available: true,
    freeBytes: '3000',
    managedBytes: '1250',
    path: '/var/lib/volleyball/media-recordings',
    totalBytes: '5000',
    usedBytes: '2000',
  },
  objectStorage: {
    available: true,
    freeBytes: '8000',
    managedBytes: '2048',
    path: 'http://minio:9000',
    totalBytes: '10000',
    usedBytes: '2000',
  },
  matchMedia: [
    {
      activeCaptureCount: 1,
      captureCount: 1,
      failedCaptureCount: 0,
      gapSegmentCount: 0,
      indexedDurationUs: '1800000000',
      matchId: 'match-1',
      readySegmentCount: 507,
      segmentCount: 507,
      storedBytes: '2048',
    },
  ],
  streams: [
    {
      captureSessionId: 'capture-1',
      matchId: 'match-1',
      matchTitle: 'JPN vs IND',
      sourceKind: 'FILE',
      sourceLabel: 'Demo archive',
      sourceDurationUs: '1800000000',
      status: 'LIVE',
      health: 'HEALTHY',
      startedAt: '2026-08-07T23:30:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      completionExpectedSegments: null,
      completionRequestedAt: null,
      epochCount: 1,
      sourceWork: {
        id: 'source-work-1',
        status: 'RUNNING',
        attempts: 1,
        availableAt: '2026-08-07T23:30:00.000Z',
        leaseExpiresAt: '2026-08-08T00:00:30.000Z',
        lastHeartbeatAt: '2026-08-08T00:00:00.000Z',
        lastErrorCode: null,
        resumeSegmentIndex: 507,
        resumeCaptureTimeUs: '1800000000',
        createdAt: '2026-08-07T23:30:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
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
    },
  ],
}

describe('operations routes', () => {
  it('renders bounded aggregate Prometheus metrics without payload data', () => {
    const metrics = renderPrometheusMetrics(snapshot)
    expect(metrics).toContain('vmai_process_resident_memory_bytes 1024')
    expect(metrics).toContain('vmai_host_storage_free_bytes 3000')
    expect(metrics).toContain('vmai_host_storage_managed_bytes 1250')
    expect(metrics).toContain('vmai_object_storage_free_bytes 8000')
    expect(metrics).toContain('vmai_object_storage_total_bytes 10000')
    expect(metrics).toContain('vmai_object_storage_managed_bytes 2048')
    expect(metrics).toContain(
      'vmai_rallies_total{annotation_status="SUBMITTED",processing_status="COMPLETED"} 1',
    )
    expect(metrics).toContain('vmai_annotation_command_receipts_total{accepted="false"} 1')
    expect(metrics).toContain('vmai_annotation_operations_total 7')
    expect(metrics).toContain(
      'vmai_ai_provider_worker_active_jobs{build="analysis/0.1.0",instance="analysis-1"} 1',
    )
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
    await app.register(
      operationsRoutes(
        async identity => {
          collectedFor = identity
          return snapshot
        },
        {
          authenticate: async () => ({ role: 'OPERATOR', userId: 'operator-1' }),
          collectReadiness: async () => ({
            status: 'ready',
            checks: { minio: 'ok', postgres: 'ok', redis: 'ok' },
          }),
        },
      ),
    )
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
    await app.register(
      operationsRoutes(async () => snapshot, {
        authenticate: async () => ({ role: 'COACH', userId: 'coach-1' }),
        collectReadiness: async () => ({ status: 'ready', checks: {} }),
      }),
    )
    const response = await app.inject({ method: 'GET', url: '/api/v1/operations/summary' })
    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('deletes an inactive worker through the authenticated control route', async () => {
    const app = Fastify()
    const deleteAiWorker = vi.fn(async () => ({
      deleted: true as const,
      id: '30000000-0000-4000-8000-000000000001',
      instanceKey: 'analysis-worker-01',
    }))
    await app.register(
      operationsRoutes(async () => snapshot, {
        authenticate: async () => ({ role: 'OPERATOR', userId: 'operator-1' }),
        collectReadiness: async () => ({ status: 'ready', checks: {} }),
        deleteAiWorker,
      }),
    )
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/operations/ai-workers/30000000-0000-4000-8000-000000000001',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      schema_version: '1.0.0',
      deleted_worker: {
        id: '30000000-0000-4000-8000-000000000001',
        instance_key: 'analysis-worker-01',
      },
    })
    expect(deleteAiWorker).toHaveBeenCalledWith('30000000-0000-4000-8000-000000000001', {
      role: 'OPERATOR',
      userId: 'operator-1',
    })
    await app.close()
  })

  it('lets an authenticated operator create, rotate, disable, and delete worker tokens', async () => {
    const app = Fastify()
    const createAiWorkerToken = vi.fn(async () => ({
      accessToken: {
        id: '40000000-0000-4000-8000-000000000001',
        name: 'GPU A',
        tokenPrefix: 'vmai_example',
      },
      token: 'vmai_secret',
    }))
    const rotateAiWorkerToken = vi.fn(async () => ({
      tokenId: '40000000-0000-4000-8000-000000000001',
      token: 'vmai_rotated',
    }))
    const updateAiWorkerTokenState = vi.fn(async () => ({
      tokenId: '40000000-0000-4000-8000-000000000001',
      enabled: false,
    }))
    const deleteAiWorkerToken = vi.fn(async () => ({
      tokenId: '40000000-0000-4000-8000-000000000001',
    }))
    await app.register(
      operationsRoutes(async () => snapshot, {
        authenticate: async () => ({ role: 'OPERATOR', userId: 'operator-1' }),
        collectReadiness: async () => ({ status: 'ready', checks: {} }),
        createAiWorkerToken,
        deleteAiWorkerToken,
        rotateAiWorkerToken,
        updateAiWorkerTokenState,
      }),
    )

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/ai-worker-tokens',
      payload: { name: 'GPU A' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ token: 'vmai_secret' })
    expect(created.json()).not.toHaveProperty('integration')
    expect(createAiWorkerToken).toHaveBeenCalledWith('GPU A', {
      role: 'OPERATOR',
      userId: 'operator-1',
    })

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/ai-worker-tokens/40000000-0000-4000-8000-000000000001/rotate',
    })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json()).toMatchObject({
      token_id: '40000000-0000-4000-8000-000000000001',
      token: 'vmai_rotated',
    })

    const disabled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/operations/ai-worker-tokens/40000000-0000-4000-8000-000000000001',
      payload: { enabled: false },
    })
    expect(disabled.statusCode).toBe(200)
    expect(updateAiWorkerTokenState).toHaveBeenCalledWith(
      '40000000-0000-4000-8000-000000000001',
      false,
      { role: 'OPERATOR', userId: 'operator-1' },
    )

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/operations/ai-worker-tokens/40000000-0000-4000-8000-000000000001',
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({
      schema_version: '1.0.0',
      deleted_token: { id: '40000000-0000-4000-8000-000000000001' },
    })
    expect(deleteAiWorkerToken).toHaveBeenCalledWith('40000000-0000-4000-8000-000000000001', {
      role: 'OPERATOR',
      userId: 'operator-1',
    })
    await app.close()
  })

  it('atomically refuses online or busy worker records', async () => {
    const stale = new Date('2026-08-08T00:00:00.000Z')
    const now = new Date('2026-08-08T00:01:00.000Z')
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ disconnectedAt: null, instanceKey: 'online', lastSeenAt: now })
      .mockResolvedValueOnce({ disconnectedAt: null, instanceKey: 'busy', lastSeenAt: stale })
      .mockResolvedValueOnce({ disconnectedAt: null, lastSeenAt: stale })
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
    const database = { aiProviderInstance: { deleteMany, findUnique } } as unknown as Parameters<
      typeof deleteInactiveAiWorker
    >[0]

    await expect(deleteInactiveAiWorker(database, 'worker-online', now)).resolves.toEqual({
      deleted: false,
      reason: 'online',
    })
    await expect(deleteInactiveAiWorker(database, 'worker-busy', now)).resolves.toEqual({
      deleted: false,
      reason: 'active_jobs',
    })
    expect(deleteMany).toHaveBeenCalledOnce()
    expect(deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        jobs: { none: { status: { in: ['QUEUED', 'RUNNING'] } } },
        providerJobs: { none: { status: { in: ['QUEUED', 'RUNNING'] } } },
      }),
    })
  })
})
