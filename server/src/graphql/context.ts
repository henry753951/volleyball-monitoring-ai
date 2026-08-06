import type { FastifyReply, FastifyRequest } from 'fastify'

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
  // Phase 1: replace dev header identity with real auth/session lookup.
  const userId = input.request.headers.get('x-dev-user-id')
  return {
    ...input,
    user: userId ? { id: userId, role: input.request.headers.get('x-dev-role') ?? 'ADMIN' } : null,
  }
}
