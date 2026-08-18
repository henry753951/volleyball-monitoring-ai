import type { WorkerRole } from './worker-role.js'
import { createServer } from 'node:http'
import type { YoutubeAuthStatus } from './media/youtube-auth.js'

export type WorkerComponentStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface WorkerComponentHealth {
  name: string
  critical: boolean
  status: WorkerComponentStatus
  activeWork: number
  failedJobs: number
  backlog: number | null
  lastHeartbeatAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorName: string | null
}

export interface WorkerHealthDocument {
  role: WorkerRole
  status: WorkerComponentStatus
  generatedAt: string
  components: WorkerComponentHealth[]
}

export function createWorkerHealthDocument(
  role: WorkerRole,
  components: WorkerComponentHealth[],
): WorkerHealthDocument {
  const unhealthy = components.some(
    component => component.critical && component.status === 'unhealthy',
  )
  const degraded = components.some(component => component.status !== 'healthy')
  return {
    role,
    status: unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy',
    generatedAt: new Date().toISOString(),
    components,
  }
}

export async function startWorkerHealthServer(options: {
  role: WorkerRole
  port: number
  snapshot: () => WorkerComponentHealth[]
  youtubeAuth?: {
    status: YoutubeAuthStatus
    snapshot(): Promise<Pick<YoutubeAuthStatus, 'revision' | 'profileUpdatedAt' | 'lastReadAt'>>
    refresh(): Promise<YoutubeAuthStatus>
  }
  youtubeAuthToken?: string
}) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    const authPath =
      request.url === '/internal/youtube-auth/status' ||
      request.url === '/internal/youtube-auth/refresh'
    if (authPath) {
      const expected = options.youtubeAuthToken ?? process.env.YOUTUBE_AUTH_PROBE_TOKEN
      if (expected && request.headers['x-youtube-auth-token'] !== expected) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!options.youtubeAuth) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'youtube_auth_unavailable' }))
        return
      }
      void (async () => {
        const value =
          request.url === '/internal/youtube-auth/refresh'
            ? await options.youtubeAuth!.refresh()
            : { ...options.youtubeAuth!.status, ...(await options.youtubeAuth!.snapshot()) }
        response.statusCode = 200
        response.end(JSON.stringify(value))
      })().catch(error => {
        response.statusCode = 502
        response.end(
          JSON.stringify({
            error: 'youtube_auth_probe_failed',
            message: String(error).slice(-240),
          }),
        )
      })
      return
    }
    if (request.url === '/health/live') {
      response.statusCode = 200
      response.end(JSON.stringify({ role: options.role, status: 'ok' }))
      return
    }
    if (request.url === '/health/ready') {
      const document = createWorkerHealthDocument(options.role, options.snapshot())
      response.statusCode = document.status === 'unhealthy' ? 503 : 200
      response.end(JSON.stringify(document))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not_found' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      }),
  }
}
