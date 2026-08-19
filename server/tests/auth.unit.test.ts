import Fastify from 'fastify'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authRoutes } from '../src/routes/auth.js'
import { authenticateAnnotationRequest, createAppSession } from '../src/realtime/auth.js'

const userId = '00000000-0000-4000-8000-000000000002'
const authEnvKeys = [
  'APP_AUTH_ENABLED',
  'APP_AUTH_USERNAME',
  'APP_AUTH_PASSWORD',
  'APP_AUTH_SESSION_SECRET',
  'APP_AUTH_USER_ID',
  'APP_AUTH_COOKIE_NAME',
  'APP_AUTH_COOKIE_SECURE',
] as const
const originalAuthEnv = new Map(authEnvKeys.map(key => [key, process.env[key]]))

function setAuthEnv(values: Partial<Record<(typeof authEnvKeys)[number], string>>) {
  for (const key of authEnvKeys) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function fakeDatabase() {
  const sessions = new Map<string, { revokedAt: Date | null; userId: string }>()
  return {
    deviceSession: {
      create: vi.fn(async ({ data }: { data: { id: string; userId: string } }) => {
        sessions.set(data.id, { revokedAt: null, userId: data.userId })
        return data
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null,
      ),
      update: vi.fn(async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string }
          create: { id: string; userId: string }
          update: { userAgent?: string | null }
        }) => {
          const existing = sessions.get(where.id)
          if (existing) return existing
          const session = { revokedAt: null, userId: create.userId }
          sessions.set(create.id, session)
          void update
          return session
        },
      ),
      updateMany: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const session = sessions.get(where.id)
        if (!session || session.userId !== where.userId || session.revokedAt) return { count: 0 }
        session.revokedAt = new Date()
        return { count: 1 }
      }),
    },
    user: { upsert: vi.fn(async ({ create }: { create: unknown }) => create) },
  } as unknown as PrismaClient
}

describe('application authentication routes', () => {
  afterEach(() => {
    for (const key of authEnvKeys) {
      const value = originalAuthEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('logs in the configured root account, reads the session, and logs out', async () => {
    setAuthEnv({
      APP_AUTH_COOKIE_SECURE: 'false',
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_PASSWORD: 'test-password',
      APP_AUTH_SESSION_SECRET: 'test-session-secret',
      APP_AUTH_USER_ID: userId,
      APP_AUTH_USERNAME: 'volley-ai',
    })

    const app = Fastify({ logger: false })
    await app.register(authRoutes({ database: fakeDatabase() }))
    try {
      const login = await app.inject({
        method: 'POST',
        payload: { password: 'test-password', username: 'volley-ai' },
        url: '/api/v1/auth/login',
      })
      expect(login.statusCode).toBe(200)
      expect(login.json()).toMatchObject({
        authenticated: true,
        user: { id: userId, role: 'ADMIN' },
      })
      const cookie = String(login.headers['set-cookie'])
      expect(cookie).toContain('volley_session=')

      const session = await app.inject({
        headers: { cookie: cookie.split(';')[0] },
        method: 'GET',
        url: '/api/v1/auth/session',
      })
      expect(session.json()).toMatchObject({
        authenticated: true,
        user: { id: userId, role: 'ADMIN' },
      })

      const logout = await app.inject({
        headers: { cookie: cookie.split(';')[0] },
        method: 'POST',
        url: '/api/v1/auth/logout',
      })
      expect(logout.statusCode).toBe(200)
      expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
      expect(String(logout.headers['set-cookie'])).toContain(
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      )

      const revoked = await app.inject({
        headers: { cookie: cookie.split(';')[0] },
        method: 'GET',
        url: '/api/v1/auth/session',
      })
      expect(revoked.json()).toMatchObject({ authenticated: false, user: null })
    } finally {
      await app.close()
    }
  })

  it('expires both a configured cookie name and the legacy default cookie name', async () => {
    setAuthEnv({
      APP_AUTH_COOKIE_NAME: 'volley_app_session',
      APP_AUTH_COOKIE_SECURE: 'false',
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_PASSWORD: 'test-password',
      APP_AUTH_SESSION_SECRET: 'test-session-secret',
      APP_AUTH_USER_ID: userId,
      APP_AUTH_USERNAME: 'volley-ai',
    })

    const app = Fastify({ logger: false })
    await app.register(authRoutes({ database: fakeDatabase() }))
    try {
      const login = await app.inject({
        method: 'POST',
        payload: { password: 'test-password', username: 'volley-ai' },
        url: '/api/v1/auth/login',
      })
      const cookie = String(login.headers['set-cookie']).split(';')[0]
      const logout = await app.inject({
        headers: { cookie },
        method: 'POST',
        url: '/api/v1/auth/logout',
      })
      const cleared = String(logout.headers['set-cookie'])
      expect(cleared).toContain('volley_app_session=')
      expect(cleared).toContain('volley_session=')
      expect(cleared).toContain('Max-Age=0')
    } finally {
      await app.close()
    }
  })

  it('rejects invalid credentials without creating a session', async () => {
    setAuthEnv({
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_PASSWORD: 'test-password',
      APP_AUTH_SESSION_SECRET: 'test-session-secret',
      APP_AUTH_USERNAME: 'volley-ai',
    })

    const database = fakeDatabase()
    const app = Fastify({ logger: false })
    await app.register(authRoutes({ database }))
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { password: 'wrong', username: 'volley-ai' },
        url: '/api/v1/auth/login',
      })
      expect(response.statusCode).toBe(401)
      expect(database.deviceSession.create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('accepts a distinct authenticated device session for each browser window', async () => {
    setAuthEnv({
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_PASSWORD: 'test-password',
      APP_AUTH_SESSION_SECRET: 'test-session-secret',
      APP_AUTH_USER_ID: userId,
      APP_AUTH_USERNAME: 'volley-ai',
    })
    const database = fakeDatabase()
    const session = await createAppSession(database)
    const windowDeviceSessionId = '00000000-0000-4000-8000-000000000003'
    const identity = await authenticateAnnotationRequest(
      {
        headers: new Headers({
          cookie: `volley_session=${session.token}`,
          'user-agent': 'test-browser',
        }),
        url: `/ws/annotations?device_session_id=${windowDeviceSessionId}`,
      },
      database,
    )
    expect(identity).toMatchObject({
      deviceSessionId: windowDeviceSessionId,
      userId,
    })
  })
})
