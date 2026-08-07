import { db } from '@volleyball-monitoring/db'
import { assignTrackIdentity, getCoachMatchAnalytics } from '../services/coach-analytics.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'

builder.queryField('coachMatchAnalytics', (t) => t.field({ args: { matchId: t.arg.id({ required: true }) }, nullable: true, type: 'JSON', resolve: (_root, args, context) => { const identity = requireIdentity(context); return getCoachMatchAnalytics(db, { matchId: args.matchId, userId: identity.id, role: identity.role }) } }))
builder.mutationField('assignTrackIdentity', (t) => t.field({ args: { analysisRunId: t.arg.id({ required: true }), trackId: t.arg.int({ required: true }), rosterEntryId: t.arg.id({ required: true }) }, type: 'JSON', resolve: (_root, args, context) => { const identity = requireIdentity(context); return assignTrackIdentity(db, { analysisRunId: args.analysisRunId, trackId: args.trackId, rosterEntryId: args.rosterEntryId, userId: identity.id, role: identity.role }) } }))
