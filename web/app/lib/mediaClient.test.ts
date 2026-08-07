import { describe, expect, it, vi } from 'vitest'
import { createMediaClient } from './mediaClient'
import { classifyMediaError, MediaApiError } from './mediaModel'

describe('media REST client', () => {
  it('uses same-origin credentials and preserves decimal strings', async () => {
    const fetcher = vi.fn(async (_url, init) => new Response(JSON.stringify({ schema_version: '1.0.0', capture_time_us: '9007199254740993' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await createMediaClient({ fetcher }).resolveCursor({ schema_version: '1.0.0', playback_window_id: 'w', mapping_version: 1, player_media_time_us: '3', observation_source: 'current_time_fallback', presented_frames: null, seek_generation: 0, cursor_status: 'ready' })
    expect(result.capture_time_us).toBe('9007199254740993')
    const firstCall = fetcher.mock.calls.at(0)
    expect(firstCall).toBeDefined()
    expect(firstCall![1]).toMatchObject({ credentials: 'include', method: 'POST' })
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
  it('classifies every media error deterministically', () => {
    const expected = {
      WINDOW_EXPIRED: 'recreate_window', MAPPING_STALE: 'recreate_window', WINDOW_BOUNDARY: 'recenter_retry',
      MEDIA_NOT_READY: 'retry_later', CURSOR_NOT_READY: 'retry_later', CAPTURE_GAP: 'block', SAMPLE_NOT_FOUND: 'block',
      BAD_REQUEST: 'fatal', UNAUTHENTICATED: 'fatal', FORBIDDEN: 'fatal', NOT_FOUND: 'fatal', UNKNOWN: 'fatal',
    } as const
    for (const [code, action] of Object.entries(expected)) expect(classifyMediaError(new MediaApiError(code as any, 'x', 400))).toBe(action)
  })
})
