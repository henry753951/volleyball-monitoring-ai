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

  it('does not issue a request when setup is deferred', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      createMediaSourceClient({ fetcher }).create('match-3', { kind: 'later' }),
    ).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
