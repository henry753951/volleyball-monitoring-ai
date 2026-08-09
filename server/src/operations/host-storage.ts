import { statfs } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface HostStorageSnapshot {
  available: boolean
  freeBytes: string
  path: string
  totalBytes: string
  usedBytes: string
}

export type HostStorageProbe = () => Promise<HostStorageSnapshot>

export function createHostStorageProbe(path: string): HostStorageProbe {
  const target = resolve(path)
  return async () => {
    try {
      const value = await statfs(target, { bigint: true })
      const totalBytes = value.blocks * value.bsize
      const freeBytes = value.bavail * value.bsize
      return { available: true, freeBytes: freeBytes.toString(), path: target, totalBytes: totalBytes.toString(), usedBytes: (totalBytes - freeBytes).toString() }
    }
    catch {
      return { available: false, freeBytes: '0', path: target, totalBytes: '0', usedBytes: '0' }
    }
  }
}
