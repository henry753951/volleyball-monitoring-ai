import { db } from '@volleyball-monitoring/db'
import { RosterPosition, UserRole } from '@volleyball-monitoring/db/client'
import type { Match, MatchSet, Prisma, Team, MatchStatus } from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from '../graphql/context.js'
import { domainError } from '../graphql/errors.js'
import { segmentStartCaptureTimeUs } from '../domain/rally-display-order.js'
import { projectCanonicalMatch } from './canonical-match-projection.js'

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
  effectiveFromRallyId?: string | null | undefined
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
  setId?: string | null | undefined
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
    const [rawSets, placementRows, courtSideBoundaries] = await Promise.all([
      tx.matchSet.findMany({
        orderBy: [{ setNumber: 'asc' }, { id: 'asc' }],
        where: { matchId },
        include: {
          sideAssignments: {
            orderBy: [{ effectiveFromRallyOrdinal: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      }),
      tx.rally.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { matchId, voidedAt: null },
        select: {
          id: true,
          ordinal: true,
          createdAt: true,
          scoreResolutionState: true,
          scoringCourtSide: true,
          scoringTeamId: true,
          setId: true,
          set: { select: { setNumber: true } },
          sideAssignmentReversed: true,
          sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
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
              scoreResolutionState: true,
              scoringCourtSide: true,
              scoringTeamId: true,
              leftTeamId: true,
              rightTeamId: true,
              sideAssignmentReversed: true,
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
      }),
      tx.courtSideSwapMarker.findMany({
        where: { matchId },
        select: {
          id: true,
          effectiveRallyId: true,
          leftTeamId: true,
          rightTeamId: true,
        },
      }),
    ])
    const projection = projectCanonicalMatch({
      sets: rawSets,
      courtSideBoundaries,
      segments: placementRows.map(row => ({
        id: row.id,
        rawSetNumber: row.set.setNumber,
        rawOrdinal: row.ordinal,
        startCaptureTimeUs:
          segmentStartCaptureTimeUs(row) ?? segmentStartCaptureTimeUs(row.activeSubmission ?? {}),
        createdAt: row.createdAt,
        submitted: Boolean(row.activeSubmission),
        scoreResolutionState:
          row.activeSubmission?.scoreResolutionState ?? row.scoreResolutionState,
        scoringCourtSide: row.scoringCourtSide ?? row.activeSubmission?.scoringCourtSide ?? null,
        scoringTeamId: row.scoringTeamId ?? row.activeSubmission?.scoringTeamId ?? null,
        baseLeftTeamId: row.sideAssignment?.leftTeamId ?? row.activeSubmission?.leftTeamId ?? null,
        baseRightTeamId:
          row.sideAssignment?.rightTeamId ?? row.activeSubmission?.rightTeamId ?? null,
        sideAssignmentReversed: row.sideAssignment
          ? row.sideAssignmentReversed
          : (row.activeSubmission?.sideAssignmentReversed ?? false),
      })),
    })
    const winnerRallyId = effectiveFromRallyId ?? projection.orderedSegmentIds.at(-1) ?? null
    const winnerRally = winnerRallyId ? placementRows.find(row => row.id === winnerRallyId) : null
    const winnerProjection = winnerRallyId ? projection.segmentById.get(winnerRallyId) : null
    if (!winnerRally || !winnerProjection) domainError('請先選取本局最後一個回合', 'BAD_USER_INPUT')
    if (winnerProjection.endsSet) {
      if (winnerProjection.winningTeamId !== winningTeamId)
        domainError('這個回合已經有不同的勝局結果；請先刪除原勝局標記', 'BAD_USER_INPUT')
    }
    if (winnerProjection.scoringTeamId && winnerProjection.scoringTeamId !== winningTeamId)
      domainError('最後一回合的得分方與勝局隊伍不同，請先修正回合得分', 'BAD_USER_INPUT')

    const markerSet = rawSets.find(set => set.id === winnerRally.setId)
    if (!markerSet) domainError('Selected rally set not found', 'NOT_FOUND')
    if (markerSet.winningRallyId && markerSet.winningRallyId !== winnerRally.id)
      domainError('這個資料列已有另一個勝局標記；請先刪除原勝局標記', 'BAD_USER_INPUT')
    await tx.matchSet.update({
      data: {
        endedAt: new Date(),
        status: 'FINISHED',
        winningRallyId: winnerRally.id,
        winningTeamId,
      },
      where: { id: markerSet.id },
    })
    const nextExisting = rawSets.find(
      set => set.setNumber > markerSet.setNumber && !set.winningTeamId,
    )
    const next = nextExisting
      ? await tx.matchSet.update({
          data: { status: 'LIVE', startedAt: nextExisting.startedAt ?? new Date() },
          where: { id: nextExisting.id },
        })
      : await tx.matchSet.create({
          data: {
            matchId,
            setNumber: Math.max(...rawSets.map(set => set.setNumber), 0) + 1,
            status: 'LIVE',
            startedAt: new Date(),
          },
        })
    const nextAssignment = nextExisting?.sideAssignments[0]
    if (!nextAssignment) {
      const leftTeamId = winnerProjection.leftTeamId
      const rightTeamId = winnerProjection.rightTeamId
      if (!leftTeamId || !rightTeamId)
        domainError('Winner rally has no court-side assignment', 'INTERNAL_SERVER_ERROR')
      await tx.courtSideAssignment.create({
        data: {
          effectiveFromRallyOrdinal: 1,
          leftTeamId,
          rightTeamId,
          setId: next.id,
        },
      })
    }
    return next
  })
}

