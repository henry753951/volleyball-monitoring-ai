import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseAnnotationCommand, type CreateServiceKeyPointCommand, type ResolvedMediaAnchor } from '@volleyball-monitoring/contracts'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaHttpError } from '../src/media/playback-domain.js'
import {
  createAnnotationCommandService,
  type AnnotationCommandService,
} from '../src/services/annotation-command.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `phase3a_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  assignment: '82000000-0000-4000-8000-000000000001',
  capture: '82000000-0000-4000-8000-000000000002',
  device: '82000000-0000-4000-8000-000000000003',
  epoch: '82000000-0000-4000-8000-000000000004',
  left: '82000000-0000-4000-8000-000000000005',
  match: '82000000-0000-4000-8000-000000000006',
  operator: '82000000-0000-4000-8000-000000000007',
  outsider: '82000000-0000-4000-8000-000000000008',
  program: '82000000-0000-4000-8000-000000000009',
  newerProgram: '82000000-0000-4000-8000-000000000013',
  right: '82000000-0000-4000-8000-000000000010',
  set: '82000000-0000-4000-8000-000000000011',
  window: '82000000-0000-4000-8000-000000000012',
}

const identity = { deviceSessionId: ids.device, role: UserRole.OPERATOR, userId: ids.operator }
const roomId = `match:${ids.match}:capture:${ids.capture}`
const anchor: ResolvedMediaAnchor = {
  schema_version: '1.0.0',
  capture_epoch_id: ids.epoch,
  capture_frame_index: '9007199254740994',
  capture_session_id: ids.capture,
  capture_time_us: '9007199254740993',
  dvr_segment_id: '82000000-0000-4000-8000-000000000099',
  mapping_version: 1,
  playback_window_id: ids.window,
  resolved_player_media_time_us: '1234',
  snap_distance_us: '7',
  source_pts: '-9007199254740993',
  source_time_base: { den: 60_000, num: 1 },
  timing_precision: 'frame_exact',
}

let db: typeof DatabaseClient
let service: AnnotationCommandService
let createdDatabase = false
let cursorFailure: MediaHttpError | null = null

function serviceCommand(commandId: string, rallyId: string): CreateServiceKeyPointCommand {
  return {
    schema_version: '2.0.0',
    base_revision: '0',
    command_id: commandId,
    kind: 'CREATE_SERVICE_KEY_POINT',
    payload: {
      playback_cursor: {
        cursor_status: 'ready',
        mapping_version: 1,
        observation_source: 'request_video_frame_callback',
        playback_window_id: ids.window,
        player_media_time_us: '1234',
        presented_frames: '44',
        seek_generation: 0,
      },
    },
    rally_id: rallyId,
    room_id: roomId,
  }
}

beforeAll(async () => {
  await maintenancePool.query(`CREATE DATABASE "${databaseName}"`)
  createdDatabase = true
  process.env.DATABASE_URL = isolatedDatabaseUrl.toString()
  await execFileAsync('bun', ['x', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'], {
    cwd: databasePackageRoot,
    env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString() },
    windowsHide: true,
  })
  db = (await import('@volleyball-monitoring/db')).db
  await db.user.createMany({ data: [
    { displayName: 'Operator', email: 'operator@phase3.local', id: ids.operator },
    { displayName: 'Outsider', email: 'outsider@phase3.local', id: ids.outsider },
  ] })
  await db.deviceSession.create({ data: { id: ids.device, userId: ids.operator } })
  await db.team.createMany({ data: [
    { id: ids.left, name: 'Left', shortName: 'L' },
    { id: ids.right, name: 'Right', shortName: 'R' },
  ] })
  await db.match.create({ data: {
    id: ids.match,
    members: { create: { role: 'OPERATOR', userId: ids.operator } },
    title: 'Phase 3A',
  } })
  await db.matchTeam.createMany({ data: [
    { matchId: ids.match, teamId: ids.left },
    { matchId: ids.match, teamId: ids.right },
  ] })
  await db.matchSet.create({ data: { id: ids.set, matchId: ids.match, setNumber: 1, status: 'LIVE' } })
  await db.courtSideAssignment.create({ data: {
    effectiveFromRallyOrdinal: 1,
    id: ids.assignment,
    leftTeamId: ids.left,
    rightTeamId: ids.right,
    setId: ids.set,
  } })
  await db.captureSession.create({ data: {
    health: 'HEALTHY', id: ids.capture, ingestPath: '/phase3a', matchId: ids.match,
    sourceKind: 'fixture', status: 'LIVE',
  } })
  await db.captureEpoch.create({ data: {
    captureFrameOrigin: 0n, captureSessionId: ids.capture, captureTimeOriginUs: 0n,
    id: ids.epoch, sequenceIndex: 0, sourcePtsOrigin: 0n,
    sourceTimeBaseDen: 60_000, sourceTimeBaseNum: 1, startedAtCaptureUs: 0n,
  } })
  await db.dvrProgram.create({ data: {
    captureSessionId: ids.capture, durationUs: 0n, fpsDen: 1, fpsNum: 30,
    createdAt: new Date('2026-08-07T00:00:00.000Z'), id: ids.program,
    liveEdgeUs: 0n, playlistRevision: 1n, status: 'FINISHED',
    timeBaseDen: 60_000, timeBaseNum: 1,
  } })
  await db.dvrProgram.create({ data: {
    captureSessionId: ids.capture, createdAt: new Date('2026-08-07T01:00:00.000Z'),
    durationUs: 0n, fpsDen: 1, fpsNum: 30, id: ids.newerProgram,
    liveEdgeUs: 0n, playlistRevision: 2n, status: 'LIVE', timeBaseDen: 60_000, timeBaseNum: 1,
  } })
  await db.playbackWindow.create({ data: {
    captureEndUs: 10_000n, captureSessionId: ids.capture, captureStartUs: 0n,
    createdByUserId: ids.operator, dvrProgramId: ids.program,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'), id: ids.window,
    mappingVersion: 1, mode: 'ARCHIVE', presentationOriginCaptureUs: 0n,
    targetPlayerMediaTimeUs: 1_234n, timelineVersion: 1n,
  } })
  service = createAnnotationCommandService({
    database: db,
    resolveCursor: async () => {
      if (cursorFailure) throw cursorFailure
      return anchor
    },
  })
}, 120_000)

