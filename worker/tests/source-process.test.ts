import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildYoutubeProbeArgs,
  buildYoutubeVodDownloadArgs,
  createMediaSourceProcess,
  type MediaSourceProcessOptions,
} from '../src/media/source-process.js'

const execFileAsync = promisify(execFile)
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function ffmpegAvailable(): Promise<boolean> {
  try { await execFileAsync('ffmpeg', ['-version']); return true }
  catch { return false }
}

const hasFfmpeg = await ffmpegAvailable()

const youtubeOptions: MediaSourceProcessOptions = {
  importRoot: '/imports',
  ingestBaseUrl: 'rtmp://127.0.0.1:1935/app',
  recordingRoot: '/recordings',
  workRoot: '/work',
  youtubeCookiesFile: '/run/secrets/youtube.cookies.txt',
  youtubeExtractorArgs: 'youtube:player_client=default',
  youtubeFormat: 'live-format',
  youtubeVodConcurrentFragments: 4,
  youtubeVodFormat: 'vod-format',
}

describe('media source process', () => {
  it('builds separate probe and VOD arguments without exposing cookie contents', () => {
    expect(buildYoutubeProbeArgs('https://youtu.be/example', youtubeOptions)).toEqual([
      '--dump-single-json', '--no-playlist', '--no-progress', '--no-warnings',
      '--cookies', '/run/secrets/youtube.cookies.txt',
      '--extractor-args', 'youtube:player_client=default',
      '--format', 'live-format', 'https://youtu.be/example',
    ])
    expect(buildYoutubeVodDownloadArgs('https://youtu.be/example', '/work/source.%(ext)s', youtubeOptions)).toEqual([
      '--no-playlist', '--no-progress', '--no-warnings',
      '--cookies', '/run/secrets/youtube.cookies.txt',
      '--extractor-args', 'youtube:player_client=default',
      '--abort-on-unavailable-fragments', '--concurrent-fragments', '4',
      '--format', 'vod-format', '--merge-output-format', 'mp4',
      '--output', '/work/source.%(ext)s', 'https://youtu.be/example',
    ])
  })

  it.skipIf(!hasFfmpeg)('segments an uploaded MP4 into resumable frame-timed recordings', async () => {
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
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x180:rate=60', '-t', '4.1',
      '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-an', '-y', input,
    ])
    const classified: unknown[] = []
    const resumed: number[] = []
    const run = createMediaSourceProcess({
      importRoot,
      ingestBaseUrl: 'rtmp://127.0.0.1:1935/app',
      recordingRoot,
      workRoot,
      youtubeExtractorArgs: 'youtube:player_client=android_vr',
      youtubeFormat: 'best',
      youtubeVodConcurrentFragments: 4,
      youtubeVodFormat: 'best',
    })
    const result = await run({
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
    }, {
      classified: async value => { classified.push(value) },
      resumed: async value => { resumed.push(value) },
    }, new AbortController().signal)

    const files = await readdir(join(recordingRoot, 'fixture-court'))
    expect(result).toMatchObject({ sourceKind: 'local_mp4' })
    expect(result.expectedSegments).toBeGreaterThanOrEqual(2)
    expect(classified).toHaveLength(1)
    expect(resumed.at(-1)).toBe(result.expectedSegments)
    expect(files).toHaveLength(result.expectedSegments)
    expect(files.every(name => /^2026-08-09_06-00-\d{2}-\d{6}\.mp4$/.test(name))).toBe(true)
  })
})
