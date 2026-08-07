import { db } from '@volleyball-monitoring/db'
import {
  findVisibleMatch,
  listVisibleMatches,
} from '../services/core-domain.js'
import { builder } from './builder.js'
import { domainError, requireIdentity } from './errors.js'
import { HealthType, MatchType, ViewerType } from './types.js'

builder.queryType({
  fields: (t) => ({
    health: t.field({
      resolve: () => ({ service: 'volleyball-monitoring-server', status: 'ok' }),
      type: HealthType,
    }),
    match: t.field({
      args: { id: t.arg.id({ required: true }) },
      nullable: true,
      resolve: (_root, args, context) => findVisibleMatch(requireIdentity(context), args.id),
      type: MatchType,
    }),
    matches: t.field({
      resolve: (_root, _args, context) => listVisibleMatches(requireIdentity(context)),
      type: [MatchType],
    }),
    viewer: t.field({
      resolve: async (_root, _args, context) => {
        const identity = requireIdentity(context)
        const user = await db.user.findUnique({ where: { id: identity.id } })
        if (!user) {
          domainError('Authenticated user is unavailable', 'UNAUTHENTICATED')
        }
        return { ...user, role: identity.role }
      },
      type: ViewerType,
    }),
  }),
})
