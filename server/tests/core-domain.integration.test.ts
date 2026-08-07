import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GraphQLSchema } from 'graphql'
import { createYoga } from 'graphql-yoga'
import { Pool } from 'pg'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import type { db as databaseClient } from '@volleyball-monitoring/db'
import type { GraphQLContext } from '../src/graphql/context.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const schemaSnapshotPath = resolve(repositoryRoot, 'packages/contracts/graphql/schema.graphql')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `phase1b_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const adminUser = { id: '10000000-0000-4000-8000-000000000001', role: 'ADMIN' as const }
const operatorUser = { id: '10000000-0000-4000-8000-000000000002', role: 'OPERATOR' as const }
const outsiderOperator = { id: '10000000-0000-4000-8000-000000000003', role: 'OPERATOR' as const }
const coachUser = { id: '10000000-0000-4000-8000-000000000004', role: 'COACH' as const }

let db: typeof databaseClient
let schema: GraphQLSchema
let createGraphQLContext: typeof import('../src/graphql/context.js')['createGraphQLContext']
let createdDatabase = false

const setupMutation = /* GraphQL */ `
  mutation CreateMatchSetup($input: CreateMatchSetupInput!) {
    createMatchSetup(input: $input) {
      id
      title
      venue
      status
      scheduledAt
      teams {
        id
        name
        shortName
        players { id teamId name }
      }
      rosterEntries { id teamId name jerseyNumber }
      sets {
        id
        setNumber
        status
        leftScore
        rightScore
        sideAssignments {
          id
          effectiveFromRallyOrdinal
          effectiveToRallyOrdinal
          leftTeamId
          rightTeamId
        }
      }
    }
  }
`

const listQuery = /* GraphQL */ `
  query ListMatches {
    viewer { id role email displayName }
    matches { id title status }
  }
`

const detailQuery = /* GraphQL */ `
  query MatchDetail($id: ID!) {
    match(id: $id) {
      id
      title
      teams { id name shortName players { id teamId name } }
      rosterEntries { id teamId name jerseyNumber }
      sets {
        id
        setNumber
        status
        leftScore
        rightScore
        sideAssignments {
          id
          effectiveFromRallyOrdinal
          effectiveToRallyOrdinal
          leftTeamId
          rightTeamId
        }
      }
    }
  }
`

const swapMutation = /* GraphQL */ `
  mutation SwapCourtSides($input: SwapCourtSidesInput!) {
    swapCourtSides(input: $input) {
      id
      sideAssignments {
        id
        effectiveFromRallyOrdinal
        effectiveToRallyOrdinal
        leftTeamId
        rightTeamId
      }
    }
  }
`

const validSetup = {
  leftTeam: {
    name: '  North   Stars ',
    roster: [
      { jerseyNumber: '01', name: 'Avery Chen' },
      { jerseyNumber: '12', name: 'Morgan Lin' },
    ],
    shortName: ' NS ',
  },
  rightTeam: {
    name: 'South Waves',
    roster: [
      { jerseyNumber: '7', name: 'Jamie Wu' },
      { jerseyNumber: '19', name: 'Riley Huang' },
    ],
    shortName: 'SW',
  },
  scheduledAt: '2026-08-08T02:30:00.000Z',
  title: '  Phase 1B   Match ',
  venue: ' Main   Court ',
}

function contextFor(user: GraphQLContext['user']): GraphQLContext {
  return { request: new Request('http://localhost/graphql'), user }
}

