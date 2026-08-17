import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaybackWindowDescriptor } from '../lib/mediaModel'
import { createDvrPlaybackService } from '../services/annotation-workstation/dvr-playback.service'
import { MEDIA_BUFFER_PROFILES } from '../utils/mediaPlaybackPreferences'
import { boundedPlayerMediaSeconds } from '../utils/playerMediaTime'
import { requiresPlaybackPipelineReplacement } from './useDvrPlayback'

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
  private readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>()

  constructor() {
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

vi.mock('hls.js/light', () => ({ default: FakeHls }))

function descriptor(mappingVersion: number): PlaybackWindowDescriptor {
  return {
    schema_version: '1.0.0',
    playback_window_id: 'window-a',
    capture_session_id: 'capture-a',
    mode: 'archive',
    mapping_version: mappingVersion,
    timeline_capture_start_us: '0',
    timeline_capture_end_us: '120000000',
    window_capture_start_us: '0',
    window_capture_end_us: mappingVersion === 1 ? '60000000' : '90000000',
    presentation_origin_capture_us: '0',
    target_player_media_time_us: '37000000',
    manifest_url: '/api/v1/media/playback-windows/window-a/manifest.m3u8',
    expires_at: '2099-01-01T00:00:00.000Z',
    live_edge_capture_time_us: null,
    has_more_before: false,
    has_more_after: true,
  }
}

beforeEach(() => hlsInstances.splice(0))

describe('bounded player media time', () => {
  it('does not subtract canonical presentation origin', () => {
    expect(boundedPlayerMediaSeconds('120000000')).toBe(120)
  })
  it('rejects negative or unbounded local values', () => {
    expect(() => boundedPlayerMediaSeconds('-1')).toThrow(RangeError)
    expect(() => boundedPlayerMediaSeconds('9007199254740992')).toThrow(RangeError)
  })
})

describe('rolling HLS attachment', () => {
  it('keeps one MSE pipeline for mapping revisions of the same window', () => {
    expect(
      requiresPlaybackPipelineReplacement(
        { playback_window_id: 'window-a' },
        { playback_window_id: 'window-a' },
      ),
    ).toBe(false)
    expect(
      requiresPlaybackPipelineReplacement(
        { playback_window_id: 'window-a' },
        { playback_window_id: 'window-b' },
      ),
    ).toBe(true)
  })

  it('does not reload or restart media when the same window appends a mapping revision', async () => {
    const element = {
      buffered: { length: 1, start: () => 0, end: () => 120 },
      canPlayType: () => '',
      currentTime: 0,
      ended: false,
      load: vi.fn(),
      paused: true,
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement
    const service = createDvrPlaybackService(ref(element), MEDIA_BUFFER_PROFILES.balanced)

    await service.attach(descriptor(1))
    const hls = hlsInstances[0]!
    expect(element.currentTime).toBe(37)
    hls.loadSource.mockClear()
    hls.startLoad.mockClear()

    await service.attach(descriptor(2))

    expect(service.activeWindow.value?.mapping_version).toBe(2)
    expect(element.currentTime).toBe(37)
    expect(hls.loadSource).not.toHaveBeenCalled()
    expect(hls.startLoad).not.toHaveBeenCalled()
  })
})
