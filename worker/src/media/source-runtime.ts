import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  claimDrainingMediaSourceWork,
  claimMediaSourceWork,
  claimStoppedMediaSourceWork,
  failMediaSourceWork,
  finalizeMediaSourceIfDrained,
  heartbeatMediaSourceWork,
  listCompletedMediaSpoolCandidates,
  mediaSourceWorkStates,
  recordMediaSourceClassification,
  recordMediaSourceRelayError,
  recordMediaSourceRelayHealthy,
  recordMediaSourceResume,
  releaseMediaSourceLease,
  requestMediaSourceCompletion,
  retryMediaSourceWork,
  type ClaimedMediaSourceWork,
  type SourceCompletion,
} from './source-work.js'
import { countMediaSourceRecordings, type MediaSourceProcessObserver } from './source-process.js'

export type MediaSourceRunner = (
  work: ClaimedMediaSourceWork,
  observer: MediaSourceProcessObserver,
  signal: AbortSignal,
) => Promise<SourceCompletion>

type ActiveSource = {
  controller: AbortController
  phase: 'source' | 'draining'
  promise: Promise<void>
  relayErrorAt: string | null
  relayErrorName: string | null
  retryBudgetReset: boolean
  stopRequested: boolean
  work: ClaimedMediaSourceWork
}

export type MediaSourceRuntimeOptions = {
  concurrency?: number
  drainConcurrency?: number
  database: PrismaClient
  leaseSeconds?: number
  maxAttempts?: number
  owner?: string
  pollIntervalMs?: number
  recordingRoot: string
  run: MediaSourceRunner
  log?: (message: string) => void
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name.toUpperCase() : 'MEDIA_SOURCE_FAILED'
}

export function completedMediaSpoolPath(recordingRoot: string, ingestPath: string): string {
  const root = resolve(recordingRoot)
  const target = resolve(root, ingestPath)
  if (!ingestPath || ingestPath === '.' || dirname(target) !== root) {
    throw new Error('completed media spool path is outside the recording root')
  }
  return target
}

export async function cleanupCompletedMediaSpools(
  database: PrismaClient,
  recordingRoot: string,
  options: {
    load?: typeof listCompletedMediaSpoolCandidates
    remove?: (path: string) => Promise<void>
  } = {},
): Promise<number> {
  const candidates = await (options.load ?? listCompletedMediaSpoolCandidates)(database)
  const remove = options.remove ?? (path => rm(path, { force: true, recursive: true }))
  for (const candidate of candidates) {
    await remove(completedMediaSpoolPath(recordingRoot, candidate.ingestPath))
  }
  return candidates.length
}

export function mediaSourceRetryDelay(code: string, attempts: number, maxAttempts: number): number | null {
  if (code === 'YOUTUBE_UPCOMING') return 30_000
  if (attempts >= maxAttempts) return null
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1))
}

export class MediaSourceRuntime {
  readonly #active = new Map<string, ActiveSource>()
  readonly #owner: string
  #timer: ReturnType<typeof setInterval> | undefined
  #tickPromise: Promise<void> | undefined
  #stopping = false
  #lastHeartbeatAt: string | null = null
  #lastSuccessAt: string | null = null
  #lastErrorAt: string | null = null
  #lastErrorName: string | null = null
  #failedCount = 0

  constructor(private readonly options: MediaSourceRuntimeOptions) {
    this.#owner = options.owner ?? `${hostname()}:${process.pid}`
  }

