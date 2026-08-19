import { db } from '@volleyball-monitoring/db'
import { RosterPosition, UserRole } from '@volleyball-monitoring/db/client'
import type { Match, MatchSet, Prisma, Team, MatchStatus } from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from '../graphql/context.js'
import { domainError } from '../graphql/errors.js'
import {
  deriveRallyDisplayOrdinals,
  segmentStartCaptureTimeUs,
} from '../domain/rally-display-order.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export interface RosterSetupInput {
  jerseyNumber: string
  name: string
  position?: RosterPosition | null | undefined
}

export interface TeamSetupInput {
  name: string
  roster: readonly RosterSetupInput[]
  shortName: string
}

export interface CreateMatchSetupInput {
  teams: readonly TeamSetupInput[]
  scheduledAt?: Date | null | undefined
  title: string
  venue?: string | null | undefined
}

export interface SwapCourtSidesInput {
  effectiveFromRallyOrdinal: number
  expectedLeftTeamId: string
  expectedRightTeamId: string
  setId: string
}

export interface RosterEditInput extends RosterSetupInput {
  id?: string | null | undefined
}

export interface UpdateMatchRosterInput {
  matchId: string
  roster: readonly RosterEditInput[]
  teamId: string
}

export interface UpdateMatchClipPolicyInput {
  matchId: string
  preRollSeconds: number
  postRollSeconds: number
}

export interface UpdateMatchInput {
  matchId: string
  scheduledAt?: Date | null | undefined
  status: MatchStatus
  title: string
  venue?: string | null | undefined
}

export interface StartNextSetInput {
  effectiveFromRallyId?: string | null | undefined
  matchId: string
  winningTeamId: string
}

export interface ReopenLastSetInput {
  matchId: string
}

interface NormalizedRosterSetup {
  jerseyNumber: string
  name: string
  position: RosterPosition
}

interface NormalizedTeamSetup {
  name: string
  roster: NormalizedRosterSetup[]
  shortName: string
}

interface NormalizedMatchSetup {
  teams: readonly [NormalizedTeamSetup, NormalizedTeamSetup]
  scheduledAt: Date | null
  title: string
  venue: string | null
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

function comparisonKey(value: string): string {
  return normalizeText(value).toLocaleLowerCase('en-US')
}

function requireText(value: string, field: string): string {
  const normalized = normalizeText(value)
  if (!normalized) {
    domainError(`${field} must not be empty`, 'BAD_USER_INPUT')
  }
  return normalized
}

export function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) {
    domainError(`${field} must be a UUID`, 'BAD_USER_INPUT')
  }
  return value
}

function normalizeTeam(input: TeamSetupInput, field: string): NormalizedTeamSetup {
  const name = requireText(input.name, `${field}.name`)
  const shortName = requireText(input.shortName, `${field}.shortName`)
  const names = new Set<string>()
  const jerseyNumbers = new Set<string>()
  const roster = input.roster.map((row, index) => {
    const rowField = `${field}.roster[${index}]`
    const playerName = requireText(row.name, `${rowField}.name`)
    const jerseyNumber = requireText(row.jerseyNumber, `${rowField}.jerseyNumber`)
    const nameKey = comparisonKey(playerName)
    const jerseyKey = comparisonKey(jerseyNumber)

    if (names.has(nameKey)) {
      domainError(`${field} contains duplicate player names`, 'BAD_USER_INPUT')
    }
    if (jerseyNumbers.has(jerseyKey)) {
      domainError(`${field} contains duplicate jersey numbers`, 'BAD_USER_INPUT')
    }

    names.add(nameKey)
    jerseyNumbers.add(jerseyKey)
    return { name: playerName, jerseyNumber, position: row.position ?? RosterPosition.UNSPECIFIED }
  })

  return { name, shortName, roster }
}

export function normalizeMatchSetup(input: CreateMatchSetupInput): NormalizedMatchSetup {
  const title = requireText(input.title, 'title')
  if (input.teams.length !== 2) domainError('Exactly two teams are required', 'BAD_USER_INPUT')
  const firstTeam = normalizeTeam(input.teams[0]!, 'teams[0]')
  const secondTeam = normalizeTeam(input.teams[1]!, 'teams[1]')

  if (comparisonKey(firstTeam.name) === comparisonKey(secondTeam.name)) {
    domainError('Team names must be distinct', 'BAD_USER_INPUT')
  }
  if (comparisonKey(firstTeam.shortName) === comparisonKey(secondTeam.shortName)) {
    domainError('Team short names must be distinct', 'BAD_USER_INPUT')
  }

  const scheduledAt = input.scheduledAt ?? null
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    domainError('scheduledAt must be a valid DateTime', 'BAD_USER_INPUT')
  }

  const venue = input.venue == null ? null : normalizeText(input.venue) || null
  return { title, venue, scheduledAt, teams: [firstTeam, secondTeam] }
}

