import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  omeMasterPlaylistUrl,
  parseOmePresentationObservation,
  parseOmeVideoPlaylistUrl,
  type OmePresentationObservation,
} from './ome-live-presentation.js'
import { writeSourceRestartMarker } from './source-process.js'

type OmeMonitorOptions = {
  apiToken: string
  apiUrl: string
  database: PrismaClient
  intervalMs?: number
  llhlsBaseUrl: string
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
      status: this.#lastError ? ('degraded' as const) : ('healthy' as const),
    }
  }

  async start(): Promise<void> {
    this.#stopped = false
    await this.poll()
    this.#timer = setInterval(
      () => void this.poll().catch(() => undefined),
      this.options.intervalMs ?? 1_000,
    )
  }

  async poll(): Promise<void> {
    if (this.#stopped) return
    if (this.#pollPromise) return this.#pollPromise
    this.#pollPromise = this.#poll().finally(() => {
      this.#pollPromise = undefined
    })
    return this.#pollPromise
  }

  async #poll(): Promise<void> {
    try {
      if (this.options.apiToken.length < 32) throw new Error('OME_API_ACCESS_TOKEN is invalid')
      const authorization = Buffer.from(this.options.apiToken).toString('base64')
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.apiUrl.replace(/\/+$/, '')}/v1/vhosts/default/apps/app/streams`,
        {
          headers: { authorization: `Basic ${authorization}` },
          signal: AbortSignal.timeout(5_000),
        },
      )
      if (!response.ok) throw new Error(`OME_HTTP_${response.status}`)
      const payload = (await response.json()) as { response?: unknown }
      const streams = new Set(
        Array.isArray(payload.response)
          ? payload.response.filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            )
          : [],
      )
      const captures = await this.options.database.captureSession.findMany({
        select: {
          id: true,
          ingestPath: true,
          sourceOnline: true,
          startedAt: true,
          status: true,
        },
        where: {
          sourceKind: { notIn: ['local_mp4', 'youtube_vod'] },
          status: { in: ['STARTING', 'LIVE', 'STOPPING'] },
        },
      })
      const observedAt = new Date()
      for (const capture of captures) {
        const online = streams.has(capture.ingestPath)
        const promoteToLive = online && capture.status === 'STARTING'
        if (capture.sourceOnline && !online) {
          await writeSourceRestartMarker(this.options.recordingRoot, capture.ingestPath)
          await this.options.database.livePresentationAnchor.updateMany({
            data: { endedAt: observedAt },
            where: { captureSessionId: capture.id, endedAt: null },
          })
        }
        if (online !== capture.sourceOnline || promoteToLive) {
          await this.options.database.captureSession.update({
            data: {
              health: online ? 'HEALTHY' : 'OFFLINE',
              sourceObservedAt: observedAt,
              sourceOnline: online,
              ...(promoteToLive
                ? {
                    // OME readiness is the Live media-plane readiness signal.
                    // Durable FILE finalization/cataloguing must not delay
                    // direct LL-HLS playback by one recording extent.
                    startedAt: capture.startedAt ?? observedAt,
                    status: 'LIVE' as const,
                  }
                : {}),
            },
            where: { id: capture.id },
          })
        }
        if (online) {
          const observation = await this.#observePresentation(capture.ingestPath)
          if (observation) await this.#persistPresentation(capture.id, observation, observedAt)
        }
      }
      this.#lastError = null
      this.#lastErrorAt = null
      this.#lastSuccessAt = observedAt
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message.slice(0, 120) : 'OME_MONITOR_FAILED'
      this.#lastErrorAt = new Date()
      this.options.log?.(`ome monitor degraded: ${this.#lastError}`)
      throw error
    }
  }

  async #observePresentation(ingestPath: string): Promise<OmePresentationObservation | null> {
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch
      const masterUrl = omeMasterPlaylistUrl(this.options.llhlsBaseUrl, ingestPath)
      const masterResponse = await fetchImpl(masterUrl, { signal: AbortSignal.timeout(3_000) })
      if (masterResponse.status === 404) return null
      if (!masterResponse.ok) throw new Error(`OME_LLHLS_MASTER_HTTP_${masterResponse.status}`)
      const playlistUrl = parseOmeVideoPlaylistUrl(await masterResponse.text(), masterUrl)
      const playlistResponse = await fetchImpl(playlistUrl, { signal: AbortSignal.timeout(3_000) })
      if (playlistResponse.status === 404) return null
      if (!playlistResponse.ok)
        throw new Error(`OME_LLHLS_PLAYLIST_HTTP_${playlistResponse.status}`)
      return parseOmePresentationObservation(await playlistResponse.text(), playlistUrl)
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 120) : 'OME_LLHLS_ANCHOR_FAILED'
      this.options.log?.(`ome presentation observation skipped: ${message}`)
      return null
    }
  }

  async #persistPresentation(
    captureSessionId: string,
    observation: OmePresentationObservation,
    observedAt: Date,
  ): Promise<void> {
    await this.options.database.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ome-presentation:${captureSessionId}`}, 0))::text AS lock`
      const existing = await tx.livePresentationAnchor.findUnique({
        where: {
          captureSessionId_streamInstanceId_programDateTime: {
            captureSessionId,
            programDateTime: observation.programDateTime,
            streamInstanceId: observation.streamInstanceId,
          },
        },
      })
      await tx.livePresentationAnchor.updateMany({
        data: { endedAt: observedAt },
        where: {
          captureSessionId,
          endedAt: null,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
      })
      if (existing) {
        if (existing.endedAt)
          await tx.livePresentationAnchor.update({
            data: { endedAt: null },
            where: { id: existing.id },
          })
        return
      }
      const previous = await tx.livePresentationAnchor.findFirst({
        orderBy: { sequenceIndex: 'desc' },
        select: { sequenceIndex: true },
        where: { captureSessionId },
      })
      await tx.livePresentationAnchor.create({
        data: {
          captureSessionId,
          firstMediaSequence: observation.firstMediaSequence,
          observedAt,
          programDateTime: observation.programDateTime,
          sequenceIndex: (previous?.sequenceIndex ?? -1) + 1,
          streamInstanceId: observation.streamInstanceId,
        },
      })
    })
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#pollPromise) await this.#pollPromise.catch(() => undefined)
    this.#timer = undefined
  }
}
