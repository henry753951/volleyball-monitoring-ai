import { db } from '@volleyball-monitoring/db'
import { getCoachRallyReplay } from '../services/coach-replay.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'

builder.queryField('coachRallyReplay', (t) => t.field({
  args: { rallyId: t.arg.id({ required: true }) }, nullable: true, type: 'JSON',
  resolve: (_root, args, context) => { const identity = requireIdentity(context); return getCoachRallyReplay(db, { rallyId: args.rallyId, userId: identity.id, role: identity.role }) },
}))
