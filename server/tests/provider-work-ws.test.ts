import type { ProviderWorkCapability } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import {
  providerCapabilityMatchesJob,
  providerDatabaseWorkKinds,
  providerMatchScope,
  providerMatchScopeWhere,
  providerStorageEndpoint,
  recoverExpiredProviderJobs,
} from '../src/realtime/provider-work-ws.js'

const capability: ProviderWorkCapability = {
  work_kind: 'ANALYSIS',
  request_schema_versions: ['1.0.0'],
  result_schema_versions: ['1.0.0'],
  accepted_input_artifact_kinds: ['CANONICAL_CLIP'],
  produced_artifact_kinds: ['ANALYSIS_DATA'],
  model_recipe_namespaces: ['analysis/base-every-frame-pose-v1'],
  hardware: { accelerator: 'CUDA' },
  max_concurrency: 1,
}

describe('Provider Work v2 scheduling', () => {
  it('limits candidate queries to the work kinds declared by the provider', () => {
    expect(
      providerDatabaseWorkKinds({
        schema_version: '3.0.0',
        provider_name: 'analysis-only',
        provider_build_id: 'analysis-only/test',
        work_capabilities: [capability, { ...capability }],
      }),
    ).toEqual(['ANALYSIS'])
  })

  it('scopes an opt-in provider connection to one match', () => {
    const matchId = '1322399f-91fa-42c8-92b2-683067101f3b'
    expect(providerMatchScope(`/api/v2/ai/providers/ws?match_id=${matchId}`)).toBe(matchId)
    expect(providerMatchScopeWhere(matchId)).toEqual({
      requestPayload: { path: ['match_id'], equals: matchId },
    })
    expect(providerMatchScope('/api/v2/ai/providers/ws')).toBeNull()
    expect(providerMatchScopeWhere(null)).toEqual({})
    expect(() => providerMatchScope('/api/v2/ai/providers/ws?match_id=not-a-uuid')).toThrow(
      'Provider match_id scope must be a UUID',
    )
  })

  it('uses the provider-reachable endpoint before the browser-facing public endpoint', () => {
    expect(
      providerStorageEndpoint({
        MINIO_PROVIDER_ENDPOINT: 'http://minio-provider:9000',
        MINIO_ENDPOINT: 'http://minio:9000',
        MINIO_PUBLIC_ENDPOINT: 'https://storage.example.test',
      }),
    ).toBe('http://minio-provider:9000')
    expect(
      providerStorageEndpoint({
        MINIO_ENDPOINT: 'http://minio:9000',
        MINIO_PUBLIC_ENDPOINT: 'https://storage.example.test',
      }),
    ).toBe('http://minio:9000')
    expect(providerStorageEndpoint({ MINIO_PUBLIC_ENDPOINT: 'https://storage.example.test' })).toBe(
      'https://storage.example.test',
    )
  })

  it('requires every required input artifact to be supported', () => {
    expect(
      providerCapabilityMatchesJob(capability, {
        requestSchemaVersion: '1.0.0',
        resultSchemaVersion: '1.0.0',
        artifacts: [
          { direction: 'INPUT', artifactKind: 'CANONICAL_CLIP', required: true },
          { direction: 'INPUT', artifactKind: 'OPTIONAL_DEBUG', required: false },
        ],
      }),
    ).toBe(true)
    expect(
      providerCapabilityMatchesJob(capability, {
        requestSchemaVersion: '1.0.0',
        resultSchemaVersion: '1.0.0',
        artifacts: [{ direction: 'INPUT', artifactKind: 'REID_BANK_SNAPSHOT', required: true }],
      }),
    ).toBe(false)
  })

  it('requeues an expired lease but terminalizes an exhausted execution', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const database = {
      providerJob: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'retry', attemptCount: 1, maxAttempts: 3, status: JobStatus.RUNNING },
          { id: 'exhausted', attemptCount: 3, maxAttempts: 3, status: JobStatus.QUEUED },
        ]),
        updateMany,
      },
    } as unknown as PrismaClient
    const now = new Date('2026-08-15T12:00:00.000Z')

    await recoverExpiredProviderJobs(database, now)

    expect(updateMany).toHaveBeenCalledTimes(2)
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: JobStatus.QUEUED,
      providerInstanceId: null,
      deliveryId: null,
      stage: 'worker_lease_expired',
    })
    expect(updateMany.mock.calls[1]?.[0].data).toMatchObject({
      status: JobStatus.FAILED,
      errorCode: 'PROVIDER_EXECUTION_LEASE_EXHAUSTED',
      completedAt: now,
    })
  })
})
