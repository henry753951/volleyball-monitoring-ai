import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMediaInputArgs,
  buildYoutubeProbeArgs,
  buildYoutubeVodProbeArgs,
  classifyYoutubeSource,
  createMediaSourceProcess,
  latestFfmpegProgressUs,
  nextLiveRelayFailureCount,
  preflightYoutubeInput,
  recordingExtentFilename,
  recordingExtentSeconds,
  reachedExpectedMediaEnd,
  segmentListTiming,
  type MediaSourceProcessOptions,
  vodCompletionToleranceUs,
} from '../src/media/source-process.js'

const execFileAsync = promisify(execFile)
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(path => rm(path, { force: true, recursive: true })),
  )
})

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

const hasFfmpeg = await ffmpegAvailable()

const youtubeOptions: MediaSourceProcessOptions = {
  importRoot: '/imports',
  ingestBaseUrl: 'rtmp://127.0.0.1:1935/app',
  recordingRoot: '/recordings',
  workRoot: '/work',
  youtubeCookiesFile: '/run/secrets/youtube.cookies.txt',
  youtubeExtractorArgs: 'youtube:player_client=mweb',
  youtubeFormat: 'live-format',
  youtubeVodExtractorArgs: 'youtube:player_client=mweb',
  youtubeVodFormat: 'vod-format',
  youtubeVodUseCookies: false,
}

