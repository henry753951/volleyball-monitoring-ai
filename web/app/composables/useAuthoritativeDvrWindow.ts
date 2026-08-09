import type { PlaybackCursorInput, PlaybackWindowDescriptor, ResolvedMediaAnchor, CanonicalFrameAnchor } from '../lib/mediaModel'
import type { MediaClient } from '../lib/mediaClient'
import { MediaApiError } from '../lib/mediaModel'
import { shallowRef, ref, readonly } from 'vue'
import { classifyMediaError } from '../lib/mediaModel'

export type WindowStatus = 'idle' | 'loading' | 'ready' | 'recovering' | 'gap' | 'error'
export function frameRecovery(code: string) {
  if (code === 'WINDOW_BOUNDARY') return 'recenter'
  if (code === 'WINDOW_EXPIRED' || code === 'MAPPING_STALE') return 'refresh'
  if (code === 'SAMPLE_NOT_FOUND' || code === 'CAPTURE_GAP') return 'blocked'
  return 'error'
}
export function boundedPlayerSeconds(playerUs: string) { const value = BigInt(playerUs); if (value < 0n || value > 86_400_000_000n) throw new RangeError('unbounded player time'); return Number(value) / 1_000_000 }
export function frameCommandEnabled(input: { descriptor: boolean; anchor: boolean; cursorReady: boolean; busy: boolean; recovering: boolean }) { return input.descriptor && input.anchor && input.cursorReady && !input.busy && !input.recovering }
export const authoritativeControlsEnabled = (input: { cursorReady: boolean; status: WindowStatus; busy: boolean; descriptor: PlaybackWindowDescriptor | null; anchor: { playback_window_id: string; mapping_version: number } | null }) => Boolean(input.cursorReady && input.status === 'ready' && !input.busy && input.descriptor && input.anchor && input.anchor.playback_window_id === input.descriptor.playback_window_id && input.anchor.mapping_version === input.descriptor.mapping_version)
export function seekVideoToCanonicalFrame(video: HTMLVideoElement, anchor: { player_media_time_us: string }) { const seconds = boundedPlayerSeconds(anchor.player_media_time_us); video.currentTime = seconds; return seconds }
export function useAuthoritativeDvrWindow(client: MediaClient) {
  const current = shallowRef<PlaybackWindowDescriptor | null>(null)
  const anchor = shallowRef<ResolvedMediaAnchor | CanonicalFrameAnchor | null>(null)
  const status = ref<WindowStatus>('idle'); const error = shallowRef<MediaApiError | Error | null>(null); const busy = ref(false)
  let generation = 0
  let resolveGeneration = 0
  const begin = () => { const id = ++generation; busy.value = true; status.value = 'loading'; error.value = null; return id }
  const valid = (id: number) => id === generation
  async function create(input: Parameters<MediaClient['createPlaybackWindow']>[0]) {
    const id = begin(); const previous = current.value
    try { const descriptor = await client.createPlaybackWindow(input); if (!valid(id)) return null; current.value = descriptor; anchor.value = null; status.value = 'ready'; return descriptor }
    catch (cause) { if (!valid(id)) return null; current.value = previous; status.value = 'error'; error.value = cause instanceof Error ? cause : new Error('Window request failed'); throw cause }
    finally { if (valid(id)) busy.value = false }
  }
  function activate(descriptor: PlaybackWindowDescriptor) {
    generation += 1
    resolveGeneration += 1
    current.value = descriptor
    anchor.value = null
    status.value = 'ready'
    error.value = null
    busy.value = false
    return descriptor
  }
  function refresh(descriptor: PlaybackWindowDescriptor) {
    const previous = current.value
    if (!previous || previous.playback_window_id !== descriptor.playback_window_id) return activate(descriptor)
    generation += 1
    resolveGeneration += 1
    current.value = descriptor
    // A rolling mapping revision can evict the sample backing the old anchor.
    // Never relabel that anchor as if the server had resolved it under the new
    // mapping; the next presented cursor will establish fresh authority.
    if (anchor.value?.mapping_version !== descriptor.mapping_version) anchor.value = null
    status.value = 'ready'
    error.value = null
    busy.value = false
    return descriptor
  }
  function clear() {
    generation += 1
    resolveGeneration += 1
    current.value = null
    anchor.value = null
    status.value = 'idle'
    error.value = null
    busy.value = false
  }
  async function resolve(cursor: PlaybackCursorInput) {
    const operationGeneration = generation
    const id = ++resolveGeneration
    try {
      const value = await client.resolveCursor(cursor)
      if (operationGeneration !== generation || id !== resolveGeneration) return null
      anchor.value = value
      status.value = 'ready'
      error.value = null
      return value
    }
    catch (cause) {
      if (operationGeneration !== generation || id !== resolveGeneration) return null
      status.value = 'error'
      error.value = cause instanceof Error ? cause : new Error('Cursor resolution failed')
      return null
    }
  }
  async function step(direction: 'previous' | 'next', inputFactory: (target: string) => Parameters<MediaClient['createPlaybackWindow']>[0]) {
    if (!current.value || !anchor.value) return null
    let attempt = 0
    while (attempt++ < 2) {
      const id = begin()
      const sourceAnchor: ResolvedMediaAnchor | CanonicalFrameAnchor | null = anchor.value
      if (!sourceAnchor || !current.value) return null
      try { const value = await client.frameStep({ schema_version: '1.0.0', capture_session_id: current.value.capture_session_id, playback_window_id: current.value.playback_window_id, mapping_version: current.value.mapping_version, capture_frame_index: sourceAnchor.capture_frame_index, direction }); if (!valid(id)) return null; anchor.value = value; status.value = 'ready'; busy.value = false; return value }
      catch (cause) {
        if (!valid(id)) return null
        const mediaError = cause as MediaApiError
        const classification = classifyMediaError(mediaError)
        if (attempt >= 2 || classification !== 'recenter_retry' && classification !== 'recreate_window') {
          status.value = mediaError.code === 'CAPTURE_GAP' || mediaError.code === 'SAMPLE_NOT_FOUND' ? 'gap' : 'error'; error.value = mediaError; busy.value = false; return null
        }
        status.value = 'recovering'; busy.value = false
        const target = mediaError.details && typeof mediaError.details === 'object' && 'target_capture_time_us' in mediaError.details ? String(mediaError.details.target_capture_time_us) : sourceAnchor.capture_time_us
        const priorAnchor: ResolvedMediaAnchor | CanonicalFrameAnchor = sourceAnchor
        try { const refreshed = await create(inputFactory(target)); if (refreshed && priorAnchor) anchor.value = { ...priorAnchor, playback_window_id: refreshed.playback_window_id, mapping_version: refreshed.mapping_version } } catch (refreshError) { status.value = 'error'; error.value = refreshError instanceof Error ? refreshError : mediaError; busy.value = false; return null }
      }
    }
    return null
  }
  return { current, anchor, status: readonly(status), error: readonly(error), busy: readonly(busy), activate, clear, create, refresh, resolve, step }
}
