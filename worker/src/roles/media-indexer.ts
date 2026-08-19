import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { PgBoss, type JobResult, type JobWithMetadata, type QueueResult } from 'pg-boss'
import {
  MEDIA_INGEST_QUEUE,
  MediaIngestEnvelope,
  enqueueUnique,
  recordingInfoCandidates,
  scanActiveCaptureDirectory,
  scanSpool,
  scanSpoolCandidate,
  type ActiveCaptureDirectory,
  type IngestQueue,
} from '../media/indexer-runtime.js'

export {
  MEDIA_INGEST_QUEUE,
  MediaIngestEnvelope,
  canonicalCandidate,
  createEnvelope,
  enqueueUnique,
  epochCandidateId,
  recordingInfoCandidates,
  scanActiveCaptureDirectory,
  scanSpool,
  scanSpoolCandidate,
  sourceOrderFromCandidate,
  sourceOrderFromRestartMarker,
} from '../media/indexer-runtime.js'

const RETENTION_SECONDS = 1_209_600
const DELETE_AFTER_SECONDS = 604_800
const LOCAL_INGEST_CONCURRENCY = 4

export const mediaIngestQueueOptions = Object.freeze({
  policy: 'key_strict_fifo' as const,
  partition: true,
  retryLimit: 5,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 300,
  heartbeatSeconds: 60,
  retentionSeconds: RETENTION_SECONDS,
  deleteAfterSeconds: DELETE_AFTER_SECONDS,
  deadLetter: `${MEDIA_INGEST_QUEUE}.dead-letter`,
  notify: true,
})

export type PermanentMediaIngestCode = 'INVALID_JOB' | 'PERMANENT_FAILURE'

export type PermanentMediaIngestFailure = {
  sourceJobId: string
  captureSessionId: string
  code: string
}

export type RecordPermanentMediaIngestFailure = (
  failure: PermanentMediaIngestFailure,
) => Promise<void>

const DETERMINISTIC_REPOSITORY_CODES = new Set([
  'INVALID_INPUT',
  'SESSION_NOT_FOUND',
  'SESSION_TERMINAL',
  'PROGRAM_CONFLICT',
  'ARTIFACT_CONFLICT',
  'EXPECTATIONS_REQUIRED',
  'REVISION_EXHAUSTED',
])

const DETERMINISTIC_ARTIFACT_CODES = new Set([
  'INVALID_CONFIG',
  'INPUT_TOO_LARGE',
  'OUTPUT_TOO_LARGE',
  'INVALID_BOX',
  'INVALID_LAYOUT',
])

export class PermanentMediaIngestError extends Error {
  readonly permanent = true

  constructor(public readonly code: PermanentMediaIngestCode) {
    super('Media ingest job cannot be processed.')
    this.name = 'PermanentMediaIngestError'
  }
}

export function assertJobSingleton(
  job: Pick<JobWithMetadata<MediaIngestEnvelope>, 'singletonKey' | 'data'>,
): MediaIngestEnvelope {
  let envelope: MediaIngestEnvelope
  try {
    envelope = MediaIngestEnvelope.parse(job.data)
  } catch {
    throw new PermanentMediaIngestError('INVALID_JOB')
  }
  if (job.singletonKey !== envelope.captureSessionId) {
    throw new PermanentMediaIngestError('INVALID_JOB')
  }
  return envelope
}

function permanentCode(error: unknown): PermanentMediaIngestCode | null {
  if (error instanceof PermanentMediaIngestError) return error.code
  if (
    error instanceof Error &&
    'permanent' in error &&
    (error as { permanent?: unknown }).permanent === true
  )
    return 'PERMANENT_FAILURE'
  if (
    error instanceof Error &&
    error.name === 'Fmp4ArtifactSourceError' &&
    'code' in error &&
    DETERMINISTIC_ARTIFACT_CODES.has(String((error as { code?: unknown }).code))
  )
    return 'PERMANENT_FAILURE'
  if (
    error instanceof Error &&
    error.name === 'PrismaIngestRepositoryError' &&
    'code' in error &&
    DETERMINISTIC_REPOSITORY_CODES.has(String((error as { code?: unknown }).code))
  )
    return 'PERMANENT_FAILURE'
  return null
}

function safeCauseCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  const raw = String((error as { code?: unknown }).code ?? '')
  const safe = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 120)
  return safe || undefined
}

function shouldRetryFinalizedMedia(
  error: unknown,
  job: JobWithMetadata<MediaIngestEnvelope>,
): boolean {
  return (
    error instanceof Error &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === true &&
    job.retryCount < job.retryLimit
  )
}

type PermanentMediaIngestOutput = {
  code?: PermanentMediaIngestCode
  causeCode?: string
}

export async function processMediaIngestJobs(
  jobs: JobWithMetadata<MediaIngestEnvelope>[],
  processJob: (envelope: MediaIngestEnvelope, signal: AbortSignal) => Promise<void>,
): Promise<JobResult<PermanentMediaIngestOutput>[]> {
  const job = jobs[0]
  if (!job) return []
  try {
    const envelope = assertJobSingleton(job)
    await processJob(envelope, job.signal)
    return [{ id: job.id, status: 'completed' }]
  } catch (error) {
    const code = permanentCode(error)
    if (code) {
      // A recorder file can look structurally incomplete while its final bytes
      // are still becoming visible on a shared volume. Retry those probe
      // failures with the queue's bounded backoff before treating them as
      // terminal; a genuinely corrupt file still fails closed at the limit.
      if (shouldRetryFinalizedMedia(error, job)) throw error
      const causeCode = safeCauseCode(error)
      return [
        {
          id: job.id,
          status: 'deadletter',
          output: { code, ...(causeCode && causeCode !== code ? { causeCode } : {}) },
        },
      ]
    }
    throw error
  }
}

type PermanentMediaIngestResult = JobResult<PermanentMediaIngestOutput>

type QuarantineSuccessors = (captureSessionId: string) => Promise<void>

export async function quarantinePermanentMediaFailures(
  jobs: Pick<JobWithMetadata<MediaIngestEnvelope>, 'id' | 'data'>[],
  results: PermanentMediaIngestResult[],
  sendDeadLetter: (id: string, data: Record<string, unknown>) => Promise<unknown>,
  recordFailure: RecordPermanentMediaIngestFailure,
  quarantineSuccessors: QuarantineSuccessors = async () => undefined,
): Promise<PermanentMediaIngestResult[]> {
  const jobsById = new Map(jobs.map(job => [job.id, job]))
  return Promise.all(
    results.map(async result => {
      if (result.status !== 'deadletter') return result
      const job = jobsById.get(result.id)
      if (!job) throw new Error('Permanent media ingest result has no matching job.')
      const parsed = MediaIngestEnvelope.safeParse(job.data)
      await sendDeadLetter(job.id, {
        ...(parsed.success ? parsed.data : {}),
        permanentFailure: result.output ?? { code: 'PERMANENT_FAILURE' },
        sourceJobId: job.id,
        sourceQueue: MEDIA_INGEST_QUEUE,
      })
      if (parsed.success) {
        await recordFailure({
          captureSessionId: parsed.data.captureSessionId,
          code: result.output?.causeCode ?? result.output?.code ?? 'PERMANENT_FAILURE',
          sourceJobId: job.id,
        })
        await quarantineSuccessors(parsed.data.captureSessionId)
      }
      // Preserve the terminal failure in key_strict_fifo, but cancel queued
      // successors for this key. Leaving them in CREATED makes pg-boss select
      // the oldest quarantined successor repeatedly; activating it conflicts
      // with the failed-key sentinel and can starve unrelated capture keys.
      return result
    }),
  )
}

type QuarantineBoss = Pick<PgBoss, 'cancel' | 'findJobs'>

export async function quarantineBlockedCaptureJobs(
  boss: QuarantineBoss,
  captureSessionId: string,
): Promise<number> {
  const queued = await boss.findJobs<MediaIngestEnvelope>(MEDIA_INGEST_QUEUE, {
    key: captureSessionId,
    queued: true,
  })
  if (queued.length === 0) return 0
  await boss.cancel(
    MEDIA_INGEST_QUEUE,
    queued.map(job => job.id),
  )
  return queued.length
}

