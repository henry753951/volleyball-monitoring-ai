import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ClientOptions } from 'minio'
import { describe, expect, it, vi } from 'vitest'
import {
  MinioObjectReaderError,
  createMinioObjectReader,
  createMinioObjectReaderFromEnv,
  type MinioObjectClient,
} from '../src/media/minio-object-reader.js'
import type { MediaObjectReadRequest } from '../src/media/playback-domain.js'

const accessKey = 'test-access-key'
const secretKey = 'test-secret-key'
const bucket = 'dvr-media'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function requestFor(
  bytes: Uint8Array,
  overrides: Partial<MediaObjectReadRequest> = {},
): MediaObjectReadRequest {
  return {
    bucket,
    expectedByteLength: BigInt(bytes.byteLength),
    expectedContentType: 'video/mp4',
    expectedInternalSchemaVersion: '1.0.0',
    expectedKind: 'DVR_SEGMENT',
    expectedSha256: sha256(bytes),
    key: 'sessions/segment-1.m4s',
    ...overrides,
  }
}

function createReader(
  client: MinioObjectClient,
  overrides: Partial<Parameters<typeof createMinioObjectReader>[0]> = {},
) {
  let options: ClientOptions | undefined
  const reader = createMinioObjectReader({
    accessKey,
    bucket,
    endpoint: 'http://127.0.0.1:9000',
    maxObjectBytes: 1024,
    operationTimeoutMs: 1000,
    secretKey,
    ...overrides,
  }, (value) => {
    options = value
    return client
  })
  return { options, reader }
}

function rejectingClient(error: unknown): MinioObjectClient {
  return {
    getObject: () => Promise.reject(error),
  }
}

describe('MinIO object reader configuration', () => {
  it('builds the official client options from a strict endpoint', () => {
    const { options } = createReader({
      getObject: async () => Readable.from([]),
    }, { endpoint: 'https://minio.internal:9443' })
    expect(options).toEqual({
      accessKey,
      endPoint: 'minio.internal',
      pathStyle: true,
      port: 9443,
      secretKey,
      useSSL: true,
    })
  })

  it.each([
    'ftp://minio.internal',
    'http://user:password@minio.internal',
    'http://minio.internal/storage',
    'http://minio.internal?region=local',
    'http://minio.internal#fragment',
    'not a URL',
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => createReader({
      getObject: async () => Readable.from([]),
    }, { endpoint })).toThrowError(expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: 'MinIO endpoint is invalid',
    }))
  })

  it('requires complete valid credentials, bucket and bounds', () => {
    const client = { getObject: async () => Readable.from([]) }
    for (const overrides of [
      { accessKey: '' },
      { secretKey: '' },
      { bucket: 'UPPERCASE' },
      { bucket: 'ab' },
      { maxObjectBytes: 0 },
      { operationTimeoutMs: 0 },
    ]) {
      expect(() => createReader(client, overrides)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      )
    }
    expect(createMinioObjectReaderFromEnv({})).toBeUndefined()
    expect(() => createMinioObjectReaderFromEnv({
      MINIO_ENDPOINT: 'http://127.0.0.1:9000',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: 'MinIO reader configuration is incomplete',
    }))
  })
})

