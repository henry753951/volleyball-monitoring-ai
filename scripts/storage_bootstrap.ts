import { Client } from 'minio'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type StorageBootstrapMode = 'ensure' | 'validate'

export interface StorageAdminClient {
  bucketExists: (bucket: string) => Promise<boolean>
  makeBucket: (bucket: string) => Promise<void>
}

export interface StorageBootstrapConfig {
  buckets: string[]
  mode: StorageBootstrapMode
  timeoutMs: number
}

const BUCKET_ENV_KEYS = [
  'MINIO_RAW_BUCKET',
  'MINIO_DVR_BUCKET',
  'MINIO_RALLY_BUCKET',
  'MINIO_ANALYSIS_BUCKET',
] as const

const BUCKET_NAME = /^(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function parseBootstrapMode(
  value: string | undefined,
  nodeEnv = 'development',
): StorageBootstrapMode {
  const normalized =
    value?.trim().toLowerCase() || (nodeEnv === 'production' ? 'validate' : 'ensure')
  if (normalized !== 'ensure' && normalized !== 'validate') {
    throw new Error('OBJECT_STORAGE_BOOTSTRAP_MODE must be ensure or validate')
  }
  return normalized
}

export function resolveHostMinioEndpoint(env: NodeJS.ProcessEnv): URL {
  const explicit = env.MINIO_BOOTSTRAP_ENDPOINT?.trim()
  const endpoint = new URL(
    explicit || env.MINIO_ENDPOINT?.trim() || `http://127.0.0.1:${env.MINIO_HOST_PORT || '9000'}`,
  )
  if (!explicit && endpoint.hostname === 'minio') {
    endpoint.hostname = '127.0.0.1'
    endpoint.port = env.MINIO_HOST_PORT?.trim() || endpoint.port || '9000'
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('MINIO_BOOTSTRAP_ENDPOINT must use http or https')
  }
  return endpoint
}

export function storageBootstrapConfig(env: NodeJS.ProcessEnv): StorageBootstrapConfig {
  const buckets = [
    ...new Set(
      BUCKET_ENV_KEYS.map(key => env[key]?.trim()).filter((value): value is string =>
        Boolean(value),
      ),
    ),
  ]
  if (buckets.length !== BUCKET_ENV_KEYS.length) {
    throw new Error(`all object storage buckets are required: ${BUCKET_ENV_KEYS.join(', ')}`)
  }
  for (const bucket of buckets) {
    if (!BUCKET_NAME.test(bucket)) throw new Error(`invalid S3 bucket name: ${bucket}`)
  }
  return {
    buckets,
    mode: parseBootstrapMode(env.OBJECT_STORAGE_BOOTSTRAP_MODE, env.NODE_ENV),
    timeoutMs: positiveInteger(
      env.OBJECT_STORAGE_BOOTSTRAP_TIMEOUT_MS,
      180_000,
      'OBJECT_STORAGE_BOOTSTRAP_TIMEOUT_MS',
    ),
  }
}

function isAlreadyCreated(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String(error.code) : ''
  return code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists'
}

async function waitUntilReachable(
  client: StorageAdminClient,
  probeBucket: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  do {
    try {
      await client.bucketExists(probeBucket)
      return
    } catch (error) {
      lastError = error
      await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
    }
  } while (Date.now() < deadline)
  throw new Error(`object storage was not reachable within ${timeoutMs} ms`, { cause: lastError })
}

export async function bootstrapStorage(
  client: StorageAdminClient,
  config: StorageBootstrapConfig,
): Promise<string[]> {
  await waitUntilReachable(client, config.buckets[0]!, config.timeoutMs)
  const missing: string[] = []
  for (const bucket of config.buckets) {
    if (await client.bucketExists(bucket)) continue
    if (config.mode === 'validate') {
      missing.push(bucket)
      continue
    }
    try {
      await client.makeBucket(bucket)
    } catch (error) {
      if (!isAlreadyCreated(error) && !(await client.bucketExists(bucket))) throw error
    }
  }
  if (missing.length > 0)
    throw new Error(`missing required object storage buckets: ${missing.join(', ')}`)
  return config.buckets
}

export function createStorageAdminClient(env: NodeJS.ProcessEnv): StorageAdminClient {
  const endpoint = resolveHostMinioEndpoint(env)
  const accessKey = env.MINIO_ACCESS_KEY?.trim()
  const secretKey = env.MINIO_SECRET_KEY?.trim()
  if (!accessKey || !secretKey)
    throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required')
  return new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey,
    secretKey,
    pathStyle: true,
  })
}

async function main(): Promise<void> {
  const config = storageBootstrapConfig(process.env)
  const endpoint = resolveHostMinioEndpoint(process.env)
  const buckets = await bootstrapStorage(createStorageAdminClient(process.env), config)
  console.info(
    `object storage ${config.mode} complete at ${endpoint.origin}: ${buckets.join(', ')}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
