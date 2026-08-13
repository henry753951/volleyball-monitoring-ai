import { db } from '@volleyball-monitoring/db'
import {
  AnnotationStatus,
  CourtSide,
  MatchStatus,
  ProcessingStatus,
  RosterPosition,
  ScoreResolutionState,
  SetStatus,
  UserRole,
} from '@volleyball-monitoring/db/client'
import type {
  CourtSideAssignment,
  Match,
  MatchRosterEntry,
  MatchSet,
  Player,
  Rally,
  Team,
} from '@volleyball-monitoring/db/client'
import { CaptureStatus, SourceHealth } from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from './context.js'
import { builder } from './builder.js'
import { domainError } from './errors.js'
import {
  listCaptureSessionsForMatch,
  type CaptureSessionView,
  type CaptureTimelineRangeView,
  type CaptureTimelineView,
} from '../services/media-timeline.js'
import type { ProcessingStateView } from '../services/capture-processing.js'
import type { MatchDeleteReceipt } from '../services/match-administration.js'
import {
  getDerivedRallyDisplayOrdinal,
  type RallyDeleteReceipt,
  type RallyPlacementResult,
} from '../services/rally-administration.js'

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
export const RosterPositionType = builder.enumType(RosterPosition, { name: 'RosterPosition' })
export const SetStatusType = builder.enumType(SetStatus, { name: 'SetStatus' })
export const CaptureStatusType = builder.enumType(CaptureStatus, { name: 'CaptureStatus' })
export const SourceHealthType = builder.enumType(SourceHealth, { name: 'SourceHealth' })
export const AnnotationStatusType = builder.enumType(AnnotationStatus, { name: 'AnnotationStatus' })
export const ProcessingStatusType = builder.enumType(ProcessingStatus, { name: 'ProcessingStatus' })
export const ScoreResolutionStateType = builder.enumType(ScoreResolutionState, { name: 'ScoreResolutionState' })
export const CourtSideType = builder.enumType(CourtSide, { name: 'CourtSide' })

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

export const MatchDeleteReceiptType = builder.objectRef<MatchDeleteReceipt>('MatchDeleteReceipt')
MatchDeleteReceiptType.implement({
  fields: (t) => ({
    cleanupWarnings: t.exposeStringList('cleanupWarnings'),
    matchId: t.exposeID('matchId'),
    removedAssetCount: t.exposeInt('removedAssetCount'),
    removedBytes: t.exposeString('removedBytes'),
  }),
})

export const RallyDeleteReceiptType = builder.objectRef<RallyDeleteReceipt>('RallyDeleteReceipt')
RallyDeleteReceiptType.implement({
  fields: (t) => ({
    abortedJobCount: t.exposeInt('abortedJobCount'),
    cleanupWarnings: t.exposeStringList('cleanupWarnings'),
    matchId: t.exposeID('matchId'),
    rallyId: t.exposeID('rallyId'),
    removedAssetCount: t.exposeInt('removedAssetCount'),
    removedBytes: t.exposeString('removedBytes'),
  }),
})

