import { Client, type ClientOptions } from 'minio'
import { sha256, validateBucketName, type ArtifactMetadata, type MediaArtifact } from './artifacts'
import type { MediaObjectStore } from './ingest'

export type MinioObjectStoreErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_ARTIFACT'
  | 'LOCATION_MISMATCH'
  | 'OBJECT_CONFLICT'
  | 'OBJECT_MISSING'
  | 'METADATA_MISMATCH'
  | 'STAT_FAILED'
  | 'UPLOAD_FAILED'
  | 'TIMEOUT'

export class MinioObjectStoreError extends Error {
  constructor(
    public readonly code: MinioObjectStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MinioObjectStoreError'
  }
}

export type MinioObjectStoreConfig = {
  endpointUrl: string
  useTls: boolean
  accessKey: string
  secretKey: string
  bucket: string
  operationTimeoutMs: number
}

export type MinioObjectStat = {
  size: number
  metadata: Readonly<Record<string, unknown>>
}

export interface MinioClientLike {
  statObject(bucket: string, key: string): Promise<MinioObjectStat>
  putObject(
    bucket: string,
    key: string,
    bytes: Buffer,
    size: number,
    metadata: Readonly<Record<string, string>>,
  ): Promise<unknown>
}

export type MinioClientFactory = (options: ClientOptions) => MinioClientLike

const SHA256_METADATA = 'x-amz-meta-sha256'
const BYTE_LENGTH_METADATA = 'x-amz-meta-byte-length'
const SCHEMA_VERSION_METADATA = 'x-amz-meta-internal-schema-version'
const ARTIFACT_KIND_METADATA = 'x-amz-meta-artifact-kind'
const CONTENT_TYPE_METADATA = 'content-type'
const MAX_TIMEOUT_MS = 300_000

const defaultClientFactory: MinioClientFactory = options => {
  const client = new Client(options)
  return {
    async statObject(bucket, key) {
      const result = await client.statObject(bucket, key)
      return { size: result.size, metadata: result.metaData }
    },
    async putObject(bucket, key, bytes, size, metadata) {
      return client.putObject(bucket, key, bytes, size, metadata)
    },
  }
}

type ValidatedMinioConfig = {
  bucket: string
  timeoutMs: number
  clientOptions: ClientOptions
}

function validateConfig(config: MinioObjectStoreConfig): ValidatedMinioConfig {
  if (typeof config.useTls !== 'boolean') {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO TLS flag must be boolean')
  }
  if (
    !config.accessKey ||
    !config.secretKey ||
    config.accessKey.length > 128 ||
    config.secretKey.length > 256
  ) {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO credentials are invalid')
  }
  if (
    !Number.isInteger(config.operationTimeoutMs) ||
    config.operationTimeoutMs <= 0 ||
    config.operationTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO operation timeout is invalid')
  }

  let endpoint: URL
  try {
    endpoint = new URL(config.endpointUrl)
  } catch {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO endpoint URL is invalid')
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '' && endpoint.pathname !== '/') ||
    (config.useTls && endpoint.protocol !== 'https:') ||
    (!config.useTls && endpoint.protocol !== 'http:')
  ) {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO endpoint URL is invalid')
  }

  let bucket: string
  try {
    bucket = validateBucketName(config.bucket)
  } catch {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO bucket is invalid')
  }
  const port = endpoint.port ? Number.parseInt(endpoint.port, 10) : config.useTls ? 443 : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO endpoint port is invalid')
  }

  return {
    bucket,
    timeoutMs: config.operationTimeoutMs,
    clientOptions: {
      endPoint: endpoint.hostname,
      port,
      useSSL: config.useTls,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      pathStyle: true,
    },
  }
}

function validateObjectKey(key: string): void {
  const segments = key.split('/')
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new MinioObjectStoreError('INVALID_ARTIFACT', 'object key is invalid')
  }
}

function expectedMetadata(artifact: ArtifactMetadata): Readonly<Record<string, string>> {
  return {
    'If-None-Match': '*',
    'Content-Type': artifact.contentType,
    [SHA256_METADATA]: artifact.sha256,
    [BYTE_LENGTH_METADATA]: artifact.byteLength.toString(),
    [SCHEMA_VERSION_METADATA]: artifact.internalSchemaVersion,
    [ARTIFACT_KIND_METADATA]: artifact.kind,
  }
}

function metadataValue(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const normalizedKey = key.toLowerCase()
  const bareKey = normalizedKey.startsWith('x-amz-meta-')
    ? normalizedKey.slice('x-amz-meta-'.length)
    : normalizedKey
  for (const [candidate, value] of Object.entries(metadata)) {
    const normalizedCandidate = candidate.toLowerCase()
    if (normalizedCandidate === normalizedKey || normalizedCandidate === bareKey) {
      return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
    }
  }
  return undefined
}

