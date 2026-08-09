import type { WorkerRole } from './worker-role.js'
import { createServer } from 'node:http'

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
  const unhealthy = components.some(component => component.critical && component.status === 'unhealthy')
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
}) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
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
    stop: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
