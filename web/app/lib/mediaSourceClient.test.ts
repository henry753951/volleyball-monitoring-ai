import { describe, expect, it, vi } from 'vitest'
import { createMediaSourceClient } from './mediaSourceClient'

describe('match media source client', () => {
  it('starts a YouTube source with same-origin credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ capture_session_id: 'capture-1' }), { status: 202 }),
    )
    await createMediaSourceClient({ fetcher }).create('match-1', {
      kind: 'youtube',
      label: '主場轉播',
      url: 'https://www.youtube.com/watch?v=NMTbgYfa-ZM',
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/media-sources/youtube')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      match_id: 'match-1',
      source_label: '主場轉播',
      source_url: 'https://www.youtube.com/watch?v=NMTbgYfa-ZM',
    })
  })

  it('uploads MP4 through multipart without setting a content-type boundary', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ capture_session_id: 'capture-2' }), { status: 202 }),
    )
    await createMediaSourceClient({ fetcher }).create('match-2', {
      kind: 'local_mp4',
      label: '完整賽事',
      file: new File(['video'], 'match.mp4', { type: 'video/mp4' }),
    })
    const init = fetcher.mock.calls[0]?.[1]
    const body = init?.body
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/media-sources/upload')
    expect(body).toBeInstanceOf(FormData)
    expect(init?.headers).toBeUndefined()
    if (!(body instanceof FormData)) throw new TypeError('Expected upload request FormData.')
    expect(body.get('match_id')).toBe('match-2')
  })

  it('creates an RTMP source with JSON and returns its credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            rtmp: {
              publish_url: 'rtmp://encoder/app/key',
              rtmp_url: 'rtmp://encoder/app',
              stream_key: 'key',
            },
          }),
          { status: 202 },
        ),
    )
    const response = await createMediaSourceClient({ fetcher }).create('match-rtmp', {
      kind: 'rtmp',
      label: '場館攝影機',
    })
    expect(response?.rtmp?.stream_key).toBe('key')
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/media-sources/rtmp')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      match_id: 'match-rtmp',
      source_label: '場館攝影機',
    })
  })

  it('does not issue a request when setup is deferred', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      createMediaSourceClient({ fetcher }).create('match-3', { kind: 'later' }),
    ).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('force reloads a YouTube source through the fresh-resolve retry endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ attempt: 3 }), { status: 202 }),
    )
    await expect(
      createMediaSourceClient({ fetcher }).forceReloadYoutubeSource('capture-1'),
    ).resolves.toEqual({ attempt: 3 })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/media-sources/youtube/capture-1/retry')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' })
  })

  it('clears a failed media source task through the scoped delete endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ cleared: true }), { status: 200 }),
    )
    await expect(
      createMediaSourceClient({ fetcher }).clearMediaSource('capture-1'),
    ).resolves.toEqual({ cleared: true })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/media-sources/capture-1')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', credentials: 'include' })
  })
})
