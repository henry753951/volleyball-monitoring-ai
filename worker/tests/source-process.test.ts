import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createMediaSourceProcess } from '../src/media/source-process.js'

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

describe('media source process', () => {
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
