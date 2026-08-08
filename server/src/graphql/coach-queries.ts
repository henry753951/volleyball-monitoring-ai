import { db } from '@volleyball-monitoring/db'
import { getCoachMatchState } from '../services/coach-dashboard.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'

builder.queryField('coachMatchState', (t) => t.field({
  args: { matchId: t.arg.id({ required: true }) }, nullable: true, type: 'JSON',
  resolve: (_root, args, context) => {
    const identity = requireIdentity(context)
    return getCoachMatchState(
      db,
      { matchId: args.matchId, userId: identity.id, role: identity.role },
      context.timingManifestReader
        ? { timingManifestReader: context.timingManifestReader }
        : {},
    )
  },
}))
