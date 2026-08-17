import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { Client, type ClientOptions } from 'minio'
import type {
  MediaAssetKind,
  MediaObjectReader,
  MediaObjectReadRequest,
} from './playback-domain.js'

export type MinioObjectReaderErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST'
  | 'OBJECT_MISSING'
  | 'READ_FAILED'
  | 'STREAM_FAILED'
  | 'OBJECT_TOO_LARGE'
  | 'LENGTH_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'TIMEOUT'

export class MinioObjectReaderError extends Error {
  constructor(
    public readonly code: MinioObjectReaderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MinioObjectReaderError'
  }
}

export interface MinioObjectReaderConfig {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  operationTimeoutMs?: number
  maxObjectBytes?: number
}

export interface MinioObjectClient {
  getObject(bucket: string, key: string): Promise<Readable>
}

export type MinioObjectClientFactory = (options: ClientOptions) => MinioObjectClient

interface ValidatedConfig {
  bucket: string
  clientOptions: ClientOptions
  maxObjectBytes: number
  operationTimeoutMs: number
}

const DEFAULT_MAX_OBJECT_BYTES = 128 * 1024 * 1024
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000
const MAX_CONFIGURED_OBJECT_BYTES = 1024 * 1024 * 1024
const MAX_OPERATION_TIMEOUT_MS = 300_000
const SHA256 = /^[0-9a-f]{64}$/i
const BUCKET = /^(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/
const EXPECTED_CONTENT_TYPES: Readonly<Record<MediaAssetKind, string>> = {
  DVR_INIT: 'video/mp4',
  DVR_SEGMENT: 'video/mp4',
  SAMPLE_INDEX: 'application/json',
  TIMING_MANIFEST: 'application/json',
}
const EXPECTED_SCHEMA_VERSIONS: Readonly<Record<MediaAssetKind, readonly string[]>> = {
  DVR_INIT: ['1.0.0'],
  DVR_SEGMENT: ['1.0.0'],
  SAMPLE_INDEX: ['1.0.0'],
  TIMING_MANIFEST: ['1.1.0', '2.0.0'],
}

const defaultClientFactory: MinioObjectClientFactory = options => {
  const client = new Client(options)
  return {
    getObject(bucket, key) {
      return client.getObject(bucket, key)
    },
  }
}

function invalidConfig(message: string): never {
  throw new MinioObjectReaderError('INVALID_CONFIG', message)
}

function validCredential(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\0-\x1f\x7f]/.test(value)
  )
}

function validateBucket(bucket: string): string {
  if (
    !BUCKET.test(bucket) ||
    bucket.length < 3 ||
    bucket.length > 63 ||
    bucket.includes('..') ||
    bucket.includes('.-') ||
    bucket.includes('-.')
  ) {
    invalidConfig('MinIO DVR bucket is invalid')
  }
  return bucket
}

function validateConfig(config: MinioObjectReaderConfig): ValidatedConfig {
  if (!validCredential(config.accessKey, 128)) {
    invalidConfig('MinIO access key is invalid')
  }
  if (!validCredential(config.secretKey, 256)) {
    invalidConfig('MinIO secret key is invalid')
  }

  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch {
    invalidConfig('MinIO endpoint is invalid')
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    invalidConfig('MinIO endpoint is invalid')
  }
  const port = endpoint.port
    ? Number.parseInt(endpoint.port, 10)
    : endpoint.protocol === 'https:'
      ? 443
      : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    invalidConfig('MinIO endpoint port is invalid')
  }

  const operationTimeoutMs = config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  if (
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs <= 0 ||
    operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS
  ) {
    invalidConfig('MinIO read timeout is invalid')
  }
  const maxObjectBytes = config.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES
  if (
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes <= 0 ||
    maxObjectBytes > MAX_CONFIGURED_OBJECT_BYTES
  ) {
    invalidConfig('MinIO object size limit is invalid')
  }

  return {
    bucket: validateBucket(config.bucket),
    clientOptions: {
      accessKey: config.accessKey,
      endPoint: endpoint.hostname,
      pathStyle: true,
      port,
      secretKey: config.secretKey,
      useSSL: endpoint.protocol === 'https:',
    },
    maxObjectBytes,
    operationTimeoutMs,
  }
}

