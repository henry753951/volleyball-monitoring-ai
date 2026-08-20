import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmeLivePlaybackSource } from '~/lib/omeLivePlayback'
import { MEDIA_BUFFER_PROFILES } from '~/utils/mediaPlaybackPreferences'
import {
  createOmeLivePlaybackService,
  omeLiveAttachRetryDelayMs,
  requiresOmeLiveMasterReload,
  requiresOmeLivePipelineReplacement,
} from './ome-live-playback.service'

const hlsInstances = vi.hoisted(() => [] as FakeHls[])
const hlsBehavior = vi.hoisted(() => ({ manifestFailuresRemaining: 0 }))

class FakeHls {
  static readonly ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' }
  static readonly Events = {
    BUFFER_APPENDED: 'bufferAppended',
    BUFFER_FLUSHED: 'bufferFlushed',
    ERROR: 'error',
    FRAG_BUFFERED: 'fragBuffered',
    LEVEL_UPDATED: 'levelUpdated',
    MANIFEST_PARSED: 'manifestParsed',
  }
  static isSupported() {
    return true
  }

  readonly attachMedia = vi.fn()
  readonly destroy = vi.fn()
  readonly loadSource = vi.fn(() =>
    queueMicrotask(() => {
      if (hlsBehavior.manifestFailuresRemaining > 0) {
        hlsBehavior.manifestFailuresRemaining -= 1
        this.emit(FakeHls.Events.ERROR, undefined, {
          details: 'manifestLoadError',
          fatal: true,
          type: FakeHls.ErrorTypes.NETWORK_ERROR,
        })
        return
      }
      this.emit(FakeHls.Events.MANIFEST_PARSED)
    }),
  )
  readonly recoverMediaError = vi.fn()
  readonly startLoad = vi.fn(() => queueMicrotask(() => this.emit(FakeHls.Events.FRAG_BUFFERED)))
  readonly config: Record<string, unknown>
  private readonly listeners = new Map<string, Set<(...arguments_: unknown[]) => void>>()

  constructor(config: Record<string, unknown>) {
    this.config = config
    hlsInstances.push(this)
  }