describe('MinIO verified object reads', () => {
  it('returns exact bytes only after length and checksum verification', async () => {
    const expected = Buffer.from('verified media bytes')
    const getObject = vi.fn(async () => Readable.from([
      expected.subarray(0, 5),
      expected.subarray(5),
    ]))
    const { reader } = createReader({ getObject })

    await expect(reader(requestFor(expected))).resolves.toEqual(expected)
    expect(getObject).toHaveBeenCalledOnce()
    expect(getObject).toHaveBeenCalledWith(bucket, 'sessions/segment-1.m4s')
  })

  it.each([
    { bucket: 'other-bucket' },
    { key: '/absolute.m4s' },
    { key: '../escape.m4s' },
    { key: 'folder//empty.m4s' },
    { key: 'folder\\windows.m4s' },
    { key: 'folder/./relative.m4s' },
  ])('rejects an unauthorized bucket or unsafe key', async (overrides) => {
    const bytes = Buffer.from('bytes')
    const getObject = vi.fn(async () => Readable.from([bytes]))
    const { reader } = createReader({ getObject })
    await expect(reader(requestFor(bytes, overrides))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Media object request is invalid',
    })
    expect(getObject).not.toHaveBeenCalled()
  })

  it('maps missing and network failures to typed sanitized errors', async () => {
    const bytes = Buffer.from('bytes')
    const missing = createReader(rejectingClient({
      code: 'NoSuchKey',
      message: 'secret endpoint and object details',
    })).reader
    const network = createReader(rejectingClient(new Error(
      'connect ECONNREFUSED http://secret-endpoint/private-key',
    ))).reader

    await expect(missing(requestFor(bytes))).rejects.toMatchObject({
      code: 'OBJECT_MISSING',
      message: 'Media object is unavailable',
    })
    await expect(network(requestFor(bytes))).rejects.toMatchObject({
      code: 'READ_FAILED',
      message: 'Media object read failed',
    })
    const synchronous = createReader({
      getObject() {
        throw new Error('synchronous secret endpoint failure')
      },
    }).reader
    await expect(synchronous(requestFor(bytes))).rejects.toMatchObject({
      code: 'READ_FAILED',
      message: 'Media object read failed',
    })
  })

  it('maps a stream failure without exposing its cause', async () => {
    const bytes = Buffer.from('bytes')
    const stream = new Readable({
      read() {
        this.destroy(new Error('secret stream endpoint and object key'))
      },
    })
    const { reader } = createReader({ getObject: async () => stream })
    await expect(reader(requestFor(bytes))).rejects.toMatchObject({
      code: 'STREAM_FAILED',
      message: 'Media object stream failed',
    })
  })

  it('rejects short, overflowing and checksum-mismatched objects', async () => {
    const expected = Buffer.from('expected')
    const short = createReader({
      getObject: async () => Readable.from([expected.subarray(0, 3)]),
    }).reader
    const overflowingStream = Readable.from([Buffer.from('too-long')])
    const destroy = vi.spyOn(overflowingStream, 'destroy')
    const overflowing = createReader({
      getObject: async () => overflowingStream,
    }).reader
    const checksum = createReader({
      getObject: async () => Readable.from([Buffer.from('mismatch')]),
    }).reader

    await expect(short(requestFor(expected))).rejects.toMatchObject({
      code: 'LENGTH_MISMATCH',
    })
    await expect(overflowing(requestFor(Buffer.from('tiny')))).rejects.toMatchObject({
      code: 'OBJECT_TOO_LARGE',
    })
    expect(destroy).toHaveBeenCalled()
    await expect(checksum(requestFor(Buffer.from('mismatch'), {
      expectedSha256: sha256(expected),
    }))).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })
  })

  it('enforces the configured object bound before contacting MinIO', async () => {
    const bytes = Buffer.alloc(17)
    const getObject = vi.fn(async () => Readable.from([bytes]))
    const { reader } = createReader({ getObject }, { maxObjectBytes: 16 })
    await expect(reader(requestFor(bytes))).rejects.toMatchObject({
      code: 'OBJECT_TOO_LARGE',
      message: 'Media object exceeds the configured size limit',
    })
    expect(getObject).not.toHaveBeenCalled()
  })

  it('destroys a stalled stream on timeout', async () => {
    const bytes = Buffer.from('bytes')
    const stream = new Readable({ read() {} })
    const destroy = vi.spyOn(stream, 'destroy')
    const { reader } = createReader(
      { getObject: async () => stream },
      { operationTimeoutMs: 20 },
    )
    await expect(reader(requestFor(bytes))).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Media object read timed out',
    })
    expect(destroy).toHaveBeenCalled()
  })

  it('destroys a stream that arrives after the getObject timeout', async () => {
    const bytes = Buffer.from('bytes')
    let resolveStream: ((stream: Readable) => void) | undefined
    const getObject = new Promise<Readable>((resolve) => {
      resolveStream = resolve
    })
    const { reader } = createReader(
      { getObject: () => getObject },
      { operationTimeoutMs: 20 },
    )
    await expect(reader(requestFor(bytes))).rejects.toMatchObject({
      code: 'TIMEOUT',
    })

    const stream = new Readable({ read() {} })
    const destroy = vi.spyOn(stream, 'destroy')
    resolveStream?.(stream)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(destroy).toHaveBeenCalled()
  })

  it('keeps all errors free of credentials, endpoint and object identity', async () => {
    const sensitive = [
      accessKey,
      secretKey,
      'secret-endpoint.internal',
      'private/object.m4s',
    ]
    const errors: MinioObjectReaderError[] = []
    try {
      createMinioObjectReader({
        accessKey,
        bucket,
        endpoint: `http://${accessKey}:${secretKey}@secret-endpoint.internal`,
        secretKey,
      })
    } catch (error) {
      if (error instanceof MinioObjectReaderError) errors.push(error)
    }
    const reader = createReader(rejectingClient(new Error(
      'secret-endpoint.internal/private/object.m4s',
    ))).reader
    try {
      await reader(requestFor(Buffer.from('bytes'), { key: 'private/object.m4s' }))
    } catch (error) {
      if (error instanceof MinioObjectReaderError) errors.push(error)
    }
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      for (const value of sensitive) expect(error.message).not.toContain(value)
    }
  })
})