function assertStatMatches(
  stat: MinioObjectStat,
  artifact: ArtifactMetadata,
  code: 'OBJECT_CONFLICT' | 'METADATA_MISMATCH',
): void {
  const matches =
    Number.isSafeInteger(stat.size) &&
    stat.size >= 0 &&
    BigInt(stat.size) === artifact.byteLength &&
    metadataValue(stat.metadata, CONTENT_TYPE_METADATA) === artifact.contentType &&
    metadataValue(stat.metadata, SHA256_METADATA) === artifact.sha256 &&
    metadataValue(stat.metadata, BYTE_LENGTH_METADATA) === artifact.byteLength.toString() &&
    metadataValue(stat.metadata, SCHEMA_VERSION_METADATA) === artifact.internalSchemaVersion &&
    metadataValue(stat.metadata, ARTIFACT_KIND_METADATA) === artifact.kind
  if (!matches) {
    throw new MinioObjectStoreError(
      code,
      code === 'OBJECT_CONFLICT'
        ? 'existing object metadata conflicts with the artifact'
        : 'stored object metadata does not match the artifact',
    )
  }
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const value = Reflect.get(error, 'code')
  return typeof value === 'string' ? value : undefined
}

function isMissingObject(error: unknown): boolean {
  if (['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(errorCode(error) ?? '')) {
    return true
  }
  if (error === null || typeof error !== 'object') return false
  return Reflect.get(error, 'statusCode') === 404
}

function isPreconditionFailed(error: unknown): boolean {
  if (errorCode(error) === 'PreconditionFailed') return true
  if (error === null || typeof error !== 'object') return false
  return Reflect.get(error, 'statusCode') === 412
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new MinioObjectStoreError('TIMEOUT', 'MinIO operation timed out')),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([operation, timedOut])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function assertArtifact(artifact: ArtifactMetadata, configuredBucket: string): void {
  if (artifact.location.bucket !== configuredBucket) {
    throw new MinioObjectStoreError(
      'LOCATION_MISMATCH',
      'artifact bucket does not match the configured bucket',
    )
  }
  validateObjectKey(artifact.location.key)
  if (
    artifact.byteLength <= 0n ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    artifact.internalSchemaVersion !== '1.0.0' ||
    !['init', 'media', 'sample-index'].includes(artifact.kind) ||
    ((artifact.kind === 'init' || artifact.kind === 'media') &&
      artifact.contentType !== 'video/mp4') ||
    (artifact.kind === 'sample-index' && artifact.contentType !== 'application/json')
  ) {
    throw new MinioObjectStoreError('INVALID_ARTIFACT', 'artifact metadata is invalid')
  }
}

class MinioMediaObjectStore implements MediaObjectStore {
  readonly #client: MinioClientLike
  readonly #bucket: string
  readonly #timeoutMs: number

  constructor(client: MinioClientLike, bucket: string, timeoutMs: number) {
    this.#client = client
    this.#bucket = bucket
    this.#timeoutMs = timeoutMs
  }

  private async stat(artifact: ArtifactMetadata): Promise<MinioObjectStat | undefined> {
    try {
      return await withTimeout(
        this.#client.statObject(artifact.location.bucket, artifact.location.key),
        this.#timeoutMs,
      )
    } catch (error) {
      if (error instanceof MinioObjectStoreError) throw error
      if (isMissingObject(error)) return undefined
      throw new MinioObjectStoreError('STAT_FAILED', 'MinIO stat operation failed')
    }
  }

  async upload(artifact: MediaArtifact): Promise<void> {
    assertArtifact(artifact, this.#bucket)
    if (
      BigInt(artifact.bytes.byteLength) !== artifact.byteLength ||
      sha256(artifact.bytes) !== artifact.sha256
    ) {
      throw new MinioObjectStoreError('INVALID_ARTIFACT', 'artifact bytes do not match metadata')
    }

    const existing = await this.stat(artifact)
    if (existing) {
      assertStatMatches(existing, artifact, 'OBJECT_CONFLICT')
      return
    }
    try {
      await withTimeout(
        this.#client.putObject(
          artifact.location.bucket,
          artifact.location.key,
          Buffer.from(artifact.bytes),
          artifact.bytes.byteLength,
          expectedMetadata(artifact),
        ),
        this.#timeoutMs,
      )
    } catch (error) {
      if (error instanceof MinioObjectStoreError) throw error
      if (isPreconditionFailed(error)) {
        const concurrent = await this.stat(artifact)
        if (concurrent) {
          assertStatMatches(concurrent, artifact, 'OBJECT_CONFLICT')
          return
        }
      }
      throw new MinioObjectStoreError('UPLOAD_FAILED', 'MinIO upload operation failed')
    }
  }

  async verify(artifact: ArtifactMetadata): Promise<void> {
    assertArtifact(artifact, this.#bucket)
    const stat = await this.stat(artifact)
    if (!stat) {
      throw new MinioObjectStoreError('OBJECT_MISSING', 'stored object is missing')
    }
    assertStatMatches(stat, artifact, 'METADATA_MISMATCH')
  }
}

export function createMinioMediaObjectStore(
  config: MinioObjectStoreConfig,
  clientFactory: MinioClientFactory = defaultClientFactory,
): MediaObjectStore {
  const validated = validateConfig(config)
  let client: MinioClientLike
  try {
    client = clientFactory(validated.clientOptions)
  } catch {
    throw new MinioObjectStoreError('INVALID_CONFIG', 'MinIO client initialization failed')
  }
  return new MinioMediaObjectStore(client, validated.bucket, validated.timeoutMs)
}
