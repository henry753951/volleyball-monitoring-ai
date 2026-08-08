export type ProvisionedMediaSource = {
  captureSessionId: string
  ingestPath: string
  sourceKind: 'youtube' | 'local_mp4'
  sourceUrl?: string
  importPath?: string
}

export interface MediaSourceGateway {
  start(source: ProvisionedMediaSource): Promise<void>
  stop(captureSessionId: string): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function boundedError(response: Response): Promise<string> {
  const message = (await response.text()).slice(0, 512).trim()
  return message || `HTTP ${response.status}`
}

export function createHttpMediaSourceGateway(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): MediaSourceGateway {
  const endpoint = baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(endpoint)) throw new TypeError('MEDIA_SOURCE_GATEWAY_URL must be an HTTP URL')
  if (token.length < 32) throw new TypeError('MEDIA_SOURCE_GATEWAY_TOKEN must contain at least 32 characters')

  const request = async (path: string, init: RequestInit) => {
    const signal = AbortSignal.timeout(15_000)
    const response = await fetchImpl(`${endpoint}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) throw new Error(`Media source gateway rejected the request: ${await boundedError(response)}`)
  }

  return {
    async start(source) {
      if (!UUID.test(source.captureSessionId)) throw new TypeError('Invalid capture session id')
      await request('/v1/sources', { method: 'POST', body: JSON.stringify({
        capture_session_id: source.captureSessionId,
        import_path: source.importPath,
        ingest_path: source.ingestPath,
        source_kind: source.sourceKind,
        source_url: source.sourceUrl,
      }) })
    },
    async stop(captureSessionId) {
      if (!UUID.test(captureSessionId)) throw new TypeError('Invalid capture session id')
      await request(`/v1/sources/${captureSessionId}`, { method: 'DELETE' })
    },
  }
}

export function createMediaSourceGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): MediaSourceGateway | null {
  const baseUrl = env.MEDIA_SOURCE_GATEWAY_URL?.trim()
  const token = env.MEDIA_SOURCE_GATEWAY_TOKEN?.trim()
  if (!baseUrl && !token) return null
  if (!baseUrl || !token) throw new TypeError('MEDIA_SOURCE_GATEWAY_URL and MEDIA_SOURCE_GATEWAY_TOKEN must be configured together')
  return createHttpMediaSourceGateway(baseUrl, token)
}
