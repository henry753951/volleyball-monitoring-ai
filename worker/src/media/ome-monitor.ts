import type { PrismaClient } from '@volleyball-monitoring/db'
import { writeSourceRestartMarker } from './source-process.js'

type OmeMonitorOptions = {
  apiToken: string
  apiUrl: string
  database: PrismaClient
  intervalMs?: number
  recordingRoot: string
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

export class OmeMonitorRuntime {
  #lastError: string | null = null
  #lastErrorAt: Date | null = null
  #lastSuccessAt: Date | null = null
  #timer: ReturnType<typeof setInterval> | undefined
  #pollPromise: Promise<void> | undefined
  #stopped = false

  constructor(private readonly options: OmeMonitorOptions) {}

  get snapshot() {
    return {
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt?.toISOString() ?? null,
      lastSuccessAt: this.#lastSuccessAt?.toISOString() ?? null,
      status: this.#lastError ? 'degraded' as const : 'healthy' as const,
    }
  }

  async start(): Promise<void> {
    this.#stopped = false
    await this.poll()
    this.#timer = setInterval(() => void this.poll().catch(() => undefined), this.options.intervalMs ?? 1_000)
  }

  async poll(): Promise<void> {
    if (this.#stopped) return
    if (this.#pollPromise) return this.#pollPromise
    this.#pollPromise = this.#poll().finally(() => { this.#pollPromise = undefined })
    return this.#pollPromise
  }

  async #poll(): Promise<void> {
    try {
      if (this.options.apiToken.length < 32) throw new Error('OME_API_ACCESS_TOKEN is invalid')
      const authorization = Buffer.from(this.options.apiToken).toString('base64')
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.apiUrl.replace(/\/+$/, '')}/v1/vhosts/default/apps/app/streams`,
        { headers: { authorization: `Basic ${authorization}` }, signal: AbortSignal.timeout(5_000) },
      )
      if (!response.ok) throw new Error(`OME_HTTP_${response.status}`)
      const payload = await response.json() as { response?: unknown }
      const streams = new Set(Array.isArray(payload.response)
        ? payload.response.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [])
      const captures = await this.options.database.captureSession.findMany({
        select: { id: true, ingestPath: true, sourceOnline: true },
        where: {
          sourceKind: { notIn: ['local_mp4', 'youtube_vod'] },
          status: { in: ['STARTING', 'LIVE', 'STOPPING'] },
        },
      })
      const observedAt = new Date()
      for (const capture of captures) {
        const online = streams.has(capture.ingestPath)
        if (capture.sourceOnline && !online) {
          await writeSourceRestartMarker(this.options.recordingRoot, capture.ingestPath)
        }
        if (online !== capture.sourceOnline) {
          await this.options.database.captureSession.update({
            data: {
              health: online ? 'HEALTHY' : 'OFFLINE',
              sourceObservedAt: observedAt,
              sourceOnline: online,
            },
            where: { id: capture.id },
          })
        }
      }
      this.#lastError = null
      this.#lastErrorAt = null
      this.#lastSuccessAt = observedAt
    }
    catch (error) {
      this.#lastError = error instanceof Error ? error.message.slice(0, 120) : 'OME_MONITOR_FAILED'
      this.#lastErrorAt = new Date()
      this.options.log?.(`ome monitor degraded: ${this.#lastError}`)
      throw error
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#pollPromise) await this.#pollPromise.catch(() => undefined)
    this.#timer = undefined
  }
}