function validateObjectKey(key: string): void {
  const segments = key.split('/')
  if (
    !key ||
    Buffer.byteLength(key, 'utf8') > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    /[\0-\x1f\x7f]/.test(key) ||
    segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new MinioObjectReaderError('INVALID_REQUEST', 'Media object request is invalid')
  }
}

function validateRequest(
  request: MediaObjectReadRequest,
  configuredBucket: string,
  maxObjectBytes: number,
): number {
  if (request.bucket !== configuredBucket) {
    throw new MinioObjectReaderError('INVALID_REQUEST', 'Media object request is invalid')
  }
  validateObjectKey(request.key)
  if (
    request.expectedByteLength <= 0n ||
    request.expectedByteLength > BigInt(maxObjectBytes) ||
    request.expectedByteLength > BigInt(Number.MAX_SAFE_INTEGER) ||
    !SHA256.test(request.expectedSha256) ||
    !EXPECTED_SCHEMA_VERSIONS[request.expectedKind].includes(
      request.expectedInternalSchemaVersion,
    ) ||
    EXPECTED_CONTENT_TYPES[request.expectedKind] !== request.expectedContentType
  ) {
    throw new MinioObjectReaderError(
      request.expectedByteLength > BigInt(maxObjectBytes) ? 'OBJECT_TOO_LARGE' : 'INVALID_REQUEST',
      request.expectedByteLength > BigInt(maxObjectBytes)
        ? 'Media object exceeds the configured size limit'
        : 'Media object request is invalid',
    )
  }
  return Number(request.expectedByteLength)
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

async function getObjectStream(
  client: MinioObjectClient,
  request: MediaObjectReadRequest,
  timeoutMs: number,
): Promise<Readable> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const operation = Promise.resolve().then(() => client.getObject(request.bucket, request.key))
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      reject(new MinioObjectReaderError('TIMEOUT', 'Media object read timed out'))
    }, timeoutMs)
  })
  operation
    .then(stream => {
      if (timedOut) stream.destroy()
    })
    .catch(() => undefined)
  try {
    return await Promise.race([operation, timeoutPromise])
  } catch (error) {
    if (error instanceof MinioObjectReaderError) throw error
    if (isMissingObject(error)) {
      throw new MinioObjectReaderError('OBJECT_MISSING', 'Media object is unavailable')
    }
    throw new MinioObjectReaderError('READ_FAILED', 'Media object read failed')
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function chunkBytes(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  throw new MinioObjectReaderError('STREAM_FAILED', 'Media object stream failed')
}

async function consumeStream(
  stream: Readable,
  expectedByteLength: number,
  timeoutMs: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  const chunks: Buffer[] = []
  const hash = createHash('sha256')
  let received = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      stream.destroy()
      reject(new MinioObjectReaderError('TIMEOUT', 'Media object read timed out'))
    }, timeoutMs)
  })
  const consume = async () => {
    try {
      for await (const chunk of stream) {
        const bytes = chunkBytes(chunk)
        received += bytes.byteLength
        if (received > expectedByteLength) {
          stream.destroy()
          throw new MinioObjectReaderError(
            'OBJECT_TOO_LARGE',
            'Media object exceeded its expected size',
          )
        }
        hash.update(bytes)
        chunks.push(bytes)
      }
    } catch (error) {
      if (error instanceof MinioObjectReaderError) throw error
      throw new MinioObjectReaderError('STREAM_FAILED', 'Media object stream failed')
    }
    if (received !== expectedByteLength) {
      throw new MinioObjectReaderError(
        'LENGTH_MISMATCH',
        'Media object length did not match its expected value',
      )
    }
    return { bytes: Buffer.concat(chunks, received), sha256: hash.digest('hex') }
  }
  try {
    return await Promise.race([consume(), timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

class MinioMediaObjectReader {
  constructor(
    private readonly client: MinioObjectClient,
    private readonly bucket: string,
    private readonly maxObjectBytes: number,
    private readonly operationTimeoutMs: number,
  ) {}

  async read(request: MediaObjectReadRequest): Promise<Uint8Array> {
    const expectedByteLength = validateRequest(request, this.bucket, this.maxObjectBytes)
    const stream = await getObjectStream(this.client, request, this.operationTimeoutMs)
    const result = await consumeStream(stream, expectedByteLength, this.operationTimeoutMs)
    if (result.sha256 !== request.expectedSha256.toLowerCase()) {
      throw new MinioObjectReaderError(
        'CHECKSUM_MISMATCH',
        'Media object checksum did not match its expected value',
      )
    }
    return result.bytes
  }
}

export function createMinioObjectReader(
  config: MinioObjectReaderConfig,
  clientFactory: MinioObjectClientFactory = defaultClientFactory,
): MediaObjectReader {
  const validated = validateConfig(config)
  let client: MinioObjectClient
  try {
    client = clientFactory(validated.clientOptions)
  } catch {
    throw new MinioObjectReaderError('INVALID_CONFIG', 'MinIO client initialization failed')
  }
  const reader = new MinioMediaObjectReader(
    client,
    validated.bucket,
    validated.maxObjectBytes,
    validated.operationTimeoutMs,
  )
  return request => reader.read(request)
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) invalidConfig('MinIO reader numeric setting is invalid')
  return Number(value)
}

export function createMinioObjectReaderFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  bucketVariable: 'MINIO_DVR_BUCKET' | 'MINIO_RALLY_BUCKET' = 'MINIO_DVR_BUCKET',
): MediaObjectReader | undefined {
  const required = [
    environment.MINIO_ENDPOINT,
    environment.MINIO_ACCESS_KEY,
    environment.MINIO_SECRET_KEY,
    environment[bucketVariable],
  ]
  if (required.every(value => value === undefined)) return undefined
  if (required.some(value => value === undefined)) {
    invalidConfig('MinIO reader configuration is incomplete')
  }
  const maxObjectBytes = optionalPositiveInteger(environment.MINIO_READ_MAX_OBJECT_BYTES)
  const operationTimeoutMs = optionalPositiveInteger(environment.MINIO_READ_TIMEOUT_MS)
  return createMinioObjectReader({
    accessKey: environment.MINIO_ACCESS_KEY ?? '',
    bucket: environment[bucketVariable] ?? '',
    endpoint: environment.MINIO_ENDPOINT ?? '',
    ...(maxObjectBytes === undefined ? {} : { maxObjectBytes }),
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
    secretKey: environment.MINIO_SECRET_KEY ?? '',
  })
}

function localObjectPath(rootValue: string, bucket: string, key: string): string {
  validateObjectKey(key)
  const root = resolve(rootValue)
  const target = resolve(root, bucket, ...key.split('/'))
  const relation = relative(root, target)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new MinioObjectReaderError('INVALID_REQUEST', 'Media object request is invalid')
  }
  return target
}

