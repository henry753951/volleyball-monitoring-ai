import type { CanonicalFrameAnchor, FrameStepRequest, PlaybackCursorInput, PlaybackWindowDescriptor, PlaybackWindowRequest, ResolvedMediaAnchor } from './mediaModel'
import { MEDIA_ERROR_CODES, MediaApiError } from './mediaModel'

export interface MediaClientOptions { baseUrl?: string; fetcher?: typeof fetch }
export function createMediaClient(options: MediaClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '/api/v1'; const fetcher = options.fetcher ?? fetch
  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
    if (response.ok) return await response.json() as T
    let body: any = null; try { body = await response.json() } catch { /* non-json */ }
    const error = body?.code ? body : (body?.error?.code ? body.error : null)
    const code = error && (MEDIA_ERROR_CODES as readonly string[]).includes(error.code) ? error.code : 'UNKNOWN'
    throw new MediaApiError(code as any, error?.message ?? `Media request failed (${response.status})`, response.status, error?.details)
  }
  return {
    createPlaybackWindow: (input: PlaybackWindowRequest) => request<PlaybackWindowDescriptor>('/media/playback-windows', { method: 'POST', body: JSON.stringify(input) }),
    getPlaybackWindow: (id: string) => request<PlaybackWindowDescriptor>(`/media/playback-windows/${encodeURIComponent(id)}`, { method: 'GET' }),
    resolveCursor: (input: PlaybackCursorInput) => request<ResolvedMediaAnchor>('/media/resolve-cursor', { method: 'POST', body: JSON.stringify(input) }),
    frameStep: (input: FrameStepRequest) => request<CanonicalFrameAnchor>('/media/frame-step', { method: 'POST', body: JSON.stringify(input) }),
  }
}
export type MediaClient = ReturnType<typeof createMediaClient>