afterAll(async () => {
  if (db) await db.$disconnect()
  if (createdDatabase) {
    await maintenancePool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    )
    await maintenancePool.query(`DROP DATABASE "${databaseName}"`)
  }
  await maintenancePool.end()
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
}, 120_000)

describe('durable service annotation command', () => {
  it('atomically creates revision one, seq-zero service, receipt, operation and outbox only', async () => {
    const command = serviceCommand(randomUUID(), randomUUID())
    const response = await service.apply(command, identity)
    expect(response).toMatchObject({
      type: 'command_ack', operation_kind: 'CREATE_SERVICE_KEY_POINT', result_revision: '1',
      effects: { annotation_status: 'open', score_resolution: 'pending', scoring_court_side: null },
      resolved_anchor: { capture_time_us: anchor.capture_time_us },
    })
    const receipt = await db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })
    expect(receipt).toMatchObject({ accepted: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(receipt?.serverSequence.toString()).toBe(response.type === 'command_ack' ? response.server_sequence : '')
    await expect(db.rally.findUnique({ include: { keyPoints: true, operations: true }, where: { id: command.rally_id } })).resolves.toMatchObject({
      annotationRevision: 1n,
      annotationStatus: 'OPEN',
      dvrProgramId: ids.program,
      keyPoints: [expect.objectContaining({ isTerminal: false, markerKind: 'SERVICE', sequenceIndex: 0 })],
      operations: [expect.objectContaining({ receiptServerSequence: receipt?.serverSequence })],
    })
    await expect(db.rallySubmission.count({ where: { rallyId: command.rally_id } })).resolves.toBe(0)
    await expect(db.pointAward.count()).resolves.toBe(0)
    await expect(db.outboxEvent.count({ where: { aggregateId: command.rally_id } })).resolves.toBe(1)
  })

  it('replays the exact stored response and rejects command-id hash mismatch without mutation', async () => {
    const command = serviceCommand(randomUUID(), randomUUID())
    const first = await service.apply(command, identity)
    await expect(service.apply(structuredClone(command), identity)).resolves.toEqual(first)
    const mismatch = structuredClone(command)
    mismatch.payload.playback_cursor.player_media_time_us = '9999'
    await expect(service.apply(mismatch, identity)).resolves.toMatchObject({ type: 'command_rejected', code: 'COMMAND_ID_REUSED' })
    await expect(db.annotationCommandReceipt.count({ where: { commandId: command.command_id } })).resolves.toBe(1)
    await expect(db.keyPoint.count({ where: { rallyId: command.rally_id } })).resolves.toBe(1)
  })

  it('serializes competing service starts and leaves one complete rally only', async () => {
    const rallyId = randomUUID()
    const responses = await Promise.all([
      service.apply(serviceCommand(randomUUID(), rallyId), identity),
      service.apply(serviceCommand(randomUUID(), rallyId), identity),
    ])
    expect(responses.filter((value) => value.type === 'command_ack')).toHaveLength(1)
    expect(responses.filter((value) => value.type === 'command_rejected' && value.code === 'REVISION_CONFLICT')).toHaveLength(1)
    await expect(db.rally.count({ where: { id: rallyId } })).resolves.toBe(1)
    await expect(db.keyPoint.count({ where: { rallyId } })).resolves.toBe(1)
    await expect(db.annotationOperation.count({ where: { rallyId } })).resolves.toBe(1)
    await expect(db.annotationCommandReceipt.count({ where: { rallyId } })).resolves.toBe(2)
  })

  it('locks set-level ordinal allocation for different rally ids', async () => {
    const commands = [
      serviceCommand(randomUUID(), randomUUID()),
      serviceCommand(randomUUID(), randomUUID()),
    ]
    const responses = await Promise.all(commands.map((value) => service.apply(value, identity)))
    expect(responses.every((value) => value.type === 'command_ack')).toBe(true)
    const rallies = await db.rally.findMany({
      orderBy: { ordinal: 'asc' },
      select: { id: true, ordinal: true },
      where: { id: { in: commands.map((value) => value.rally_id) } },
    })
    expect(rallies).toHaveLength(2)
    expect(rallies[1]!.ordinal).toBe(rallies[0]!.ordinal + 1)
  })

  it('durably rejects foreign rooms and cursor-not-ready without partial domain rows', async () => {
    const foreign = serviceCommand(randomUUID(), randomUUID())
    foreign.room_id = `match:${ids.match}:capture:${randomUUID()}`
    await expect(service.apply(foreign, identity)).resolves.toMatchObject({ code: 'ROOM_NOT_FOUND' })
    cursorFailure = new MediaHttpError(422, 'CURSOR_NOT_READY', 'Playback cursor is not ready')
    const notReady = serviceCommand(randomUUID(), randomUUID())
    await expect(service.apply(notReady, identity)).resolves.toMatchObject({ code: 'CURSOR_NOT_READY' })
    cursorFailure = null
    for (const command of [foreign, notReady]) {
      await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toMatchObject({ accepted: false })
      await expect(db.rally.findUnique({ where: { id: command.rally_id } })).resolves.toBeNull()
      await expect(db.keyPoint.count({ where: { rallyId: command.rally_id } })).resolves.toBe(0)
    }
  })

  it('parses but durably rejects non-Z v2 commands and stale service revisions', async () => {
    const contact = parseAnnotationCommand({
      ...serviceCommand(randomUUID(), randomUUID()),
      kind: 'CREATE_CONTACT_KEY_POINT',
    })
    await expect(service.apply(contact, identity)).resolves.toMatchObject({ code: 'UNSUPPORTED_COMMAND' })
    const stale = serviceCommand(randomUUID(), randomUUID())
    stale.base_revision = '3'
    await expect(service.apply(stale, identity)).resolves.toMatchObject({
      code: 'REVISION_CONFLICT', expected_revision: '3', actual_revision: '0',
    })
    for (const command of [contact, stale]) {
      await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toMatchObject({ accepted: false })
      await expect(db.rally.findUnique({ where: { id: command.rally_id } })).resolves.toBeNull()
    }
  })

  it('durably rejects invalid authoritative anchor state without partial domain rows', async () => {
    const invalidAnchorService = createAnnotationCommandService({
      database: db,
      resolveCursor: async () => ({ ...anchor, capture_epoch_id: randomUUID() }),
    })
    const command = serviceCommand(randomUUID(), randomUUID())
    await expect(invalidAnchorService.apply(command, identity)).resolves.toMatchObject({ code: 'ANNOTATION_NOT_READY' })
    await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toMatchObject({ accepted: false })
    await expect(db.rally.findUnique({ where: { id: command.rally_id } })).resolves.toBeNull()
    await expect(db.annotationOperation.findUnique({ where: { clientMutationId: command.command_id } })).resolves.toBeNull()
  })

  it('rolls back rally, key point and receipt when a late operation write fails', async () => {
    const existingRally = await db.rally.findFirstOrThrow({ select: { id: true } })
    const legacyCommandId = randomUUID()
    await db.annotationOperation.create({ data: {
      baseRevision: 0n,
      clientMutationId: legacyCommandId,
      deviceSessionId: ids.device,
      operationKind: 'LEGACY_TEST',
      payload: {},
      payloadHash: 'legacy',
      rallyId: existingRally.id,
      resultRevision: 1n,
      userId: ids.operator,
    } })
    const command = serviceCommand(legacyCommandId, randomUUID())
    await expect(service.apply(command, identity)).rejects.toMatchObject({ code: 'P2002' })
    await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toBeNull()
    await expect(db.rally.findUnique({ where: { id: command.rally_id } })).resolves.toBeNull()
    await expect(db.keyPoint.count({ where: { rallyId: command.rally_id } })).resolves.toBe(0)
  })
})
