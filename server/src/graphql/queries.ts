import { db } from '@volleyball-monitoring/db'
import {
  findVisibleMatch,
  listVisibleMatches,
} from '../services/core-domain.js'
import { builder } from './builder.js'
import { domainError, requireIdentity } from './errors.js'
import { CaptureSessionType, HealthType, MatchType, ViewerType } from './types.js'

builder.queryType({
  fields: (t) => ({
    health: t.field({
      resolve: () => ({ service: 'volleyball-monitoring-server', status: 'ok' }),
      type: HealthType,
    }),
    captureSession: t.field({
      type: CaptureSessionType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_root, args, context) => {
        const identity = requireIdentity(context)
        const session = await db.captureSession.findFirst({ where: { id: args.id, match: { members: { some: { userId: identity.id } } } } })
        if (!session) return null
        const program = await db.dvrProgram.findFirst({ where: { captureSessionId: session.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
        let timeline = null
        if (program) {
          const segments = await db.dvrSegment.findMany({ where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null }, initAsset: { state: 'READY' }, mediaAsset: { state: 'READY' }, sampleIndexAsset: { state: 'READY' } }, orderBy: [{ captureStartUs: 'asc' }, { sequenceNumber: 'asc' }] })
          const ranges: { startUs: bigint; endUs: bigint; discontinuity: number }[] = []
          for (const segment of segments) { const previous = ranges[ranges.length - 1]; if (previous !== undefined && previous.discontinuity === segment.discontinuitySequence && previous.endUs >= segment.captureStartUs) previous.endUs = previous.endUs > segment.captureEndUs ? previous.endUs : segment.captureEndUs; else ranges.push({ startUs: segment.captureStartUs, endUs: segment.captureEndUs, discontinuity: segment.discontinuitySequence }) }
          if (ranges.length) timeline = { captureSessionId: session.id, timelineVersion: program.playlistRevision, captureStartTimeUs: ranges[0]!.startUs, liveEdgeCaptureTimeUs: ranges[ranges.length - 1]!.endUs, availableRanges: ranges }
        }
        return { id: session.id, matchId: session.matchId, sourceLabel: session.sourceLabel, status: session.status, health: session.health, startedAt: session.startedAt, endedAt: session.endedAt, timeline }
      },
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