  get snapshot() {
    const relayErrors = [...this.#active.values()]
      .filter(active => active.relayErrorAt && active.relayErrorName)
      .sort((left, right) => (right.relayErrorAt ?? '').localeCompare(left.relayErrorAt ?? ''))
    const latestRelayError = relayErrors[0]
    return {
      active: this.#active.size,
      activeFailureCount: relayErrors.length,
      activeLastErrorAt: latestRelayError?.relayErrorAt ?? null,
      activeLastErrorName: latestRelayError?.relayErrorName ?? null,
      failedCount: this.#failedCount,
      lastErrorAt: this.#lastErrorAt,
      lastErrorName: this.#lastErrorName,
      lastHeartbeatAt: this.#lastHeartbeatAt,
      lastSuccessAt: this.#lastSuccessAt,
      owner: this.#owner,
      runningCaptureIds: [...this.#active.values()].map(value => value.work.captureSessionId),
    }
  }

  async start(): Promise<void> {
    this.#stopping = false
    await this.#cleanupCompletedSpools()
    await this.tick()
    this.#timer = setInterval(() => void this.tick().catch(error => {
      this.options.log?.(`media-source scheduler tick failed: ${errorCode(error)}`)
    }), this.options.pollIntervalMs ?? 250)
  }

  async tick(): Promise<void> {
    if (this.#stopping) return
    if (this.#tickPromise) return this.#tickPromise
    this.#lastHeartbeatAt = new Date().toISOString()
    this.#tickPromise = this.#tick()
      .then(() => { this.#lastSuccessAt = new Date().toISOString() })
      .catch((error) => {
        this.#failedCount += 1
        this.#lastErrorAt = new Date().toISOString()
        this.#lastErrorName = errorCode(error)
        throw error
      })
      .finally(() => { this.#tickPromise = undefined })
    return this.#tickPromise
  }

  async #tick(): Promise<void> {
    const activeIds = [...this.#active.keys()]
    if (activeIds.length > 0) {
      const states = await mediaSourceWorkStates(this.options.database, activeIds)
      for (const [id, active] of this.#active) {
        const state = states.get(id)
        if (state?.sourceOnline && (!active.retryBudgetReset || active.relayErrorName)) {
          active.relayErrorAt = null
          active.relayErrorName = null
          active.retryBudgetReset = true
          active.work.attempts = 0
          await recordMediaSourceRelayHealthy(this.options.database, id, this.#owner)
        }
        if (!['RUNNING', 'DRAINING'].includes(state?.status ?? '') && !active.controller.signal.aborted) {
          active.stopRequested = state?.status === 'STOP_REQUESTED' || state === undefined
          active.controller.abort()
        }
      }
      await heartbeatMediaSourceWork(
        this.options.database,
        this.#owner,
        activeIds,
        this.options.leaseSeconds ?? 30,
      )
    }

    const draining = [...this.#active.values()].filter(active => active.phase === 'draining').length
    const drainAvailable = (this.options.drainConcurrency ?? 16) - draining
    if (drainAvailable > 0) {
      const claimedDraining = await claimDrainingMediaSourceWork(
        this.options.database,
        this.#owner,
        drainAvailable,
        this.options.leaseSeconds ?? 30,
      )
      for (const work of claimedDraining) this.#launchDraining(work)
    }

    const running = [...this.#active.values()].filter(active => active.phase === 'source').length
    let available = (this.options.concurrency ?? 2) - running
    if (available <= 0) return
    const stopped = await claimStoppedMediaSourceWork(
      this.options.database,
      this.#owner,
      available,
      this.options.leaseSeconds ?? 30,
    )
    for (const work of stopped) this.#launchStopped(work)
    available = (this.options.concurrency ?? 2)
      - [...this.#active.values()].filter(active => active.phase === 'source').length
    if (available <= 0) return
    const claimed = await claimMediaSourceWork(
      this.options.database,
      this.#owner,
      available,
      this.options.leaseSeconds ?? 30,
    )
    for (const work of claimed) this.#launch(work)
  }

  #launch(work: ClaimedMediaSourceWork): void {
    const controller = new AbortController()
    const active: ActiveSource = {
      controller,
      phase: 'source',
      promise: Promise.resolve(),
      relayErrorAt: null,
      relayErrorName: null,
      retryBudgetReset: false,
      stopRequested: false,
      work,
    }
    active.promise = this.#run(active)
      .finally(() => this.#active.delete(work.id))
    this.#active.set(work.id, active)
  }

  #launchStopped(work: ClaimedMediaSourceWork): void {
    const controller = new AbortController()
    const active: ActiveSource = {
      controller,
      phase: 'draining',
      promise: Promise.resolve(),
      relayErrorAt: null,
      relayErrorName: null,
      retryBudgetReset: false,
      stopRequested: true,
      work,
    }
    active.promise = this.#completeStopped(work).finally(() => this.#active.delete(work.id))
    this.#active.set(work.id, active)
  }

  #launchDraining(work: ClaimedMediaSourceWork): void {
    const active: ActiveSource = {
      controller: new AbortController(),
      phase: 'draining',
      promise: Promise.resolve(),
      relayErrorAt: null,
      relayErrorName: null,
      retryBudgetReset: false,
      stopRequested: false,
      work,
    }
    active.promise = this.#drain(work).finally(() => this.#active.delete(work.id))
    this.#active.set(work.id, active)
  }

  async #completeStopped(work: ClaimedMediaSourceWork): Promise<void> {
    const expectedSegments = await countMediaSourceRecordings(this.options.recordingRoot, work.ingestPath)
    const sourceKind = ['youtube', 'youtube_live', 'youtube_vod', 'local_mp4'].includes(work.captureSourceKind ?? '')
      ? work.captureSourceKind as SourceCompletion['sourceKind']
      : work.sourceKind
    await this.#complete(work, {
      expectedSegments,
      sourceDurationUs: work.captureSourceDurationUs ?? null,
      sourceKind,
    })
  }

  async #run(active: ActiveSource): Promise<void> {
    const { work } = active
    const state: { classification: Pick<SourceCompletion, 'sourceDurationUs' | 'sourceKind'> | null } = { classification: null }
    const observer: MediaSourceProcessObserver = {
      classified: async value => {
        state.classification = value
        await recordMediaSourceClassification(this.options.database, work.captureSessionId, value)
        this.options.log?.(`media-source classified capture=${work.captureSessionId} kind=${value.sourceKind}`)
      },
      retrying: async code => {
        active.relayErrorAt = new Date().toISOString()
        active.relayErrorName = code
        active.retryBudgetReset = false
        await recordMediaSourceRelayError(this.options.database, work.id, this.#owner, code)
        this.options.log?.(`media-source live relay retry capture=${work.captureSessionId} code=${code}`)
      },
      resumed: (segmentIndex, captureTimeUs) => recordMediaSourceResume(this.options.database, work.id, segmentIndex, captureTimeUs),
    }
    try {
      const completion = await this.options.run(work, observer, active.controller.signal)
      active.phase = 'draining'
      await this.#complete(work, completion)
    }
    catch (error) {
      if (active.controller.signal.aborted) {
        if (active.stopRequested) {
          const expectedSegments = await countMediaSourceRecordings(this.options.recordingRoot, work.ingestPath)
          await this.#complete(work, {
            expectedSegments,
            sourceDurationUs: state.classification?.sourceDurationUs ?? null,
            sourceKind: state.classification?.sourceKind ?? work.sourceKind,
          })
        }
        else {
          await retryMediaSourceWork(this.options.database, work.id, 'WORKER_STOPPED', 0)
        }
        return
      }
      const code = errorCode(error)
      const delayMs = mediaSourceRetryDelay(code, work.attempts, this.options.maxAttempts ?? 5)
      if (delayMs !== null) {
        this.options.log?.(`media-source retry capture=${work.captureSessionId} code=${code} delay_ms=${delayMs}`)
        await retryMediaSourceWork(this.options.database, work.id, code, delayMs)
      }
      else {
        this.options.log?.(`media-source failed capture=${work.captureSessionId} code=${code}`)
        await failMediaSourceWork(this.options.database, work.id, code)
      }
    }
  }

  async #complete(work: ClaimedMediaSourceWork, completion: SourceCompletion): Promise<void> {
    await requestMediaSourceCompletion(this.options.database, work.id, completion)
    this.options.log?.(`media-source draining capture=${work.captureSessionId} expected_segments=${completion.expectedSegments}`)
    await this.#drain(work)
  }

  async #drain(work: ClaimedMediaSourceWork): Promise<void> {
    while (!this.#stopping) {
      if (await finalizeMediaSourceIfDrained(this.options.database, work.id)) {
        await this.#cleanupCompletedSpools()
        return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    await releaseMediaSourceLease(this.options.database, work.id)
  }

  async #cleanupCompletedSpools(): Promise<void> {
    try {
      const removed = await cleanupCompletedMediaSpools(
        this.options.database,
        this.options.recordingRoot,
      )
      if (removed > 0) this.options.log?.(`media-source cleaned completed spools=${removed}`)
    }
    catch (error) {
      this.options.log?.(`media-source completed spool cleanup failed: ${errorCode(error)}`)
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#tickPromise) await this.#tickPromise
    for (const active of this.#active.values()) active.controller.abort()
    await Promise.allSettled([...this.#active.values()].map(active => active.promise))
    this.#timer = undefined
  }
}
