import type { ClientOptions } from 'minio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256, type MediaArtifact } from '../src/media/artifacts'
import {
  createMinioMediaObjectStore,
  MinioObjectStoreError,
  type MinioClientLike,
  type MinioObjectStat,
  type MinioObjectStoreConfig,
} from '../src/media/minio-object-store'

const bytes = Buffer.from('immutable-media-artifact')
const artifact: MediaArtifact = {
  kind: 'init',
  location: {
    bucket: 'volleyball-dvr',
    key: 'dvr/capture-01/hash/init.mp4',
  },
  bytes,
  sha256: sha256(bytes),
  byteLength: BigInt(bytes.byteLength),
  contentType: 'video/mp4',
  internalSchemaVersion: '1.0.0',
}

const config: MinioObjectStoreConfig = {
  endpointUrl: 'http://127.0.0.1:9100',
  useTls: false,
  accessKey: 'unit-access-key',
  secretKey: 'unit-secret-key',
  bucket: 'volleyball-dvr',
  operationTimeoutMs: 1_000,
}

type PutCall = {
  bucket: string
  key: string
  bytes: Buffer
  size: number
  metadata: Readonly<Record<string, string>>
}

function missingError(): Error {
  const error = new Error('missing')
  Reflect.set(error, 'code', 'NoSuchKey')
  return error
}

class FakeMinioClient implements MinioClientLike {
  readonly statCalls: Array<{ bucket: string; key: string }> = []
  readonly putCalls: PutCall[] = []
  readonly objects = new Map<string, MinioObjectStat>()
  statError?: Error
  putError?: Error
  onPut?: () => void
  pendingStat = false

  private identity(bucket: string, key: string): string {
    return `${bucket}\0${key}`
  }

  async statObject(bucket: string, key: string): Promise<MinioObjectStat> {
    this.statCalls.push({ bucket, key })
    if (this.pendingStat) return new Promise<MinioObjectStat>(() => undefined)
    if (this.statError) throw this.statError
    const value = this.objects.get(this.identity(bucket, key))
    if (!value) throw missingError()
    return value
  }

  async putObject(
    bucket: string,
    key: string,
    objectBytes: Buffer,
    size: number,
    metadata: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.putCalls.push({
      bucket,
      key,
      bytes: Buffer.from(objectBytes),
      size,
      metadata: { ...metadata },
    })
    this.onPut?.()
    if (this.putError) throw this.putError
    this.objects.set(this.identity(bucket, key), {
      size,
      metadata: { ...metadata },
    })
  }

  seed(value: MinioObjectStat, target = artifact): void {
    this.objects.set(this.identity(target.location.bucket, target.location.key), value)
  }
}

function expectedStat(): MinioObjectStat {
  return {
    size: bytes.byteLength,
    metadata: {
      'Content-Type': 'video/mp4',
      'x-amz-meta-sha256': artifact.sha256,
      'x-amz-meta-byte-length': artifact.byteLength.toString(),
      'x-amz-meta-internal-schema-version': '1.0.0',
      'x-amz-meta-artifact-kind': 'init',
    },
  }
}

