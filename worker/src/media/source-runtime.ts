import { hostname } from 'node:os'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  claimMediaSourceWork,
  claimStoppedMediaSourceWork,
  failMediaSourceWork,
  finalizeMediaSourceIfDrained,
  heartbeatMediaSourceWork,
  mediaSourceWorkStates,
  recordMediaSourceClassification,
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
  promise: Promise<void>
  stopRequested: boolean
  work: ClaimedMediaSourceWork
}

export type MediaSourceRuntimeOptions = {
  concurrency?: number
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

export class MediaSourceRuntime {
  readonly #active = new Map<string, ActiveSource>()
  readonly #owner: string
  #timer: ReturnType<typeof setInterval> | undefined
  #tickPromise: Promise<void> | undefined
  #stopping = false

  constructor(private readonly options: MediaSourceRuntimeOptions) {
    this.#owner = options.owner ?? `${hostname()}:${process.pid}`
  }

  get snapshot() {
    return {
      active: this.#active.size,
      owner: this.#owner,
      runningCaptureIds: [...this.#active.values()].map(value => value.work.captureSessionId),
    }
  }

  async start(): Promise<void> {
    this.#stopping = false
    await this.tick()
    this.#timer = setInterval(() => void this.tick().catch(error => {
      this.options.log?.(`media-source scheduler tick failed: ${errorCode(error)}`)
    }), this.options.pollIntervalMs ?? 250)
  }

  async tick(): Promise<void> {
    if (this.#stopping) return
    if (this.#tickPromise) return this.#tickPromise
    this.#tickPromise = this.#tick().finally(() => { this.#tickPromise = undefined })
    return this.#tickPromise
  }

  async #tick(): Promise<void> {
    const activeIds = [...this.#active.keys()]
    if (activeIds.length > 0) {
      const states = await mediaSourceWorkStates(this.options.database, activeIds)
      for (const [id, active] of this.#active) {
        const state = states.get(id)
        if (!['RUNNING', 'DRAINING'].includes(state ?? '') && !active.controller.signal.aborted) {
          active.stopRequested = state === 'STOP_REQUESTED' || state === undefined
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

    let available = (this.options.concurrency ?? 2) - this.#active.size
    if (available <= 0) return
    const stopped = await claimStoppedMediaSourceWork(
      this.options.database,
      this.#owner,
      available,
      this.options.leaseSeconds ?? 30,
    )
    for (const work of stopped) this.#launchStopped(work)
    available = (this.options.concurrency ?? 2) - this.#active.size
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
      promise: Promise.resolve(),
      stopRequested: false,
      work,
    }
    active.promise = (work.status === 'DRAINING' ? this.#drain(work) : this.#run(active))
      .finally(() => this.#active.delete(work.id))
    this.#active.set(work.id, active)
  }

  #launchStopped(work: ClaimedMediaSourceWork): void {
    const controller = new AbortController()
    const active: ActiveSource = {
      controller,
      promise: Promise.resolve(),
      stopRequested: true,
      work,
    }
    active.promise = this.#completeStopped(work).finally(() => this.#active.delete(work.id))
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
      },
      resumed: segmentIndex => recordMediaSourceResume(this.options.database, work.id, segmentIndex),
    }
    try {
      const completion = await this.options.run(work, observer, active.controller.signal)
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
      if (work.attempts < (this.options.maxAttempts ?? 5)) {
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.max(0, work.attempts - 1))
        await retryMediaSourceWork(this.options.database, work.id, code, delayMs)
      }
      else await failMediaSourceWork(this.options.database, work.id, code)
    }
  }

  async #complete(work: ClaimedMediaSourceWork, completion: SourceCompletion): Promise<void> {
    await requestMediaSourceCompletion(this.options.database, work.id, completion)
    await this.#drain(work)
  }

  async #drain(work: ClaimedMediaSourceWork): Promise<void> {
    while (!this.#stopping) {
      if (await finalizeMediaSourceIfDrained(this.options.database, work.id)) return
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    await releaseMediaSourceLease(this.options.database, work.id)
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
