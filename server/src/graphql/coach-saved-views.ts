import { GraphQLError } from 'graphql'
import { db } from '@volleyball-monitoring/db'
import { listSavedAnalysisViews, saveAnalysisView } from '../services/saved-analysis-views.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'

builder.queryField('savedAnalysisViews', t => t.field({
  args: { matchId: t.arg.id({ required: true }) }, nullable: true, type: 'JSON',
  resolve: (_root, args, context) => { const identity = requireIdentity(context); return listSavedAnalysisViews(db, { matchId: args.matchId, userId: identity.id, role: identity.role }) },
}))

builder.mutationField('saveAnalysisView', t => t.field({
  args: { matchId: t.arg.id({ required: true }), name: t.arg.string({ required: true }), filters: t.arg({ type: 'JSON', required: true }), layout: t.arg({ type: 'JSON' }) }, type: 'JSON',
  resolve: async (_root, args, context) => {
    const identity = requireIdentity(context)
    try { return await saveAnalysisView(db, { matchId: args.matchId, userId: identity.id, role: identity.role, name: args.name, filters: args.filters, layout: args.layout }) }
    catch (error) {
      const code = error instanceof Error ? error.message : 'INTERNAL_SERVER_ERROR'
      if (code === 'NOT_FOUND') throw new GraphQLError('Match not found', { extensions: { code } })
      if (code === 'BAD_USER_INPUT') throw new GraphQLError('Saved view input is invalid', { extensions: { code } })
      throw new GraphQLError('Saved view could not be saved', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
    }
  },
}))
