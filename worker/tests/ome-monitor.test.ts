import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it, vi } from 'vitest'
import { OmeMonitorRuntime } from '../src/media/ome-monitor.js'

const apiToken = 'a'.repeat(32)

function harness(
  capture: {
    id: string
    ingestPath: string
    sourceOnline: boolean
    startedAt: Date | null
    status: 'LIVE' | 'STARTING'
  },
  streams: string[],
  presentation?: { existing?: { id: string }; instanceId: string },
) {
  const update = vi.fn().mockResolvedValue(undefined)
  const anchorCreate = vi.fn().mockResolvedValue(undefined)
  const anchorUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    livePresentationAnchor: {
      create: anchorCreate,
      findFirst: vi.fn().mockResolvedValue({ sequenceIndex: 4 }),
      findUnique: vi.fn().mockResolvedValue(presentation?.existing ?? null),
      updateMany: anchorUpdateMany,
    },
  }
  const database = {
    $transaction: vi.fn(async callback => callback(transaction)),
    captureSession: {
      findMany: vi.fn().mockResolvedValue([capture]),
      update,
    },
    livePresentationAnchor: { updateMany: anchorUpdateMany },
  } as unknown as PrismaClient
  const fetchImpl = vi.fn().mockImplementation((input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/streams'))
      return Promise.resolve(
        new Response(JSON.stringify({ response: streams }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
    if (!presentation) return Promise.resolve(new Response('', { status: 404 }))
    if (url.endsWith('/master.m3u8'))
      return Promise.resolve(
        new Response(
          `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\n/app/${capture.ingestPath}/chunklist_0_video_${presentation.instanceId}_llhls.m3u8\n`,
        ),
      )
    return Promise.resolve(
      new Response(
        '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:2026-08-18T07:01:16.338+00:00\n#EXTINF:2.0,\nseg.m4s\n',
      ),
    )
  })
  return {
    anchorCreate,
    anchorUpdateMany,
    fetchImpl,
    runtime: new OmeMonitorRuntime({
      apiToken,
      apiUrl: 'http://ome.test:8081',
      database,
      fetchImpl,
      llhlsBaseUrl: 'http://ome.test:3333',
      recordingRoot: 'C:\\recordings',
    }),
    update,
  }
}

describe('OME monitor', () => {
  it('promotes an online starting capture without waiting for a recording extent', async () => {
    const test = harness(
      {
        id: 'capture-1',
        ingestPath: 'youtube-live-1',
        sourceOnline: false,
        startedAt: null,
        status: 'STARTING',
      },
      ['youtube-live-1'],
    )

    await test.runtime.poll()

    expect(test.update).toHaveBeenCalledOnce()
    expect(test.update).toHaveBeenCalledWith({
      data: {
        health: 'HEALTHY',
        sourceObservedAt: expect.any(Date),
        sourceOnline: true,
        startedAt: expect.any(Date),
        status: 'LIVE',
      },
      where: { id: 'capture-1' },
    })
  })

  it('repairs a previously observed online capture still stuck in STARTING', async () => {
    const startedAt = new Date('2026-08-18T06:00:00.000Z')
    const test = harness(
      {
        id: 'capture-2',
        ingestPath: 'youtube-live-2',
        sourceOnline: true,
        startedAt,
        status: 'STARTING',
      },
      ['youtube-live-2'],
    )

    await test.runtime.poll()

    expect(test.update).toHaveBeenCalledWith({
      data: {
        health: 'HEALTHY',
        sourceObservedAt: expect.any(Date),
        sourceOnline: true,
        startedAt,
        status: 'LIVE',
      },
      where: { id: 'capture-2' },
    })
  })

  it('does not rewrite an unchanged online LIVE capture every poll', async () => {
    const test = harness(
      {
        id: 'capture-3',
        ingestPath: 'youtube-live-3',
        sourceOnline: true,
        startedAt: new Date('2026-08-18T06:00:00.000Z'),
        status: 'LIVE',
      },
      ['youtube-live-3'],
    )

    await test.runtime.poll()

    expect(test.update).not.toHaveBeenCalled()
  })

  it('persists a new OME stream generation once and closes the previous anchor', async () => {
    const test = harness(
      {
        id: 'capture-4',
        ingestPath: 'youtube-live-4',
        sourceOnline: true,
        startedAt: new Date('2026-08-18T06:00:00.000Z'),
        status: 'LIVE',
      },
      ['youtube-live-4'],
      { instanceId: '5494374788645664965' },
    )

    await test.runtime.poll()

    expect(test.anchorUpdateMany).toHaveBeenCalledWith({
      data: { endedAt: expect.any(Date) },
      where: { captureSessionId: 'capture-4', endedAt: null },
    })
    expect(test.anchorCreate).toHaveBeenCalledWith({
      data: {
        captureSessionId: 'capture-4',
        firstMediaSequence: 0n,
        observedAt: expect.any(Date),
        programDateTime: new Date('2026-08-18T07:01:16.338Z'),
        sequenceIndex: 5,
        streamInstanceId: '5494374788645664965',
      },
    })
  })
})
