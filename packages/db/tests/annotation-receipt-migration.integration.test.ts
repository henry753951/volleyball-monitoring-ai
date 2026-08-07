import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `receipt_migration_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const databaseUrl = new URL(sourceDatabaseUrl)
databaseUrl.pathname = `/${databaseName}`
databaseUrl.searchParams.set('schema', 'public')
const maintenance = new Pool({ connectionString: maintenanceUrl.toString() })
let database: Pool
let created = false

const ids = {
  assignment: '85000000-0000-4000-8000-000000000001',
  capture: '85000000-0000-4000-8000-000000000002',
  device: '85000000-0000-4000-8000-000000000003',
  left: '85000000-0000-4000-8000-000000000004',
  match: '85000000-0000-4000-8000-000000000005',
  operation: '85000000-0000-4000-8000-000000000006',
  program: '85000000-0000-4000-8000-000000000007',
  rally: '85000000-0000-4000-8000-000000000008',
  right: '85000000-0000-4000-8000-000000000009',
  set: '85000000-0000-4000-8000-000000000010',
  user: '85000000-0000-4000-8000-000000000011',
}

beforeAll(async () => {
  await maintenance.query(`CREATE DATABASE "${databaseName}"`)
  created = true
  database = new Pool({ connectionString: databaseUrl.toString() })
  const migrationRoot = resolve(import.meta.dirname, '../prisma/migrations')
  for (const path of [
    '20260807005050_init_core_domain/migration.sql',
    '20260807120000_playback_windows/migration.sql',
  ]) {
    await database.query(await readFile(resolve(migrationRoot, path), 'utf8'))
  }
  await database.query(`
    INSERT INTO "User" ("id", "email", "displayName", "createdAt", "updatedAt")
      VALUES ('${ids.user}', 'legacy@phase3.local', 'Legacy', NOW(), NOW());
    INSERT INTO "DeviceSession" ("id", "userId", "createdAt", "lastSeenAt")
      VALUES ('${ids.device}', '${ids.user}', NOW(), NOW());
    INSERT INTO "Match" ("id", "title", "status", "createdAt", "updatedAt")
      VALUES ('${ids.match}', 'Legacy', 'LIVE', NOW(), NOW());
    INSERT INTO "Team" ("id", "name", "shortName", "createdAt", "updatedAt") VALUES
      ('${ids.left}', 'Left', 'L', NOW(), NOW()),
      ('${ids.right}', 'Right', 'R', NOW(), NOW());
    INSERT INTO "MatchSet" ("id", "matchId", "setNumber", "status", "leftScore", "rightScore", "scoreRevision", "createdAt", "updatedAt")
      VALUES ('${ids.set}', '${ids.match}', 1, 'LIVE', 0, 0, 0, NOW(), NOW());
    INSERT INTO "CourtSideAssignment" ("id", "setId", "effectiveFromRallyOrdinal", "leftTeamId", "rightTeamId", "createdAt")
      VALUES ('${ids.assignment}', '${ids.set}', 1, '${ids.left}', '${ids.right}', NOW());
    INSERT INTO "CaptureSession" ("id", "matchId", "sourceKind", "ingestPath", "status", "health", "createdAt", "updatedAt")
      VALUES ('${ids.capture}', '${ids.match}', 'fixture', '/legacy', 'LIVE', 'HEALTHY', NOW(), NOW());
    INSERT INTO "DvrProgram" ("id", "captureSessionId", "status", "playlistRevision", "liveEdgeUs", "durationUs", "fpsNum", "fpsDen", "timeBaseNum", "timeBaseDen", "createdAt", "updatedAt")
      VALUES ('${ids.program}', '${ids.capture}', 'LIVE', 1, 0, 0, 30, 1, 1, 60000, NOW(), NOW());
    INSERT INTO "Rally" ("id", "matchId", "setId", "dvrProgramId", "sideAssignmentId", "ordinal", "annotationRevision", "annotationStatus", "processingStatus", "scoreResolutionState", "createdAt", "updatedAt")
      VALUES ('${ids.rally}', '${ids.match}', '${ids.set}', '${ids.program}', '${ids.assignment}', 1, 1, 'OPEN', 'IDLE', 'PENDING', NOW(), NOW());
    INSERT INTO "AnnotationOperation" ("id", "rallyId", "userId", "deviceSessionId", "clientMutationId", "baseRevision", "resultRevision", "operationKind", "payload", "payloadHash", "createdAt")
      VALUES ('${ids.operation}', '${ids.rally}', '${ids.user}', '${ids.device}', 'legacy-command', 0, 1, 'LEGACY', '{}'::jsonb, 'legacy', NOW());
  `)
}, 120_000)

afterAll(async () => {
  await database?.end()
  if (created) {
    await maintenance.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    )
    await maintenance.query(`DROP DATABASE "${databaseName}"`)
  }
  await maintenance.end()
}, 120_000)

describe('annotation receipt migration', () => {
  it('deploys over legacy accepted operations without fabricating receipts', async () => {
    const migration = await readFile(resolve(
      import.meta.dirname,
      '../prisma/migrations/20260807180000_annotation_command_receipts/migration.sql',
    ), 'utf8')
    await database.query(migration)
    const operation = await database.query<{ receiptServerSequence: string | null }>(
      'SELECT "receiptServerSequence" FROM "AnnotationOperation" WHERE "id" = $1',
      [ids.operation],
    )
    expect(operation.rows).toEqual([{ receiptServerSequence: null }])
    const nullable = await database.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'AnnotationOperation' AND column_name = 'receiptServerSequence'
    `)
    expect(nullable.rows).toEqual([{ is_nullable: 'YES' }])
  })
})
