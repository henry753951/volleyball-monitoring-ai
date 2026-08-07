import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { db } from '@volleyball-monitoring/db'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createYoga } from 'graphql-yoga'
import Redis from 'ioredis'
import { createGraphQLContext } from './graphql/context.js'
import { schema } from './graphql/schema.js'
import { evaluateReadiness, type ReadinessProbe } from './health/readiness.js'

const app = Fastify({ logger: true })
const redisUrl = process.env.REDIS_URL
const minioEndpoint = process.env.MINIO_ENDPOINT?.replace(/\/+$/, '')
const redis = redisUrl
  ? new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1_000, maxRetriesPerRequest: 1 })
  : null

redis?.on('error', (error) => app.log.warn({ error }, 'Redis readiness connection error'))

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
      if (await redis.ping() !== 'PONG') throw new Error('Redis did not return PONG')
    },
  },
  {
    name: 'minio',
    check: async (signal) => {
      if (!minioEndpoint) throw new Error('MINIO_ENDPOINT is required')
      const response = await fetch(`${minioEndpoint}/minio/health/ready`, { signal })
      if (!response.ok) throw new Error(`MinIO readiness returned ${response.status}`)
    },
  },
]

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true,
  credentials: true,
})
await app.register(websocket)

const yoga = createYoga<{ req: FastifyRequest; reply: FastifyReply }>({
  schema,
  graphqlEndpoint: '/graphql',
  logging: {
    debug: (...args) => args.forEach((arg) => app.log.debug(arg)),
    info: (...args) => args.forEach((arg) => app.log.info(arg)),
    warn: (...args) => args.forEach((arg) => app.log.warn(arg)),
    error: (...args) => args.forEach((arg) => app.log.error(arg)),
  },
  context: async ({ request, req, reply }) => createGraphQLContext({ request, req, reply }),
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

// High-frequency annotation traffic is intentionally not a GraphQL subscription.
// Phase 3 replaces this echo scaffold with authenticated room join, durable command
// handling, revision ACK/reject and Redis-backed fan-out.
app.get('/ws/annotations', { websocket: true }, (socket) => {
  socket.send(JSON.stringify({
    schema_version: '1.1.0',
    type: 'connection_ready',
    note: 'annotation websocket scaffold only',
  }))

  socket.on('message', (raw) => {
    const receivedBytes = Array.isArray(raw)
      ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
      : raw.byteLength
    socket.send(JSON.stringify({
      schema_version: '1.1.0',
      type: 'not_implemented',
      received_bytes: receivedBytes,
    }))
  })
})

// REST route groups are added as vertical slices:
// - /api/v1/media/**: playback-window, HLS, cursor resolve and frame-step
// - /api/v1/ai/**: provider clip download and callback ingest
// - /api/v1/analysis/**: overlay manifest/chunks and binary artifacts

const port = Number(process.env.PORT ?? 4000)
app.addHook('onClose', async () => {
  redis?.disconnect()
  await db.$disconnect()
})
await app.listen({ port, host: '0.0.0.0' })
