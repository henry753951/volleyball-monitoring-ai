import { db } from '@volleyball-monitoring/db'
import {
  assignTrackIdentity,
  clearTrackIdentity,
  getCoachMatchAnalytics,
  setTrackIdentityMappingComplete,
} from '../services/coach-analytics.js'
import { applyReidAutomaticAssignments } from '../services/reid-automatic-assignment.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'

let publishMatchInvalidation: ((matchId: string) => void) | null = null
export function configureCoachAnalyticsGraphQL(publish: (matchId: string) => void) {
  publishMatchInvalidation = publish
}

builder.queryField('coachMatchAnalytics', t =>
  t.field({
    args: { matchId: t.arg.id({ required: true }) },
    nullable: true,
    type: 'JSON',
    resolve: (_root, args, context) => {
      const identity = requireIdentity(context)
      return getCoachMatchAnalytics(db, {
        matchId: args.matchId,
        userId: identity.id,
        role: identity.role,
      })
    },
  }),
)
builder.mutationField('assignTrackIdentity', t =>
  t.field({
    args: {
      analysisRunId: t.arg.id({ required: true }),
      trackId: t.arg.int({ required: true }),
      rosterEntryId: t.arg.id({ required: true }),
      identityMode: t.arg.string(),
    },
    type: 'JSON',
    resolve: async (_root, args, context) => {
      const identity = requireIdentity(context)
      const result = await assignTrackIdentity(db, {
        analysisRunId: args.analysisRunId,
        trackId: args.trackId,
        rosterEntryId: args.rosterEntryId,
        identityMode: args.identityMode,
        userId: identity.id,
        role: identity.role,
      })
      publishMatchInvalidation?.(result.match_id)
      return result
    },
  }),
)
builder.mutationField('clearTrackIdentity', t =>
  t.field({
    args: { analysisRunId: t.arg.id({ required: true }), trackId: t.arg.int({ required: true }) },
    type: 'JSON',
    resolve: async (_root, args, context) => {
      const identity = requireIdentity(context)
      const result = await clearTrackIdentity(db, {
        analysisRunId: args.analysisRunId,
        trackId: args.trackId,
        userId: identity.id,
        role: identity.role,
      })
      publishMatchInvalidation?.(result.match_id)
      return result
    },
  }),
)
builder.mutationField('applyReidAutomaticAssignments', t =>
  t.field({
    args: { analysisRunId: t.arg.id({ required: true }) },
    type: 'JSON',
    resolve: async (_root, args, context) => {
      const identity = requireIdentity(context)
      const result = await applyReidAutomaticAssignments(db, {
        analysisRunId: args.analysisRunId,
        userId: identity.id,
        role: identity.role,
      })
      publishMatchInvalidation?.(result.match_id)
      return result
    },
  }),
)
builder.mutationField('setTrackIdentityMappingComplete', t =>
  t.field({
    args: {
      analysisRunId: t.arg.id({ required: true }),
      completed: t.arg.boolean({ required: true }),
    },
    type: 'JSON',
    resolve: async (_root, args, context) => {
      const identity = requireIdentity(context)
      const result = await setTrackIdentityMappingComplete(db, {
        analysisRunId: args.analysisRunId,
        completed: args.completed,
        userId: identity.id,
        role: identity.role,
      })
      publishMatchInvalidation?.(result.match_id)
      return result
    },
  }),
)
