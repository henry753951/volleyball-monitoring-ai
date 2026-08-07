import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseAnnotationCommand, parseAnnotationCommandResponse, type AnnotationCommand, type CreateServiceKeyPointCommand, type ResolvedMediaAnchor } from '@volleyball-monitoring/contracts'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  segment: '82000000-0000-4000-8000-000000000014',
  sampleAsset: '82000000-0000-4000-8000-000000000015',
  foreignProgramSegment: '82000000-0000-4000-8000-000000000016',
  foreignEpochSegment: '82000000-0000-4000-8000-000000000017',
  foreignCapture: '82000000-0000-4000-8000-000000000018',
  foreignEpoch: '82000000-0000-4000-8000-000000000019',
  plannedSet: '82000000-0000-4000-8000-000000000020',
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
  dvr_segment_id: ids.segment,
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

function contactCommand(commandId: string, rallyId: string, baseRevision = '1') {
  return { ...serviceCommand(commandId, rallyId), base_revision: baseRevision, kind: 'CREATE_CONTACT_KEY_POINT' as const }
}

function closeCommand(commandId: string, rallyId: string, targetKeyPointId: string, baseRevision: string, outcome: 'left' | 'right' | 'unknown' = 'unknown') {
  return (outcome === 'unknown'
    ? { ...serviceCommand(commandId, rallyId), base_revision: baseRevision, kind: 'CLOSE_RALLY' as const, payload: { target_key_point_id: targetKeyPointId, score_resolution: 'unknown' as const, scoring_court_side: null } }
    : { ...serviceCommand(commandId, rallyId), base_revision: baseRevision, kind: 'CLOSE_RALLY' as const, payload: { target_key_point_id: targetKeyPointId, score_resolution: 'resolved' as const, scoring_court_side: outcome } }) as AnnotationCommand
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
  await db.matchSet.create({ data: { id: ids.plannedSet, matchId: ids.match, setNumber: 2, status: 'PLANNED' } })
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
  await db.captureSession.create({ data: {
    health: 'HEALTHY', id: ids.foreignCapture, ingestPath: '/phase3a-foreign', matchId: ids.match,
    sourceKind: 'fixture', status: 'LIVE',
  } })
  await db.captureEpoch.create({ data: {
    captureFrameOrigin: 0n, captureSessionId: ids.foreignCapture, captureTimeOriginUs: 0n,
    id: ids.foreignEpoch, sequenceIndex: 0, sourcePtsOrigin: 0n,
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
  await db.mediaAsset.create({ data: {
    bucket: 'phase3a', contentType: 'application/json', id: ids.sampleAsset,
    internalSchemaVersion: '1.0.0', kind: 'SAMPLE_INDEX', objectKey: 'sample-index.json',
    readyAt: new Date(), state: 'READY',
  } })
  const anchorTime = BigInt(anchor.capture_time_us)
  const anchorFrame = BigInt(anchor.capture_frame_index)
  await db.dvrSegment.createMany({ data: [
    {
      captureEndUs: anchorTime + 100n, captureEpochId: ids.epoch, captureStartUs: anchorTime - 100n,
      discontinuitySequence: 0, dvrProgramId: ids.program, durationUs: 200n,
      firstFrameIndex: anchorFrame - 2n, frameCount: 5n, id: ids.segment,
      readyAt: new Date(), sampleIndexAssetId: ids.sampleAsset, sequenceNumber: 0n,
    },
    {
      captureEndUs: anchorTime + 100n, captureEpochId: ids.epoch, captureStartUs: anchorTime - 100n,
      discontinuitySequence: 0, dvrProgramId: ids.newerProgram, durationUs: 200n,
      firstFrameIndex: anchorFrame - 2n, frameCount: 5n, id: ids.foreignProgramSegment,
      readyAt: new Date(), sampleIndexAssetId: ids.sampleAsset, sequenceNumber: 0n,
    },
    {
      captureEndUs: anchorTime + 100n, captureEpochId: ids.foreignEpoch, captureStartUs: anchorTime - 100n,
      discontinuitySequence: 0, dvrProgramId: ids.program, durationUs: 200n,
      firstFrameIndex: anchorFrame - 2n, frameCount: 5n, id: ids.foreignEpochSegment,
      readyAt: new Date(), sampleIndexAssetId: ids.sampleAsset, sequenceNumber: 1n,
    },
  ] })
  await db.playbackWindow.create({ data: {
    captureEndUs: anchorTime + 1_000n, captureSessionId: ids.capture, captureStartUs: anchorTime - 2_000n,
    createdByUserId: ids.operator, dvrProgramId: ids.program,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'), id: ids.window,
    mappingVersion: 1, mode: 'ARCHIVE', presentationOriginCaptureUs: anchorTime - 1_234n,
    targetPlayerMediaTimeUs: 1_234n, timelineVersion: 1n,
    segments: { create: [
      { dvrSegmentId: ids.segment, sequenceIndex: 0 },
      { dvrSegmentId: ids.foreignProgramSegment, sequenceIndex: 1 },
      { dvrSegmentId: ids.foreignEpochSegment, sequenceIndex: 2 },
    ] },
  } })
  service = createAnnotationCommandService({
    database: db,
    resolveCursor: async () => {
      if (cursorFailure) throw cursorFailure
      return anchor
    },
  })
}, 120_000)

afterEach(async () => {
  if (db) {
    await db.rally.updateMany({
      data: { annotationStatus: 'VOIDED', voidedAt: new Date() },
      where: { annotationStatus: { in: ['OPEN', 'READY'] }, setId: ids.set },
    })
  }
})

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
      setId: ids.set,
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
    const retry = await service.apply(structuredClone(command), identity)
    expect(JSON.stringify(retry)).toBe(JSON.stringify(first))
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

  it('durably rejects a sequential second active draft in the same set', async () => {
    const first = serviceCommand(randomUUID(), randomUUID())
    const second = serviceCommand(randomUUID(), randomUUID())
    await expect(service.apply(first, identity)).resolves.toMatchObject({ type: 'command_ack' })
    await expect(service.apply(second, identity)).resolves.toMatchObject({
      type: 'command_rejected', code: 'ACTIVE_RALLY_EXISTS',
    })
    await expect(db.rally.count({ where: { id: { in: [first.rally_id, second.rally_id] } } })).resolves.toBe(1)
    await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: second.command_id } })).resolves.toMatchObject({ accepted: false })
  })

  it('allows only one active draft when different rally ids race for the same set', async () => {
    const commands = [
      serviceCommand(randomUUID(), randomUUID()),
      serviceCommand(randomUUID(), randomUUID()),
    ]
    const responses = await Promise.all(commands.map((value) => service.apply(value, identity)))
    expect(responses.filter((value) => value.type === 'command_ack')).toHaveLength(1)
    expect(responses.filter((value) => value.type === 'command_rejected' && value.code === 'ACTIVE_RALLY_EXISTS')).toHaveLength(1)
    const rallies = await db.rally.findMany({
      orderBy: { ordinal: 'asc' },
      select: { id: true, ordinal: true },
      where: { id: { in: commands.map((value) => value.rally_id) } },
    })
    expect(rallies).toHaveLength(1)
    await expect(db.annotationCommandReceipt.count({
      where: { commandId: { in: commands.map((value) => value.command_id) } },
    })).resolves.toBe(2)
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
    const unsupported = parseAnnotationCommand({
      ...serviceCommand(randomUUID(), randomUUID()),
      kind: 'MOVE_KEY_POINT',
      payload: { key_point_id: randomUUID(), playback_cursor: serviceCommand(randomUUID(), randomUUID()).payload.playback_cursor },
    })
    await expect(service.apply(unsupported, identity)).resolves.toMatchObject({ code: 'UNSUPPORTED_COMMAND' })
    const stale = serviceCommand(randomUUID(), randomUUID())
    stale.base_revision = '3'
    const firstStale = await service.apply(stale, identity)
    expect(firstStale).toMatchObject({
      code: 'REVISION_CONFLICT', expected_revision: '3', actual_revision: '0',
    })
    const retriedStale = await service.apply(structuredClone(stale), identity)
    expect(JSON.stringify(retriedStale)).toBe(JSON.stringify(firstStale))
    for (const command of [unsupported, stale]) {
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

  it('rejects nonexistent, foreign-program, foreign-epoch and removed playback mappings', async () => {
    const variants: ResolvedMediaAnchor[] = [
      { ...anchor, dvr_segment_id: null },
      { ...anchor, dvr_segment_id: randomUUID() },
      { ...anchor, dvr_segment_id: ids.foreignProgramSegment },
      { ...anchor, capture_epoch_id: ids.foreignEpoch, dvr_segment_id: ids.foreignEpochSegment },
    ]
    for (const invalidAnchor of variants) {
      const invalidService = createAnnotationCommandService({ database: db, resolveCursor: async () => invalidAnchor })
      const command = serviceCommand(randomUUID(), randomUUID())
      await expect(invalidService.apply(command, identity)).resolves.toMatchObject({
        type: 'command_rejected', code: 'ANNOTATION_NOT_READY',
      })
      await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toMatchObject({ accepted: false })
      await expect(db.rally.findUnique({ where: { id: command.rally_id } })).resolves.toBeNull()
      await expect(db.keyPoint.count({ where: { rallyId: command.rally_id } })).resolves.toBe(0)
      await expect(db.annotationOperation.findUnique({ where: { clientMutationId: command.command_id } })).resolves.toBeNull()
    }

    await db.playbackWindowSegment.delete({
      where: { playbackWindowId_dvrSegmentId: { dvrSegmentId: ids.segment, playbackWindowId: ids.window } },
    })
    const removed = serviceCommand(randomUUID(), randomUUID())
    try {
      await expect(service.apply(removed, identity)).resolves.toMatchObject({
        type: 'command_rejected', code: 'ANNOTATION_NOT_READY',
      })
      await expect(db.rally.findUnique({ where: { id: removed.rally_id } })).resolves.toBeNull()
      await expect(db.keyPoint.count({ where: { rallyId: removed.rally_id } })).resolves.toBe(0)
      await expect(db.annotationOperation.findUnique({ where: { clientMutationId: removed.command_id } })).resolves.toBeNull()
    } finally {
      await db.playbackWindowSegment.create({
        data: { dvrSegmentId: ids.segment, playbackWindowId: ids.window, sequenceIndex: 0 },
      })
    }
  })

  it('revalidates membership after cursor resolution and durably rejects a stale room', async () => {
    const staleMembershipService = createAnnotationCommandService({
      database: db,
      resolveCursor: async () => {
        await db.matchMember.delete({
          where: { matchId_userId: { matchId: ids.match, userId: ids.operator } },
        })
        return anchor
      },
    })
    const command = serviceCommand(randomUUID(), randomUUID())
    try {
      await expect(staleMembershipService.apply(command, identity)).resolves.toMatchObject({
        type: 'command_rejected', code: 'ROOM_AUTHORIZATION_STALE',
      })
      await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toMatchObject({ accepted: false })
      await expect(db.rally.findUnique({ where: { id: command.rally_id } })).resolves.toBeNull()
      await expect(db.keyPoint.count({ where: { rallyId: command.rally_id } })).resolves.toBe(0)
      await expect(db.annotationOperation.findUnique({ where: { clientMutationId: command.command_id } })).resolves.toBeNull()
    } finally {
      await db.matchMember.create({ data: { matchId: ids.match, role: 'OPERATOR', userId: ids.operator } })
    }
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

  it('creates contacts, preserves anchors, and replays accepted/rejected responses byte-for-byte', async () => {
    const rallyId = randomUUID()
    const serviceResponse = await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    expect(serviceResponse.type).toBe('command_ack')
    const command = contactCommand(randomUUID(), rallyId)
    const first = await service.apply(command, identity)
    expect(first).toMatchObject({ type: 'command_ack', operation_kind: 'CREATE_CONTACT_KEY_POINT', result_revision: '2' })
    const replay = await service.apply(structuredClone(command), identity)
    const stored = await db.annotationCommandReceipt.findUniqueOrThrow({ where: { commandId: command.command_id } })
    expect(JSON.stringify(replay)).toBe(JSON.stringify(parseAnnotationCommandResponse(stored.responseJson)))
    const mismatch = structuredClone(command); mismatch.payload.playback_cursor.player_media_time_us = '9999'
    expect(await service.apply(mismatch, identity)).toMatchObject({ type: 'command_rejected', code: 'COMMAND_ID_REUSED' })
    expect(await db.keyPoint.count({ where: { rallyId } })).toBe(2)
  })

  it('marks equal-frame contacts as possible duplicates and rejects stale mapping/anchor state', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const first = await service.apply(contactCommand(randomUUID(), rallyId), identity)
    const second = await service.apply(contactCommand(randomUUID(), rallyId, '2'), identity)
    expect(first.type).toBe('command_ack'); expect(second.type).toBe('command_ack')
    await expect(db.keyPoint.findMany({ where: { rallyId }, orderBy: { sequenceIndex: 'asc' }, select: { markerKind: true, possibleDuplicate: true } })).resolves.toEqual([{ markerKind: 'SERVICE', possibleDuplicate: false }, { markerKind: 'CONTACT', possibleDuplicate: true }, { markerKind: 'CONTACT', possibleDuplicate: true }])
    const invalid = createAnnotationCommandService({ database: db, resolveCursor: async () => ({ ...anchor, playback_window_id: randomUUID() }) })
    await expect(invalid.apply(contactCommand(randomUUID(), rallyId, '3'), identity)).resolves.toMatchObject({ type: 'command_rejected', code: 'ANNOTATION_NOT_READY' })
  })

  it('inserts a contact in canonical middle order under the rally lock', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const early = { ...anchor, capture_time_us: '9007199254740800', capture_frame_index: '9007199254740900' }
    const late = { ...anchor, capture_time_us: '9007199254741100', capture_frame_index: '9007199254741101' }
    const resolver = createAnnotationCommandService({ database: db, resolveCursor: async (cursor) => cursor.player_media_time_us === '1' ? early : late })
    const first = contactCommand(randomUUID(), rallyId); first.payload.playback_cursor.player_media_time_us = '1'; await resolver.apply(first, identity)
    const second = contactCommand(randomUUID(), rallyId, '2'); second.payload.playback_cursor.player_media_time_us = '2'; await resolver.apply(second, identity)
    const middle = { ...anchor, capture_time_us: '9007199254741000', capture_frame_index: '9007199254741000' }
    const middleService = createAnnotationCommandService({ database: db, resolveCursor: async () => middle }); await middleService.apply(contactCommand(randomUUID(), rallyId, '3'), identity)
    await expect(db.keyPoint.findMany({ where: { rallyId }, orderBy: { sequenceIndex: 'asc' }, select: { markerKind: true, sequenceIndex: true, captureTimeUs: true } })).resolves.toEqual([{ markerKind: 'SERVICE', sequenceIndex: 0, captureTimeUs: 9007199254740993n }, { markerKind: 'CONTACT', sequenceIndex: 1, captureTimeUs: 9007199254740800n }, { markerKind: 'CONTACT', sequenceIndex: 2, captureTimeUs: 9007199254741000n }, { markerKind: 'CONTACT', sequenceIndex: 3, captureTimeUs: 9007199254741100n }])
  })

  it.each(['left', 'right', 'unknown'] as const)('closes with %s outcome without creating forbidden rows', async (outcome) => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const before = await db.keyPoint.findMany({ where: { rallyId }, select: { id: true, captureTimeUs: true, captureFrameIndex: true, sourcePts: true, captureEpochId: true, timingPrecision: true, isTerminal: true } })
    const target = before[0]!.id
    const closeCommandValue = closeCommand(randomUUID(), rallyId, target, '1', outcome)
    const response = await service.apply(closeCommandValue, identity)
    expect(response).toMatchObject({ type: 'command_ack', operation_kind: 'CLOSE_RALLY', resolved_anchor: null, effects: { annotation_status: 'ready', score_resolution: outcome === 'unknown' ? 'unknown' : 'resolved', scoring_court_side: outcome === 'unknown' ? null : outcome } })
    const after = await db.keyPoint.findMany({ where: { rallyId }, select: { id: true, captureTimeUs: true, captureFrameIndex: true } })
    expect(after).toEqual(before); await expect(db.rallySubmission.count({ where: { rallyId } })).resolves.toBe(0); await expect(db.pointAward.count()).resolves.toBe(0)
    await expect(db.clipJob.count()).resolves.toBe(0); await expect(db.aiJob.count()).resolves.toBe(0); await expect(db.analysisRun.count()).resolves.toBe(0)
    const replay = await service.apply(structuredClone(closeCommandValue), identity)
    expect(JSON.stringify(replay)).toBe(JSON.stringify(parseAnnotationCommandResponse((await db.annotationCommandReceipt.findUniqueOrThrow({ where: { commandId: closeCommandValue.command_id } })).responseJson)))
  })

  it('rejects non-last, deleted and stale close targets with snapshot refetch', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity); const contact = await service.apply(contactCommand(randomUUID(), rallyId), identity)
    const servicePoint = (await db.keyPoint.findFirstOrThrow({ where: { rallyId, sequenceIndex: 0 } })).id
    await expect(service.apply(closeCommand(randomUUID(), rallyId, servicePoint, '2'), identity)).resolves.toMatchObject({ code: 'CLOSE_RALLY_TARGET_NOT_LAST', snapshot_refetch_required: true })
    await expect(service.apply(closeCommand(randomUUID(), rallyId, (contact as any).effects.created_key_point_id, '1'), identity)).resolves.toMatchObject({ code: 'REVISION_CONFLICT', snapshot_refetch_required: true })
  })

  it('rejects a deleted close target without changing the rally', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const point = await db.keyPoint.findFirstOrThrow({ where: { rallyId } }); await db.keyPoint.update({ data: { deletedAt: new Date() }, where: { id: point.id } })
    await expect(service.apply(closeCommand(randomUUID(), rallyId, point.id, '1'), identity)).resolves.toMatchObject({ type: 'command_rejected', code: 'CLOSE_RALLY_TARGET_NOT_LAST', snapshot_refetch_required: true })
  })

  it('serializes contact races and close races to one accepted mutation', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const contacts = await Promise.all([service.apply(contactCommand(randomUUID(), rallyId), identity), service.apply(contactCommand(randomUUID(), rallyId), identity)])
    expect(contacts.filter((value) => value.type === 'command_ack')).toHaveLength(1)
    const point = await db.keyPoint.findFirstOrThrow({ where: { rallyId, sequenceIndex: 1 } })
    const closes = await Promise.all([service.apply(closeCommand(randomUUID(), rallyId, point.id, '2', 'left'), identity), service.apply(closeCommand(randomUUID(), rallyId, point.id, '2', 'right'), identity)])
    expect(closes.filter((value) => value.type === 'command_ack')).toHaveLength(1)
    expect(closes.filter((value) => value.type === 'command_rejected')).toHaveLength(1)
  })
})
