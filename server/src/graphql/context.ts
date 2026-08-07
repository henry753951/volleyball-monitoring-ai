import type { FastifyReply, FastifyRequest } from 'fastify'
import { GraphQLError } from 'graphql'
import { db } from '@volleyball-monitoring/db'

export interface GraphQLContext {
  request: Request
  req?: FastifyRequest
  reply?: FastifyReply
  user: { id: string; role: string } | null
}

export async function createGraphQLContext(input: {
  request: Request
  req?: FastifyRequest
  reply?: FastifyReply
}): Promise<GraphQLContext> {
  const enabled = process.env.DEV_AUTH_ENABLED === 'true' || process.env.NODE_ENV !== 'production'
  const userId = enabled ? input.request.headers.get('x-dev-user-id') ?? process.env.DEV_USER_ID : null
  const role = enabled ? input.request.headers.get('x-dev-role') ?? process.env.DEV_USER_ROLE ?? 'ADMIN' : null
  if (!userId || !role) return { ...input, user: null }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new GraphQLError('Invalid development identity', { extensions: { code: 'UNAUTHENTICATED' } })
  }
  if (!['ADMIN', 'OPERATOR', 'ANNOTATOR', 'COACH', 'VIEWER'].includes(role)) {
    throw new GraphQLError('Invalid development role', { extensions: { code: 'UNAUTHENTICATED' } })
  }
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email: `${userId}@dev.volleyball.local`, displayName: 'Development User' } })
  return {
    ...input,
    user: { id: userId, role },
  }
}
