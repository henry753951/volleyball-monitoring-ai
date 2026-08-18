import { mediaIndexerConfig } from './media/runtime-config.js'
import { createPgBossMediaRuntime, MediaIndexerRuntime } from './roles/media-indexer.js'
import { createMinioMediaObjectStore } from './media/minio-object-store.js'
import { createTieredMediaObjectStore } from './media/tiered-media-object-store.js'
import { FinalizedFileArtifactSource } from './media/fmp4-artifact-source.js'
import { PrismaIngestRepository } from './media/prisma-ingest-repository.js'
import { ingestEnvelope } from './media/ingest-handler.js'
import { resolveCaptureSession, resolveProgramProfile } from './media/resolvers.js'
import { createMediaSourceProcess } from './media/source-process.js'
import { MediaSourceRuntime } from './media/source-runtime.js'
import { recordPermanentMediaIngestFailure } from './media/source-work.js'
import { OmeMonitorRuntime } from './media/ome-monitor.js'
import type { WorkerComponentHealth } from './runtime-health.js'

export interface MediaIndexerLifecyclePorts {
  queue: { start(): Promise<void>; stop(): Promise<void> }
  scanner: { start(): Promise<void>; stop(): Promise<void> }
  disconnect(): Promise<void>
}

type LifecycleState = 'new' | 'started' | 'stopped'

async function runCleanup(steps: Array<() => Promise<void>>): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

export function createMediaIndexerLifecycle(ports: MediaIndexerLifecyclePorts) {
  let state: LifecycleState = 'new'
  let queueStarted = false

  return {
    async start(): Promise<void> {
      if (state !== 'new') throw new Error('composition already started or stopped')
      try {
        await ports.queue.start()
        queueStarted = true
        await ports.scanner.start()
        state = 'started'
      } catch (startError) {
        state = 'stopped'
        const cleanupErrors = await runCleanup([
          ...(queueStarted ? [() => ports.queue.stop()] : []),
          () => ports.disconnect(),
        ])
        queueStarted = false
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [startError, ...cleanupErrors],
            'media-indexer startup and cleanup failed',
            { cause: startError },
          )
        }
        throw startError
      }
    },

    async stop(): Promise<void> {
      if (state === 'stopped') return
      const scannerStarted = state === 'started'
      state = 'stopped'
      const cleanupErrors = await runCleanup([
        ...(scannerStarted ? [() => ports.scanner.stop()] : []),
        ...(queueStarted ? [() => ports.queue.stop()] : []),
        () => ports.disconnect(),
      ])
      queueStarted = false
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'media-indexer cleanup failed')
      }
    },
  }
}

