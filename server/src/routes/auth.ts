import type { PrismaClient } from '@volleyball-monitoring/db'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  appAuthConfigured,
  appSessionCookie,
  authenticateAnnotationRequest,
  clearAppSessionCookies,
  createAppSession,
  verifyAppCredentials,
} from '../realtime/auth.js'

const LoginRequest = z
  .object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(512) })
  .strict()

export interface AuthRouteDependencies {
  authenticate?: typeof authenticateAnnotationRequest
  database: PrismaClient
}

function userPayload(identity: Awaited<ReturnType<typeof authenticateAnnotationRequest>>) {
  return identity
    ? { device_session_id: identity.deviceSessionId, id: identity.userId, role: identity.role }
    : null
}

export const authRoutes =
  (dependencies: AuthRouteDependencies): FastifyPluginAsync =>
  async app => {
    app.post('/api/v1/auth/login', async (request, reply) => {
      if (!appAuthConfigured())
        return reply.status(503).send({ code: 'AUTH_NOT_CONFIGURED', message: '登入服務尚未設定' })
      const parsed = LoginRequest.safeParse(request.body)
      if (!parsed.success || !verifyAppCredentials(parsed.data.username, parsed.data.password)) {
        return reply.status(401).send({ code: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' })
      }
      const session = await createAppSession(dependencies.database, request.headers['user-agent'])
      return reply
        .header('cache-control', 'no-store')
        .header('set-cookie', appSessionCookie(session.token))
        .send({
          authenticated: true,
          expires_at: session.expiresAt.toISOString(),
          user: userPayload(session.identity),
        })
    })

    app.get('/api/v1/auth/session', async (request, reply) => {
      const authenticate = dependencies.authenticate ?? authenticateAnnotationRequest
      const identity = await authenticate(request, dependencies.database).catch(() => null)
      return reply
        .header('cache-control', 'no-store')
        .send({ authenticated: Boolean(identity), user: userPayload(identity) })
    })

    app.get('/api/v1/auth/forward-auth', async (request, reply) => {
      const authenticate = dependencies.authenticate ?? authenticateAnnotationRequest
      const identity = await authenticate(request, dependencies.database).catch(() => null)
      if (!identity) return reply.status(401).header('cache-control', 'no-store').send()
      return reply.status(204).header('cache-control', 'no-store').send()
    })

    app.post('/api/v1/auth/logout', async (request, reply) => {
      const authenticate = dependencies.authenticate ?? authenticateAnnotationRequest
      const identity = await authenticate(request, dependencies.database).catch(() => null)
      if (identity) {
        await dependencies.database.deviceSession.updateMany({
          data: { revokedAt: new Date() },
          where: { id: identity.deviceSessionId, userId: identity.userId, revokedAt: null },
        })
      }
      return reply
        .header('cache-control', 'no-store')
        .header('set-cookie', clearAppSessionCookies())
        .send({ authenticated: false })
    })
  }
