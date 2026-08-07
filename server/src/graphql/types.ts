import { db } from '@volleyball-monitoring/db'
import {
  MatchStatus,
  SetStatus,
  UserRole,
} from '@volleyball-monitoring/db/client'
import type {
  CourtSideAssignment,
  Match,
  MatchRosterEntry,
  MatchSet,
  Player,
  Team,
} from '@volleyball-monitoring/db/client'
import { CaptureStatus, SourceHealth } from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from './context.js'
import { builder } from './builder.js'
import { domainError } from './errors.js'

interface Health {
  service: string
  status: string
}

interface Viewer extends AuthenticatedUser {
  displayName: string
  email: string
}

export const UserRoleType = builder.enumType(UserRole, { name: 'UserRole' })
export const MatchStatusType = builder.enumType(MatchStatus, { name: 'MatchStatus' })
export const SetStatusType = builder.enumType(SetStatus, { name: 'SetStatus' })
export const CaptureStatusType = builder.enumType(CaptureStatus, { name: 'CaptureStatus' })
export const SourceHealthType = builder.enumType(SourceHealth, { name: 'SourceHealth' })

export const HealthType = builder.objectRef<Health>('Health')
HealthType.implement({
  fields: (t) => ({
    service: t.exposeString('service'),
    status: t.exposeString('status'),
  }),
})

export const ViewerType = builder.objectRef<Viewer>('Viewer')
ViewerType.implement({
  fields: (t) => ({
    displayName: t.exposeString('displayName'),
    email: t.exposeString('email'),
    id: t.exposeID('id'),
    role: t.field({ type: UserRoleType, resolve: (viewer) => viewer.role }),
  }),
})

export const PlayerType = builder.objectRef<Player>('Player')
PlayerType.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    teamId: t.exposeID('teamId'),
  }),
})

export const TeamType = builder.objectRef<Team>('Team')
TeamType.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    players: t.field({
      type: [PlayerType],
      resolve: (team) => db.player.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { teamId: team.id },
      }),
    }),
    shortName: t.exposeString('shortName'),
  }),
})

export const MatchRosterEntryType = builder.objectRef<MatchRosterEntry>('MatchRosterEntry')
MatchRosterEntryType.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    jerseyNumber: t.exposeString('jerseyNumber'),
    name: t.string({
      resolve: async (entry) => {
        if (entry.displayNameSnapshot !== null) {
          return entry.displayNameSnapshot
        }
        if (!entry.playerId) {
          domainError('Roster entry name is unavailable', 'INTERNAL_SERVER_ERROR')
        }
        const player = await db.player.findUnique({ where: { id: entry.playerId } })
        return player?.name
          ?? domainError('Roster entry player is unavailable', 'INTERNAL_SERVER_ERROR')
      },
    }),
    teamId: t.exposeID('teamId'),
  }),
})

export const CourtSideAssignmentType = builder.objectRef<CourtSideAssignment>('CourtSideAssignment')
CourtSideAssignmentType.implement({
  fields: (t) => ({
    effectiveFromRallyOrdinal: t.exposeInt('effectiveFromRallyOrdinal'),
    effectiveToRallyOrdinal: t.exposeInt('effectiveToRallyOrdinal', { nullable: true }),
    id: t.exposeID('id'),
    leftTeamId: t.exposeID('leftTeamId'),
    rightTeamId: t.exposeID('rightTeamId'),
  }),
})

export const MatchSetType = builder.objectRef<MatchSet>('MatchSet')
MatchSetType.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    leftScore: t.exposeInt('leftScore'),
    rightScore: t.exposeInt('rightScore'),
    setNumber: t.exposeInt('setNumber'),
    sideAssignments: t.field({
      type: [CourtSideAssignmentType],
      resolve: (matchSet) => db.courtSideAssignment.findMany({
        orderBy: [{ effectiveFromRallyOrdinal: 'asc' }, { id: 'asc' }],
        where: { setId: matchSet.id },
      }),
    }),
    status: t.field({ type: SetStatusType, resolve: (matchSet) => matchSet.status }),
  }),
})

