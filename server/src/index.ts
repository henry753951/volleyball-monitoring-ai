import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import { db } from '@volleyball-monitoring/db'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createYoga } from 'graphql-yoga'
import Redis from 'ioredis'
import { createGraphQLContext } from './graphql/context.js'
import { configureAnnotationGraphQL } from './graphql/annotation-mutations.js'
import { schema } from './graphql/schema.js'
import { evaluateReadiness, type ReadinessProbe } from './health/readiness.js'
import { createPrismaCursorWindowStore, mediaCursorRoutes } from './media/cursor-routes.js'
import { resolvePlaybackCursor } from './media/cursor-resolution.js'
import { resolveOmeLivePlaybackCursor } from './media/ome-live-cursor-resolution.js'
import {
  createDvrObjectReaderFromEnv,
  createDvrObjectStreamReaderFromEnv,
  createMinioObjectReaderFromEnv,
} from './media/minio-object-reader.js'
import { createMediaObjectRemoverFromEnv } from './media/media-object-remover.js'
import { createSampleIndexRepository } from './media/sample-index-repository.js'
import { createPersistedSampleSnapResolver } from './media/sample-snap-resolver.js'
import { mediaPlaybackRoutes } from './routes/media-playback.js'
import { providerJobCallbackRoutes } from './routes/provider-job-callback.js'
import { analysisMediaRoutesWithDependencies } from './routes/analysis-media.js'
import { coachHighlightExportRoutes } from './routes/coach-highlight-exports.js'
import { analysisReviewRoutesWithDependencies } from './routes/analysis-review.js'
import {
  collectOperationsSnapshot,
  deleteInactiveAiWorker,
  operationsRoutes,
} from './routes/operations.js'
import { createHostStorageProbe } from './operations/host-storage.js'
import { createKubernetesDeploymentProbe } from './operations/kubernetes-deployments.js'
import { createMinioStorageProbe } from './operations/minio-storage.js'
import { mediaSourceRoutes } from './routes/media-sources.js'
import { authRoutes } from './routes/auth.js'
import { createAnnotationPresenceService } from './realtime/annotation-presence.js'
import { createAnnotationSnapshotEventService } from './realtime/annotation-events.js'
import { createAiProgressService } from './realtime/ai-progress.js'
import { annotationWebSocketRoutes } from './realtime/annotation-ws.js'
import { CoachMatchEventHub, coachWebSocketRoutes } from './realtime/coach-ws.js'
import { configureCoachAnalyticsGraphQL } from './graphql/coach-analytics.js'
import { providerWorkWebSocketRoutes } from './realtime/provider-work-ws.js'
import { authenticateAnnotationRequest } from './realtime/auth.js'
import { createAnnotationCommandService } from './services/annotation-command.js'
import { getAnnotationSnapshot } from './services/annotation-snapshot.js'
import {
  createAiWorkerToken,
  deleteAiWorkerToken,
  rotateAiWorkerToken,
  setAiWorkerTokenEnabled,
} from './services/ai-worker-access.js'
import { createMatchCleanupCoordinator } from './services/match-cleanup-coordinator.js'
import { configureMediaTimelineCache } from './services/media-timeline.js'

const app = Fastify({ logger: true })
const redisUrl = process.env.REDIS_URL
const minioEndpoint = process.env.MINIO_ENDPOINT?.replace(/\/+$/, '')
const omeApiEndpoint = process.env.OME_API_URL?.replace(/\/+$/, '')
const omeApiToken = process.env.OME_API_ACCESS_TOKEN?.trim()
const mediaObjectReader = createDvrObjectReaderFromEnv()
const mediaObjectStreamReader = createDvrObjectStreamReaderFromEnv()
if (!mediaObjectReader || !mediaObjectStreamReader) {
  throw new Error('MinIO reader configuration is required for media playback and cursor resolution')
}
const timingManifestReader = createMinioObjectReaderFromEnv(process.env, 'MINIO_RALLY_BUCKET')
if (!timingManifestReader) {
  throw new Error(
    'MinIO rally artifact reader configuration is required for exact analysis coverage',
  )
}
const redis = redisUrl
  ? new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1_000, maxRetriesPerRequest: 1 })
  : null
