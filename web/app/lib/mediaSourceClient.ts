import type { CreateMatchSetupInput } from './coreDomain'

export type MatchMediaSourceDraft =
  | { kind: 'youtube'; label: string; url: string }
  | { kind: 'local_mp4'; label: string; file: File }
  | { kind: 'later' }

export interface CreateMatchWithMediaInput {
  match: CreateMatchSetupInput
  media: MatchMediaSourceDraft
}

export interface MediaSourceClientOptions {
  baseUrl?: string
  fetcher?: typeof fetch
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
    async create(matchId: string, source: MatchMediaSourceDraft) {
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
        return response.json()
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
      return response.json()
    },
  }
}
