import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmeLivePlaybackSource } from '~/lib/omeLivePlayback'
import { MEDIA_BUFFER_PROFILES } from '~/utils/mediaPlaybackPreferences'
import {
  createOmeLivePlaybackService,
  requiresOmeLivePipelineReplacement,
} from './ome-live-playback.service'

const hlsInstances = vi.hoisted(() => [] as FakeHls[])

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
  readonly loadSource = vi.fn(() => queueMicrotask(() => this.emit(FakeHls.Events.MANIFEST_PARSED)))
  readonly recoverMediaError = vi.fn()
  readonly startLoad = vi.fn(() => queueMicrotask(() => this.emit(FakeHls.Events.FRAG_BUFFERED)))
  readonly config: Record<string, unknown>
  private readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>()

  constructor(config: Record<string, unknown>) {
    this.config = config
    hlsInstances.push(this)
  }

  on(event: string, listener: (...arguments_: never[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event: string, listener: (...arguments_: never[]) => void) {
    this.listeners.get(event)?.delete(listener)
  }

  private emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

vi.mock('hls.js', () => ({ default: FakeHls }))

function source(overrides: Partial<OmeLivePlaybackSource> = {}): OmeLivePlaybackSource {
  return {
    backend: 'ome_llhls',
    captureSessionId: 'capture-a',
    liveEdgeCaptureTimeUs: '120000000',
    manifestUrl: '/ome/app/stream-a/master.m3u8',
    ...overrides,
  }
}

function videoElement() {
  return {
    buffered: { length: 0, start: () => 0, end: () => 0 },
    canPlayType: () => '',
    currentTime: 0,
    load: vi.fn(),
    removeAttribute: vi.fn(),
  } as unknown as HTMLVideoElement
}

beforeEach(() => hlsInstances.splice(0))

describe('OME live playback pipeline', () => {
  it('only replaces the pipeline when capture or manifest identity changes', () => {
    expect(requiresOmeLivePipelineReplacement(source(), source())).toBe(false)
    expect(
      requiresOmeLivePipelineReplacement(source(), source({ captureSessionId: 'capture-b' })),
    ).toBe(true)
  })

  it('starts at the live edge and keeps the pipeline while the canonical edge advances', async () => {
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
    await service.attach(source({ liveEdgeCaptureTimeUs: '122000000' }))

    expect(service.activeSource.value?.liveEdgeCaptureTimeUs).toBe('122000000')
    expect(hls.loadSource).not.toHaveBeenCalled()
    expect(hls.startLoad).not.toHaveBeenCalled()
  })
})
