import { describe, expect, it } from 'vitest'
import {
  bootstrapStorage,
  parseBootstrapMode,
  resolveHostMinioEndpoint,
  storageBootstrapConfig,
  type StorageAdminClient,
} from './storage_bootstrap.js'

function fakeClient(existing: string[] = []): StorageAdminClient & { created: string[] } {
  const buckets = new Set(existing)
  const created: string[] = []
  return {
    created,
    async bucketExists(bucket) {
      return buckets.has(bucket)
    },
    async makeBucket(bucket) {
      buckets.add(bucket)
      created.push(bucket)
    },
  }
}

const env = {
  MINIO_ENDPOINT: 'http://minio:9000',
  MINIO_HOST_PORT: '9100',
  MINIO_RAW_BUCKET: 'raw-media',
  MINIO_DVR_BUCKET: 'dvr-media',
  MINIO_RALLY_BUCKET: 'rally-media',
  MINIO_ANALYSIS_BUCKET: 'analysis-artifacts',
} as NodeJS.ProcessEnv

describe('storage bootstrap', () => {
  it('maps the Compose service hostname to the host-published port', () => {
    expect(resolveHostMinioEndpoint(env).origin).toBe('http://127.0.0.1:9100')
    expect(
      resolveHostMinioEndpoint({ ...env, MINIO_BOOTSTRAP_ENDPOINT: 'https://storage.example.test' })
        .origin,
    ).toBe('https://storage.example.test')
  })

  it('defaults production to validation and development to ensure', () => {
    expect(parseBootstrapMode(undefined, 'production')).toBe('validate')
    expect(parseBootstrapMode(undefined, 'development')).toBe('ensure')
  })

  it('idempotently creates only missing buckets in ensure mode', async () => {
    const client = fakeClient(['raw-media', 'dvr-media'])
    const config = storageBootstrapConfig({ ...env, OBJECT_STORAGE_BOOTSTRAP_MODE: 'ensure' })
    await expect(bootstrapStorage(client, config)).resolves.toEqual(config.buckets)
    expect(client.created).toEqual(['rally-media', 'analysis-artifacts'])
    await bootstrapStorage(client, config)
    expect(client.created).toHaveLength(2)
  })

  it('never creates buckets in validate mode', async () => {
    const client = fakeClient(['raw-media'])
    const config = storageBootstrapConfig({ ...env, OBJECT_STORAGE_BOOTSTRAP_MODE: 'validate' })
    await expect(bootstrapStorage(client, config)).rejects.toThrow(
      'dvr-media, rally-media, analysis-artifacts',
    )
    expect(client.created).toEqual([])
  })
})
