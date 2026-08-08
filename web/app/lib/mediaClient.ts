import { parseCanonicalFrameAnchor, parseMediaApiError, parsePlaybackWindowDescriptor, parseResolvedMediaAnchor, type CanonicalFrameAnchor, type FrameStepRequest, type PlaybackWindowDescriptor, type PlaybackWindowExtendRequest, type PlaybackWindowRequest, type ResolvedMediaAnchor } from '@volleyball-monitoring/contracts'
import { MediaApiError, type PlaybackCursorInput } from './mediaModel'

export interface MediaClientOptions { baseUrl?: string; fetcher?: typeof fetch }
export function createMediaClient(options: MediaClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '/api/v1'; const fetcher = options.fetcher ?? fetch
  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
    const body = await response.json().catch(() => undefined)
    if (response.ok) return body as T
    try { const error = parseMediaApiError(body); throw new MediaApiError(error.code, error.message, response.status, error.details) } catch (error) {
      if (error instanceof MediaApiError) throw error
      throw new MediaApiError('UNKNOWN', `Malformed media error envelope (${response.status})`, response.status)
    }
  }
  return {
    createPlaybackWindow: async (input: PlaybackWindowRequest) => parsePlaybackWindowDescriptor(await request<unknown>('/media/playback-windows', { method: 'POST', body: JSON.stringify(input) })),
    extendPlaybackWindow: async (id: string, input: PlaybackWindowExtendRequest) => parsePlaybackWindowDescriptor(await request<unknown>(`/media/playback-windows/${encodeURIComponent(id)}/extend`, { method: 'POST', body: JSON.stringify(input) })),
    getPlaybackWindow: async (id: string) => parsePlaybackWindowDescriptor(await request<unknown>(`/media/playback-windows/${encodeURIComponent(id)}`, { method: 'GET' })),
    resolveCursor: async (input: PlaybackCursorInput) => parseResolvedMediaAnchor(await request<unknown>('/media/resolve-cursor', { method: 'POST', body: JSON.stringify(input) })),
    frameStep: async (input: FrameStepRequest) => parseCanonicalFrameAnchor(await request<unknown>('/media/frame-step', { method: 'POST', body: JSON.stringify(input) })),
  }
}
export type MediaClient = ReturnType<typeof createMediaClient>
