import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PgBoss,
  type JobResult,
  type JobWithMetadata,
  type QueueResult,
} from 'pg-boss'
import {
  MEDIA_INGEST_QUEUE,
  MediaIngestEnvelope,
  enqueueUnique,
  scanSpool,
  type IngestQueue,
} from '../media/indexer-runtime.js'

export {
  MEDIA_INGEST_QUEUE,
  MediaIngestEnvelope,
  canonicalCandidate,
  createEnvelope,
  enqueueUnique,
  epochCandidateId,
  scanSpool,
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

const DETERMINISTIC_REPOSITORY_CODES = new Set([
  'INVALID_INPUT',
  'SESSION_NOT_FOUND',
  'SESSION_TERMINAL',
  'PROGRAM_CONFLICT',
  'RESERVATION_CONFLICT',
  'TIMELINE_CONFLICT',
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
    error instanceof Error
    && 'permanent' in error
    && (error as { permanent?: unknown }).permanent === true
  ) return 'PERMANENT_FAILURE'
  if (
    error instanceof Error
    && error.name === 'Fmp4ArtifactSourceError'
    && 'code' in error
    && DETERMINISTIC_ARTIFACT_CODES.has(
      String((error as { code?: unknown }).code),
    )
  ) return 'PERMANENT_FAILURE'
  if (
    error instanceof Error
    && error.name === 'PrismaIngestRepositoryError'
    && 'code' in error
    && DETERMINISTIC_REPOSITORY_CODES.has(
      String((error as { code?: unknown }).code),
    )
  ) return 'PERMANENT_FAILURE'
  return null
}

export async function processMediaIngestJobs(
  jobs: JobWithMetadata<MediaIngestEnvelope>[],
  processJob: (
    envelope: MediaIngestEnvelope,
    signal: AbortSignal,
  ) => Promise<void>,
): Promise<JobResult<{ code?: PermanentMediaIngestCode }>[]> {
  const job = jobs[0]
  if (!job) return []
  try {
    const envelope = assertJobSingleton(job)
    await processJob(envelope, job.signal)
    return [{ id: job.id, status: 'completed' }]
  } catch (error) {
    const code = permanentCode(error)
    if (code) {
      return [{ id: job.id, status: 'deadletter', output: { code } }]
    }
    throw error
  }
}

type PermanentMediaIngestResult = JobResult<{
  code?: PermanentMediaIngestCode
}>

export async function quarantinePermanentMediaFailures(
  jobs: Pick<JobWithMetadata<MediaIngestEnvelope>, 'id' | 'data'>[],
  results: PermanentMediaIngestResult[],
  sendDeadLetter: (
    id: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<PermanentMediaIngestResult[]> {
  const jobsById = new Map(jobs.map(job => [job.id, job]))
  return Promise.all(results.map(async (result) => {
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
    // key_strict_fifo intentionally blocks a key while its source job is in
    // failed state. The quarantined copy is the durable audit record, while
    // completing the source job lets independent captures and later valid
    // segments continue instead of creating a global head-of-line stall.
    return { ...result, status: 'completed' as const }
  }))
}

async function releaseQuarantinedFailures(
  boss: PgBoss,
  deadLetter: string,
): Promise<void> {
  const blockedKeys = await boss.getBlockedKeys(MEDIA_INGEST_QUEUE)
  for (const key of blockedKeys) {
    const jobs = await boss.findJobs<MediaIngestEnvelope>(MEDIA_INGEST_QUEUE, { key })
    for (const job of jobs) {
      if (job.state !== 'failed') continue
      const quarantined = await boss.findJobs(deadLetter, { data: job.data })
      if (quarantined.length > 0) {
        // pg-boss cannot cancel a terminal failed job. Its quarantined copy
        // is already durable, so removing only the source sentinel releases
        // the strict-FIFO key without losing the failure audit.
        await boss.deleteJob(MEDIA_INGEST_QUEUE, job.id)
      }
    }
  }
}

type IngestGroupBoss = Pick<PgBoss, 'findJobs' | 'update'>

export async function assignQueuedIngestGroups(
  boss: IngestGroupBoss,
): Promise<number> {
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
  return persisted.policy === mediaIngestQueueOptions.policy
    && persisted.partition === mediaIngestQueueOptions.partition
    && persisted.retryLimit === mediaIngestQueueOptions.retryLimit
    && persisted.retryDelay === mediaIngestQueueOptions.retryDelay
    && persisted.retryBackoff === mediaIngestQueueOptions.retryBackoff
    && persisted.retryDelayMax === mediaIngestQueueOptions.retryDelayMax
    && persisted.expireInSeconds === mediaIngestQueueOptions.expireInSeconds
    && persisted.heartbeatSeconds === mediaIngestQueueOptions.heartbeatSeconds
    && persisted.retentionSeconds === mediaIngestQueueOptions.retentionSeconds
    && persisted.deleteAfterSeconds === mediaIngestQueueOptions.deleteAfterSeconds
    && persisted.deadLetter === mediaIngestQueueOptions.deadLetter
    && persisted.notify === mediaIngestQueueOptions.notify
}

export type PgBossMediaRuntime = {
  boss: PgBoss
  start(): Promise<void>
  stop(): Promise<void>
  send(envelope: MediaIngestEnvelope): Promise<string | null>
}

export function createPgBossMediaRuntime(
  connectionString: string,
  processJob: (
    envelope: MediaIngestEnvelope,
    signal: AbortSignal,
  ) => Promise<void>,
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
        await releaseQuarantinedFailures(boss, deadLetter)
        await assignQueuedIngestGroups(boss)

        const workOptions = {
          batchSize: 1,
          // key_strict_fifo serializes each capture key in PostgreSQL. Multiple
          // local workers may therefore drain independent captures in parallel
          // without reordering segments within a capture.
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
          notifyPollingIntervalSeconds: 1,
          perJobResults: true,
        } as const
        await boss.work<
          MediaIngestEnvelope,
          JobResult<{ code?: PermanentMediaIngestCode }>[],
          typeof workOptions
        >(
          MEDIA_INGEST_QUEUE,
          workOptions,
          async (jobs) => quarantinePermanentMediaFailures(
            jobs,
            await processMediaIngestJobs(jobs, processJob),
            (id, data) => boss.send(deadLetter, data, { singletonKey: id }),
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
  log?: (message: string) => void
}

export class MediaIndexerRuntime {
  #timer: ReturnType<typeof setInterval> | undefined
  #scanPromise: Promise<void> | undefined
  #observations = new Map<string, { mtimeMs: number; size: number; stable: number }>()
  #stopped = false

  constructor(private readonly options: MediaIndexerOptions) {}

  async scan(): Promise<void> {
    if (this.#stopped) return
    if (this.#scanPromise) return this.#scanPromise
    this.#scanPromise = scanSpool(
      this.options.spoolRoot,
      this.options.resolveCapture,
    ).then(async (items) => {
      const present = new Set(items.map(item => item.candidate))
      let enqueued = 0
      for (const item of items) {
        const metadata = await stat(join(this.options.spoolRoot, item.candidate))
        const prior = this.#observations.get(item.candidate)
        const stable = prior && prior.size === metadata.size && prior.mtimeMs === metadata.mtimeMs
          ? prior.stable + 1
          : 0
        this.#observations.set(item.candidate, { mtimeMs: metadata.mtimeMs, size: metadata.size, stable })
        if (stable < 1 || Date.now() - metadata.mtimeMs < 500) continue
        await enqueueUnique(this.options.queue, item)
        enqueued += 1
      }
      for (const candidate of this.#observations.keys()) {
        if (!present.has(candidate)) this.#observations.delete(candidate)
      }
      this.options.log?.(`media-indexer scan enqueued=${enqueued}`)
    }).finally(() => {
      this.#scanPromise = undefined
    })
    return this.#scanPromise
  }

  async start(): Promise<void> {
    this.#stopped = false
    await this.scan()
    this.#timer = setInterval(() => {
      void this.scan().catch(() => {
        this.options.log?.('media-indexer periodic scan failed')
      })
    }, this.options.intervalMs ?? 1_000)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#scanPromise) await this.#scanPromise
    this.#timer = undefined
    this.#observations.clear()
  }
}