export const RallyPlacementType = builder.objectRef<RallyPlacementResult>('RallyPlacement')
RallyPlacementType.implement({
  fields: (t) => ({
    displayOrdinal: t.exposeInt('displayOrdinal'),
    displaySetNumber: t.exposeInt('displaySetNumber'),
    matchId: t.exposeID('matchId'),
    rallyId: t.exposeID('rallyId'),
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
    position: t.field({ type: RosterPositionType, resolve: (entry) => entry.position }),
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
    winningTeamId: t.exposeID('winningTeamId', { nullable: true }),
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

export const RallyType = builder.objectRef<Rally>('Rally')
RallyType.implement({
  fields: (t) => ({
    activeSubmissionId: t.exposeID('activeSubmissionId', { nullable: true }),
    annotationRevision: t.field({ type: 'BigInt', resolve: rally => rally.annotationRevision }),
    annotationStatus: t.field({ type: AnnotationStatusType, resolve: rally => rally.annotationStatus }),
    displayOrdinal: t.int({
      resolve: rally => getDerivedRallyDisplayOrdinal(db, rally.matchId, rally.id),
    }),
    displaySetNumber: t.exposeInt('displaySetNumber'),
    id: t.exposeID('id'),
    matchId: t.exposeID('matchId'),
    processingStatus: t.field({ type: ProcessingStatusType, resolve: rally => rally.processingStatus }),
    scoreResolutionState: t.field({ type: ScoreResolutionStateType, resolve: rally => rally.scoreResolutionState }),
    scoringCourtSide: t.field({ type: CourtSideType, nullable: true, resolve: rally => rally.scoringCourtSide }),
    setId: t.exposeID('setId'),
  }),
})

export const ProcessingStateType = builder.objectRef<ProcessingStateView>('ProcessingState')
ProcessingStateType.implement({
  fields: (t) => ({
    rallyId: t.exposeID('rallyId'),
    retriedStage: t.exposeString('retriedStage'),
    status: t.field({ type: ProcessingStatusType, resolve: state => state.status }),
    submissionId: t.exposeID('submissionId'),
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
    clipPostRollUs: t.field({ type: 'BigInt', resolve: match => match.clipPostRollUs }),
    clipPreRollUs: t.field({ type: 'BigInt', resolve: match => match.clipPreRollUs }),
    captureSessions: t.field({ type: [CaptureSessionType], resolve: (match) => listCaptureSessionsForMatch(match.id) }),
    rosterEntries: t.field({
      type: [MatchRosterEntryType],
      resolve: (match) => db.matchRosterEntry.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { active: true, matchId: match.id },
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

export const CaptureTimelineRangeType = builder.objectRef<CaptureTimelineRangeView>(
  'CaptureTimelineRange',
)
CaptureTimelineRangeType.implement({
  fields: (t) => ({
    discontinuity: t.exposeInt('discontinuity'),
    endUs: t.field({ type: 'BigInt', resolve: (range) => range.endUs }),
    startUs: t.field({ type: 'BigInt', resolve: (range) => range.startUs }),
  }),
})

export const CaptureTimelineType = builder.objectRef<CaptureTimelineView>('CaptureTimeline')
CaptureTimelineType.implement({
  fields: (t) => ({
    availableRanges: t.field({
      type: [CaptureTimelineRangeType],
      resolve: (timeline) => timeline.availableRanges,
    }),
    availabilityComplete: t.exposeBoolean('availabilityComplete'),
    captureSessionId: t.exposeID('captureSessionId'),
    captureStartTimeUs: t.field({
      type: 'BigInt',
      resolve: (timeline) => timeline.captureStartTimeUs,
    }),
    gapRanges: t.field({
      type: [CaptureTimelineRangeType],
      resolve: (timeline) => timeline.gapRanges,
    }),
    ingestFrontierCaptureTimeUs: t.field({
      nullable: true,
      type: 'BigInt',
      resolve: (timeline) => timeline.ingestFrontierCaptureTimeUs,
    }),
    liveEdgeCaptureTimeUs: t.field({
      nullable: true,
      type: 'BigInt',
      resolve: (timeline) => timeline.liveEdgeCaptureTimeUs,
    }),
    sourceEndCaptureTimeUs: t.field({
      nullable: true,
      type: 'BigInt',
      resolve: (timeline) => timeline.sourceEndCaptureTimeUs,
    }),
    timelineVersion: t.field({
      type: 'BigInt',
      resolve: (timeline) => timeline.timelineVersion,
    }),
  }),
})

CaptureSessionType.implement({
  fields: (t) => ({
    endedAt: t.field({
      nullable: true,
      type: 'DateTime',
      resolve: (session) => session.endedAt,
    }),
    health: t.field({ type: SourceHealthType, resolve: (session) => session.health }),
    id: t.exposeID('id'),
    matchId: t.exposeID('matchId'),
    sourceLabel: t.exposeString('sourceLabel', { nullable: true }),
    sourceDurationUs: t.field({
      nullable: true,
      type: 'BigInt',
      resolve: (session) => session.sourceDurationUs,
    }),
    sourceKind: t.exposeString('sourceKind'),
    startedAt: t.field({
      nullable: true,
      type: 'DateTime',
      resolve: (session) => session.startedAt,
    }),
    status: t.field({ type: CaptureStatusType, resolve: (session) => session.status }),
    timeline: t.field({
      nullable: true,
      type: CaptureTimelineType,
      resolve: (session) => session.timeline,
    }),
  }),
})