export async function quarantineFailedIngestGroups(boss: QuarantineBoss): Promise<number> {
  const jobs = await boss.findJobs<MediaIngestEnvelope>(MEDIA_INGEST_QUEUE)
  const failedCaptureIds = new Set(
    jobs
      .filter(job => job.state === 'failed' && job.singletonKey)
      .map(job => job.singletonKey as string),
  )
  let cancelled = 0
  for (const captureSessionId of failedCaptureIds) {
    cancelled += await quarantineBlockedCaptureJobs(boss, captureSessionId)
  }
  return cancelled
}

function failureFromDeadLetter(value: unknown): PermanentMediaIngestFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const parsed = MediaIngestEnvelope.safeParse({
    schemaVersion: data.schemaVersion,
    jobType: data.jobType,
    captureSessionId: data.captureSessionId,
    candidate: data.candidate,
    sourceOrder: data.sourceOrder,
    epochCandidateId: data.epochCandidateId,
    sourceRestart: data.sourceRestart,
    timestampDiscontinuity: data.timestampDiscontinuity,
    explicitGapBeforeUs: data.explicitGapBeforeUs,
  })
  const failure = data.permanentFailure
  const code =
    failure && typeof failure === 'object' && !Array.isArray(failure)
      ? (failure as Record<string, unknown>).code
      : null
  const causeCode =
    failure && typeof failure === 'object' && !Array.isArray(failure)
      ? (failure as Record<string, unknown>).causeCode
      : null
  if (
    !parsed.success ||
    data.sourceJobId !== parsed.data.epochCandidateId ||
    !['INVALID_JOB', 'PERMANENT_FAILURE'].includes(String(code))
  )
    return null
  return {
    captureSessionId: parsed.data.captureSessionId,
    code:
      typeof causeCode === 'string' && /^[A-Z0-9_]{1,120}$/.test(causeCode)
        ? causeCode
        : (code as PermanentMediaIngestCode),
    sourceJobId: parsed.data.epochCandidateId,
  }
}

type DeadLetterBoss = Pick<PgBoss, 'findJobs'>

export async function reconcilePermanentMediaFailures(
  boss: DeadLetterBoss,
  deadLetter: string,
  recordFailure: RecordPermanentMediaIngestFailure,
  quarantineSuccessors: QuarantineSuccessors = async () => undefined,
): Promise<number> {
  const jobs = await boss.findJobs<Record<string, unknown>>(deadLetter)
  const captureSessionIds = new Set<string>()
  let recorded = 0
  for (const job of jobs) {
    const failure = failureFromDeadLetter(job.data)
    if (!failure) continue
    await recordFailure(failure)
    captureSessionIds.add(failure.captureSessionId)
    recorded += 1
  }
  for (const captureSessionId of captureSessionIds) {
    await quarantineSuccessors(captureSessionId)
  }
  return recorded
}

type IngestGroupBoss = Pick<PgBoss, 'findJobs' | 'update'>

export async function assignQueuedIngestGroups(boss: IngestGroupBoss): Promise<number> {
  const queued = await boss.findJobs<MediaIngestEnvelope>(MEDIA_INGEST_QUEUE, {
    queued: true,
  })
  const keys = new Set(
    queued
      .filter(job => job.singletonKey && job.groupId !== job.singletonKey)
      .map(job => job.singletonKey as string),
  )

  let updated = 0
  for (const key of keys) {
    const result = await boss.update(MEDIA_INGEST_QUEUE, undefined, {
      singletonKey: key,
      match: 'all',
      group: { id: key },
    })
    updated += result.updated
  }
  return updated
}

function queueMatches(persisted: QueueResult): boolean {
  return (
    persisted.policy === mediaIngestQueueOptions.policy &&
    persisted.partition === mediaIngestQueueOptions.partition &&
    persisted.retryLimit === mediaIngestQueueOptions.retryLimit &&
    persisted.retryDelay === mediaIngestQueueOptions.retryDelay &&
    persisted.retryBackoff === mediaIngestQueueOptions.retryBackoff &&
    persisted.retryDelayMax === mediaIngestQueueOptions.retryDelayMax &&
    persisted.expireInSeconds === mediaIngestQueueOptions.expireInSeconds &&
    persisted.heartbeatSeconds === mediaIngestQueueOptions.heartbeatSeconds &&
    persisted.retentionSeconds === mediaIngestQueueOptions.retentionSeconds &&
    persisted.deleteAfterSeconds === mediaIngestQueueOptions.deleteAfterSeconds &&
    persisted.deadLetter === mediaIngestQueueOptions.deadLetter &&
    persisted.notify === mediaIngestQueueOptions.notify
  )
}

