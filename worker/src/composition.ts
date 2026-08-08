import { mediaIndexerConfig } from './media/runtime-config.js'
import { createPgBossMediaRuntime, MediaIndexerRuntime } from './roles/media-indexer.js'
import { createMinioMediaObjectStore } from './media/minio-object-store.js'
import { FinalizedFileArtifactSource } from './media/fmp4-artifact-source.js'
import { PrismaIngestRepository } from './media/prisma-ingest-repository.js'
import { ingestEnvelope } from './media/ingest-handler.js'
import { resolveCaptureSession, resolveProgramProfile } from './media/resolvers.js'

export interface MediaIndexerLifecyclePorts {
  queue: { start(): Promise<void>; stop(): Promise<void> }
  scanner: { start(): Promise<void>; stop(): Promise<void> }
  disconnect(): Promise<void>
}

type LifecycleState = 'new' | 'started' | 'stopped'

async function runCleanup(
  steps: Array<() => Promise<void>>,
): Promise<unknown[]> {
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

export async function createMediaIndexerComposition() {
  const config = mediaIndexerConfig()
  const { db } = await import('@volleyball-monitoring/db')
  const repository = new PrismaIngestRepository(db)
  const endpoint = new URL(config.MINIO_ENDPOINT)
  const store = createMinioMediaObjectStore({ endpointUrl: config.MINIO_ENDPOINT, useTls: endpoint.protocol === 'https:', accessKey: config.MINIO_ACCESS_KEY, secretKey: config.MINIO_SECRET_KEY, bucket: config.MINIO_DVR_BUCKET, operationTimeoutMs: 30_000 })
  const source = new FinalizedFileArtifactSource({ maxInputBytes: 8_000_000_000n, maxInitBytes: 64_000_000n, maxMediaBytes: 8_000_000_000n, readTimeoutMs: 30_000 })
  const processJob = async (envelope: import('./media/indexer-runtime.js').MediaIngestEnvelope, signal: AbortSignal) => ingestEnvelope(envelope, { spoolRoot: config.MEDIA_SPOOL_DIR, bucket: config.MINIO_DVR_BUCKET, repository, store, source, profile: async (captureSessionId, observed) => resolveProgramProfile(db, captureSessionId, observed) }, signal)
  const queue = createPgBossMediaRuntime(config.DATABASE_URL, processJob)
  const scanner = new MediaIndexerRuntime({ spoolRoot: config.MEDIA_SPOOL_DIR, queue: { send: (_name, payload) => queue.send(payload) }, resolveCapture: (path) => resolveCaptureSession(db, path), intervalMs: config.MEDIA_INDEXER_SCAN_INTERVAL_MS, hookPort: config.MEDIA_INDEXER_HOOK_PORT, hookBind: config.MEDIA_INDEXER_HOOK_BIND, hookToken: config.MEDIA_INDEXER_HOOK_TOKEN })
  return createMediaIndexerLifecycle({ queue, scanner, disconnect: () => db.$disconnect() })
}
