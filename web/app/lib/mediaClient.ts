import type { FrameStepRequest, PlaybackCursorInput, PlaybackWindowDescriptor, PlaybackWindowRequest, ResolvedMediaAnchor } from './mediaModel'
import { MediaApiError } from './mediaModel'

export interface MediaClientOptions { baseUrl?: string; fetcher?: typeof fetch }
export function createMediaClient(options: MediaClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '/api/v1'; const fetcher = options.fetcher ?? fetch
  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
    if (response.ok) return await response.json() as T
    let body: any = null; try { body = await response.json() } catch { /* non-json */ }
    const error = body?.error ?? body ?? {}; const code = error.code ?? 'BAD_REQUEST'
    throw new MediaApiError(code, error.message ?? `Media request failed (${response.status})`, response.status, error.details)
  }
  return {
    createPlaybackWindow: (input: PlaybackWindowRequest) => request<PlaybackWindowDescriptor>('/media/playback-windows', { method: 'POST', body: JSON.stringify(input) }),
    getPlaybackWindow: (id: string) => request<PlaybackWindowDescriptor>(`/media/playback-windows/${encodeURIComponent(id)}`, { method: 'GET' }),
    resolveCursor: (input: PlaybackCursorInput) => request<ResolvedMediaAnchor>('/media/resolve-cursor', { method: 'POST', body: JSON.stringify(input) }),
    frameStep: (input: FrameStepRequest) => request<ResolvedMediaAnchor>('/media/frame-step', { method: 'POST', body: JSON.stringify(input) }),
  }
}
export type MediaClient = ReturnType<typeof createMediaClient>