export type PgBossMediaRuntime = {
  boss: PgBoss
  start(): Promise<void>
  stop(): Promise<void>
  send(envelope: MediaIngestEnvelope): Promise<string | null>
}

export function createPgBossMediaRuntime(
  connectionString: string,
  processJob: (envelope: MediaIngestEnvelope, signal: AbortSignal) => Promise<void>,
  recordFailure: RecordPermanentMediaIngestFailure = async () => undefined,
): PgBossMediaRuntime {
  const boss = new PgBoss({ connectionString, max: 4, useListenNotify: true })
  const deadLetter = mediaIngestQueueOptions.deadLetter

  return {
    boss,
    async start() {
      await boss.start()
      try {
        await boss.createQueue(deadLetter, {
          retryLimit: 0,
          retentionSeconds: RETENTION_SECONDS,
          deleteAfterSeconds: DELETE_AFTER_SECONDS,
        })
        await boss.createQueue(MEDIA_INGEST_QUEUE, mediaIngestQueueOptions)
        const persisted = await boss.getQueue(MEDIA_INGEST_QUEUE)
        if (!persisted || !queueMatches(persisted)) {
          throw new Error('Media ingest queue configuration conflicts with runtime policy.')
        }
        await reconcilePermanentMediaFailures(
          boss,
          deadLetter,
          recordFailure,
          async captureSessionId => {
            await quarantineBlockedCaptureJobs(boss, captureSessionId)
          },
        )
        await quarantineFailedIngestGroups(boss)
        await assignQueuedIngestGroups(boss)

        const workOptions = {
          batchSize: 1,
          // Keep one active job per capture group so a capture's segments stay
          // FIFO; localConcurrency still lets independent capture groups drain
          // in parallel once their group IDs are assigned.
          localConcurrency: LOCAL_INGEST_CONCURRENCY,
          groupConcurrency: 1,
          includeMetadata: true,
          orderByCreatedOn: true,
          heartbeatRefreshSeconds: 20,
          // A strict-FIFO key only exposes its next segment after the current
          // job commits. LISTEN/NOTIFY does not reliably wake that transition,
          // so multi-second polling turns into a fixed delay per segment.
          // Keep the fallback sub-second while retaining one worker per
          // capture; this improves long VOD drain without reordering media.
          pollingIntervalSeconds: 0.5,
          // A completed strict-FIFO job does not emit a fresh queue NOTIFY for
          // the successor it unblocks. Use pg-boss's supported minimum here so
          // long VOD drains do not pay a full idle second between segments.
          notifyPollingIntervalSeconds: 0.5,
          perJobResults: true,
        } as const
        await boss.work<
          MediaIngestEnvelope,
          JobResult<PermanentMediaIngestOutput>[],
          typeof workOptions
        >(MEDIA_INGEST_QUEUE, workOptions, async jobs =>
          quarantinePermanentMediaFailures(
            jobs,
            await processMediaIngestJobs(jobs, processJob),
            (id, data) => boss.send(deadLetter, data, { singletonKey: id }),
            recordFailure,
            async captureSessionId => {
              await quarantineBlockedCaptureJobs(boss, captureSessionId)
            },
          ),
        )
      } catch (error) {
        await boss.stop({ graceful: true }).catch(() => undefined)
        throw error
      }
    },
    async stop() {
      await boss.stop({ graceful: true })
    },
    async send(envelopeValue) {
      const envelope = MediaIngestEnvelope.parse(envelopeValue)
      return boss.send(MEDIA_INGEST_QUEUE, envelope, {
        singletonKey: envelope.captureSessionId,
        group: { id: envelope.captureSessionId },
        id: envelope.epochCandidateId,
      })
    },
  }
}

