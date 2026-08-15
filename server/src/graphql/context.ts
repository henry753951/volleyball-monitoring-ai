import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { GraphQLError } from 'graphql'
import { ensureDevelopmentDeviceSession } from '../realtime/auth.js'
import type { MediaObjectReader } from '../media/playback-domain.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const USER_ROLES = new Set<UserRole>(Object.values(UserRole))

export interface AuthenticatedUser {
  id: string
  role: UserRole
}

export interface GraphQLContext {
  request: Request
  req?: FastifyRequest
  reply?: FastifyReply
  user: AuthenticatedUser | null
  deviceSessionId?: string | null
  timingManifestReader?: MediaObjectReader
}

function unauthenticated(message: string): never {
  throw new GraphQLError(message, { extensions: { code: 'UNAUTHENTICATED' } })
}

function parseDevelopmentRole(value: string): UserRole {
  if (!USER_ROLES.has(value as UserRole)) {
    unauthenticated('Invalid development role')
  }
  return value as UserRole
}

export async function createGraphQLContext(input: {
  request: Request
  req?: FastifyRequest
  reply?: FastifyReply
  timingManifestReader?: MediaObjectReader
}): Promise<GraphQLContext> {
  const developmentAuthEnabled =
    process.env.DEV_AUTH_ENABLED === 'true' && process.env.NODE_ENV !== 'production'

  if (!developmentAuthEnabled) {
    return { ...input, deviceSessionId: null, user: null }
  }

  const userId = input.request.headers.get('x-dev-user-id') ?? process.env.DEV_USER_ID
  const roleValue = input.request.headers.get('x-dev-role') ?? process.env.DEV_USER_ROLE
  if (!userId && !roleValue) {
    return { ...input, deviceSessionId: null, user: null }
  }
  if (!userId || !UUID.test(userId)) {
    unauthenticated('Invalid development identity')
  }
  if (!roleValue) {
    unauthenticated('Invalid development role')
  }

  const role = parseDevelopmentRole(roleValue)
  const email = `${userId}@dev.volleyball.local`
  const displayName =
    input.request.headers.get('x-dev-display-name')?.trim() ||
    process.env.DEV_USER_DISPLAY_NAME?.trim() ||
    'Development User'

  await db.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, email, displayName },
  })

  return {
    ...input,
    deviceSessionId: await ensureDevelopmentDeviceSession(db, {
      deviceSessionId: input.request.headers.get('x-dev-device-session-id'),
      userAgent: input.request.headers.get('user-agent'),
      userId,
    }),
    user: { id: userId, role },
  }
}