function requireSetupRole(actor: AuthenticatedUser): void {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.OPERATOR) {
    domainError('Insufficient role', 'FORBIDDEN')
  }
}

async function createTeamWithRoster(
  tx: Prisma.TransactionClient,
  matchId: string,
  input: NormalizedTeamSetup,
): Promise<Team> {
  const team = await tx.team.create({
    data: { name: input.name, shortName: input.shortName },
  })
  await tx.matchTeam.create({ data: { matchId, teamId: team.id } })

  for (const row of input.roster) {
    const player = await tx.player.create({
      data: { teamId: team.id, name: row.name },
    })
    await tx.matchRosterEntry.create({
      data: {
        displayNameSnapshot: row.name,
        jerseyNumber: row.jerseyNumber,
        position: row.position,
        matchId,
        playerId: player.id,
        teamId: team.id,
      },
    })
  }

  return team
}

export async function createMatchSetup(
  actor: AuthenticatedUser,
  input: CreateMatchSetupInput,
): Promise<Match> {
  requireSetupRole(actor)
  const setup = normalizeMatchSetup(input)

  return db.$transaction(async tx => {
    const match = await tx.match.create({
      data: {
        scheduledAt: setup.scheduledAt,
        title: setup.title,
        venue: setup.venue,
      },
    })
    const firstTeam = await createTeamWithRoster(tx, match.id, setup.teams[0])
    const secondTeam = await createTeamWithRoster(tx, match.id, setup.teams[1])
    await tx.matchMember.create({
      data: { matchId: match.id, role: UserRole.OPERATOR, userId: actor.id },
    })
    const firstSet = await tx.matchSet.create({
      data: { matchId: match.id, setNumber: 1 },
    })
    await tx.courtSideAssignment.create({
      data: {
        effectiveFromRallyOrdinal: 1,
        leftTeamId: firstTeam.id,
        rightTeamId: secondTeam.id,
        setId: firstSet.id,
      },
    })
    return match
  })
}

export function listVisibleMatches(actor: AuthenticatedUser): Promise<Match[]> {
  return db.match.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: {
      deletionRequestedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { members: { some: { userId: actor.id } } }),
    },
  })
}

export function findVisibleMatch(
  actor: AuthenticatedUser,
  rawMatchId: string,
): Promise<Match | null> {
  const matchId = requireUuid(rawMatchId, 'id')
  return db.match.findFirst({
    where: {
      deletionRequestedAt: null,
      id: matchId,
      ...(actor.role === UserRole.ADMIN ? {} : { members: { some: { userId: actor.id } } }),
    },
  })
}

function operatorSetWhere(actor: AuthenticatedUser, setId: string): Prisma.MatchSetWhereInput {
  if (actor.role === UserRole.ADMIN) {
    return { id: setId }
  }
  return {
    id: setId,
    match: {
      members: {
        some: { role: UserRole.OPERATOR, userId: actor.id },
      },
    },
  }
}

export async function updateMatch(
  actor: AuthenticatedUser,
  input: UpdateMatchInput,
): Promise<Match> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  const title = requireText(input.title, 'title')
  const venue = input.venue == null ? null : normalizeText(input.venue) || null
  const scheduledAt = input.scheduledAt ?? null
  if (scheduledAt && Number.isNaN(scheduledAt.getTime()))
    domainError('scheduledAt must be a valid DateTime', 'BAD_USER_INPUT')
  const existing = await db.match.findFirst({
    select: { id: true },
    where: {
      deletionRequestedAt: null,
      id: matchId,
      ...(actor.role === UserRole.ADMIN
        ? {}
        : {
            members: {
              some: { userId: actor.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } },
            },
          }),
    },
  })
  if (!existing) domainError('Match was not found', 'NOT_FOUND')
  return db.match.update({
    data: { scheduledAt, status: input.status, title, venue },
    where: { id: matchId },
  })
}