export type MediaIndexerOptions = {
  spoolRoot: string
  queue: IngestQueue
  resolveCapture: (ingestPath: string) => Promise<string | null>
  intervalMs?: number
  activePollIntervalMs?: number
  listActiveCaptures?: () => Promise<ActiveCaptureDirectory[]>
  watchSpool?: (
    root: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => Pick<FSWatcher, 'close' | 'on'>
  log?: (message: string) => void
}

const FAST_SCAN_DELAYS_MS = [0, 300, 850] as const

export function isIndexerMediaEvent(filename: string): boolean {
  return ['.mp4', '.m4s', '.fmp4'].includes(extname(filename).toLowerCase())
}

export function isIndexerRecordingInfoEvent(filename: string): boolean {
  return filename.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() === 'recording.xml'
}

export class MediaIndexerRuntime {
  #timer: ReturnType<typeof setInterval> | undefined
  #activeTimer: ReturnType<typeof setInterval> | undefined
  #activeScanPromise: Promise<void> | undefined
  #scanPromise: Promise<void> | undefined
  #observations = new Map<string, { mtimeMs: number; size: number; stable: number }>()
  #enqueued = new Set<string>()
  #enqueueing = new Set<string>()
  #fastScanTimers = new Set<ReturnType<typeof setTimeout>>()
  #watcher: Pick<FSWatcher, 'close' | 'on'> | undefined
  #stopped = false
  #failedCount = 0
  #lastErrorAt: string | null = null
  #lastErrorName: string | null = null
  #lastHeartbeatAt: string | null = null
  #lastSuccessAt: string | null = null

  constructor(private readonly options: MediaIndexerOptions) {}

  get snapshot() {
    return {
      candidates: this.#observations.size,
      failedCount: this.#failedCount,
      lastErrorAt: this.#lastErrorAt,
      lastErrorName: this.#lastErrorName,
      lastHeartbeatAt: this.#lastHeartbeatAt,
      lastSuccessAt: this.#lastSuccessAt,
      running: !this.#stopped,
      watching: this.#watcher !== undefined,
    }
  }

  async #observe(item: MediaIngestEnvelope): Promise<boolean> {
    if (this.#enqueued.has(item.candidate) || this.#enqueueing.has(item.candidate)) return false
    const metadata = await stat(join(this.options.spoolRoot, item.candidate))
    const prior = this.#observations.get(item.candidate)
    const stable =
      prior && prior.size === metadata.size && prior.mtimeMs === metadata.mtimeMs
        ? prior.stable + 1
        : 0
    this.#observations.set(item.candidate, {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      stable,
    })
    if (stable < 2 || Date.now() - metadata.mtimeMs < 500) return false
    if (this.#enqueued.has(item.candidate) || this.#enqueueing.has(item.candidate)) return false
    this.#enqueueing.add(item.candidate)
    try {
      await enqueueUnique(this.options.queue, item)
      this.#enqueued.add(item.candidate)
      return true
    } finally {
      this.#enqueueing.delete(item.candidate)
    }
  }

  #trackFailure(error: unknown): void {
    this.#failedCount += 1
    this.#lastErrorAt = new Date().toISOString()
    this.#lastErrorName = error instanceof Error ? error.name : 'UnknownError'
  }

  async scan(): Promise<void> {
    if (this.#stopped) return
    if (this.#scanPromise) return this.#scanPromise
    this.#lastHeartbeatAt = new Date().toISOString()
    this.#scanPromise = scanSpool(this.options.spoolRoot, this.options.resolveCapture)
      .then(async items => {
        const present = new Set(items.map(item => item.candidate))
        let enqueued = 0
        for (const item of items) {
          // Require two unchanged scans even for atomically renamed source
          // extents. Event-driven bursts make a finalized file eligible in
          // roughly 0.85 s; reconciliation keeps the same fail-closed rule.
          if (await this.#observe(item)) enqueued += 1
        }
        for (const candidate of this.#observations.keys()) {
          if (!present.has(candidate)) this.#observations.delete(candidate)
        }
        this.options.log?.(`media-indexer scan enqueued=${enqueued}`)
        this.#lastSuccessAt = new Date().toISOString()
      })
      .catch(error => {
        this.#trackFailure(error)
        throw error
      })
      .finally(() => {
        this.#scanPromise = undefined
      })
    return this.#scanPromise
  }

  async #scanCandidate(candidate: string): Promise<void> {
    if (this.#stopped || this.#enqueued.has(candidate)) return
    const item = await scanSpoolCandidate(
      this.options.spoolRoot,
      candidate,
      this.options.resolveCapture,
    )
    if (!item) return
    if (await this.#observe(item)) {
      this.options.log?.(`media-indexer event enqueued candidate=${item.candidate}`)
      this.#lastSuccessAt = new Date().toISOString()
    }
  }

  async scanActiveCaptures(): Promise<void> {
    if (this.#stopped || !this.options.listActiveCaptures) return
    if (this.#activeScanPromise) return this.#activeScanPromise
    this.#lastHeartbeatAt = new Date().toISOString()
    this.#activeScanPromise = this.options
      .listActiveCaptures()
      .then(async captures => {
        let enqueued = 0
        for (const capture of captures) {
          const items = await scanActiveCaptureDirectory(this.options.spoolRoot, capture)
          for (const item of items) if (await this.#observe(item)) enqueued += 1
        }
        if (enqueued > 0) this.options.log?.(`media-indexer active poll enqueued=${enqueued}`)
        this.#lastSuccessAt = new Date().toISOString()
      })
      .catch(error => {
        this.#trackFailure(error)
        throw error
      })
      .finally(() => {
        this.#activeScanPromise = undefined
      })
    return this.#activeScanPromise
  }

  #schedule(operation: () => Promise<void>, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#fastScanTimers.delete(timer)
      if (this.#stopped) return
      void operation().catch(error => {
        this.#trackFailure(error)
        this.options.log?.(`media-indexer event scan failed: ${this.#lastErrorName}`)
      })
    }, delayMs)
    this.#fastScanTimers.add(timer)
  }

  #scheduleCandidateBurst(candidate: string): void {
    for (const delay of FAST_SCAN_DELAYS_MS)
      this.#schedule(() => this.#scanCandidate(candidate), delay)
  }

  #scheduleReconciliationBurst(): void {
    for (const delay of FAST_SCAN_DELAYS_MS) this.#schedule(() => this.scan(), delay)
  }

  #handleWatchEvent(filename: string | null): void {
    if (!filename) {
      this.#scheduleReconciliationBurst()
      return
    }
    const normalized = filename.replaceAll('\\', '/')
    if (isIndexerMediaEvent(normalized)) {
      this.#scheduleCandidateBurst(normalized)
      return
    }
    if (isIndexerRecordingInfoEvent(normalized)) {
      this.#schedule(async () => {
        const candidates = await recordingInfoCandidates(this.options.spoolRoot, normalized)
        for (const candidate of candidates) this.#scheduleCandidateBurst(candidate)
      }, 100)
    }
  }

  #startWatcher(): void {
    try {
      const createWatcher =
        this.options.watchSpool ??
        ((root: string, listener: (eventType: string, filename: string | null) => void) =>
          watch(root, { recursive: true, encoding: 'utf8' }, listener))
      this.#watcher = createWatcher(this.options.spoolRoot, (_eventType, filename) =>
        this.#handleWatchEvent(filename),
      )
      this.#watcher.on('error', error => {
        this.#trackFailure(error)
        this.options.log?.(`media-indexer watch degraded: ${this.#lastErrorName}`)
        this.#watcher?.close()
        this.#watcher = undefined
      })
    } catch (error) {
      this.#trackFailure(error)
      this.options.log?.(`media-indexer watch unavailable; reconciliation remains active`)
    }
  }

  async start(): Promise<void> {
    this.#stopped = false
    this.#startWatcher()
    this.#scheduleReconciliationBurst()
    await this.scan()
    if (this.options.listActiveCaptures) {
      await this.scanActiveCaptures()
      this.#activeTimer = setInterval(() => {
        void this.scanActiveCaptures().catch(() => {
          this.options.log?.('media-indexer active capture poll failed')
        })
      }, this.options.activePollIntervalMs ?? 500)
    }
    this.#timer = setInterval(() => {
      this.#scheduleReconciliationBurst()
    }, this.options.intervalMs ?? 30_000)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#activeTimer) clearInterval(this.#activeTimer)
    if (this.#scanPromise) await this.#scanPromise
    if (this.#activeScanPromise) await this.#activeScanPromise
    this.#watcher?.close()
    for (const timer of this.#fastScanTimers) clearTimeout(timer)
    this.#timer = undefined
    this.#activeTimer = undefined
    this.#watcher = undefined
    this.#fastScanTimers.clear()
    this.#observations.clear()
    this.#enqueued.clear()
    this.#enqueueing.clear()
  }
}