async function execute(
  source: string,
  contextValue: GraphQLContext,
  variableValues?: Record<string, unknown>,
) {
  const yoga = createYoga({
    context: () => contextValue,
    graphqlEndpoint: '/graphql',
    logging: false,
    maskedErrors: false,
    schema,
  })
  const response = await yoga.fetch('http://localhost/graphql', {
    body: JSON.stringify({ query: source, variables: variableValues }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return response.json() as Promise<{
    data?: Record<string, unknown> | null
    errors?: Array<{ extensions: Record<string, unknown> }>
  }>
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} was not an object`)
  }
  const fieldValue = (value as Record<string, unknown>)[field]
  if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
    throw new TypeError(`${field} was not an object`)
  }
  return fieldValue as Record<string, unknown>
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  const fieldValue = value[field]
  if (!Array.isArray(fieldValue)) {
    throw new TypeError(`${field} was not an array`)
  }
  return fieldValue
}

function errorCode(result: Awaited<ReturnType<typeof execute>>): unknown {
  return result.errors?.[0]?.extensions?.code
}

async function setupRowCounts() {
  const [matches, teams, players, matchTeams, rosterEntries, sets, assignments, memberships] = await Promise.all([
    db.match.count(),
    db.team.count(),
    db.player.count(),
    db.matchTeam.count(),
    db.matchRosterEntry.count(),
    db.matchSet.count(),
    db.courtSideAssignment.count(),
    db.matchMember.count(),
  ])
  return { assignments, matchTeams, matches, memberships, players, rosterEntries, sets, teams }
}

async function createUser(id: string, label: string) {
  await db.user.create({
    data: {
      displayName: label,
      email: `${id}@integration.volleyball.local`,
      id,
    },
  })
}

beforeAll(async () => {
  await maintenancePool.query(`CREATE DATABASE "${databaseName}"`)
  createdDatabase = true
  process.env.DATABASE_URL = isolatedDatabaseUrl.toString()

  await execFileAsync(
    'bun',
    ['x', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    {
      cwd: databasePackageRoot,
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString() },
      windowsHide: true,
    },
  )

  const dbModule = await import('@volleyball-monitoring/db')
  const schemaModule = await import('../src/graphql/schema.js')
  const contextModule = await import('../src/graphql/context.js')
  db = dbModule.db
  schema = schemaModule.schema
  createGraphQLContext = contextModule.createGraphQLContext

  await Promise.all([
    createUser(adminUser.id, 'Admin'),
    createUser(operatorUser.id, 'Operator'),
    createUser(outsiderOperator.id, 'Outside Operator'),
    createUser(coachUser.id, 'Coach'),
  ])
}, 120_000)

afterAll(async () => {
  if (db) {
    await db.$disconnect()
  }
  if (createdDatabase) {
    await maintenancePool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    )
    await maintenancePool.query(`DROP DATABASE "${databaseName}"`)
  }
  await maintenancePool.end()
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl
  }
}, 120_000)

describe('Phase 1B GraphQL schema', () => {
  it('exposes capture timeline metadata only', async () => {
    const printed = await readFile(schemaSnapshotPath, 'utf8')
    expect(printed).toContain('captureSessions')
    expect(printed).toContain('captureSession(id: ID!)')
    for (const forbidden of ['DvrSegment', 'sampleIndex', 'objectKey', 'mediaBytes']) expect(printed).not.toContain(forbidden)
  })

  it('resolves a member timeline from the newest program and coalesces ready segments', async () => {
    const matchId = '20000000-0000-4000-8000-000000000010'
    await db.match.create({ data: { id: matchId, title: 'Media Timeline Fixture', members: { create: { userId: operatorUser.id, role: 'OPERATOR' } } } })
    const sessionId = '20000000-0000-4000-8000-000000000001'
    const epochId = '20000000-0000-4000-8000-000000000002'
    const programOld = '20000000-0000-4000-8000-000000000003'
    const programNew = '20000000-0000-4000-8000-000000000004'
    const assets = [] as string[]
    try {
      await db.captureSession.create({ data: { id: sessionId, matchId, sourceKind: 'fixture', ingestPath: `/fixture/${sessionId}`, status: 'LIVE', health: 'HEALTHY' } })
    await db.captureEpoch.create({ data: { id: epochId, captureSessionId: sessionId, sequenceIndex: 0, sourceTimeBaseNum: 1, sourceTimeBaseDen: 60000, sourcePtsOrigin: 0n, captureTimeOriginUs: 9007199254740992n, captureFrameOrigin: 0n, startedAtCaptureUs: 9007199254740992n } })
    for (const [id, revision] of [[programOld, 1n], [programNew, 9007199254740993n]] as const) await db.dvrProgram.create({ data: { id, captureSessionId: sessionId, status: 'LIVE', playlistRevision: revision, liveEdgeUs: 0n, durationUs: 0n, fpsNum: 30, fpsDen: 1, timeBaseNum: 1, timeBaseDen: 60000 } })
    for (let i = 0; i < 6; i++) { const id = `20000000-0000-4000-8000-${String(10 + i).padStart(12, '0')}`; assets.push(id); await db.mediaAsset.create({ data: { id, kind: i % 3 === 0 ? 'DVR_INIT' : i % 3 === 1 ? 'DVR_SEGMENT' : 'SAMPLE_INDEX', bucket: 'fixture', objectKey: id, contentType: 'video/mp4', state: 'READY', readyAt: new Date(), internalSchemaVersion: '1.0.0' } }) }
    for (let i = 0; i < 2; i++) await db.dvrSegment.create({ data: { id: `20000000-0000-4000-8000-${String(20 + i).padStart(12, '0')}`, dvrProgramId: programNew, captureEpochId: epochId, sequenceNumber: BigInt(i), discontinuitySequence: 0, captureStartUs: 9007199254740992n + BigInt(i * 100), captureEndUs: 9007199254741092n + BigInt(i * 100), frameCount: 3n, durationUs: 100n, readyAt: new Date(), initAssetId: assets[i * 3]!, mediaAssetId: assets[i * 3 + 1]!, sampleIndexAssetId: assets[i * 3 + 2]! } })
      const result = await execute('{ captureSession(id: "20000000-0000-4000-8000-000000000001") { id timeline { timelineVersion captureStartTimeUs liveEdgeCaptureTimeUs availableRanges { startUs endUs } } } }', contextFor(operatorUser))
      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({ captureSession: { id: sessionId, timeline: { timelineVersion: '9007199254740993', captureStartTimeUs: '9007199254740992', liveEdgeCaptureTimeUs: '9007199254741192', availableRanges: [{ startUs: '9007199254740992', endUs: '9007199254741192' }] } } })
      const laterSessionId = '20000000-0000-4000-8000-000000000011'
      await db.captureSession.create({ data: { id: laterSessionId, matchId, sourceKind: 'fixture', ingestPath: `/fixture/${laterSessionId}`, createdAt: new Date('2026-08-08T00:00:00Z'), status: 'LIVE', health: 'HEALTHY' } })
      const listed = await execute(`{ match(id: "${matchId}") { captureSessions { id } } }`, contextFor(operatorUser))
      expect(listed.data).toEqual({ match: { captureSessions: [{ id: laterSessionId }, { id: sessionId }] } })
      const adminResult = await execute(`{ captureSession(id: "${sessionId}") { id } }`, contextFor(adminUser))
      expect(adminResult.data).toEqual({ captureSession: { id: sessionId } })
      const outsiderResult = await execute(`{ captureSession(id: "${sessionId}") { id } }`, contextFor(outsiderOperator))
      expect(outsiderResult.data).toEqual({ captureSession: null })
      const missingResult = await execute('{ captureSession(id: "20000000-0000-4000-8000-000000000099") { id } }', contextFor(operatorUser))
      expect(missingResult.data).toEqual({ captureSession: null })
    } finally {
      try {
        await db.dvrSegment.deleteMany({ where: { dvrProgramId: programNew } })
        await db.match.delete({ where: { id: matchId } })
      } finally {
        if (assets.length) await db.mediaAsset.deleteMany({ where: { id: { in: assets } } })
      }
    }
  })
  it('matches the committed generated snapshot and validates representative operations', async () => {
    const normalizeLineEndings = (value: string) => value.replaceAll('\r\n', '\n')
    const before = normalizeLineEndings(await readFile(schemaSnapshotPath, 'utf8'))
    await execFileAsync('bun', ['src/graphql/export-schema.ts'], {
      cwd: resolve(repositoryRoot, 'server'),
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString() },
      windowsHide: true,
    })
    await expect(readFile(schemaSnapshotPath, 'utf8').then(normalizeLineEndings)).resolves.toBe(before)

    for (const operation of [setupMutation, listQuery, detailQuery, swapMutation]) {
      const response = await execute(operation, contextFor(null), {
        id: '10000000-0000-4000-8000-000000000099',
        input: operation === setupMutation
          ? validSetup
          : { effectiveFromRallyOrdinal: 2, setId: '10000000-0000-4000-8000-000000000099' },
      })
      expect(response.errors?.[0]?.extensions.code).not.toBe('GRAPHQL_VALIDATION_FAILED')
    }
  })

  it('keeps health public and reports UNAUTHENTICATED for protected operations', async () => {
    const health = await execute('{ health { status service } }', contextFor(null))
    expect(health).toEqual({
      data: { health: { service: 'volleyball-monitoring-server', status: 'ok' } },
    })

    const protectedOperations = [
      { source: '{ viewer { id } }' },
      { source: '{ matches { id } }' },
      { source: setupMutation, variables: { input: validSetup } },
      {
        source: swapMutation,
        variables: {
          input: {
            effectiveFromRallyOrdinal: 2,
            setId: '10000000-0000-4000-8000-000000000099',
          },
        },
      },
    ]

    for (const operation of protectedOperations) {
      const result = await execute(operation.source, contextFor(null), operation.variables)
      expect(errorCode(result)).toBe('UNAUTHENTICATED')
    }
  })
})

describe('development identity resolution', () => {
  const devUserId = '10000000-0000-4000-8000-000000000010'

  it('only accepts headers when development auth is explicitly enabled and never in production', async () => {
    process.env.NODE_ENV = 'test'
    delete process.env.DEV_AUTH_ENABLED
    const request = new Request('http://localhost/graphql', {
      headers: { 'x-dev-role': 'OPERATOR', 'x-dev-user-id': devUserId },
    })
    await expect(createGraphQLContext({ request })).resolves.toMatchObject({ user: null })
    await expect(db.user.findUnique({ where: { id: devUserId } })).resolves.toBeNull()

    process.env.DEV_AUTH_ENABLED = 'true'
    const enabled = await createGraphQLContext({ request })
    expect(enabled.user).toEqual({ id: devUserId, role: 'OPERATOR' })
    await expect(db.user.findUnique({ where: { id: devUserId } })).resolves.toMatchObject({
      id: devUserId,
    })

    process.env.NODE_ENV = 'production'
    const productionUserId = '10000000-0000-4000-8000-000000000011'
    const production = await createGraphQLContext({
      request: new Request('http://localhost/graphql', {
        headers: { 'x-dev-role': 'ADMIN', 'x-dev-user-id': productionUserId },
      }),
    })
    expect(production.user).toBeNull()
    await expect(db.user.findUnique({ where: { id: productionUserId } })).resolves.toBeNull()

    process.env.NODE_ENV = 'test'
    delete process.env.DEV_AUTH_ENABLED
  })

  it('rejects invalid development UUID and role values', async () => {
    process.env.NODE_ENV = 'test'
    process.env.DEV_AUTH_ENABLED = 'true'

    await expect(createGraphQLContext({
      request: new Request('http://localhost/graphql', {
        headers: { 'x-dev-role': 'ADMIN', 'x-dev-user-id': 'not-a-uuid' },
      }),
    })).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } })

    await expect(createGraphQLContext({
      request: new Request('http://localhost/graphql', {
        headers: { 'x-dev-role': 'OWNER', 'x-dev-user-id': randomUUID() },
      }),
    })).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } })

    delete process.env.DEV_AUTH_ENABLED
  })
})

describe('match setup, visibility, and court-side history', () => {
  let matchId: string
  let setId: string
  let leftTeamId: string
  let rightTeamId: string

  it('creates the complete normalized graph and creator OPERATOR membership atomically', async () => {
    const result = await execute(
      setupMutation,
      contextFor(operatorUser),
      { input: validSetup },
    )
    expect(result.errors).toBeUndefined()
    const match = objectField(result.data, 'createMatchSetup')
    matchId = String(match.id)
    expect(match).toMatchObject({
      scheduledAt: '2026-08-08T02:30:00.000Z',
      status: 'PLANNED',
      title: 'Phase 1B Match',
      venue: 'Main Court',
    })

    const teams = arrayField(match, 'teams') as Array<Record<string, unknown>>
    expect(teams).toHaveLength(2)
    expect(teams.map((team) => team.name)).toEqual(['North Stars', 'South Waves'])
    leftTeamId = String(teams[0]?.id)
    rightTeamId = String(teams[1]?.id)
    expect((teams[0]?.players as unknown[])).toHaveLength(2)
    expect((teams[1]?.players as unknown[])).toHaveLength(2)

    const rosterEntries = arrayField(match, 'rosterEntries') as Array<Record<string, unknown>>
    expect(rosterEntries.map((entry) => entry.name)).toEqual([
      'Avery Chen',
      'Morgan Lin',
      'Jamie Wu',
      'Riley Huang',
    ])

    const sets = arrayField(match, 'sets') as Array<Record<string, unknown>>
    expect(sets).toHaveLength(1)
    setId = String(sets[0]?.id)
    expect(sets[0]).toMatchObject({ leftScore: 0, rightScore: 0, setNumber: 1, status: 'PLANNED' })
    expect(sets[0]?.sideAssignments).toEqual([expect.objectContaining({
      effectiveFromRallyOrdinal: 1,
      effectiveToRallyOrdinal: null,
      leftTeamId,
      rightTeamId,
    })])

    await expect(db.matchMember.findUnique({
      where: { matchId_userId: { matchId, userId: operatorUser.id } },
    })).resolves.toMatchObject({ role: 'OPERATOR' })
    await expect(setupRowCounts()).resolves.toEqual({
      assignments: 1,
      matchTeams: 2,
      matches: 1,
      memberships: 1,
      players: 4,
      rosterEntries: 4,
      sets: 1,
      teams: 2,
    })
  })

  it('returns BAD_USER_INPUT and preserves every setup row count for duplicate input', async () => {
    const before = await setupRowCounts()
    const duplicateJerseySetup = structuredClone(validSetup)
    duplicateJerseySetup.leftTeam.roster[1] = {
      jerseyNumber: ' ０１ ',
      name: 'Different Player',
    }

    const result = await execute(
      setupMutation,
      contextFor(operatorUser),
      { input: duplicateJerseySetup },
    )
    expect(errorCode(result)).toBe('BAD_USER_INPUT')
    await expect(setupRowCounts()).resolves.toEqual(before)
  })

  it('requires a write role and filters reads by DB membership while admins see all matches', async () => {
    const denied = await execute(setupMutation, contextFor(coachUser), { input: validSetup })
    expect(errorCode(denied)).toBe('FORBIDDEN')

    const outsiderList = await execute(listQuery, contextFor(outsiderOperator))
    expect(outsiderList.errors).toBeUndefined()
    expect(outsiderList.data?.matches).toEqual([])

    const hiddenDetail = await execute(detailQuery, contextFor(outsiderOperator), { id: matchId })
    expect(hiddenDetail.errors).toBeUndefined()
    expect(hiddenDetail.data?.match).toBeNull()

    const adminList = await execute(listQuery, contextFor(adminUser))
    expect(adminList.errors).toBeUndefined()
    expect(adminList.data?.matches).toEqual([
      expect.objectContaining({ id: matchId, title: 'Phase 1B Match' }),
    ])
    expect(adminList.data?.viewer).toMatchObject({ id: adminUser.id, role: 'ADMIN' })

    await db.matchMember.create({
      data: { matchId, role: 'COACH', userId: coachUser.id },
    })
    const memberList = await execute(listQuery, contextFor(coachUser))
    expect(memberList.errors).toBeUndefined()
    expect(memberList.data?.matches).toEqual([
      expect.objectContaining({ id: matchId }),
    ])
  })

  it('returns BAD_USER_INPUT for malformed IDs and non-disclosing NOT_FOUND for inaccessible swaps', async () => {
    const invalidDetail = await execute(detailQuery, contextFor(adminUser), { id: 'bad-id' })
    expect(errorCode(invalidDetail)).toBe('BAD_USER_INPUT')

    const forbidden = await execute(swapMutation, contextFor(coachUser), {
      input: { effectiveFromRallyOrdinal: 2, setId },
    })
    expect(errorCode(forbidden)).toBe('FORBIDDEN')

    const hidden = await execute(swapMutation, contextFor(outsiderOperator), {
      input: { effectiveFromRallyOrdinal: 2, setId },
    })
    expect(errorCode(hidden)).toBe('NOT_FOUND')
  })

  it('serializes concurrent swaps and returns ordered, non-overlapping assignment history', async () => {
    const firstSwap = await execute(swapMutation, contextFor(operatorUser), {
      input: { effectiveFromRallyOrdinal: 4, setId },
    })
    expect(firstSwap.errors).toBeUndefined()

    const concurrent = await Promise.all([
      execute(swapMutation, contextFor(operatorUser), {
        input: { effectiveFromRallyOrdinal: 8, setId },
      }),
      execute(swapMutation, contextFor(operatorUser), {
        input: { effectiveFromRallyOrdinal: 8, setId },
      }),
    ])
    expect(concurrent.filter((result) => result.errors === undefined)).toHaveLength(1)
    expect(concurrent.filter((result) => errorCode(result) === 'BAD_USER_INPUT')).toHaveLength(1)

    const detail = await execute(detailQuery, contextFor(operatorUser), { id: matchId })
    expect(detail.errors).toBeUndefined()
    const match = objectField(detail.data, 'match')
    const sets = arrayField(match, 'sets') as Array<Record<string, unknown>>
    expect(sets[0]?.sideAssignments).toEqual([
      expect.objectContaining({
        effectiveFromRallyOrdinal: 1,
        effectiveToRallyOrdinal: 3,
        leftTeamId,
        rightTeamId,
      }),
      expect.objectContaining({
        effectiveFromRallyOrdinal: 4,
        effectiveToRallyOrdinal: 7,
        leftTeamId: rightTeamId,
        rightTeamId: leftTeamId,
      }),
      expect.objectContaining({
        effectiveFromRallyOrdinal: 8,
        effectiveToRallyOrdinal: null,
        leftTeamId,
        rightTeamId,
      }),
    ])
  })

  it('rejects a non-advancing ordinal without changing assignment rows', async () => {
    const before = await db.courtSideAssignment.findMany({
      orderBy: { effectiveFromRallyOrdinal: 'asc' },
      where: { setId },
    })
    const result = await execute(swapMutation, contextFor(operatorUser), {
      input: { effectiveFromRallyOrdinal: 8, setId },
    })
    expect(errorCode(result)).toBe('BAD_USER_INPUT')
    await expect(db.courtSideAssignment.findMany({
      orderBy: { effectiveFromRallyOrdinal: 'asc' },
      where: { setId },
    })).resolves.toEqual(before)
  })
})
