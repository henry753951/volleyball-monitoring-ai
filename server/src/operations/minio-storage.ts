import type { HostStorageProbe, HostStorageSnapshot } from './host-storage.js'

const CAPACITY_METRICS_PATH = '/minio/metrics/v3/cluster/health'
const TOTAL_METRIC_NAMES = [
  'minio_cluster_health_capacity_usable_total_bytes',
  'minio_cluster_capacity_usable_total_bytes',
] as const
const FREE_METRIC_NAMES = [
  'minio_cluster_health_capacity_usable_free_bytes',
  'minio_cluster_capacity_usable_free_bytes',
] as const

function unavailable(path: string): HostStorageSnapshot {
  return {
    available: false,
    freeBytes: '0',
    managedBytes: '0',
    path,
    totalBytes: '0',
    usedBytes: '0',
  }
}

function prometheusInteger(value: string): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value)
  if (!match) return null

  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  const scale = Number.parseInt(exponent, 10) - fraction.length
  if (!Number.isSafeInteger(scale)) return null

  const integerDigits = scale >= 0
    ? `${digits}${'0'.repeat(scale)}`
    : digits.slice(0, Math.max(0, digits.length + scale)) || '0'
  const result = BigInt(`${sign}${integerDigits}`)
  return result >= 0n ? result : null
}

function metricValue(payload: string, names: readonly string[]): bigint | null {
  const accepted = new Set(names)
  for (const line of payload.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const match = /^(\w+)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(line.trim())
    if (!match || !accepted.has(match[1]!)) continue
    return prometheusInteger(match[2]!)
  }
  return null
}

export function createMinioStorageProbe(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): HostStorageProbe {
  let metricsUrl: URL | null = null
  try {
    const baseUrl = new URL(endpoint)
    if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('unsupported protocol')
    metricsUrl = new URL(CAPACITY_METRICS_PATH, baseUrl)
  }
  catch {}

  const path = metricsUrl?.origin ?? ''
  return async () => {
    if (!metricsUrl) return unavailable(path)
    try {
      const response = await fetchImpl(metricsUrl, {
        headers: { accept: 'text/plain' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return unavailable(path)

      const payload = await response.text()
      const totalBytes = metricValue(payload, TOTAL_METRIC_NAMES)
      const freeBytes = metricValue(payload, FREE_METRIC_NAMES)
      if (totalBytes === null || freeBytes === null || totalBytes < freeBytes) {
        return unavailable(path)
      }

      return {
        available: true,
        freeBytes: freeBytes.toString(),
        managedBytes: '0',
        path,
        totalBytes: totalBytes.toString(),
        usedBytes: (totalBytes - freeBytes).toString(),
      }
    }
    catch {
      return unavailable(path)
    }
  }
}
