import { describe, expect, it, vi } from 'vitest'
import { createMediaClient } from './mediaClient'
import { classifyMediaError, MediaApiError } from './mediaModel'

describe('media REST client', () => {
  it('uses same-origin credentials and preserves decimal strings', async () => {
    const fetcher = vi.fn(async (_url, init) => new Response(JSON.stringify({ schema_version: '1.0.0', playback_window_id: 'w', capture_session_id: 's', mode: 'archive', mapping_version: 1, timeline_capture_start_us: '9007199254740000', timeline_capture_end_us: '9007199254745000', window_capture_start_us: '9007199254740000', window_capture_end_us: '9007199254745000', presentation_origin_capture_us: '9007199254740000', target_player_media_time_us: '1', manifest_url: '/m', expires_at: '2026-08-07T00:00:00Z', has_more_before: false, has_more_after: false }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await createMediaClient({ fetcher }).createPlaybackWindow({ schema_version: '1.0.0', capture_session_id: 's', mode: 'archive', target_capture_time_us: '9007199254740000' })
    expect(result.playback_window_id).toBe('w')
    const firstCall = fetcher.mock.calls.at(0)
    expect(firstCall).toBeDefined()
    expect(firstCall![1]).toMatchObject({ credentials: 'include', method: 'POST' })
  })
  it.each(['BAD_REQUEST','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','MAPPING_STALE','MEDIA_NOT_READY','WINDOW_BOUNDARY','WINDOW_EXPIRED','CURSOR_NOT_READY','CAPTURE_GAP','SAMPLE_NOT_FOUND'] as const)('normalizes %s', async code => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ schema_version: '1.0.0', code, message: 'x', request_id: 'r', details: { retryable: false } }), { status: 400 }))
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toMatchObject({ code, status: 400 })
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toBeInstanceOf(MediaApiError)
  })
  it('does not pretend malformed or unknown envelopes are BAD_REQUEST', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'bad' }), { status: 500 }))
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toMatchObject({ code: 'UNKNOWN', status: 500 })
  })
  it('rejects malformed successful payloads through canonical parser', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ schema_version: '1.0.0', playback_window_id: 'w', mapping_version: 1 }), { status: 200 }))
    await expect(createMediaClient({ fetcher }).getPlaybackWindow('w')).rejects.toBeInstanceOf(TypeError)
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
