import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobWithMetadata } from 'pg-boss'
import { afterEach, describe, expect, it } from 'vitest'
import { mediaIndexerConfig } from '../src/media/runtime-config.js'
import {
  MediaIndexerRuntime,
  PermanentMediaIngestError,
  canonicalCandidate,
  createEnvelope,
  epochCandidateId,
  mediaIngestQueueOptions,
  processMediaIngestJobs,
  scanSpool,
  sourceOrderFromCandidate,
  sourceOrderFromRestartMarker,
} from '../src/roles/media-indexer.js'

const session = '00000000-0000-4000-8000-000000000001'
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(path => rm(path, { force: true, recursive: true })),
  )
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
  retryCount = 0,
  retryLimit = 5,
): JobWithMetadata<typeof value> {
  return {
    id: 'job-id',
    data: value,
    singletonKey,
    retryCount,
    retryLimit,
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
    expect(() =>
      createEnvelope({
        ...envelope(),
        candidate: envelope().candidate,
        sourceOrder: '000',
      }),
    ).toThrow()
  })

  it('parses canonical recorder timestamps into chronological source order', () => {
    const first = sourceOrderFromCandidate('court-a/2026-08-07_06-30-01-123456.mp4')
    const second = sourceOrderFromCandidate('court-a/2026-08-07_06-30-02-000001.mp4')
    expect(BigInt(first)).toBeLessThan(BigInt(second))
    expect(sourceOrderFromCandidate('court-a/2026-08-07_06-30-02_12.mp4')).toBe('1786084202000012')
    expect(sourceOrderFromCandidate('court-a/20260807063002_12.mp4')).toBe('1786084202000012')
    expect(() => sourceOrderFromCandidate('court-a/segment-1.mp4')).toThrow()
    expect(() => sourceOrderFromCandidate('court-a/2026-02-31_06-30-01-123456.mp4')).toThrow()
    expect(
      sourceOrderFromRestartMarker('court-a/.source-restart-2026-08-07_06-30-01-500000.marker'),
    ).toBe('1786084201500000')
    expect(() => sourceOrderFromRestartMarker('court-a/restart.marker')).toThrow()
  })

  it('rescans canonical files, resolves their ingest directory and sorts them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volleyball-indexer-'))
    temporaryPaths.push(root)
    await mkdir(join(root, 'court-a'))
    await writeFile(join(root, 'court-a', '2026-08-07_06-30-02-000001.mp4'), Buffer.from('later'))
    await writeFile(join(root, 'court-a', '2026-08-07_06-30-01-123456.mp4'), Buffer.from('earlier'))
    await writeFile(
      join(root, 'court-a', '.source-restart-2026-08-07_06-30-01-500000.marker'),
      Buffer.from('{"event":"source_offline"}'),
    )
    await writeFile(join(root, 'court-a', 'ignored.mp4'), Buffer.from('ignored'))
    const resolved: string[] = []

    const scanned = await scanSpool(root, async ingestPath => {
      resolved.push(ingestPath)
      return ingestPath === 'court-a' ? session : null
    })

    expect(resolved).toEqual(['court-a', 'court-a'])
    expect(scanned.map(item => item.candidate)).toEqual([
      'court-a/2026-08-07_06-30-01-123456.mp4',
      'court-a/2026-08-07_06-30-02-000001.mp4',
    ])
    expect(scanned.map(item => item.sourceRestart)).toEqual([false, true])
    expect(BigInt(scanned[0]!.sourceOrder)).toBeLessThan(BigInt(scanned[1]!.sourceOrder))
  })

  it('validates the composed media worker environment', () => {
    const config = mediaIndexerConfig({
      DATABASE_URL: 'postgresql://postgres:postgres@postgres:5432/volleyball',
      MEDIA_IMPORT_ROOT: '/imports',
      MEDIA_INGEST_BASE_URL: 'rtmp://ovenmediaengine:1935/app',
      MEDIA_SPOOL_DIR: '/var/lib/volleyball/media-spool',
      MEDIA_SOURCE_WORK_ROOT: '/work',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'volleyball',
      MINIO_SECRET_KEY: 'volleyball-dev-secret',
      MINIO_DVR_BUCKET: 'dvr-media',
      OME_API_ACCESS_TOKEN: '0123456789abcdef0123456789abcdef',
      OME_API_URL: 'http://ovenmediaengine:8081',
    })
    expect(config).toMatchObject({
      MEDIA_INDEXER_SCAN_INTERVAL_MS: 1_000,
      MEDIA_SOURCE_CONCURRENCY: 2,
      MEDIA_SOURCE_POLL_INTERVAL_MS: 250,
      YOUTUBE_EXTRACTOR_ARGS: 'youtube:player_client=default',
      YOUTUBE_LIVE_MAX_CONSECUTIVE_FAILURES: 5,
      YOUTUBE_VOD_CONCURRENT_FRAGMENTS: 4,
    })
    expect(config.YOUTUBE_FORMAT).toContain('best[protocol*=m3u8][height<=1080]')
    expect(config.YOUTUBE_VOD_FORMAT).toContain('bestvideo[protocol^=http][height<=1080]')
    expect(() =>
      mediaIndexerConfig({
        DATABASE_URL: 'not-a-url',
        MEDIA_IMPORT_ROOT: '/imports',
        MEDIA_INGEST_BASE_URL: 'rtmp://ovenmediaengine:1935/app',
        MEDIA_SPOOL_DIR: '/tmp',
        MEDIA_SOURCE_WORK_ROOT: '/work',
        MINIO_ENDPOINT: 'http://minio:9000',
        MINIO_ACCESS_KEY: 'x',
        MINIO_SECRET_KEY: 'x',
        MINIO_DVR_BUCKET: 'dvr-media',
        OME_API_ACCESS_TOKEN: '0123456789abcdef0123456789abcdef',
        OME_API_URL: 'http://ovenmediaengine:8081',
      }),
    ).toThrow()
  })

  it('settles permanent jobs safely and throws transient failures for retry', async () => {
    const success = await processMediaIngestJobs([job()], async () => undefined)
    expect(success).toEqual([{ id: 'job-id', status: 'completed' }])

    const mismatch = await processMediaIngestJobs(
      [job(envelope(), '00000000-0000-4000-8000-000000000002')],
      async () => {
        throw new Error('must not run')
      },
    )
    expect(mismatch).toEqual([
      {
        id: 'job-id',
        status: 'deadletter',
        output: { code: 'INVALID_JOB' },
      },
    ])

    const permanent = await processMediaIngestJobs([job()], async () => {
      throw new PermanentMediaIngestError('PERMANENT_FAILURE')
    })
    expect(permanent[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE' },
    })
    const deterministicConflict = await processMediaIngestJobs([job()], async () => {
      const error = Object.assign(new Error('do not expose this detail'), {
        code: 'ARTIFACT_CONFLICT',
      })
      error.name = 'PrismaIngestRepositoryError'
      throw error
    })
    expect(deterministicConflict[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE' },
    })
    for (const code of ['RESERVATION_CONFLICT', 'TIMELINE_CONFLICT']) {
      await expect(
        processMediaIngestJobs([job()], async () => {
          const error = Object.assign(new Error('retry this ordered segment'), { code })
          error.name = 'PrismaIngestRepositoryError'
          throw error
        }),
      ).rejects.toMatchObject({ code })
    }
    const invalidArtifact = await processMediaIngestJobs([job()], async () => {
      const error = Object.assign(new Error('unsupported initialization box'), {
        code: 'INVALID_LAYOUT',
      })
      error.name = 'Fmp4ArtifactSourceError'
      throw error
    })
    expect(invalidArtifact[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE' },
    })
    const deterministicProbe = await processMediaIngestJobs([job()], async () => {
      throw Object.assign(new Error('no video samples'), { permanent: true })
    })
    expect(deterministicProbe[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE' },
    })
    const retryableProbe = Object.assign(new Error('file may still be finalizing'), {
      code: 'NO_VIDEO_SAMPLES',
      permanent: true,
      retryable: true,
    })
    await expect(
      processMediaIngestJobs([job()], async () => {
        throw retryableProbe
      }),
    ).rejects.toBe(retryableProbe)
    const exhaustedProbe = await processMediaIngestJobs(
      [job(envelope(), session, 5, 5)],
      async () => {
        throw retryableProbe
      },
    )
    expect(exhaustedProbe[0]).toMatchObject({
      status: 'deadletter',
      output: { code: 'PERMANENT_FAILURE', causeCode: 'NO_VIDEO_SAMPLES' },
    })
    await expect(
      processMediaIngestJobs([job()], async () => {
        const error = Object.assign(new Error('earlier reservation is pending'), {
          code: 'FIFO_BLOCKED',
        })
        error.name = 'PrismaIngestRepositoryError'
        throw error
      }),
    ).rejects.toThrow('earlier reservation is pending')
    await expect(
      processMediaIngestJobs([job()], async () => {
        throw new Error('database unavailable')
      }),
    ).rejects.toThrow('database unavailable')
    expect(mediaIngestQueueOptions).toMatchObject({
      policy: 'key_strict_fifo',
      partition: true,
      retryLimit: 5,
      heartbeatSeconds: 60,
      notify: true,
    })
  })

  it('only queues finalized files after their size and mtime are stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volleyball-stable-recording-'))
    temporaryPaths.push(root)
    await mkdir(join(root, 'court-a'))
    const path = join(root, 'court-a', '2026-08-07_06-30-01-123456.mp4')
    await writeFile(path, Buffer.from('sealed'))
    const old = new Date(Date.now() - 2_000)
    await utimes(path, old, old)
    const sent: unknown[] = []
    const runtime = new MediaIndexerRuntime({
      spoolRoot: root,
      queue: {
        send: async (_name, value) => {
          sent.push(value)
          return 'job-id'
        },
      },
      resolveCapture: async () => session,
    })
    await runtime.scan()
    expect(sent).toHaveLength(0)
    await runtime.scan()
    expect(sent).toHaveLength(0)
    await runtime.scan()
    expect(sent).toHaveLength(1)
  })
})