/**
 * Read newly published DVR artifacts from the shared single-node hot tier and
 * fall back to the archived MinIO object after the asynchronous mirror wins.
 * The immutable database length/checksum is verified on both paths.
 */
export function createDvrObjectReaderFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): MediaObjectReader | undefined {
  const archived = createMinioObjectReaderFromEnv(environment, 'MINIO_DVR_BUCKET')
  const root = environment.MEDIA_HOT_ROOT?.trim()
  if (!root) return archived
  if (!archived) invalidConfig('MinIO reader configuration is required with the DVR hot tier')
  const bucket = validateBucket(environment.MINIO_DVR_BUCKET ?? '')
  const configuredMaximum = optionalPositiveInteger(environment.MINIO_READ_MAX_OBJECT_BYTES)
  const maximum = configuredMaximum ?? DEFAULT_MAX_OBJECT_BYTES
  return async request => {
    const expectedLength = validateRequest(request, bucket, maximum)
    const path = localObjectPath(root, request.bucket, request.key)
    try {
      const metadata = await stat(path)
      if (!metadata.isFile() || metadata.size !== expectedLength) {
        throw new MinioObjectReaderError(
          'LENGTH_MISMATCH',
          'Hot media object length did not match its expected value',
        )
      }
      const bytes = await readFile(path)
      if (
        createHash('sha256').update(bytes).digest('hex') !== request.expectedSha256.toLowerCase()
      ) {
        throw new MinioObjectReaderError(
          'CHECKSUM_MISMATCH',
          'Hot media object checksum did not match its expected value',
        )
      }
      return bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return archived(request)
      throw error
    }
  }
}