export async function createMediaComposition() {
  const config = mediaIndexerConfig()
  const { db } = await import('@volleyball-monitoring/db')
  const repository = new PrismaIngestRepository(db, {
    liveArchiveBackend: config.LIVE_ARCHIVE_BACKEND,
  })
  const endpoint = new URL(config.MINIO_ENDPOINT)
  const archiveStore = createMinioMediaObjectStore({
    endpointUrl: config.MINIO_ENDPOINT,
    useTls: endpoint.protocol === 'https:',
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
    bucket: config.MINIO_DVR_BUCKET,
    operationTimeoutMs: 30_000,
  })
  const tieredStore = config.MEDIA_HOT_ROOT
    ? createTieredMediaObjectStore({
        root: config.MEDIA_HOT_ROOT,
        archive: archiveStore,
        archiveConcurrency: config.MEDIA_ARCHIVE_CONCURRENCY,
      })
    : null
  const store = tieredStore ?? archiveStore
  const artifactSource = new FinalizedFileArtifactSource({
    maxInputBytes: 8_000_000_000n,
    maxInitBytes: 64_000_000n,
    maxMediaBytes: 8_000_000_000n,
    readTimeoutMs: 30_000,
  })
  const processJob = async (
    envelope: import('./media/indexer-runtime.js').MediaIngestEnvelope,
    signal: AbortSignal,
  ) =>
    ingestEnvelope(
      envelope,
      {
        spoolRoot: config.MEDIA_SPOOL_DIR,
        bucket: config.MINIO_DVR_BUCKET,
        repository,
        store,
        source: artifactSource,
        profile: async (captureSessionId, observed) =>
          resolveProgramProfile(db, captureSessionId, observed),
      },
      signal,
    )
  const queue = createPgBossMediaRuntime(config.DATABASE_URL, processJob, failure =>
    recordPermanentMediaIngestFailure(db, failure),
  )
  const scanner = new MediaIndexerRuntime({
    activePollIntervalMs: config.MEDIA_INDEXER_ACTIVE_POLL_INTERVAL_MS,
    spoolRoot: config.MEDIA_SPOOL_DIR,
    queue: { send: (_name, payload) => queue.send(payload) },
    listActiveCaptures: () =>
      db.captureSession
        .findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, ingestPath: true },
          where: {
            ingestFailures: { none: {} },
            status: { in: ['STARTING', 'LIVE', 'STOPPING'] },
          },
        })
        .then(captures =>
          captures.map(capture => ({
            captureSessionId: capture.id,
            ingestPath: capture.ingestPath,
          })),
        ),
    resolveCapture: async path => {
      const captureSessionId = await resolveCaptureSession(db, path)
      if (!captureSessionId) return null
      const failure = await db.mediaIngestFailure.findFirst({
        select: { sourceJobId: true },
        where: { captureSessionId },
      })
      return failure ? null : captureSessionId
    },
    intervalMs: config.MEDIA_INDEXER_SCAN_INTERVAL_MS,
  })
  const indexer = createMediaIndexerLifecycle({ queue, scanner, disconnect: async () => undefined })
  const sources = new MediaSourceRuntime({
    concurrency: config.MEDIA_SOURCE_CONCURRENCY,
    database: db,
    pollIntervalMs: config.MEDIA_SOURCE_POLL_INTERVAL_MS,
    recordingRoot: config.MEDIA_SPOOL_DIR,
    run: createMediaSourceProcess({
      importRoot: config.MEDIA_IMPORT_ROOT,
      ingestBaseUrl: config.MEDIA_INGEST_BASE_URL,
      recordingRoot: config.MEDIA_SPOOL_DIR,
      recordingExtentSeconds: config.MEDIA_RECORDING_EXTENT_SECONDS,
      workRoot: config.MEDIA_SOURCE_WORK_ROOT,
      ...(config.YOUTUBE_COOKIES_FILE ? { youtubeCookiesFile: config.YOUTUBE_COOKIES_FILE } : {}),
      youtubeExtractorArgs: config.YOUTUBE_EXTRACTOR_ARGS,
      youtubeFormat: config.YOUTUBE_FORMAT,
      youtubeLiveExtractorArgs: config.YOUTUBE_LIVE_EXTRACTOR_ARGS,
      youtubeLiveMaxConsecutiveFailures: config.YOUTUBE_LIVE_MAX_CONSECUTIVE_FAILURES,
      ...(config.YOUTUBE_POT_PROVIDER_URL
        ? { youtubePotProviderUrl: config.YOUTUBE_POT_PROVIDER_URL }
        : {}),
      youtubeVodExtractorArgs: config.YOUTUBE_VOD_EXTRACTOR_ARGS,
      youtubeVodFormat: config.YOUTUBE_VOD_FORMAT,
      youtubeVodUseCookies: config.YOUTUBE_VOD_USE_COOKIES,
      ytDlpCommand: config.YT_DLP_COMMAND,
    }),
  })
  const ome = new OmeMonitorRuntime({
    apiToken: config.OME_API_ACCESS_TOKEN,
    apiUrl: config.OME_API_URL,
    database: db,
    llhlsBaseUrl: config.OME_LLHLS_URL,
    recordingRoot: config.MEDIA_SPOOL_DIR,
  })
  let started = false
  return {
    get snapshot() {
      return { indexer: scanner.snapshot, mediaSources: sources.snapshot, ome: ome.snapshot }
    },
    healthSnapshot(): WorkerComponentHealth[] {
      const source = sources.snapshot
      const indexerSnapshot = scanner.snapshot
      const omeSnapshot = ome.snapshot
      return [
        {
          name: 'source-scheduler',
          critical: true,
          status:
            started && source.activeFailureCount > 0
              ? 'degraded'
              : started &&
                  (!source.lastErrorAt ||
                    (source.lastSuccessAt && source.lastSuccessAt >= source.lastErrorAt))
                ? 'healthy'
                : started
                  ? 'degraded'
                  : 'unhealthy',
          activeWork: source.active,
          failedJobs: source.failedCount + source.activeFailureCount,
          backlog: null,
          lastHeartbeatAt: source.lastHeartbeatAt,
          lastSuccessAt: source.lastSuccessAt,
          lastErrorAt: source.activeLastErrorAt ?? source.lastErrorAt,
          lastErrorName: source.activeLastErrorName ?? source.lastErrorName,
        },
        {
          name: 'media-indexer',
          critical: true,
          status:
            indexerSnapshot.running &&
            (!indexerSnapshot.lastErrorAt ||
              (indexerSnapshot.lastSuccessAt &&
                indexerSnapshot.lastSuccessAt >= indexerSnapshot.lastErrorAt))
              ? 'healthy'
              : indexerSnapshot.running
                ? 'degraded'
                : 'unhealthy',
          activeWork: 0,
          failedJobs: indexerSnapshot.failedCount,
          backlog: indexerSnapshot.candidates,
          lastHeartbeatAt: indexerSnapshot.lastHeartbeatAt,
          lastSuccessAt: indexerSnapshot.lastSuccessAt,
          lastErrorAt: indexerSnapshot.lastErrorAt,
          lastErrorName: indexerSnapshot.lastErrorName,
        },
        {
          name: 'ome-monitor',
          critical: false,
          status: started ? omeSnapshot.status : 'unhealthy',
          activeWork: 0,
          failedJobs: omeSnapshot.lastError ? 1 : 0,
          backlog: null,
          lastHeartbeatAt: omeSnapshot.lastSuccessAt,
          lastSuccessAt: omeSnapshot.lastSuccessAt,
          lastErrorAt: omeSnapshot.lastErrorAt,
          lastErrorName: omeSnapshot.lastError,
        },
        ...(tieredStore
          ? [
              {
                name: 'media-archive',
                critical: false,
                status: tieredStore.snapshot.lastErrorAt
                  ? ('degraded' as const)
                  : ('healthy' as const),
                activeWork: tieredStore.snapshot.pending,
                failedJobs: tieredStore.snapshot.lastErrorAt ? 1 : 0,
                backlog: tieredStore.snapshot.pending,
                lastHeartbeatAt: tieredStore.snapshot.lastSuccessAt,
                lastSuccessAt: tieredStore.snapshot.lastSuccessAt,
                lastErrorAt: tieredStore.snapshot.lastErrorAt,
                lastErrorName: tieredStore.snapshot.lastErrorAt ? 'MediaArchiveError' : null,
              },
            ]
          : []),
      ]
    },
    async start() {
      if (started) throw new Error('media composition already started')
      try {
        await tieredStore?.start()
        await indexer.start()
        await sources.start()
        await ome.start()
        started = true
      } catch (error) {
        await Promise.allSettled([ome.stop(), sources.stop(), indexer.stop(), tieredStore?.stop()])
        await db.$disconnect()
        throw error
      }
    },
    async stop() {
      if (!started) return
      started = false
      const results = await Promise.allSettled([
        ome.stop(),
        sources.stop(),
        indexer.stop(),
        tieredStore?.stop(),
      ])
      await db.$disconnect()
      const errors = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'media composition cleanup failed')
    },
  }
}