  on(event: string, listener: (...arguments_: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event: string, listener: (...arguments_: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: string, ...arguments_: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_)
  }
}

vi.mock('hls.js', () => ({ default: FakeHls }))

function source(overrides: Partial<OmeLivePlaybackSource> = {}): OmeLivePlaybackSource {
  return {
    backend: 'ome_llhls',
    captureSessionId: 'capture-a',
    manifestUrl: '/ome/app/stream-a/master.m3u8',
    presentationAnchors: [],
    ...overrides,
  }
}

function videoElement(overrides: Partial<HTMLVideoElement> = {}) {
  return {
    buffered: { length: 0, start: () => 0, end: () => 0 },
    addEventListener: vi.fn(),
    canPlayType: () => '',
    currentTime: 0,
    ended: false,
    load: vi.fn(),
    pause: vi.fn(),
    paused: true,
    play: vi.fn().mockResolvedValue(undefined),
    removeAttribute: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  } as unknown as HTMLVideoElement
}

beforeEach(() => {
  hlsInstances.splice(0)
  hlsBehavior.manifestFailuresRemaining = 0
})

describe('OME live playback pipeline', () => {
  it('only replaces the pipeline when capture or manifest identity changes', () => {
    expect(requiresOmeLivePipelineReplacement(source(), source())).toBe(false)
    expect(
      requiresOmeLivePipelineReplacement(source(), source({ captureSessionId: 'capture-b' })),
    ).toBe(true)
  })

  it('backs off attach retries with an eight second cap', () => {
    expect([0, 1, 2, 3, 4].map(omeLiveAttachRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ])
  })

  it('recognizes stale rendition failures that require reloading the OME master manifest', () => {
    expect(requiresOmeLiveMasterReload({ details: 'levelLoadError' })).toBe(true)
    expect(requiresOmeLiveMasterReload({ details: 'fragLoadError', response: { code: 404 } })).toBe(
      true,
    )
    expect(requiresOmeLiveMasterReload({ details: 'fragLoadError', response: { code: 500 } })).toBe(
      false,
    )
  })

  it('recreates the HLS pipeline when OME is briefly unavailable', async () => {
    hlsBehavior.manifestFailuresRemaining = 1
    const service = createOmeLivePlaybackService(
      ref(videoElement()),
      MEDIA_BUFFER_PROFILES.balanced,
      { attachRetryWindowMs: 1_000, retryDelayMs: () => 0 },
    )

    await service.attach(source())

    expect(hlsInstances).toHaveLength(2)
    expect(hlsInstances[0]?.destroy).toHaveBeenCalled()
    expect(hlsInstances[1]?.loadSource).toHaveBeenCalledWith('/ome/app/stream-a/master.m3u8')
    expect(service.activeSource.value?.captureSessionId).toBe('capture-a')
  })

  it('starts at the live edge and keeps the pipeline while canonical anchors advance', async () => {
    const service = createOmeLivePlaybackService(
      ref(videoElement()),
      MEDIA_BUFFER_PROFILES.balanced,
    )

    await service.attach(source())
    const hls = hlsInstances[0]!
    expect(hls.loadSource).toHaveBeenCalledWith('/ome/app/stream-a/master.m3u8')
    expect(hls.startLoad).toHaveBeenCalledWith(-1)
    expect(hls.config).not.toHaveProperty('liveMaxLatencyDurationCount')
    expect(hls.config.maxLiveSyncPlaybackRate).toBe(1)

    hls.loadSource.mockClear()
    hls.startLoad.mockClear()
    await service.attach(
      source({
        presentationAnchors: [
          {
            captureTimeOriginUs: '122000000',
            programDateTime: '2026-08-18T07:10:13.252Z',
            sequenceIndex: 1,
          },
        ],
      }),
    )

    expect(service.activeSource.value?.presentationAnchors).toHaveLength(1)
    expect(hls.loadSource).not.toHaveBeenCalled()
    expect(hls.startLoad).not.toHaveBeenCalled()
  })

  it('resumes playback after replacing a failed live pipeline', async () => {
    const element = videoElement({ paused: false })
    vi.mocked(element.load).mockImplementation(() => {
      Object.defineProperty(element, 'paused', { configurable: true, value: true })
    })
    const service = createOmeLivePlaybackService(ref(element), MEDIA_BUFFER_PROFILES.balanced)

    await service.attach(source())

    expect(element.play).toHaveBeenCalledOnce()
  })

  it('pauses the current frame before recovering the live buffer', async () => {
    const pause = vi.fn()
    const element = videoElement({ paused: false, currentTime: 12, pause })
    const service = createOmeLivePlaybackService(ref(element), MEDIA_BUFFER_PROFILES.balanced)

    await service.attach(source())
    const hls = hlsInstances[0]!
    hls.startLoad.mockClear()
    pause.mockClear()

    expect(service.recover()).toBe(true)
    expect(pause).toHaveBeenCalledOnce()
    expect(hls.startLoad).toHaveBeenCalledWith(12)
  })

  it('reloads the master manifest when a restarted OME stream invalidates the old rendition', async () => {
    const service = createOmeLivePlaybackService(
      ref(videoElement()),
      MEDIA_BUFFER_PROFILES.balanced,
      { attachRetryWindowMs: 1_000, retryDelayMs: () => 0 },
    )
    await service.attach(source())

    hlsInstances[0]!.emit(FakeHls.Events.ERROR, undefined, {
      details: 'levelLoadError',
      fatal: false,
      response: { code: 404 },
      type: FakeHls.ErrorTypes.NETWORK_ERROR,
    })

    await vi.waitFor(() => expect(hlsInstances).toHaveLength(2))
    expect(hlsInstances[0]!.destroy).toHaveBeenCalled()
    expect(hlsInstances[1]!.loadSource).toHaveBeenCalledWith('/ome/app/stream-a/master.m3u8')
  })
})