export async function reopenLastSet(
  actor: AuthenticatedUser,
  input: ReopenLastSetInput,
): Promise<MatchSet> {
  requireSetupRole(actor)
  const matchId = requireUuid(input.matchId, 'matchId')
  const setId = input.setId ? requireUuid(input.setId, 'setId') : null
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

    const winnerMarker = setId
      ? await tx.matchSet.findFirst({
          where: { id: setId, matchId, winningTeamId: { not: null } },
        })
      : await tx.matchSet.findFirst({
          orderBy: [{ setNumber: 'desc' }, { id: 'desc' }],
          where: { matchId, winningTeamId: { not: null } },
        })
    if (!winnerMarker) domainError('Set winner marker not found', 'BAD_USER_INPUT')

    // A winner is an independent result marker. Clearing it must never
    // rewrite set placement or remove any rally, point, or annotation data.
    return tx.matchSet.update({
      data: {
        endedAt: null,
        status: 'LIVE',
        winningRallyId: null,
        winningTeamId: null,
      },
      where: { id: winnerMarker.id },
    })
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
  const effectiveFromRallyId = input.effectiveFromRallyId
    ? requireUuid(input.effectiveFromRallyId, 'effectiveFromRallyId')
    : null
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
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`court-side-match:${matchSet.matchId}`}, 0)
      )::text AS locked
    `

    const [sets, projectionRows, courtSideBoundaries] = await Promise.all([
      tx.matchSet.findMany({
        where: { matchId: matchSet.matchId },
        select: {
          id: true,
          setNumber: true,
          status: true,
          winningTeamId: true,
          winningRallyId: true,
        },
      }),
      tx.rally.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { matchId: matchSet.matchId, voidedAt: null },
        select: {
          id: true,
          ordinal: true,
          createdAt: true,
          scoreResolutionState: true,
          scoringCourtSide: true,
          scoringTeamId: true,
          setId: true,
          set: { select: { setNumber: true } },
          sideAssignmentReversed: true,
          sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
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
              scoreResolutionState: true,
              scoringCourtSide: true,
              scoringTeamId: true,
              leftTeamId: true,
              rightTeamId: true,
              boundaries: {
                where: { kind: 'START' },
                select: { captureTimeUs: true, kind: true },
              },
              keyPoints: { select: { captureTimeUs: true, markerKind: true } },
            },
          },
        },
      }),
      tx.courtSideSwapMarker.findMany({
        where: { matchId: matchSet.matchId },
        select: {
          id: true,
          effectiveRallyId: true,
          leftTeamId: true,
          rightTeamId: true,
        },
      }),
    ])
    const selectedRally = effectiveFromRallyId
      ? projectionRows.find(rally => rally.id === effectiveFromRallyId)
      : projectionRows.find(
          rally => rally.setId === setId && rally.ordinal === input.effectiveFromRallyOrdinal,
        )
    if (!selectedRally) {
      domainError('選取回合已不存在；請重新整理後再換場', 'BAD_USER_INPUT')
    }

    const projection = projectCanonicalMatch({
      sets,
      courtSideBoundaries,
      segments: projectionRows.map(rally => ({
        id: rally.id,
        rawSetNumber: rally.set.setNumber,
        rawOrdinal: rally.ordinal,
        startCaptureTimeUs:
          segmentStartCaptureTimeUs(rally) ??
          segmentStartCaptureTimeUs(rally.activeSubmission ?? {}),
        createdAt: rally.createdAt,
        submitted: Boolean(rally.activeSubmission),
        scoreResolutionState:
          rally.scoreResolutionState ?? rally.activeSubmission?.scoreResolutionState ?? null,
        scoringCourtSide:
          rally.scoringCourtSide ?? rally.activeSubmission?.scoringCourtSide ?? null,
        scoringTeamId: rally.scoringTeamId ?? rally.activeSubmission?.scoringTeamId ?? null,
        baseLeftTeamId:
          rally.sideAssignment?.leftTeamId ?? rally.activeSubmission?.leftTeamId ?? null,
        baseRightTeamId:
          rally.sideAssignment?.rightTeamId ?? rally.activeSubmission?.rightTeamId ?? null,
        sideAssignmentReversed: rally.sideAssignmentReversed,
      })),
    })
    const selectedProjection = projection.segmentById.get(selectedRally.id)
    if (!selectedProjection?.leftTeamId || !selectedProjection.rightTeamId) {
      domainError('選取回合沒有可用的場地資訊', 'BAD_USER_INPUT')
    }
    if (
      selectedProjection.leftTeamId !== expectedLeftTeamId ||
      selectedProjection.rightTeamId !== expectedRightTeamId
    ) {
      domainError('Court-side assignment changed; refresh before swapping again', 'BAD_USER_INPUT')
    }

    const existingMarker = courtSideBoundaries.find(
      marker => marker.effectiveRallyId === selectedRally.id,
    )
    if (existingMarker) {
      await tx.courtSideSwapMarker.delete({ where: { id: existingMarker.id } })
    } else {
      await tx.courtSideSwapMarker.create({
        data: {
          matchId: matchSet.matchId,
          effectiveRallyId: selectedRally.id,
          leftTeamId: selectedProjection.rightTeamId,
          rightTeamId: selectedProjection.leftTeamId,
          createdByUserId: actor.id,
        },
      })
    }
    return tx.matchSet.findUniqueOrThrow({ where: { id: matchSet.id } })
  })
}
