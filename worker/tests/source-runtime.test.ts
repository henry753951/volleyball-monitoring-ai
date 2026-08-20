import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import { MediaSourceRuntime } from '../src/media/source-runtime.js'
import type { ClaimedMediaSourceWork } from '../src/media/source-work.js'

function queryText(strings: TemplateStringsArray): string {
  return Array.from(strings).join('?')
}

function work(): ClaimedMediaSourceWork {
  return {
    id: 'work-1',
    captureSessionId: 'capture-1',
    sourceKind: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=live',
    importKey: null,
    attempts: 1,
    status: 'RUNNING',
    segmentBaseAt: new Date('2026-08-20T12:00:00.000Z'),
    resumeSegmentIndex: 3,
    resumeCaptureTimeUs: 180_000_000n,
    ingestPath: 'youtube-live-1',
    captureSourceKind: 'youtube_live',
    captureSourceDurationUs: null,
  }
}

describe('media source runtime shutdown handling', () => {
  it('requeues a live source when the runner returns after worker abort', async () => {
    const updates: unknown[] = []
    let claimed = true
    let releaseRunner: (() => void) | undefined
    const database = {
      $queryRaw: (strings: TemplateStringsArray) => {
        const query = queryText(strings)
        if (query.includes(`work."status" = 'COMPLETED'`)) return Promise.resolve([])
        if (query.includes(`work."status" = 'DRAINING'`)) return Promise.resolve([])
        if (query.includes(`work."status" = 'STOP_REQUESTED'`)) return Promise.resolve([])
        if (query.includes(`work."status" = 'REQUESTED'`)) {
          if (!claimed) return Promise.resolve([])
          claimed = false
          return Promise.resolve([work()])
        }
        throw new Error(`unexpected query: ${query}`)
      },
      mediaSourceWork: {
        update: async (input: unknown) => {
          updates.push(input)
          return {}
        },
      },
    } as unknown as PrismaClient
    const runtime = new MediaSourceRuntime({
      database,
      owner: 'test-worker',
      pollIntervalMs: 60_000,
      recordingRoot: 'C:/recordings',
      run: async (_work, _observer, signal) => {
        await new Promise<void>(resolve => {
          releaseRunner = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { expectedSegments: 4, sourceDurationUs: null, sourceKind: 'youtube_live' }
      },
    })

    await runtime.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime.snapshot.runningCaptureIds).toEqual(['capture-1'])

    const stopping = runtime.stop()
    releaseRunner?.()
    await stopping

    expect(updates).toEqual([
      {
        data: {
          availableAt: expect.any(Date),
          lastErrorCode: 'WORKER_STOPPED',
          leaseExpiresAt: null,
          leaseOwner: null,
          status: 'REQUESTED',
        },
        where: { id: 'work-1' },
      },
    ])
  })
})