function clipSecondsToUs(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 30) {
    domainError(`${field} must be an integer between 0 and 30`, 'BAD_USER_INPUT')
  }
  return BigInt(value) * 1_000_000n
}

export async function updateMatchClipPolicy(
  actor: AuthenticatedUser,
  input: UpdateMatchClipPolicyInput,
): Promise<Match> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  const clipPreRollUs = clipSecondsToUs(input.preRollSeconds, 'preRollSeconds')
  const clipPostRollUs = clipSecondsToUs(input.postRollSeconds, 'postRollSeconds')
  const updated = await db.match.updateMany({
    data: { clipPreRollUs, clipPostRollUs },
    where: {
      deletionRequestedAt: null,
      id: matchId,
      ...(actor.role === UserRole.ADMIN
        ? {}
        : { members: { some: { role: UserRole.OPERATOR, userId: actor.id } } }),
    },
  })
  if (updated.count !== 1) domainError('Match not found', 'NOT_FOUND')
  return db.match.findUniqueOrThrow({ where: { id: matchId } })
}

export async function startNextSet(
  actor: AuthenticatedUser,
  input: StartNextSetInput,
): Promise<MatchSet> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  const winningTeamId = requireUuid(input.winningTeamId, 'winningTeamId')
  const effectiveFromRallyId = input.effectiveFromRallyId
    ? requireUuid(input.effectiveFromRallyId, 'effectiveFromRallyId')
    : null
  return db.$transaction(async tx => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${`match-set:${matchId}`}, 0))::text AS locked
    `
    const match = await tx.match.findFirst({
      where: {
        deletionRequestedAt: null,
        id: matchId,
        matchTeams: { some: { teamId: winningTeamId } },
        ...(actor.role === UserRole.ADMIN
          ? {}
          : { members: { some: { role: UserRole.OPERATOR, userId: actor.id } } }),
      },
    })
    if (!match) domainError('Match team not found', 'NOT_FOUND')
    const current = await tx.matchSet.findFirst({
      orderBy: [{ setNumber: 'desc' }, { id: 'desc' }],
      where: { matchId, status: { in: ['LIVE', 'PLANNED'] } },
      include: { sideAssignments: { orderBy: { effectiveFromRallyOrdinal: 'desc' }, take: 1 } },
    })
    if (!current) domainError('Current set not found', 'NOT_FOUND')
    const assignment = current.sideAssignments[0]
    if (!assignment)
      domainError('Current set has no court-side assignment', 'INTERNAL_SERVER_ERROR')
    if (effectiveFromRallyId) {
      const placementRows = await tx.rally.findMany({
        where: { matchId, displaySetNumber: current.setNumber, voidedAt: null },
        select: {
          id: true,
          boundaries: {
            where: { kind: 'START' },
            select: { captureTimeUs: true, kind: true },
          },
          keyPoints: {
            where: { deletedAt: null },
            select: { captureTimeUs: true, markerKind: true },
          },
          activeSubmission: {
            select: {
              boundaries: {
                where: { kind: 'START' },
                select: { captureTimeUs: true, kind: true },
              },
              keyPoints: {
                select: { captureTimeUs: true, markerKind: true },
              },
            },
          },
        },
      })
      const displayOrdinals = deriveRallyDisplayOrdinals(
        placementRows.map(row => ({
          displaySetNumber: current.setNumber,
          id: row.id,
          startCaptureTimeUs:
            segmentStartCaptureTimeUs(row) ?? segmentStartCaptureTimeUs(row.activeSubmission ?? {}),
        })),
      )
      const boundaryOrdinal = displayOrdinals.get(effectiveFromRallyId)
      if (!boundaryOrdinal)
        domainError(
          '選取回合不在目前局；請先選取目前局的回合。若前一個勝局標錯，請先撤銷最近勝局標記。',
          'BAD_USER_INPUT',
        )
      const suffixIds = placementRows
        .filter(row => (displayOrdinals.get(row.id) ?? 0) > boundaryOrdinal)
        .map(row => row.id)
      if (suffixIds.length) {
        await tx.rally.updateMany({
          data: { displaySetNumber: current.setNumber + 1 },
          where: { id: { in: suffixIds } },
        })
      }
    }
    await tx.matchSet.update({
      data: { endedAt: new Date(), status: 'FINISHED', winningTeamId },
      where: { id: current.id },
    })
    const next = await tx.matchSet.create({
      data: { matchId, setNumber: current.setNumber + 1, status: 'LIVE', startedAt: new Date() },
    })
    await tx.courtSideAssignment.create({
      data: {
        effectiveFromRallyOrdinal: 1,
        leftTeamId: assignment.leftTeamId,
        rightTeamId: assignment.rightTeamId,
        setId: next.id,
      },
    })
    return next
  })
}

export async function reopenLastSet(
  actor: AuthenticatedUser,
  input: ReopenLastSetInput,
): Promise<MatchSet> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  return db.$transaction(async tx => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${`match-set:${matchId}`}, 0))::text AS locked
    `
    const match = await tx.match.findFirst({
      where: {
        deletionRequestedAt: null,
        id: matchId,
        ...(actor.role === UserRole.ADMIN
          ? {}
          : { members: { some: { role: UserRole.OPERATOR, userId: actor.id } } }),
      },
    })
    if (!match) domainError('Match not found', 'NOT_FOUND')

    const current = await tx.matchSet.findFirst({
      orderBy: [{ setNumber: 'desc' }, { id: 'desc' }],
      where: { matchId, status: 'LIVE' },
    })
    if (!current || current.setNumber <= 1)
      domainError('No reversible set winner marker found', 'BAD_USER_INPUT')

    const previous = await tx.matchSet.findUnique({
      where: { matchId_setNumber: { matchId, setNumber: current.setNumber - 1 } },
    })
    if (!previous || previous.status !== 'FINISHED' || !previous.winningTeamId)
      domainError('Previous set has no winner marker to reopen', 'BAD_USER_INPUT')

    const [currentRallyCount, currentPointAwardCount, currentLedgerCount] = await Promise.all([
      tx.rally.count({ where: { setId: current.id, voidedAt: null } }),
      tx.pointAward.count({ where: { setId: current.id } }),
      tx.scoreLedgerEntry.count({ where: { setId: current.id } }),
    ])
    if (currentRallyCount || currentPointAwardCount || currentLedgerCount) {
      domainError(
        '下一局已有新的標註或比分資料，為避免覆蓋內容，無法撤銷勝局標記',
        'BAD_USER_INPUT',
      )
    }

    await tx.rally.updateMany({
      data: { displaySetNumber: previous.setNumber },
      where: {
        displaySetNumber: current.setNumber,
        matchId,
        setId: previous.id,
        voidedAt: null,
      },
    })
    await tx.matchSet.update({
      data: { endedAt: null, status: 'LIVE', winningTeamId: null },
      where: { id: previous.id },
    })
    await tx.matchSet.delete({ where: { id: current.id } })
    return tx.matchSet.findUniqueOrThrow({ where: { id: previous.id } })
  })
}

