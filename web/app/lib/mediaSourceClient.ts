import type { CreateMatchSetupInput } from './coreDomain'

export type MatchMediaSourceDraft =
  | { kind: 'youtube'; label: string; url: string }
  | { kind: 'local_mp4'; label: string; file: File }
  | { kind: 'rtmp'; label: string }
  | { kind: 'later' }

export interface RtmpSourceCredentials {
  publish_url: string
  rtmp_url: string
  stream_key: string
}

export interface MediaSourceCreateResponse {
  capture_session?: {
    id: string
    ingest_path: string
    match_id: string
    source_kind: string
    source_label: string | null
    status: string
    health: string
  }
  rtmp?: RtmpSourceCredentials
}

export interface CreateMatchWithMediaInput {
  match: CreateMatchSetupInput
  media: MatchMediaSourceDraft
}

export interface MediaSourceClientOptions {
  baseUrl?: string
  fetcher?: typeof fetch
}

export interface YoutubeAuthStatus {
  browser: 'running' | 'offline' | 'unknown'
  cookieAvailable: boolean
  sessionState: 'available' | 'login_required' | 'unknown'
  revision: string | null
  profileUpdatedAt: string | null
  lastReadAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

export interface YoutubeSourceAuthMetadata {
  capture_session_id: string
  attempt: number
  status: string
  last_error: string | null
  auth: {
    cookieRevision?: string | null
    cookieReadAt?: string | null
    resolverStartedAt?: string
    resolverFinishedAt?: string
    playerClient?: string | null
    selectedFormatIds?: string[]
  } | null
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null
  return new Error(
    typeof body?.message === 'string' ? body.message : `影音來源建立失敗 (${response.status})`,
  )
}

export function createMediaSourceClient(options: MediaSourceClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '/api/v1'
  const fetcher = options.fetcher ?? fetch
  return {
    async create(
      matchId: string,
      source: MatchMediaSourceDraft,
    ): Promise<MediaSourceCreateResponse | null> {
      if (source.kind === 'later') return null
      if (source.kind === 'youtube') {
        const response = await fetcher(`${baseUrl}/media-sources/youtube`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            match_id: matchId,
            source_label: source.label || undefined,
            source_url: source.url,
          }),
        })
        if (!response.ok) throw await responseError(response)
        return (await response.json()) as MediaSourceCreateResponse
      }
      if (source.kind === 'rtmp') {
        const response = await fetcher(`${baseUrl}/media-sources/rtmp`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            match_id: matchId,
            source_label: source.label || undefined,
          }),
        })
        if (!response.ok) throw await responseError(response)
        return (await response.json()) as MediaSourceCreateResponse
      }
      const body = new FormData()
      body.append('match_id', matchId)
      if (source.label) body.append('source_label', source.label)
      body.append('file', source.file, source.file.name)
      const response = await fetcher(`${baseUrl}/media-sources/upload`, {
        method: 'POST',
        credentials: 'include',
        body,
      })
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as MediaSourceCreateResponse
    },
    async rtmpCredentials(captureSessionId: string): Promise<RtmpSourceCredentials> {
      const response = await fetcher(
        `${baseUrl}/media-sources/rtmp/${encodeURIComponent(captureSessionId)}`,
        { credentials: 'include' },
      )
      if (!response.ok) throw await responseError(response)
      const body = (await response.json()) as { rtmp?: RtmpSourceCredentials }
      if (!body.rtmp) throw new Error('RTMP 來源憑證不存在')
      return body.rtmp
    },
    async youtubeAuthStatus(): Promise<YoutubeAuthStatus> {
      const response = await fetcher(`${baseUrl}/media-sources/youtube-auth/status`, {
        credentials: 'include',
      })
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as YoutubeAuthStatus
    },
    async refreshYoutubeAuth(): Promise<YoutubeAuthStatus> {
      const response = await fetcher(`${baseUrl}/media-sources/youtube-auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as YoutubeAuthStatus
    },
    async youtubeSourceAuth(captureSessionId: string): Promise<YoutubeSourceAuthMetadata> {
      const response = await fetcher(
        `${baseUrl}/media-sources/youtube/${encodeURIComponent(captureSessionId)}/auth`,
        { credentials: 'include' },
      )
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as YoutubeSourceAuthMetadata
    },
    async retryYoutubeSource(captureSessionId: string): Promise<{ attempt: number }> {
      const response = await fetcher(
        `${baseUrl}/media-sources/youtube/${encodeURIComponent(captureSessionId)}/retry`,
        { method: 'POST', credentials: 'include' },
      )
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as { attempt: number }
    },
    async forceReloadYoutubeSource(captureSessionId: string): Promise<{ attempt: number }> {
      // The existing retry primitive already guarantees a fresh browser-cookie
      // read and resolver run. Keep one server-side retry path so the worker's
      // checkpoint and idempotency rules remain unchanged.
      const response = await fetcher(
        `${baseUrl}/media-sources/youtube/${encodeURIComponent(captureSessionId)}/retry`,
        { method: 'POST', credentials: 'include' },
      )
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as { attempt: number }
    },
    async retryMediaSource(
      captureSessionId: string,
    ): Promise<{ attempt: number; source_kind?: string }> {
      const response = await fetcher(
        `${baseUrl}/media-sources/${encodeURIComponent(captureSessionId)}/retry`,
        { method: 'POST', credentials: 'include' },
      )
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as { attempt: number; source_kind?: string }
    },
    async clearMediaSource(captureSessionId: string): Promise<{ cleared: boolean }> {
      const response = await fetcher(
        `${baseUrl}/media-sources/${encodeURIComponent(captureSessionId)}`,
        { method: 'DELETE', credentials: 'include' },
      )
      if (!response.ok) throw await responseError(response)
      return (await response.json()) as { cleared: boolean }
    },
  }
}
