import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { JobWithMetadata } from 'pg-boss'
import { afterEach, describe, expect, it } from 'vitest'
import { mediaIndexerConfig } from '../src/media/runtime-config.js'
import {
  MEDIA_INDEXER_HOOK_PATH,
  MediaIndexerRuntime,
  PermanentMediaIngestError,
  canonicalCandidate,
  constantTimeToken,
  createEnvelope,
  epochCandidateId,
  mediaIngestQueueOptions,
  processMediaIngestJobs,
  scanSpool,
  sourceOrderFromCandidate,
} from '../src/roles/media-indexer.js'

const session = '00000000-0000-4000-8000-000000000001'
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })))
})

function envelope(candidate = 'court-a/2026-08-07_06-30-01-123456.mp4') {
  return createEnvelope({
    schemaVersion: '1.0.0',
    jobType: 'media.ingest.finalized.v1',
    captureSessionId: session,
    candidate,
    sourceOrder: sourceOrderFromCandidate(candidate),
    sourceRestart: false,
    timestampDiscontinuity: false,
    explicitGapBeforeUs: null,
  })
}

function job(
  value = envelope(),
  singletonKey: string | null = session,
): JobWithMetadata<typeof value> {
  return {
    id: 'job-id',
    data: value,
    singletonKey,
    signal: new AbortController().signal,
  } as unknown as JobWithMetadata<typeof value>
}

