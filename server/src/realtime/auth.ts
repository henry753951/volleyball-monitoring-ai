import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyRequest } from 'fastify'
import type { AnnotationIdentity } from '../services/annotation-command.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const ROLES = new Set<UserRole>(Object.values(UserRole))
const DEFAULT_APP_AUTH_USER_ID = '00000000-0000-4000-8000-000000000002'
const DEFAULT_APP_AUTH_EMAIL = 'volley-ai@volley-ai.local'
const DEFAULT_APP_AUTH_COOKIE = 'volley_session'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

export interface AnnotationAuthRequestLike {
  headers: Headers | FastifyRequest['headers']
  url?: string
}

interface AppAuthConfig {
  cookieName: string
  displayName: string
  email: string
  password: string
  secret: string
  sessionTtlSeconds: number
  userId: string
  username: string
  secureCookie: boolean
}

interface AppSessionPayload {
  exp: number
  iat: number
  sid: string
  uid: string
  v: 1
}

function appAuthConfig(): AppAuthConfig | null {
  if (process.env.APP_AUTH_ENABLED === 'false') return null
  const username = process.env.APP_AUTH_USERNAME?.trim()
  const password = process.env.APP_AUTH_PASSWORD
  if (!username || !password) return null
  const configuredTtl = Number(process.env.APP_AUTH_SESSION_TTL_SECONDS)
  const sessionTtlSeconds = Number.isFinite(configuredTtl)
    ? Math.min(Math.max(Math.floor(configuredTtl), 300), 2_592_000)
    : DEFAULT_SESSION_TTL_SECONDS
  return {
    cookieName: process.env.APP_AUTH_COOKIE_NAME?.trim() || DEFAULT_APP_AUTH_COOKIE,
    displayName: process.env.APP_AUTH_DISPLAY_NAME?.trim() || 'VollyAI 主帳號',
    email: process.env.APP_AUTH_EMAIL?.trim() || DEFAULT_APP_AUTH_EMAIL,
    password,
    secret: process.env.APP_AUTH_SESSION_SECRET?.trim() || password,
    sessionTtlSeconds,
    secureCookie:
      process.env.APP_AUTH_COOKIE_SECURE === 'true' ||
      (process.env.APP_AUTH_COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production'),
    userId: process.env.APP_AUTH_USER_ID?.trim() || DEFAULT_APP_AUTH_USER_ID,
    username,
  }
}

export function appAuthConfigured(): boolean {
  return appAuthConfig() !== null
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

export function verifyAppCredentials(username: string, password: string): boolean {
  const config = appAuthConfig()
  return Boolean(
    config && safeEqual(config.username, username) && safeEqual(config.password, password),
  )
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function sessionSignature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function sessionToken(payload: AppSessionPayload, secret: string): string {
  const encoded = base64Json(payload)
  return `${encoded}.${sessionSignature(encoded, secret)}`
}

function parseSessionToken(value: string, config: AppAuthConfig): AppSessionPayload | null {
  if (value.length > 2_048) return null
  const [encoded, presentedSignature, extra] = value.split('.')
  if (!encoded || !presentedSignature || extra) return null
  const expectedSignature = sessionSignature(encoded, config.secret)
  if (!safeEqual(expectedSignature, presentedSignature)) return null
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<AppSessionPayload>
    const now = Math.floor(Date.now() / 1_000)
    if (
      payload.v !== 1 ||
      payload.uid !== config.userId ||
      typeof payload.sid !== 'string' ||
      !UUID.test(payload.sid) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.iat > now + 60 ||
      payload.exp <= now ||
      payload.exp - payload.iat > config.sessionTtlSeconds
    )
      return null
    return payload as AppSessionPayload
  } catch {
    return null
  }
}

function cookieValue(request: AnnotationAuthRequestLike, name: string): string | null {
  const cookies = header(request, 'cookie')
  if (!cookies) return null
  for (const item of cookies.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    const key = item.slice(0, separator).trim()
    if (key !== name) continue
    try {
      return decodeURIComponent(item.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function bearerValue(request: AnnotationAuthRequestLike): string | null {
  const value = header(request, 'authorization')
  if (!value || !/^Bearer\s+/i.test(value)) return null
  return value.replace(/^Bearer\s+/i, '').trim() || null
}

export function appSessionCookie(token: string): string {
  const config = appAuthConfig()
  if (!config) throw new Error('APP_AUTH_USERNAME and APP_AUTH_PASSWORD are required')
  const attributes = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${config.sessionTtlSeconds}`,
    'SameSite=Lax',
  ]
  if (config.secureCookie) attributes.push('Secure')
  return attributes.join('; ')
}

export function clearAppSessionCookie(): string {
  const config = appAuthConfig()
  const cookieName =
    config?.cookieName || process.env.APP_AUTH_COOKIE_NAME || DEFAULT_APP_AUTH_COOKIE
  const attributes = [
    `${cookieName}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'SameSite=Lax',
  ]
  if (config?.secureCookie) attributes.push('Secure')
  return attributes.join('; ')
}

/**
 * Clear the configured cookie and the original default name. The latter is
 * important after a cookie-name change: browsers keep both host cookies and
 * will continue sending the old one until it is explicitly expired.
 */
export function clearAppSessionCookies(): string[] {
  const config = appAuthConfig()
  const configuredName =
    config?.cookieName || process.env.APP_AUTH_COOKIE_NAME || DEFAULT_APP_AUTH_COOKIE
  const names = new Set([configuredName, DEFAULT_APP_AUTH_COOKIE])
  return [...names].map(cookieName => {
    const attributes = [
      `${cookieName}=`,
      'Path=/',
      'HttpOnly',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'SameSite=Lax',
    ]
    if (config?.secureCookie) attributes.push('Secure')
    return attributes.join('; ')
  })
}

export async function createAppSession(
  database: PrismaClient,
  userAgent?: string | null,
): Promise<{ expiresAt: Date; identity: AnnotationIdentity; token: string }> {
  const config = appAuthConfig()
  if (!config) throw new Error('APP_AUTH_USERNAME and APP_AUTH_PASSWORD are required')
  await database.user.upsert({
    create: { displayName: config.displayName, email: config.email, id: config.userId },
    update: { displayName: config.displayName, email: config.email },
    where: { id: config.userId },
  })
  const deviceSessionId = randomUUID()
  const now = Math.floor(Date.now() / 1_000)
  const expiresAt = new Date((now + config.sessionTtlSeconds) * 1_000)
  await database.deviceSession.create({
    data: {
      id: deviceSessionId,
      label: 'Web login',
      userAgent: userAgent ?? null,
      userId: config.userId,
    },
  })
  return {
    expiresAt,
    identity: { deviceSessionId, role: UserRole.ADMIN, userId: config.userId },
    token: sessionToken(
      {
        exp: Math.floor(expiresAt.getTime() / 1_000),
        iat: now,
        sid: deviceSessionId,
        uid: config.userId,
        v: 1,
      },
      config.secret,
    ),
  }
}

function header(request: AnnotationAuthRequestLike, name: string): string | null {
  if (request.headers instanceof Headers) return request.headers.get(name)
  const value = request.headers[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? (value[0] ?? null) : null
}

function queryParameter(request: AnnotationAuthRequestLike, name: string): string | null {
  try {
    return new URL(request.url ?? '/', 'http://annotation.local').searchParams.get(name)
  } catch {
    return null
  }
}

async function authenticateAppSession(
  request: AnnotationAuthRequestLike,
  database: PrismaClient,
): Promise<AnnotationIdentity | null> {
  const config = appAuthConfig()
  if (!config) return null
  const token = bearerValue(request) ?? cookieValue(request, config.cookieName)
  if (!token) return null
  const payload = parseSessionToken(token, config)
  if (!payload) return null
  const device = await database.deviceSession.findUnique({
    select: { revokedAt: true, userId: true },
    where: { id: payload.sid },
  })
  if (!device || device.revokedAt || device.userId !== config.userId) return null
  await database.deviceSession.update({
    where: { id: payload.sid },
    data: { lastSeenAt: new Date() },
  })
  return { deviceSessionId: payload.sid, role: UserRole.ADMIN, userId: config.userId }
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
  const existing = await database.deviceSession.findUnique({
    select: { revokedAt: true, userId: true },
    where: { id },
  })
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

async function authenticateDevelopmentHeaderRequest(
  request: AnnotationAuthRequestLike,
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
      displayName:
        header(request, 'x-dev-display-name')?.trim() ||
        process.env.DEV_USER_DISPLAY_NAME?.trim() ||
        'Development User',
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
    deviceSessionId:
      header(request, 'x-dev-device-session-id') ?? queryParameter(request, 'device_session_id'),
    userAgent: header(request, 'user-agent'),
    userId,
  })
  return { deviceSessionId, role: role as UserRole, userId }
}

export async function authenticateAnnotationRequest(
  request: AnnotationAuthRequestLike,
  database: PrismaClient,
): Promise<AnnotationIdentity | null> {
  const session = await authenticateAppSession(request, database)
  if (session) return session
  return authenticateDevelopmentHeaderRequest(request, database)
}

/**
 * Backward-compatible name for route slices that have not yet been renamed.
 * It now accepts the production app session first, then development headers only
 * when the explicit development auth flag is enabled.
 */
export async function authenticateDevelopmentAnnotationRequest(
  request: AnnotationAuthRequestLike,
  database: PrismaClient,
): Promise<AnnotationIdentity | null> {
  return authenticateAnnotationRequest(request, database)
}