function createHarness(overrides: Partial<MinioObjectStoreConfig> = {}) {
  const client = new FakeMinioClient()
  let clientOptions: ClientOptions | undefined
  const store = createMinioMediaObjectStore({ ...config, ...overrides }, options => {
    clientOptions = options
    return client
  })
  return {
    client,
    store,
    get clientOptions() {
      return clientOptions
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MinioMediaObjectStore', () => {
  it('puts and stats exact immutable bytes and metadata with separate bucket/key', async () => {
    const harness = createHarness()

    await harness.store.upload(artifact)
    await harness.store.verify(artifact)

    expect(harness.client.statCalls).toEqual([
      { bucket: 'volleyball-dvr', key: 'dvr/capture-01/hash/init.mp4' },
      { bucket: 'volleyball-dvr', key: 'dvr/capture-01/hash/init.mp4' },
    ])
    expect(harness.client.putCalls).toEqual([
      {
        bucket: 'volleyball-dvr',
        key: 'dvr/capture-01/hash/init.mp4',
        bytes,
        size: bytes.byteLength,
        metadata: {
          'If-None-Match': '*',
          ...expectedStat().metadata,
        },
      },
    ])
    expect(harness.clientOptions).toMatchObject({
      endPoint: '127.0.0.1',
      port: 9100,
      useSSL: false,
      pathStyle: true,
    })
  })

  it('treats an existing exactly verified object as an idempotent upload', async () => {
    const harness = createHarness()
    harness.client.seed(expectedStat())

    await harness.store.upload(artifact)
    await harness.store.upload(artifact)

    expect(harness.client.putCalls).toHaveLength(0)
    expect(harness.client.statCalls).toHaveLength(2)
  })

  it('re-stats a concurrent conditional-put winner and succeeds only when it matches', async () => {
    const harness = createHarness()
    const precondition = new Error('conditional write lost')
    Reflect.set(precondition, 'statusCode', 412)
    harness.client.putError = precondition
    harness.client.onPut = () => harness.client.seed(expectedStat())

    await harness.store.upload(artifact)

    expect(harness.client.putCalls).toHaveLength(1)
    expect(harness.client.statCalls).toHaveLength(2)
  })

  it.each([
    ['length', (value: MinioObjectStat) => ({ ...value, size: value.size + 1 })],
    [
      'checksum',
      (value: MinioObjectStat) => ({
        ...value,
        metadata: { ...value.metadata, 'x-amz-meta-sha256': '0'.repeat(64) },
      }),
    ],
    [
      'content type',
      (value: MinioObjectStat) => ({
        ...value,
        metadata: { ...value.metadata, 'Content-Type': 'application/json' },
      }),
    ],
    [
      'schema',
      (value: MinioObjectStat) => ({
        ...value,
        metadata: {
          ...value.metadata,
          'x-amz-meta-internal-schema-version': '0.0.0',
        },
      }),
    ],
  ])('fails closed rather than overwriting an existing %s mismatch', async (_label, mutate) => {
    const harness = createHarness()
    harness.client.seed(mutate(expectedStat()))

    await expect(harness.store.upload(artifact)).rejects.toMatchObject({
      code: 'OBJECT_CONFLICT',
    })
    expect(harness.client.putCalls).toHaveLength(0)
  })

  it.each([
    ['length', (value: MinioObjectStat) => ({ ...value, size: value.size + 1 })],
    [
      'checksum',
      (value: MinioObjectStat) => ({
        ...value,
        metadata: { ...value.metadata, 'x-amz-meta-sha256': 'f'.repeat(64) },
      }),
    ],
    [
      'content type',
      (value: MinioObjectStat) => ({
        ...value,
        metadata: { ...value.metadata, 'Content-Type': 'text/plain' },
      }),
    ],
    [
      'schema',
      (value: MinioObjectStat) => ({
        ...value,
        metadata: {
          ...value.metadata,
          'x-amz-meta-internal-schema-version': '2.0.0',
        },
      }),
    ],
  ])('rejects stored %s mismatch during verify', async (_label, mutate) => {
    const harness = createHarness()
    harness.client.seed(mutate(expectedStat()))

    await expect(harness.store.verify(artifact)).rejects.toMatchObject({
      code: 'METADATA_MISMATCH',
    })
  })

  it('reports a missing object during verify without creating it', async () => {
    const harness = createHarness()

    await expect(harness.store.verify(artifact)).rejects.toMatchObject({
      code: 'OBJECT_MISSING',
    })
    expect(harness.client.putCalls).toHaveLength(0)
  })

  it('keeps stat and upload network failures retryable with sanitized errors', async () => {
    const secret = config.secretKey
    const statHarness = createHarness()
    statHarness.client.statError = new Error(`network failed with ${secret}`)

    try {
      await statHarness.store.upload(artifact)
      throw new Error('expected stat failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'STAT_FAILED' })
      expect(String(error)).not.toContain(secret)
    }

    const uploadHarness = createHarness()
    uploadHarness.client.putError = new Error(`upload failed with ${secret}`)
    await expect(uploadHarness.store.upload(artifact)).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    })
    uploadHarness.client.putError = undefined
    await expect(uploadHarness.store.upload(artifact)).resolves.toBeUndefined()
    expect(uploadHarness.client.putCalls).toHaveLength(2)
  })

  it('rejects local checksum, byte length, key, and bucket mismatches before put', async () => {
    const harness = createHarness()

    await expect(
      harness.store.upload({ ...artifact, sha256: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    await expect(
      harness.store.upload({ ...artifact, byteLength: artifact.byteLength + 1n }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    await expect(
      harness.store.upload({
        ...artifact,
        location: { ...artifact.location, key: '../escape' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    await expect(
      harness.store.upload({
        ...artifact,
        location: { ...artifact.location, bucket: 'other-bucket' },
      }),
    ).rejects.toMatchObject({ code: 'LOCATION_MISMATCH' })
    await expect(
      harness.store.upload({
        ...artifact,
        contentType: 'application/json',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    expect(harness.client.putCalls).toHaveLength(0)
  })

  it('sanitizes client-construction failures', () => {
    expect(() =>
      createMinioMediaObjectStore(config, () => {
        throw new Error(`failed with ${config.secretKey}`)
      }),
    ).toThrow('MinIO client initialization failed')
    try {
      createMinioMediaObjectStore(config, () => {
        throw new Error(`failed with ${config.secretKey}`)
      })
    } catch (error) {
      expect(String(error)).not.toContain(config.secretKey)
    }
  })

  it.each([
    { endpointUrl: 'ftp://127.0.0.1:9100' },
    { endpointUrl: 'http://user:password@127.0.0.1:9100' },
    { endpointUrl: 'http://127.0.0.1:9100/path' },
    { endpointUrl: 'http://127.0.0.1:9100', useTls: true },
    { accessKey: '' },
    { secretKey: '' },
    { bucket: '../bucket' },
    { operationTimeoutMs: 0 },
  ])('rejects invalid sanitized configuration %#', override => {
    const serialized = JSON.stringify(override)
    expect(() => createHarness(override)).toThrow(MinioObjectStoreError)
    try {
      createHarness(override)
    } catch (error) {
      expect(String(error)).not.toContain(config.secretKey)
      expect(String(error)).not.toContain(serialized)
    }
  })

  it('times out bounded operations and keeps credentials private on the store', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ operationTimeoutMs: 25 })
    harness.client.pendingStat = true
    const rejection = expect(harness.store.verify(artifact)).rejects.toMatchObject({
      code: 'TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
    expect(Object.keys(harness.store)).toEqual([])
    expect(JSON.stringify(harness.store)).not.toContain(config.secretKey)
  })
})
