import { describe, expect, it, vi } from 'vitest'
import { createMediaClient } from './mediaClient'
import { classifyMediaError, MediaApiError } from './mediaModel'

describe('media REST client', () => {
  it('uses same-origin credentials and preserves decimal strings', async () => {
    const fetcher = vi.fn(async (_url, init) => new Response(JSON.stringify({ schema_version: '1.0.0', capture_time_us: '9007199254740993' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await createMediaClient({ fetcher }).resolveCursor({ schema_version: '1.0.0', playback_window_id: 'w', mapping_version: 1, player_media_time_us: '3', observation_source: 'current_time_fallback', presented_frames: null, seek_generation: 0, cursor_status: 'ready' })
    expect(result.capture_time_us).toBe('9007199254740993')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include', method: 'POST' })
  })
  it.each(['BAD_REQUEST','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','MAPPING_STALE','MEDIA_NOT_READY','WINDOW_BOUNDARY','WINDOW_EXPIRED','CURSOR_NOT_READY','CAPTURE_GAP','SAMPLE_NOT_FOUND'] as const)('normalizes %s', async code => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code, message: 'x', request_id: 'r', details: { retryable: false } }), { status: 400 }))
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toMatchObject({ code, status: 400 })
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toBeInstanceOf(MediaApiError)
  })
  it('does not pretend malformed or unknown envelopes are BAD_REQUEST', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'bad' }), { status: 500 }))
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toMatchObject({ code: 'UNKNOWN', status: 500 })
  })
  it('classifies deterministic recovery without silent renewal', () => {
    expect(classifyMediaError(new MediaApiError('WINDOW_EXPIRED', 'x', 410))).toBe('recreate_window')
    expect(classifyMediaError(new MediaApiError('MAPPING_STALE', 'x', 409))).toBe('recreate_window')
    expect(classifyMediaError(new MediaApiError('WINDOW_BOUNDARY', 'x', 409))).toBe('recenter_retry')
    expect(classifyMediaError(new MediaApiError('CAPTURE_GAP', 'x', 422))).toBe('block')
    expect(classifyMediaError(new MediaApiError('SAMPLE_NOT_FOUND', 'x', 422))).toBe('block')
  })
})