describe('media indexer runtime kernel', () => {
  it('rejects unsafe candidates and derives deterministic epoch identities', () => {
    expect(() => canonicalCandidate('../a.m4s')).toThrow()
    expect(() => canonicalCandidate('a\\b.m4s')).toThrow()
    expect(() => canonicalCandidate('/absolute.m4s')).toThrow()
    expect(epochCandidateId(session, envelope().candidate)).toBe(
      epochCandidateId(session, envelope().candidate),
    )
    expect(() => createEnvelope({
      ...envelope(),
      candidate: envelope().candidate,
      sourceOrder: '000',
    })).toThrow()
  })

  it('parses only real MediaMTX timestamps into chronological source order', () => {
    const first = sourceOrderFromCandidate(
      'court-a/2026-08-07_06-30-01-123456.mp4',
    )
    const second = sourceOrderFromCandidate(
      'court-a/2026-08-07_06-30-02-000001.mp4',
    )
    expect(BigInt(first)).toBeLessThan(BigInt(second))
    expect(() => sourceOrderFromCandidate('court-a/segment-1.mp4')).toThrow()
    expect(() => sourceOrderFromCandidate(
      'court-a/2026-02-31_06-30-01-123456.mp4',
    )).toThrow()
  })

  it('rescans canonical files, resolves their ingest directory and sorts them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volleyball-indexer-'))
    temporaryPaths.push(root)
    await mkdir(join(root, 'court-a'))
    await writeFile(
      join(root, 'court-a', '2026-08-07_06-30-02-000001.mp4'),
      Buffer.from('later'),
    )
    await writeFile(
      join(root, 'court-a', '2026-08-07_06-30-01-123456.mp4'),
      Buffer.from('earlier'),
    )
    await writeFile(join(root, 'court-a', 'ignored.mp4'), Buffer.from('ignored'))
    const resolved: string[] = []

    const scanned = await scanSpool(root, async (ingestPath) => {
      resolved.push(ingestPath)
      return ingestPath === 'court-a' ? session : null
    })

    expect(resolved).toEqual(['court-a', 'court-a'])
    expect(scanned.map((item) => item.candidate)).toEqual([
      'court-a/2026-08-07_06-30-01-123456.mp4',
      'court-a/2026-08-07_06-30-02-000001.mp4',
    ])
    expect(BigInt(scanned[0]!.sourceOrder)).toBeLessThan(
      BigInt(scanned[1]!.sourceOrder),
    )
  })

  it('uses a constant-size token comparison and strict runtime environment', () => {
    expect(constantTimeToken('secret', 'secret')).toBe(true)
    expect(constantTimeToken('secret', 'other')).toBe(false)
    expect(constantTimeToken('short', 'a-much-longer-secret')).toBe(false)
    expect(mediaIndexerConfig({
      DATABASE_URL: 'postgresql://postgres:postgres@postgres:5432/volleyball',
      MEDIA_SPOOL_DIR: '/var/lib/volleyball/media-spool',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'volleyball',
      MINIO_SECRET_KEY: 'volleyball-dev-secret',
      MINIO_DVR_BUCKET: 'dvr-media',
      MEDIA_INDEXER_HOOK_TOKEN: '0123456789abcdef',
    })).toMatchObject({
      MEDIA_INDEXER_HOOK_BIND: '0.0.0.0',
      MEDIA_INDEXER_HOOK_PORT: 4_100,
      MEDIA_INDEXER_SCAN_INTERVAL_MS: 10_000,
    })
    expect(() => mediaIndexerConfig({
      DATABASE_URL: 'not-a-url',
      MEDIA_SPOOL_DIR: '/tmp',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'x',
      MINIO_SECRET_KEY: 'x',
      MINIO_DVR_BUCKET: 'dvr-media',
      MEDIA_INDEXER_HOOK_TOKEN: '0123456789abcdef',
    })).toThrow()
  })

  it('settles permanent jobs safely and throws transient failures for retry', async () => {
    const success = await processMediaIngestJobs([job()], async () => undefined)
    expect(success).toEqual([{ id: 'job-id', status: 'completed' }])

    const mismatch = await processMediaIngestJobs(
      [job(envelope(), '00000000-0000-4000-8000-000000000002')],
      async () => { throw new Error('must not run') },
    )
    expect(mismatch).toEqual([{
      id: 'job-id',
      status: 'deadletter',
      output: { code: 'INVALID_JOB' },
    }])

    const permanent = await processMediaIngestJobs([job()], async () => {
      throw new PermanentMediaIngestError('PERMANENT_FAILURE')
    })
    expect(permanent[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE' },
    })
    const deterministicConflict = await processMediaIngestJobs([job()], async () => {
      const error = Object.assign(new Error('do not expose this detail'), {
        code: 'TIMELINE_CONFLICT',
      })
      error.name = 'PrismaIngestRepositoryError'
      throw error
    })
    expect(deterministicConflict[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE' },
    })
    await expect(processMediaIngestJobs([job()], async () => {
      const error = Object.assign(new Error('earlier reservation is pending'), {
        code: 'FIFO_BLOCKED',
      })
      error.name = 'PrismaIngestRepositoryError'
      throw error
    })).rejects.toThrow('earlier reservation is pending')
    await expect(processMediaIngestJobs([job()], async () => {
      throw new Error('database unavailable')
    })).rejects.toThrow('database unavailable')
    expect(mediaIngestQueueOptions).toMatchObject({
      policy: 'key_strict_fifo',
      partition: true,
      retryLimit: 5,
      heartbeatSeconds: 60,
      notify: true,
    })
  })

  it('enforces hook path, method, type, auth and chunked size bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volleyball-hook-'))
    temporaryPaths.push(root)
    const runtime = new MediaIndexerRuntime({
      spoolRoot: root,
      queue: { send: async () => 'job-id' },
      resolveCapture: async () => null,
      hookToken: '0123456789abcdef',
    })

    async function request(input: {
      method?: string
      path?: string
      contentType?: string
      authorization?: string
      body?: Uint8Array
      contentLength?: string
    }) {
      const stream = new PassThrough()
      const incoming = Object.assign(stream, {
        method: input.method ?? 'POST',
        url: input.path ?? MEDIA_INDEXER_HOOK_PATH,
        headers: {
          authorization: input.authorization ?? 'Bearer 0123456789abcdef',
          'content-type': input.contentType ?? 'application/json',
          ...(input.contentLength === undefined
            ? {}
            : { 'content-length': input.contentLength }),
        },
      }) as unknown as IncomingMessage
      const response = {
        statusCode: 0,
        body: '',
        end(body = '') { this.body = body },
      }
      const handled = runtime.handleHook(incoming, response)
      stream.end(input.body ?? Buffer.from('{}'))
      await handled
      return response
    }

    await expect(request({ path: '/wrong' })).resolves.toMatchObject({ statusCode: 404 })
    await expect(request({ method: 'GET' })).resolves.toMatchObject({ statusCode: 405 })
    await expect(request({ contentType: 'text/plain' })).resolves.toMatchObject({ statusCode: 415 })
    await expect(request({ authorization: 'Bearer wrong' })).resolves.toMatchObject({ statusCode: 401 })
    await expect(request({ contentLength: '20000' })).resolves.toMatchObject({ statusCode: 413 })
    await expect(request({ body: Buffer.alloc(16_385) })).resolves.toMatchObject({ statusCode: 413 })
    await expect(request({})).resolves.toMatchObject({ statusCode: 202 })
  })
})