configureMediaTimelineCache(redis)
const annotationPresence = redis
  ? createAnnotationPresenceService({
      redis,
      displayName: async userId =>
        (await db.user.findUnique({ where: { id: userId }, select: { displayName: true } }))
          ?.displayName ?? null,
    })
  : null
const aiProgress = redis ? createAiProgressService(redis) : null
const annotationEvents = redis ? createAnnotationSnapshotEventService(redis) : null
const coachMatchEvents = new CoachMatchEventHub()
configureCoachAnalyticsGraphQL(matchId =>
  coachMatchEvents.publish(matchId, 'identity_mapping_updated'),
)
const hostStorageProbe = createHostStorageProbe(
  process.env.MEDIA_RECORDING_ROOT ?? '/var/lib/volleyball/media-recordings',
)
const objectStorageProbe = createMinioStorageProbe(
  minioEndpoint ?? '',
  fetch,
  1_500,
  process.env.MINIO_METRICS_BEARER_TOKEN?.trim() ?? '',
)
const deploymentProbe = createKubernetesDeploymentProbe()
const mediaObjectRemover = createMediaObjectRemoverFromEnv()
const matchCleanupCoordinator = createMatchCleanupCoordinator(
  {
    database: db,
    importRoot: process.env.MEDIA_IMPORT_ROOT ?? '/var/lib/volleyball/media-imports',
    ...(mediaObjectRemover ? { objectRemover: mediaObjectRemover } : {}),
    recordingRoot: process.env.MEDIA_RECORDING_ROOT ?? '/var/lib/volleyball/media-recordings',
  },
  app.log,
)

const cursorDependencies = {
  now: () => new Date(),
  sampleIndexes: createSampleIndexRepository(db, mediaObjectReader),
  store: createPrismaCursorWindowStore(db),
}
const annotationCommands = createAnnotationCommandService({
  database: db,
  resolveCursor: (cursor, identity) =>
    cursor.schema_version === '2.0.0'
      ? resolveOmeLivePlaybackCursor(cursor, identity, db, cursorDependencies.sampleIndexes)
      : resolvePlaybackCursor(cursor, identity, cursorDependencies),
  timingManifestReader,
})
configureAnnotationGraphQL(annotationCommands, (matchId, reason) =>
  coachMatchEvents.publish(matchId, reason),
)

redis?.on('error', error => app.log.warn({ error }, 'Redis readiness connection error'))