describe('media source process', () => {
  it('waits for an external RTMP source without spawning a relay process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vollyai-rtmp-source-'))
    temporaryPaths.push(root)
    const controller = new AbortController()
    const classified: unknown[] = []
    const run = createMediaSourceProcess({
      ...youtubeOptions,
      recordingRoot: root,
      sourceOnline: async () => false,
    })
    const promise = run(
      {
        id: '92000000-0000-4000-8000-000000000010',
        captureSessionId: '92000000-0000-4000-8000-000000000011',
        sourceKind: 'rtmp',
        sourceUrl: null,
        importKey: null,
        attempts: 1,
        status: 'RUNNING',
        segmentBaseAt: new Date('2026-08-19T00:00:00.000Z'),
        resumeSegmentIndex: 0,
        resumeCaptureTimeUs: 0n,
        ingestPath: 'rtmp-test-stream',
      },
      {
        classified: async value => {
          classified.push(value)
        },
        resumed: async () => undefined,
      },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 20)
    await expect(promise).resolves.toMatchObject({
      expectedSegments: 0,
      sourceKind: 'rtmp',
      sourceDurationUs: null,
    })
    expect(classified).toEqual([])
  })

  it('routes completed live broadcasts through the VOD pipeline', () => {
    expect(classifyYoutubeSource({ is_live: false, live_status: 'was_live' })).toBe('youtube_vod')
    expect(classifyYoutubeSource({ is_live: false, live_status: 'not_live' })).toBe('youtube_vod')
    expect(classifyYoutubeSource({ is_live: true, live_status: 'is_live' })).toBe('youtube_live')
    expect(classifyYoutubeSource({ is_live: false, live_status: 'is_upcoming' })).toBe(
      'youtube_live',
    )
  })

  it('keeps shared cookies for classification but disables them for public VOD', () => {
    expect(buildYoutubeProbeArgs('https://youtu.be/example', youtubeOptions)).toEqual([
      '--dump-single-json',
      '--no-playlist',
      '--no-progress',
      '--no-warnings',
      '--cookies',
      '/run/secrets/youtube.cookies.txt',
      '--extractor-args',
      'youtube:player_client=mweb',
      '--format',
      'live-format',
      'https://youtu.be/example',
    ])
    expect(buildYoutubeVodProbeArgs('https://youtu.be/example', youtubeOptions)).toEqual([
      '--dump-single-json',
      '--no-playlist',
      '--no-progress',
      '--no-warnings',
      '--extractor-args',
      'youtube:player_client=mweb',
      '--format',
      'vod-format',
      'https://youtu.be/example',
    ])
  })

  it('allows VOD cookies only as an explicit fallback', () => {
    const options = { ...youtubeOptions, youtubeVodUseCookies: true }
    expect(buildYoutubeVodProbeArgs('https://youtu.be/example', options)).toContain('--cookies')
    expect(buildYoutubeVodProbeArgs('https://youtu.be/example', options)).toContain(
      '/run/secrets/youtube.cookies.txt',
    )
  })

  it('uses the persistent Chromium session in preference to static cookies', () => {
    const options = {
      ...youtubeOptions,
      youtubeCookiesFromBrowser: 'chromium+basictext:/var/lib/youtube-browser/.config/chromium/',
      youtubeVodUseCookies: true,
    }
    const args = buildYoutubeVodProbeArgs('https://youtu.be/example', options)
    expect(args).toContain('--cookies-from-browser')
    expect(args).toContain('chromium+basictext:/var/lib/youtube-browser/.config/chromium/')
    expect(args).not.toContain('--cookies')
    expect(args).not.toContain('/run/secrets/youtube.cookies.txt')
  })

  it('uses independent player-client policies for live and VOD resolution', () => {
    const options = {
      ...youtubeOptions,
      youtubeLiveExtractorArgs: 'youtube:player_client=mweb',
      youtubePotProviderUrl: 'http://bgutil-provider:4416',
    }
    expect(buildYoutubeProbeArgs('https://youtu.be/live', options)).toContain(
      'youtube:player_client=mweb',
    )
    expect(buildYoutubeProbeArgs('https://youtu.be/live', options)).toContain(
      'youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416',
    )
    expect(buildYoutubeVodProbeArgs('https://youtu.be/vod', options)).toContain(
      'youtube:player_client=mweb',
    )
    expect(buildYoutubeVodProbeArgs('https://youtu.be/vod', options)).toContain(
      'youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416',
    )
  })

  it('maps yt-dlp HTTP chunk metadata to bounded libavformat input options', () => {
    expect(
      buildMediaInputArgs(
        {
          httpChunkSize: 1_048_576,
          httpHeaders: { 'User-Agent': 'fixture-agent' },
          url: 'https://media.example/video',
        },
        false,
        12.5,
      ),
    ).toEqual([
      '-ss',
      '12.500000',
      '-request_size',
      '1048576',
      '-initial_request_size',
      '1048576',
      '-multiple_requests',
      '1',
      '-short_seek_size',
      '1048576',
      '-headers',
      'User-Agent: fixture-agent\r\n',
      '-i',
      'https://media.example/video',
    ])
  })

  it('preflights the first and next yt-dlp HTTP chunk without shrinking it', async () => {
    const requestedRanges: string[] = []
    const resolved = await preflightYoutubeInput(
      { httpChunkSize: 8 * 1024 * 1024, url: 'https://media.example/audio' },
      new AbortController().signal,
      async (_url, init) => {
        const range = new Headers(init?.headers).get('range') ?? ''
        requestedRanges.push(range)
        return new Response(null, { status: 206 })
      },
    )
    expect(resolved.httpChunkSize).toBe(8 * 1024 * 1024)
    expect(requestedRanges).toEqual(['bytes=0-65535', 'bytes=8388608-8454143'])
  })

  it('rejects a source URL whose next advertised chunk cannot be read', async () => {
    let requestCount = 0
    await expect(
      preflightYoutubeInput(
        { httpChunkSize: 10 * 1024 * 1024, url: 'https://media.example/video' },
        new AbortController().signal,
        async () => new Response(null, { status: ++requestCount === 1 ? 206 : 403 }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_SOURCE_URL' })
    expect(requestCount).toBe(2)
  })

  it('requires published VOD media to reach the declared duration within two segments or 5s', () => {
    expect(vodCompletionToleranceUs()).toBe(5_000_000n)
    expect(reachedExpectedMediaEnd(56_120_000n, 9_103_280_000n)).toBe(false)
    expect(reachedExpectedMediaEnd(9_099_041_000n, 9_103_280_000n)).toBe(true)
  })

  it('keeps physical recording extents coarse without widening completion tolerance', () => {
    expect(recordingExtentSeconds(youtubeOptions)).toBe(60)
    expect(recordingExtentSeconds({ ...youtubeOptions, recordingExtentSeconds: 120 })).toBe(120)
    expect(() => recordingExtentSeconds({ ...youtubeOptions, recordingExtentSeconds: 14 })).toThrow(
      'between 15 and 300 seconds',
    )
    expect(vodCompletionToleranceUs()).toBe(5_000_000n)
  })

  it('uses FFmpeg CSV timing for extent names instead of segment index guesses', () => {
    expect(
      segmentListTiming(
        '"C:\\work\\segment,000000004.mp4",5.123456,65.654321\r\n',
        'segment,000000004.mp4',
      ),
    ).toEqual({ startUs: 5_123_456n, endUs: 65_654_321n })
    expect(recordingExtentFilename(new Date('2026-08-09T06:00:00.250Z'), 5_123_456n)).toBe(
      '2026-08-09_06-00-05-373456.mp4',
    )
  })

  it('bounds consecutive live relay failures and resets the budget on durable progress', () => {
    expect(nextLiveRelayFailureCount(0, 0, 0)).toBe(1)
    expect(nextLiveRelayFailureCount(4, 0, 0)).toBe(5)
    expect(nextLiveRelayFailureCount(4, 3, 4)).toBe(0)
    expect(() => nextLiveRelayFailureCount(-1, 0, 0)).toThrow()
  })

  it('reads only advancing media timestamps from FFmpeg progress output', () => {
    expect(latestFfmpegProgressUs('frame=1\nout_time_us=500000\nprogress=continue\n')).toBe(
      500_000n,
    )
    expect(
      latestFfmpegProgressUs(
        'out_time_us=500000\nprogress=continue\nout_time_us=1500000\nprogress=continue\n',
      ),
    ).toBe(1_500_000n)
    expect(latestFfmpegProgressUs('out_time_us=N/A\nprogress=continue\n')).toBeNull()
  })

  it.skipIf(!hasFfmpeg)(
    'segments an uploaded MP4 into resumable frame-timed recordings',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'vollyai-source-process-'))
      temporaryPaths.push(root)
      const importRoot = join(root, 'imports')
      const recordingRoot = join(root, 'recordings')
      const workRoot = join(root, 'work')
      const captureId = '92000000-0000-4000-8000-000000000001'
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(importRoot, captureId), { recursive: true })
      const input = join(importRoot, captureId, 'source.mp4')
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=60',
        '-t',
        '4.1',
        '-c:v',
        'libx264',
        '-g',
        '60',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-y',
        input,
      ])
      const classified: unknown[] = []
      const resumed: Array<{ captureTimeUs: bigint; segmentIndex: number }> = []
      const run = createMediaSourceProcess({
        importRoot,
        ingestBaseUrl: 'rtmp://127.0.0.1:1935/app',
        recordingRoot,
        workRoot,
        youtubeExtractorArgs: 'youtube:player_client=android_vr',
        youtubeFormat: 'best',
        youtubeVodFormat: 'best',
      })
      const work = {
        attempts: 1,
        captureSessionId: captureId,
        id: '92000000-0000-4000-8000-000000000002',
        importKey: `${captureId}/source.mp4`,
        ingestPath: 'fixture-court',
        resumeCaptureTimeUs: 0n,
        resumeSegmentIndex: 0,
        segmentBaseAt: new Date('2026-08-09T06:00:00.000Z'),
        sourceKind: 'local_mp4',
        sourceUrl: null,
        status: 'RUNNING',
      } as const
      const result = await run(
        work,
        {
          classified: async value => {
            classified.push(value)
          },
          resumed: async (segmentIndex, captureTimeUs) => {
            resumed.push({ captureTimeUs, segmentIndex })
            // Match MediaSourceRuntime: durable checkpoint callbacks update the
            // shared claimed-work object while the process is still publishing.
            ;(work as { resumeCaptureTimeUs: bigint }).resumeCaptureTimeUs = captureTimeUs
          },
        },
        new AbortController().signal,
      )

      const files = (await readdir(join(recordingRoot, 'fixture-court'))).filter(name =>
        name.endsWith('.mp4'),
      )
      expect(result).toMatchObject({ sourceKind: 'local_mp4' })
      expect(result.expectedSegments).toBe(1)
      expect(classified).toHaveLength(1)
      expect(resumed.at(-1)?.segmentIndex).toBe(result.expectedSegments)
      expect(resumed.at(-1)?.captureTimeUs).toBeGreaterThanOrEqual(4_000_000n)
      expect(resumed.at(-1)?.captureTimeUs).toBeLessThan(5_000_000n)
      expect(resumed.at(-1)?.captureTimeUs).not.toBe(BigInt(result.expectedSegments) * 2_000_000n)
      expect(files).toHaveLength(result.expectedSegments)
      expect(files.every(name => /^2026-08-09_06-00-\d{2}-\d{6}\.mp4$/.test(name))).toBe(true)
      expect(
        JSON.parse(
          await readFile(
            join(recordingRoot, 'fixture-court', '.source-checkpoint-v1.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ schemaVersion: 1, segmentIndex: 1 })
    },
  )

  it.skipIf(!hasFfmpeg)(
    'recovers a finalized extent when the database checkpoint acknowledgement fails',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'vollyai-source-checkpoint-'))
      temporaryPaths.push(root)
      const importRoot = join(root, 'imports')
      const recordingRoot = join(root, 'recordings')
      const captureId = '93000000-0000-4000-8000-000000000001'
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(importRoot, captureId), { recursive: true })
      const input = join(importRoot, captureId, 'source.mp4')
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=30',
        '-t',
        '1.1',
        '-c:v',
        'libx264',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-y',
        input,
      ])
      const run = createMediaSourceProcess({
        importRoot,
        ingestBaseUrl: 'rtmp://127.0.0.1:1935/app',
        recordingRoot,
        workRoot: join(root, 'unused-work-root'),
        youtubeExtractorArgs: 'youtube:player_client=default',
        youtubeFormat: 'best',
        youtubeVodFormat: 'best',
      })
      const work = {
        attempts: 1,
        captureSessionId: captureId,
        id: '93000000-0000-4000-8000-000000000002',
        importKey: `${captureId}/source.mp4`,
        ingestPath: 'checkpoint-court',
        resumeCaptureTimeUs: 0n,
        resumeSegmentIndex: 0,
        segmentBaseAt: new Date('2026-08-09T07:00:00.000Z'),
        sourceKind: 'local_mp4',
        sourceUrl: null,
        status: 'RUNNING' as const,
      }
      await expect(
        run(
          work,
          {
            classified: async () => undefined,
            resumed: async () => {
              throw new Error('simulated database outage')
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow('simulated database outage')

      const checkpointDirectory = join(recordingRoot, 'checkpoint-court')
      await rename(
        join(checkpointDirectory, '.source-checkpoint-v1.json'),
        join(checkpointDirectory, '.source-checkpoint-v1.pending.json'),
      )

      const recovered: Array<{ segmentIndex: number; captureTimeUs: bigint }> = []
      const result = await run(
        work,
        {
          classified: async () => undefined,
          resumed: async (segmentIndex, captureTimeUs) => {
            recovered.push({ segmentIndex, captureTimeUs })
          },
        },
        new AbortController().signal,
      )
      expect(result.expectedSegments).toBe(1)
      expect(recovered).toHaveLength(1)
      expect(recovered[0]?.segmentIndex).toBe(1)
      expect(recovered[0]?.captureTimeUs).toBeGreaterThanOrEqual(1_000_000n)
      expect(
        (await readdir(join(recordingRoot, 'checkpoint-court'))).filter(name =>
          name.endsWith('.mp4'),
        ),
      ).toHaveLength(1)
    },
  )
})
