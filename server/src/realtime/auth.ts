import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyRequest } from 'fastify'
import type { AnnotationIdentity } from '../services/annotation-command.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const ROLES = new Set<UserRole>(Object.values(UserRole))

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value : null
}

function queryParameter(request: FastifyRequest, name: string): string | null {
  try {
    return new URL(request.url, 'http://annotation.local').searchParams.get(name)
  }
  catch {
    return null
  }
}

export async function ensureDevelopmentDeviceSession(
  database: PrismaClient,
  input: { userId: string; deviceSessionId?: string | null; userAgent?: string | null },
): Promise<string> {
  if (process.env.DEV_AUTH_ENABLED !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('Production device-session authentication is not configured')
  }
  const id = input.deviceSessionId ?? process.env.DEV_DEVICE_SESSION_ID ?? randomUUID()
  if (!UUID.test(id)) throw new TypeError('Invalid development device session')
  const existing = await database.deviceSession.findUnique({ select: { revokedAt: true, userId: true }, where: { id } })
  if (existing && existing.userId !== input.userId) {
    throw new TypeError('Development device session belongs to another user')
  }
  if (existing?.revokedAt) throw new TypeError('Development device session is revoked')
  await database.deviceSession.upsert({
    create: {
      id,
      label: 'Development annotation client',
      userAgent: input.userAgent ?? null,
      userId: input.userId,
    },
    update: { lastSeenAt: new Date(), userAgent: input.userAgent ?? null },
    where: { id },
  })
  return id
}

export async function authenticateDevelopmentAnnotationRequest(
  request: FastifyRequest,
  database: PrismaClient,
): Promise<AnnotationIdentity | null> {
  if (process.env.DEV_AUTH_ENABLED !== 'true' || process.env.NODE_ENV === 'production') return null
  const userId = header(request, 'x-dev-user-id') ?? process.env.DEV_USER_ID ?? null
  const role = header(request, 'x-dev-role') ?? process.env.DEV_USER_ROLE ?? null
  if (!userId && !role) return null
  if (!userId || !UUID.test(userId) || !role || !ROLES.has(role as UserRole)) {
    throw new TypeError('Invalid development annotation identity')
  }
  await database.user.upsert({
    create: {
      displayName: header(request, 'x-dev-display-name')?.trim()
        || process.env.DEV_USER_DISPLAY_NAME?.trim()
        || 'Development User',
      email: `${userId}@dev.volleyball.local`,
      id: userId,
    },
    update: {},
    where: { id: userId },
  })
  const deviceSessionId = await ensureDevelopmentDeviceSession(database, {
    // Browsers cannot attach custom headers to a WebSocket handshake. This
    // development-only hint keeps one tab's device identity stable across a
    // reconnect; production authentication continues to own device sessions.
    deviceSessionId: header(request, 'x-dev-device-session-id')
      ?? queryParameter(request, 'device_session_id'),
    userAgent: header(request, 'user-agent'),
    userId,
  })
  return { deviceSessionId, role: role as UserRole, userId }
}
