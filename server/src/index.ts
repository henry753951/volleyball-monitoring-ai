import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createYoga } from 'graphql-yoga'
import { createGraphQLContext } from './graphql/context.js'
import { schema } from './graphql/schema.js'

const app = Fastify({ logger: true })

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
  // Phase 1 replaces this with bounded PostgreSQL/Redis/MinIO readiness checks.
  return reply.status(503).send({ status: 'starting' })
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
    socket.send(JSON.stringify({
      schema_version: '1.1.0',
      type: 'not_implemented',
      received_bytes: raw.byteLength,
    }))
  })
})

// REST route groups are added as vertical slices:
// - /api/v1/media/**: playback-window, HLS, cursor resolve and frame-step
// - /api/v1/ai/**: provider clip download and callback ingest
// - /api/v1/analysis/**: overlay manifest/chunks and binary artifacts

const port = Number(process.env.PORT ?? 4000)
await app.listen({ port, host: '0.0.0.0' })
