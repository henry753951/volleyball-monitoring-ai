import { readdir, stat, statfs } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface HostStorageSnapshot {
  available: boolean
  freeBytes: string
  managedBytes: string
  path: string
  totalBytes: string
  usedBytes: string
}

export type HostStorageProbe = () => Promise<HostStorageSnapshot>

async function measureManagedBytes(target: string): Promise<bigint> {
  const root = await stat(target, { bigint: true })
  if (root.isFile()) return root.size

  const pending = [target]
  let total = 0n
  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) total += (await stat(path, { bigint: true })).size
    }
  }
  return total
}

export function createHostStorageProbe(path: string): HostStorageProbe {
  const target = resolve(path)
  let cachedManagedBytes = 0n
  let managedBytesExpiresAt = 0
  return async () => {
    try {
      const value = await statfs(target, { bigint: true })
      const totalBytes = value.blocks * value.bsize
      const freeBytes = value.bavail * value.bsize
      if (Date.now() >= managedBytesExpiresAt) {
        cachedManagedBytes = await measureManagedBytes(target)
        managedBytesExpiresAt = Date.now() + 30_000
      }
      return {
        available: true,
        freeBytes: freeBytes.toString(),
        managedBytes: cachedManagedBytes.toString(),
        path: target,
        totalBytes: totalBytes.toString(),
        usedBytes: (totalBytes - freeBytes).toString(),
      }
    }
    catch {
      return { available: false, freeBytes: '0', managedBytes: '0', path: target, totalBytes: '0', usedBytes: '0' }
    }
  }
}
