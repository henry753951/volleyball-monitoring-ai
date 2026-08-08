import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type {
  Match,
  MatchSet,
  Prisma,
  Team,
} from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from '../graphql/context.js'
import { domainError } from '../graphql/errors.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export interface RosterSetupInput {
  jerseyNumber: string
  name: string
}

export interface TeamSetupInput {
  name: string
  roster: readonly RosterSetupInput[]
  shortName: string
}

export interface CreateMatchSetupInput {
  leftTeam: TeamSetupInput
  rightTeam: TeamSetupInput
  scheduledAt?: Date | null | undefined
  title: string
  venue?: string | null | undefined
}

export interface SwapCourtSidesInput {
  effectiveFromRallyOrdinal: number
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

export interface StartNextSetInput {
  matchId: string
  winningTeamId: string
}

interface NormalizedRosterSetup {
  jerseyNumber: string
  name: string
}

interface NormalizedTeamSetup {
  name: string
  roster: NormalizedRosterSetup[]
  shortName: string
}

interface NormalizedMatchSetup {
  leftTeam: NormalizedTeamSetup
  rightTeam: NormalizedTeamSetup
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
    return { name: playerName, jerseyNumber }
  })

  return { name, shortName, roster }
}

export function normalizeMatchSetup(input: CreateMatchSetupInput): NormalizedMatchSetup {
  const title = requireText(input.title, 'title')
  const leftTeam = normalizeTeam(input.leftTeam, 'leftTeam')
  const rightTeam = normalizeTeam(input.rightTeam, 'rightTeam')

  if (comparisonKey(leftTeam.name) === comparisonKey(rightTeam.name)) {
    domainError('Team names must be distinct', 'BAD_USER_INPUT')
  }
  if (comparisonKey(leftTeam.shortName) === comparisonKey(rightTeam.shortName)) {
    domainError('Team short names must be distinct', 'BAD_USER_INPUT')
  }

  const scheduledAt = input.scheduledAt ?? null
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    domainError('scheduledAt must be a valid DateTime', 'BAD_USER_INPUT')
  }

  const venue = input.venue == null ? null : normalizeText(input.venue) || null
  return { title, venue, scheduledAt, leftTeam, rightTeam }
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

  return db.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        scheduledAt: setup.scheduledAt,
        title: setup.title,
        venue: setup.venue,
      },
    })
    const leftTeam = await createTeamWithRoster(tx, match.id, setup.leftTeam)
    const rightTeam = await createTeamWithRoster(tx, match.id, setup.rightTeam)
    await tx.matchMember.create({
      data: { matchId: match.id, role: UserRole.OPERATOR, userId: actor.id },
    })
    const firstSet = await tx.matchSet.create({
      data: { matchId: match.id, setNumber: 1 },
    })
    await tx.courtSideAssignment.create({
      data: {
        effectiveFromRallyOrdinal: 1,
        leftTeamId: leftTeam.id,
        rightTeamId: rightTeam.id,
        setId: firstSet.id,
      },
    })
    return match
  })
}

export function listVisibleMatches(actor: AuthenticatedUser): Promise<Match[]> {
  return db.match.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(actor.role === UserRole.ADMIN
      ? {}
      : { where: { members: { some: { userId: actor.id } } } }),
  })
}

export function findVisibleMatch(
  actor: AuthenticatedUser,
  rawMatchId: string,
): Promise<Match | null> {
  const matchId = requireUuid(rawMatchId, 'id')
  return db.match.findFirst({
    where: {
      id: matchId,
      ...(actor.role === UserRole.ADMIN
        ? {}
        : { members: { some: { userId: actor.id } } }),
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
  return db.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${`match-set:${matchId}`}, 0))::text AS locked
    `
    const match = await tx.match.findFirst({
      where: {
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
    const openDraft = await tx.rally.findFirst({
      select: { id: true },
      where: { setId: current.id, voidedAt: null, annotationStatus: { in: ['OPEN', 'READY'] } },
    })
    if (openDraft) domainError('Finish or discard the editable segment before starting a new set', 'BAD_USER_INPUT')
    const assignment = current.sideAssignments[0]
    if (!assignment) domainError('Current set has no court-side assignment', 'INTERNAL_SERVER_ERROR')
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

export async function updateMatchRoster(
  actor: AuthenticatedUser,
  input: UpdateMatchRosterInput,
): Promise<Match> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  const teamId = requireUuid(input.teamId, 'teamId')
  const normalized = normalizeTeam({ name: 'roster', shortName: 'roster', roster: input.roster }, 'roster').roster

  return db.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${`match-roster:${matchId}:${teamId}`}, 0))::text AS locked
    `
    const match = await tx.match.findFirst({
      where: {
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
      if (!byId.has(id)) domainError('Roster entry does not belong to this match team', 'BAD_USER_INPUT')
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
          data: { active: true, displayNameSnapshot: row.name, jerseyNumber: row.jerseyNumber },
          where: { id: existingEntry.id },
        })
        if (existingEntry.playerId) {
          await tx.player.update({ data: { name: row.name }, where: { id: existingEntry.playerId } })
        }
        continue
      }

      const player = await tx.player.create({ data: { name: row.name, teamId } })
      await tx.matchRosterEntry.create({
        data: {
          active: true,
          displayNameSnapshot: row.name,
          jerseyNumber: row.jerseyNumber,
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
  if (!Number.isInteger(input.effectiveFromRallyOrdinal)
    || input.effectiveFromRallyOrdinal < 1) {
    domainError('effectiveFromRallyOrdinal must be a positive integer', 'BAD_USER_INPUT')
  }

  const setId = requireUuid(input.setId, 'setId')
  return db.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`court-side-assignment:${setId}`}, 0)
      )::text AS locked
    `

    const matchSet = await tx.matchSet.findFirst({ where: operatorSetWhere(actor, setId) })
    if (!matchSet) {
      domainError('Set not found', 'NOT_FOUND')
    }

    const current = await tx.courtSideAssignment.findFirst({
      orderBy: { effectiveFromRallyOrdinal: 'desc' },
      where: { effectiveToRallyOrdinal: null, setId },
    })
    if (!current) {
      domainError('Set has no current court-side assignment', 'INTERNAL_SERVER_ERROR')
    }
    if (input.effectiveFromRallyOrdinal <= current.effectiveFromRallyOrdinal) {
      domainError('effectiveFromRallyOrdinal must advance the current assignment', 'BAD_USER_INPUT')
    }

    await tx.courtSideAssignment.update({
      data: { effectiveToRallyOrdinal: input.effectiveFromRallyOrdinal - 1 },
      where: { id: current.id },
    })
    await tx.courtSideAssignment.create({
      data: {
        effectiveFromRallyOrdinal: input.effectiveFromRallyOrdinal,
        leftTeamId: current.rightTeamId,
        rightTeamId: current.leftTeamId,
        setId,
      },
    })
    return matchSet
  })
}
