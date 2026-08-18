import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { GraphQLError } from 'graphql'
import { authenticateAnnotationRequest } from '../realtime/auth.js'
import type { MediaObjectReader } from '../media/playback-domain.js'

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

export async function createGraphQLContext(input: {
  request: Request
  req?: FastifyRequest
  reply?: FastifyReply
  timingManifestReader?: MediaObjectReader
}): Promise<GraphQLContext> {
  let identity: Awaited<ReturnType<typeof authenticateAnnotationRequest>>
  try {
    identity = await authenticateAnnotationRequest(input.request, db)
  } catch {
    unauthenticated('Authentication required')
  }

  return {
    ...input,
    deviceSessionId: identity?.deviceSessionId ?? null,
    user: identity ? { id: identity.userId, role: identity.role } : null,
  }
}