export async function updateMatchRoster(
  actor: AuthenticatedUser,
  input: UpdateMatchRosterInput,
): Promise<Match> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  const teamId = requireUuid(input.teamId, 'teamId')
  const normalized = normalizeTeam(
    { name: 'roster', shortName: 'roster', roster: input.roster },
    'roster',
  ).roster

  return db.$transaction(async tx => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${`match-roster:${matchId}:${teamId}`}, 0))::text AS locked
    `
    const match = await tx.match.findFirst({
      where: {
        deletionRequestedAt: null,
        id: matchId,
        matchTeams: { some: { teamId } },
        ...(actor.role === UserRole.ADMIN
          ? {}
          : { members: { some: { role: UserRole.OPERATOR, userId: actor.id } } }),
      },
    })
    if (!match) domainError('Match team not found', 'NOT_FOUND')

    const existing = await tx.matchRosterEntry.findMany({ where: { matchId, teamId } })
    const byId = new Map(existing.map(entry => [entry.id, entry]))
    const requestedIds = new Set<string>()
    for (const [index, row] of input.roster.entries()) {
      if (!row.id) continue
      const id = requireUuid(row.id, `roster[${index}].id`)
      if (!byId.has(id))
        domainError('Roster entry does not belong to this match team', 'BAD_USER_INPUT')
      if (requestedIds.has(id)) domainError('Roster contains duplicate entry IDs', 'BAD_USER_INPUT')
      requestedIds.add(id)
    }

    // The database enforces jersey uniqueness only for active rows. Temporarily
    // deactivate the current team so jersey swaps stay atomic while historical
    // roster snapshots and identity assignments retain their original values.
    for (const entry of existing) {
      await tx.matchRosterEntry.update({
        data: { active: false },
        where: { id: entry.id },
      })
    }

    for (const [index, row] of normalized.entries()) {
      const requested = input.roster[index]
      const existingEntry = requested?.id ? byId.get(requested.id) : undefined
      if (existingEntry) {
        await tx.matchRosterEntry.update({
          data: {
            active: true,
            displayNameSnapshot: row.name,
            jerseyNumber: row.jerseyNumber,
            position: requested?.position ?? existingEntry.position,
          },
          where: { id: existingEntry.id },
        })
        if (existingEntry.playerId) {
          await tx.player.update({
            data: { name: row.name },
            where: { id: existingEntry.playerId },
          })
        }
        continue
      }

      const player = await tx.player.create({ data: { name: row.name, teamId } })
      await tx.matchRosterEntry.create({
        data: {
          active: true,
          displayNameSnapshot: row.name,
          jerseyNumber: row.jerseyNumber,
          position: row.position,
          matchId,
          playerId: player.id,
          teamId,
        },
      })
    }
    return match
  })
}

export async function swapCourtSides(
  actor: AuthenticatedUser,
  input: SwapCourtSidesInput,
): Promise<MatchSet> {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.OPERATOR) {
    domainError('Insufficient role', 'FORBIDDEN')
  }
  if (!Number.isInteger(input.effectiveFromRallyOrdinal) || input.effectiveFromRallyOrdinal < 1) {
    domainError('effectiveFromRallyOrdinal must be a positive integer', 'BAD_USER_INPUT')
  }

  const setId = requireUuid(input.setId, 'setId')
  const expectedLeftTeamId = requireUuid(input.expectedLeftTeamId, 'expectedLeftTeamId')
  const expectedRightTeamId = requireUuid(input.expectedRightTeamId, 'expectedRightTeamId')
  return db.$transaction(async tx => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`court-side-assignment:${setId}`}, 0)
      )::text AS locked
    `
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-set:${setId}`}, 0))::text AS locked
    `

    const matchSet = await tx.matchSet.findFirst({ where: operatorSetWhere(actor, setId) })
    if (!matchSet) {
      domainError('Set not found', 'NOT_FOUND')
    }

    const assignments = await tx.courtSideAssignment.findMany({
      orderBy: { effectiveFromRallyOrdinal: 'asc' },
      where: { setId },
    })
    const target = assignments.find(
      assignment =>
        assignment.effectiveFromRallyOrdinal <= input.effectiveFromRallyOrdinal &&
        (assignment.effectiveToRallyOrdinal === null ||
          assignment.effectiveToRallyOrdinal >= input.effectiveFromRallyOrdinal),
    )
    const current = assignments.find(assignment => assignment.effectiveToRallyOrdinal === null)
    if (!target || !current) {
      domainError('Set has no current court-side assignment', 'INTERNAL_SERVER_ERROR')
    }
    if (target.leftTeamId !== expectedLeftTeamId || target.rightTeamId !== expectedRightTeamId) {
      domainError('Court-side assignment changed; refresh before swapping again', 'BAD_USER_INPUT')
    }

    const affectedRallies = await tx.rally.findMany({
      select: {
        id: true,
        ordinal: true,
        scoreResolutionState: true,
        scoringCourtSide: true,
        sideAssignmentReversed: true,
      },
      where: { setId, ordinal: { gte: input.effectiveFromRallyOrdinal }, voidedAt: null },
    })

    const assignmentFor = <T extends (typeof assignments)[number]>(
      rows: readonly T[],
      ordinal: number,
    ) =>
      rows.find(
        assignment =>
          assignment.effectiveFromRallyOrdinal <= ordinal &&
          (assignment.effectiveToRallyOrdinal === null ||
            assignment.effectiveToRallyOrdinal >= ordinal),
      )
    const effectiveTeams = (assignment: (typeof assignments)[number], reversed: boolean) =>
      reversed
        ? { leftTeamId: assignment.rightTeamId, rightTeamId: assignment.leftTeamId }
        : { leftTeamId: assignment.leftTeamId, rightTeamId: assignment.rightTeamId }
    const scoringTeamFor = (
      assignment: (typeof assignments)[number] | undefined,
      reversed: boolean,
      scoringCourtSide: 'LEFT' | 'RIGHT' | null,
    ) => {
      if (!assignment || !scoringCourtSide) return null
      const teams = effectiveTeams(assignment, reversed)
      return scoringCourtSide === 'LEFT' ? teams.leftTeamId : teams.rightTeamId
    }

    const assignmentAtTarget = assignments.find(
      assignment => assignment.effectiveFromRallyOrdinal === input.effectiveFromRallyOrdinal,
    )
    if (assignmentAtTarget) {
      for (const assignment of assignments.filter(
        entry => entry.effectiveFromRallyOrdinal >= input.effectiveFromRallyOrdinal,
      )) {
        await tx.courtSideAssignment.update({
          data: { leftTeamId: assignment.rightTeamId, rightTeamId: assignment.leftTeamId },
          where: { id: assignment.id },
        })
      }
    } else {
      await tx.courtSideAssignment.update({
        data: { effectiveToRallyOrdinal: input.effectiveFromRallyOrdinal - 1 },
        where: { id: target.id },
      })
      await tx.courtSideAssignment.create({
        data: {
          effectiveFromRallyOrdinal: input.effectiveFromRallyOrdinal,
          effectiveToRallyOrdinal: target.effectiveToRallyOrdinal,
          leftTeamId: target.rightTeamId,
          rightTeamId: target.leftTeamId,
          setId,
        },
      })
      for (const assignment of assignments.filter(
        entry => entry.effectiveFromRallyOrdinal > input.effectiveFromRallyOrdinal,
      )) {
        await tx.courtSideAssignment.update({
          data: { leftTeamId: assignment.rightTeamId, rightTeamId: assignment.leftTeamId },
          where: { id: assignment.id },
        })
      }
    }

    const nextAssignments = await tx.courtSideAssignment.findMany({
      orderBy: { effectiveFromRallyOrdinal: 'asc' },
      where: { setId },
    })
    const nextCurrent = nextAssignments.find(
      assignment => assignment.effectiveToRallyOrdinal === null,
    )
    if (!nextCurrent) {
      domainError('Set has no current court-side assignment', 'INTERNAL_SERVER_ERROR')
    }

    const scoreByTeam = new Map<string, number>([
      [current.leftTeamId, matchSet.leftScore],
      [current.rightTeamId, matchSet.rightScore],
    ])
    for (const rally of affectedRallies) {
      const beforeAssignment = assignmentFor(assignments, rally.ordinal)
      const afterAssignment = assignmentFor(nextAssignments, rally.ordinal)
      if (!afterAssignment) {
        domainError('Rally has no court-side assignment at its ordinal', 'INTERNAL_SERVER_ERROR')
      }
      const beforeScoringTeam = scoringTeamFor(
        beforeAssignment,
        rally.sideAssignmentReversed,
        rally.scoringCourtSide,
      )
      const afterScoringTeam = scoringTeamFor(
        afterAssignment,
        rally.sideAssignmentReversed,
        rally.scoringCourtSide,
      )
      if (
        rally.scoreResolutionState === 'RESOLVED' &&
        beforeScoringTeam &&
        afterScoringTeam &&
        beforeScoringTeam !== afterScoringTeam
      ) {
        scoreByTeam.set(beforeScoringTeam, (scoreByTeam.get(beforeScoringTeam) ?? 0) - 1)
        scoreByTeam.set(afterScoringTeam, (scoreByTeam.get(afterScoringTeam) ?? 0) + 1)
      }
      await tx.rally.update({
        data: {
          scoringTeamId: afterScoringTeam,
          sideAssignmentId: afterAssignment.id,
        },
        where: { id: rally.id },
      })
    }

    const changed = await tx.matchSet.updateMany({
      data: {
        leftScore: scoreByTeam.get(nextCurrent.leftTeamId) ?? 0,
        rightScore: scoreByTeam.get(nextCurrent.rightTeamId) ?? 0,
        scoreRevision: { increment: 1 },
      },
      where: { id: matchSet.id, scoreRevision: matchSet.scoreRevision },
    })
    if (changed.count !== 1) {
      domainError('Set score changed while swapping court sides', 'BAD_USER_INPUT')
    }
    return tx.matchSet.findUniqueOrThrow({ where: { id: matchSet.id } })
  })
}
