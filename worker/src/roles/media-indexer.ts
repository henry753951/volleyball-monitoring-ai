import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  PgBoss,
  type JobResult,
  type JobWithMetadata,
  type QueueResult,
} from 'pg-boss'
import {
  MEDIA_INDEXER_HOOK_PATH,
  MEDIA_INGEST_QUEUE,
  MediaIndexerHookEvent,
  MediaIngestEnvelope,
  constantTimeToken,
  enqueueUnique,
  scanSpool,
  type IngestQueue,
} from '../media/indexer-runtime.js'

export {
  MEDIA_INDEXER_HOOK_PATH,
  MEDIA_INGEST_QUEUE,
  MediaIngestEnvelope,
  canonicalCandidate,
  constantTimeToken,
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
    await sendDeadLetter(job.id, {
      ...job.data,
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
            (id, data) => boss.send(deadLetter, data, { id }),
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
  hookPort?: number
  hookBind?: string
  hookToken?: string
  hookPath?: string
  log?: (message: string) => void
}

type HookResponse = {
  statusCode: number
  end(body?: string): void
}

export class MediaIndexerRuntime {
  #timer: ReturnType<typeof setInterval> | undefined
  #scanPromise: Promise<void> | undefined
  #server: Server | undefined
  #stopped = false

  constructor(private readonly options: MediaIndexerOptions) {}

  async scan(): Promise<void> {
    if (this.#stopped) return
    if (this.#scanPromise) return this.#scanPromise
    this.#scanPromise = scanSpool(
      this.options.spoolRoot,
      this.options.resolveCapture,
    ).then(async (items) => {
      for (const item of items) await enqueueUnique(this.options.queue, item)
      this.options.log?.(`media-indexer scan enqueued=${items.length}`)
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
    }, this.options.intervalMs ?? 10_000)

    if (this.options.hookPort && this.options.hookToken) {
      this.#server = createServer((request, response) => {
        void this.handleHook(request, response).catch(() => {
          if (!response.headersSent) {
            response.statusCode = 500
            response.end('request failed')
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        this.#server!.once('error', reject)
        this.#server!.listen(
          this.options.hookPort,
          this.options.hookBind ?? '127.0.0.1',
          resolve,
        )
      })
    }
  }

  async handleHook(request: IncomingMessage, response: HookResponse): Promise<void> {
    if (request.url !== (this.options.hookPath ?? MEDIA_INDEXER_HOOK_PATH)) {
      response.statusCode = 404
      response.end('not found')
      return
    }
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.end('method not allowed')
      return
    }
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      response.statusCode = 415
      response.end('unsupported media type')
      return
    }
    const authorization = request.headers.authorization
    const token = typeof authorization === 'string'
      && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : ''
    if (!constantTimeToken(this.options.hookToken ?? '', token)) {
      response.statusCode = 401
      response.end('unauthorized')
      return
    }

    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (!Number.isSafeInteger(declaredLength) || declaredLength > 16_384) {
      response.statusCode = 413
      response.end('payload too large')
      return
    }

    const body = await new Promise<Buffer | null>((resolve) => {
      let bytes = 0
      let settled = false
      const chunks: Buffer[] = []
      const settle = (value: Buffer | null) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      request.on('data', (chunk) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += value.byteLength
        if (bytes > 16_384) settle(null)
        else chunks.push(value)
      })
      request.once('end', () => settle(bytes <= 16_384 ? Buffer.concat(chunks) : null))
      request.once('aborted', () => settle(null))
      request.once('error', () => settle(null))
    })
    if (!body) {
      response.statusCode = 413
      response.end('payload too large')
      return
    }

    try {
      MediaIndexerHookEvent.parse(JSON.parse(body.toString('utf8')))
    } catch {
      response.statusCode = 400
      response.end('invalid hook event')
      return
    }

    response.statusCode = 202
    response.end('accepted')
    void this.scan().catch(() => {
      this.options.log?.('media-indexer hook scan failed')
    })
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#scanPromise) await this.#scanPromise
    if (this.#server) {
      await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    }
    this.#timer = undefined
    this.#server = undefined
  }
}