const readinessProbes: ReadinessProbe[] = [
  {
    name: 'postgres',
    check: async () => {
      await db.$queryRaw`SELECT 1`
    },
  },
  {
    name: 'redis',
    check: async () => {
      if (!redis) throw new Error('REDIS_URL is required')
      if ((await redis.ping()) !== 'PONG') throw new Error('Redis did not return PONG')
    },
  },
  {
    name: 'minio',
    check: async signal => {
      if (!minioEndpoint) throw new Error('MINIO_ENDPOINT is required')
      const response = await fetch(`${minioEndpoint}/minio/health/ready`, { signal })
      if (!response.ok) throw new Error(`MinIO readiness returned ${response.status}`)
    },
  },
  {
    name: 'ovenmediaengine',
    check: async signal => {
      if (!omeApiEndpoint || !omeApiToken)
        throw new Error('OME_API_URL and OME_API_ACCESS_TOKEN are required')
      const authorization = Buffer.from(omeApiToken).toString('base64')
      const response = await fetch(`${omeApiEndpoint}/v1/vhosts/default/apps/app/streams`, {
        headers: { authorization: `Basic ${authorization}` },
        signal,
      })
      if (!response.ok) throw new Error(`OvenMediaEngine readiness returned ${response.status}`)
    },
  },
]

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true,
  credentials: true,
})
await app.register(multipart, {
  limits: {
    files: 2,
    fields: 4,
    parts: 6,
    fileSize: Number(process.env.MEDIA_UPLOAD_MAX_BYTES ?? 21_474_836_480),
  },
})
await app.register(websocket)
await app.register(providerJobCallbackRoutes({ database: db }))
await app.register(providerWorkWebSocketRoutes({ database: db }))
await app.register(authRoutes({ database: db }))
await app.register(analysisMediaRoutesWithDependencies({ timingManifestReader }))
await app.register(coachHighlightExportRoutes)
await app.register(
  analysisReviewRoutesWithDependencies({
    onChanged: matchId => coachMatchEvents.publish(matchId, 'analysis_review_updated'),
  }),
)
await app.register(
  mediaPlaybackRoutes({
    authenticate: async request => {
      const identity = await authenticateAnnotationRequest(request, db)
      return identity ? { id: identity.userId, role: identity.role } : null
    },
    objectReader: mediaObjectReader,
    objectStreamReader: mediaObjectStreamReader,
    resolveSample: createPersistedSampleSnapResolver(db, mediaObjectReader),
  }),
)
await app.register(
  mediaCursorRoutes({
    authenticate: async request => {
      const identity = await authenticateAnnotationRequest(request, db)
      return identity ? { id: identity.userId, role: identity.role } : null
    },
    database: db,
    objectReader: mediaObjectReader,
  }),
)
await app.register(
  mediaSourceRoutes({
    authenticate: request => authenticateAnnotationRequest(request, db),
    database: db,
    importRoot: process.env.MEDIA_IMPORT_ROOT ?? '/var/lib/volleyball/media-imports',
  }),
)
await app.register(
  operationsRoutes(
    identity =>
      collectOperationsSnapshot(
        db,
        identity,
        hostStorageProbe,
        objectStorageProbe,
        deploymentProbe,
      ),
    {
      authenticate: request => authenticateAnnotationRequest(request, db),
      collectReadiness: () => evaluateReadiness(readinessProbes),
      createAiWorkerToken: name => createAiWorkerToken(db, name),
      deleteAiWorkerToken: tokenId => deleteAiWorkerToken(db, tokenId),
      deleteAiWorker: workerId => deleteInactiveAiWorker(db, workerId),
      rotateAiWorkerToken: tokenId => rotateAiWorkerToken(db, tokenId),
      updateAiWorkerTokenState: (tokenId, enabled) => setAiWorkerTokenEnabled(db, tokenId, enabled),
    },
  ),
)
await app.register(
  annotationWebSocketRoutes({
    authenticate: request => authenticateAnnotationRequest(request, db),
    ...(annotationEvents ? { events: annotationEvents } : {}),
    ...(annotationPresence ? { presence: annotationPresence } : {}),
    ...(aiProgress ? { progress: aiProgress } : {}),
    service: annotationCommands,
    snapshot: async (roomId, rallyId, identity) => {
      const value = await getAnnotationSnapshot(db, {
        roomId,
        rallyId,
        userId: identity.userId,
        role: identity.role,
      })
      return value?.type === 'rally_snapshot' ? value : null
    },
  }),
)
await app.register(
  coachWebSocketRoutes({
    authenticate: request => authenticateAnnotationRequest(request, db),
    events: coachMatchEvents,
  }),
)

const yoga = createYoga<{ req: FastifyRequest; reply: FastifyReply }>({
  schema,
  graphqlEndpoint: '/graphql',
  logging: {
    debug: (...args) => args.forEach(arg => app.log.debug(arg)),
    info: (...args) => args.forEach(arg => app.log.info(arg)),
    warn: (...args) => args.forEach(arg => app.log.warn(arg)),
    error: (...args) => args.forEach(arg => app.log.error(arg)),
  },
  context: async ({ request, req, reply }) =>
    createGraphQLContext({
      request,
      req,
      reply,
      timingManifestReader,
    }),
})

app.route({
  url: yoga.graphqlEndpoint,
  method: ['GET', 'POST', 'OPTIONS'],
  handler: (req, reply) => yoga.handleNodeRequestAndResponse(req, reply, { req, reply }),
})

app.get('/health/live', async () => ({ status: 'ok' }))
app.get('/health/ready', async (_req, reply) => {
  const readiness = await evaluateReadiness(readinessProbes)
  return reply.status(readiness.status === 'ready' ? 200 : 503).send(readiness)
})

// REST route groups are added as vertical slices:
// - /api/v1/media/**: playback-window, HLS, cursor resolve and frame-step
// - /api/v1/ai/**: provider clip download and callback ingest
// - /api/v1/analysis/**: overlay manifest/chunks and binary artifacts

const port = Number(process.env.PORT ?? 4000)
app.addHook('onClose', async () => {
  await matchCleanupCoordinator.stop()
  annotationEvents?.close()
  annotationPresence?.close()
  aiProgress?.close()
  redis?.disconnect()
  await db.$disconnect()
})
await app.listen({ port, host: '0.0.0.0' })
matchCleanupCoordinator.start()