async function teamsForMatch(matchId: string): Promise<Team[]> {
  const initialAssignment = await db.courtSideAssignment.findFirst({
    orderBy: [
      { set: { setNumber: 'asc' } },
      { effectiveFromRallyOrdinal: 'asc' },
    ],
    where: { set: { matchId } },
  })
  if (initialAssignment) {
    const teams = await db.team.findMany({
      where: { id: { in: [initialAssignment.leftTeamId, initialAssignment.rightTeamId] } },
    })
    const byId = new Map(teams.map((team) => [team.id, team]))
    const leftTeam = byId.get(initialAssignment.leftTeamId)
    const rightTeam = byId.get(initialAssignment.rightTeamId)
    if (leftTeam && rightTeam) {
      return [leftTeam, rightTeam]
    }
  }

  const matchTeams = await db.matchTeam.findMany({
    include: { team: true },
    orderBy: { teamId: 'asc' },
    where: { matchId },
  })
  return matchTeams.map((matchTeam) => matchTeam.team)
}

export const MatchType = builder.objectRef<Match>('Match')
export const CaptureSessionType = builder.objectRef<CaptureSessionView>('CaptureSession')
MatchType.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    captureSessions: t.field({ type: [CaptureSessionType], resolve: (match) => import('../services/media-timeline.js').then(({ listCaptureSessionsForMatch }) => listCaptureSessionsForMatch(match.id)) }),
    rosterEntries: t.field({
      type: [MatchRosterEntryType],
      resolve: (match) => db.matchRosterEntry.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { matchId: match.id },
      }),
    }),
    scheduledAt: t.field({
      nullable: true,
      type: 'DateTime',
      resolve: (match) => match.scheduledAt,
    }),
    sets: t.field({
      type: [MatchSetType],
      resolve: (match) => db.matchSet.findMany({
        orderBy: [{ setNumber: 'asc' }, { id: 'asc' }],
        where: { matchId: match.id },
      }),
    }),
    status: t.field({ type: MatchStatusType, resolve: (match) => match.status }),
    teams: t.field({ type: [TeamType], resolve: (match) => teamsForMatch(match.id) }),
    title: t.exposeString('title'),
    venue: t.exposeString('venue', { nullable: true }),
  }),
})

interface CaptureTimelineRange { startUs: bigint; endUs: bigint; discontinuity: number }
interface CaptureTimeline { captureSessionId: string; timelineVersion: bigint; captureStartTimeUs: bigint; liveEdgeCaptureTimeUs: bigint | null; availableRanges: CaptureTimelineRange[] }
interface CaptureSessionView { id: string; matchId: string; sourceLabel: string | null; status: CaptureStatus; health: SourceHealth; startedAt: Date | null; endedAt: Date | null; timeline: CaptureTimeline | null }
export const CaptureTimelineRangeType = builder.objectRef<CaptureTimelineRange>('CaptureTimelineRange')
CaptureTimelineRangeType.implement({ fields: (t) => ({ startUs: t.field({ type: 'BigInt', resolve: (r) => r.startUs }), endUs: t.field({ type: 'BigInt', resolve: (r) => r.endUs }), discontinuity: t.exposeInt('discontinuity') }) })
export const CaptureTimelineType = builder.objectRef<CaptureTimeline>('CaptureTimeline')
CaptureTimelineType.implement({ fields: (t) => ({ captureSessionId: t.exposeID('captureSessionId'), timelineVersion: t.field({ type: 'BigInt', resolve: (r) => r.timelineVersion }), captureStartTimeUs: t.field({ type: 'BigInt', resolve: (r) => r.captureStartTimeUs }), liveEdgeCaptureTimeUs: t.field({ type: 'BigInt', nullable: true, resolve: (r) => r.liveEdgeCaptureTimeUs }), availableRanges: t.field({ type: [CaptureTimelineRangeType], resolve: (r) => r.availableRanges }) }) })
CaptureSessionType.implement({ fields: (t) => ({ id: t.exposeID('id'), matchId: t.exposeID('matchId'), sourceLabel: t.exposeString('sourceLabel', { nullable: true }), status: t.field({ type: CaptureStatusType, resolve: (r) => r.status }), health: t.field({ type: SourceHealthType, resolve: (r) => r.health }), startedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.startedAt }), endedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.endedAt }), timeline: t.field({ type: CaptureTimelineType, nullable: true, resolve: (r) => r.timeline }) }) })
