import type { PlaybackCursorInput, PlaybackWindowDescriptor, ResolvedMediaAnchor, CanonicalFrameAnchor } from '../lib/mediaModel'
import type { MediaClient } from '../lib/mediaClient'
import { MediaApiError } from '../lib/mediaModel'
import { shallowRef, reactive, ref, readonly, onScopeDispose } from 'vue'

export type WindowStatus = 'idle' | 'loading' | 'ready' | 'recovering' | 'gap' | 'error'
export function frameRecovery(code: string) {
  if (code === 'WINDOW_BOUNDARY') return 'recenter'
  if (code === 'WINDOW_EXPIRED' || code === 'MAPPING_STALE') return 'refresh'
  if (code === 'SAMPLE_NOT_FOUND' || code === 'CAPTURE_GAP') return 'blocked'
  return 'error'
}
export function boundedPlayerSeconds(playerUs: string) { const value = BigInt(playerUs); if (value < 0n || value > 86_400_000_000n) throw new RangeError('unbounded player time'); return Number(value) / 1_000_000 }
export function frameCommandEnabled(input: { descriptor: boolean; anchor: boolean; cursorReady: boolean; busy: boolean; recovering: boolean }) { return input.descriptor && input.anchor && input.cursorReady && !input.busy && !input.recovering }
export function useAuthoritativeDvrWindow(client: MediaClient) {
  const current = shallowRef<PlaybackWindowDescriptor | null>(null)
  const cache = reactive<{ previous: PlaybackWindowDescriptor | null; current: PlaybackWindowDescriptor | null; next: PlaybackWindowDescriptor | null }>({ previous: null, current: null, next: null })
  const anchor = shallowRef<ResolvedMediaAnchor | CanonicalFrameAnchor | null>(null)
  const status = ref<WindowStatus>('idle'); const error = shallowRef<MediaApiError | Error | null>(null); const busy = ref(false)
  let generation = 0; let abort: AbortController | null = null
  const begin = () => { abort?.abort(); abort = new AbortController(); const id = ++generation; busy.value = true; status.value = 'loading'; error.value = null; return id }
  const valid = (id: number) => id === generation
  async function create(input: Parameters<MediaClient['createPlaybackWindow']>[0], slot: keyof typeof cache = 'current') {
    const id = begin(); const previous = current.value
    try { const descriptor = await client.createPlaybackWindow(input); if (!valid(id)) return null; cache[slot] = descriptor; current.value = descriptor; status.value = 'ready'; return descriptor }
    catch (cause) { if (!valid(id)) return null; current.value = previous; status.value = 'error'; error.value = cause instanceof Error ? cause : new Error('Window request failed'); throw cause }
    finally { if (valid(id)) busy.value = false }
  }
  async function resolve(cursor: PlaybackCursorInput) { const id = begin(); try { const value = await client.resolveCursor(cursor); if (!valid(id)) return null; anchor.value = value; busy.value = false; status.value = 'ready'; return value } catch (cause) { if (!valid(id)) return null; busy.value = false; status.value = 'error'; error.value = cause instanceof Error ? cause : new Error('Cursor resolution failed'); return null } }
  async function step(direction: 'previous' | 'next', inputFactory: (target: string) => Parameters<MediaClient['createPlaybackWindow']>[0]) {
    if (!current.value || !anchor.value) return null
    let attempt = 0
    while (attempt++ < 2) {
      const id = begin()
      try { const value = await client.frameStep({ schema_version: '1.0.0', capture_session_id: current.value.capture_session_id, playback_window_id: current.value.playback_window_id, mapping_version: current.value.mapping_version, capture_frame_index: anchor.value.capture_frame_index, direction }); if (!valid(id)) return null; anchor.value = value; status.value = 'ready'; busy.value = false; return value }
      catch (cause) {
        if (!valid(id)) return null
        const mediaError = cause as MediaApiError
        if (attempt >= 2 || !['WINDOW_BOUNDARY', 'WINDOW_EXPIRED', 'MAPPING_STALE'].includes(mediaError.code)) {
          status.value = mediaError.code === 'CAPTURE_GAP' || mediaError.code === 'SAMPLE_NOT_FOUND' ? 'gap' : 'error'; error.value = mediaError; busy.value = false; return null
        }
        status.value = 'recovering'; busy.value = false
        const target = mediaError.details && typeof mediaError.details === 'object' && 'target_capture_time_us' in mediaError.details ? String(mediaError.details.target_capture_time_us) : anchor.value.capture_time_us
        try { await create(inputFactory(target)) } catch { status.value = 'error'; error.value = new Error('Window recovery failed'); busy.value = false; return null }
      }
    }
    return null
  }
  onScopeDispose(() => abort?.abort())
  return { current, cache, anchor, status: readonly(status), error: readonly(error), busy: readonly(busy), create, resolve, step }
}
