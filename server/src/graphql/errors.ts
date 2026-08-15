import { GraphQLError } from 'graphql'
import type { GraphQLContext } from './context.js'

export type DomainErrorCode =
  'BAD_USER_INPUT' | 'FORBIDDEN' | 'INTERNAL_SERVER_ERROR' | 'NOT_FOUND' | 'UNAUTHENTICATED'

export function domainError(message: string, code: DomainErrorCode): never {
  throw new GraphQLError(message, { extensions: { code } })
}

export function requireIdentity(context: GraphQLContext) {
  return context.user ?? domainError('Authentication required', 'UNAUTHENTICATED')
}
