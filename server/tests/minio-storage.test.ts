import { describe, expect, it, vi } from 'vitest'
import { createMinioStorageProbe } from '../src/operations/minio-storage.js'

describe('MinIO storage probe', () => {
  it('reads usable cluster capacity from current MinIO v3 metrics', async () => {
    const fetchImpl = vi.fn(async () => new Response(`
# HELP minio_cluster_health_capacity_usable_total_bytes Total cluster usable storage capacity in bytes
minio_cluster_health_capacity_usable_total_bytes 1.099511627776e+12
minio_cluster_health_capacity_usable_free_bytes 8.24633720832e+11
`)) as unknown as typeof fetch

    const snapshot = await createMinioStorageProbe('http://127.0.0.1:9000', fetchImpl)()

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:9000/minio/metrics/v3/cluster/health'),
      expect.objectContaining({ headers: { accept: 'text/plain' } }),
    )
    expect(snapshot).toEqual({
      available: true,
      freeBytes: '824633720832',
      managedBytes: '0',
      path: 'http://127.0.0.1:9000',
      totalBytes: '1099511627776',
      usedBytes: '274877906944',
    })
  })

  it('returns an unavailable snapshot when metrics require authentication', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch

    await expect(createMinioStorageProbe('http://minio:9000', fetchImpl)()).resolves.toEqual({
      available: false,
      freeBytes: '0',
      managedBytes: '0',
      path: 'http://minio:9000',
      totalBytes: '0',
      usedBytes: '0',
    })
  })
})
