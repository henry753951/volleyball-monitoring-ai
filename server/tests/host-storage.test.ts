import { describe, expect, it } from 'vitest'
import { createHostStorageProbe } from '../src/operations/host-storage.js'

describe('host storage probe', () => {
  it('reports bigint filesystem capacity as decimal wire values', async () => {
    const snapshot = await createHostStorageProbe(process.cwd())()
    expect(snapshot.available).toBe(true)
    expect(snapshot.path).toBeTruthy()
    expect(BigInt(snapshot.totalBytes)).toBeGreaterThan(0n)
    expect(BigInt(snapshot.freeBytes)).toBeGreaterThanOrEqual(0n)
    expect(BigInt(snapshot.managedBytes)).toBeGreaterThanOrEqual(0n)
    expect(BigInt(snapshot.usedBytes)).toBe(BigInt(snapshot.totalBytes) - BigInt(snapshot.freeBytes))
  })

  it('returns an unavailable snapshot for a missing path', async () => {
    const snapshot = await createHostStorageProbe('Z:\\definitely-missing-volleyball-storage')()
    expect(snapshot).toMatchObject({ available: false, freeBytes: '0', managedBytes: '0', totalBytes: '0', usedBytes: '0' })
  })
})
