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
import { cancelCorrectionDraft, createCorrectionDraft } from '../src/services/correction-draft.js'

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

function submitCommand(commandId: string, rallyId: string, baseRevision: string) {
  return parseAnnotationCommand({
    ...serviceCommand(commandId, rallyId),
    base_revision: baseRevision,
    kind: 'SUBMIT_RALLY',
    payload: {},
  })
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
    await Promise.all([
      db.rally.updateMany({
        data: { annotationStatus: 'VOIDED', voidedAt: new Date() },
        where: { setId: ids.set, voidedAt: null },
      }),
      db.playbackWindow.update({
        data: { captureEndUs: BigInt(anchor.capture_time_us) + 1_000n },
        where: { id: ids.window },
      }),
      db.dvrSegment.update({
        data: { captureEndUs: BigInt(anchor.capture_time_us) + 100n, frameCount: 5n },
        where: { id: ids.segment },
      }),
    ])
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

  it('keeps a closed unsubmitted rally while starting the next rally', async () => {
    const readyRallyId = randomUUID()
    const nextRallyId = randomUUID()
    await expect(service.apply(serviceCommand(randomUUID(), readyRallyId), identity)).resolves.toMatchObject({ type: 'command_ack' })
    const contact = await service.apply(contactCommand(randomUUID(), readyRallyId), identity)
    const terminalId = contact.type === 'command_ack' ? contact.effects.created_key_point_id : null
    expect(terminalId).toBeTruthy()
    await expect(service.apply(closeCommand(randomUUID(), readyRallyId, terminalId!, '2'), identity)).resolves.toMatchObject({
      type: 'command_ack', effects: { annotation_status: 'ready' },
    })

    const laterAnchor = {
      ...anchor,
      capture_frame_index: (BigInt(anchor.capture_frame_index) + 300n).toString(),
      capture_time_us: (BigInt(anchor.capture_time_us) + 10_000_000n).toString(),
      resolved_player_media_time_us: (BigInt(anchor.resolved_player_media_time_us) + 10_000_000n).toString(),
    }
    await Promise.all([
      db.playbackWindow.update({ data: { captureEndUs: BigInt(laterAnchor.capture_time_us) + 1n }, where: { id: ids.window } }),
      db.dvrSegment.update({ data: { captureEndUs: BigInt(laterAnchor.capture_time_us) + 1n, frameCount: 303n }, where: { id: ids.segment } }),
    ])
    const laterService = createAnnotationCommandService({ database: db, resolveCursor: async () => laterAnchor })
    await expect(laterService.apply(serviceCommand(randomUUID(), nextRallyId), identity)).resolves.toMatchObject({
      type: 'command_ack', effects: { annotation_status: 'open' },
    })
    await expect(db.rally.findMany({
      where: { id: { in: [readyRallyId, nextRallyId] } },
      orderBy: { ordinal: 'asc' },
      select: { id: true, annotationStatus: true },
    })).resolves.toEqual([
      { id: readyRallyId, annotationStatus: 'READY' },
      { id: nextRallyId, annotationStatus: 'OPEN' },
    ])
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

  it('parses but durably rejects orphaned edit commands and stale service revisions', async () => {
    const orphanedEdit = parseAnnotationCommand({
      ...serviceCommand(randomUUID(), randomUUID()),
      kind: 'MOVE_KEY_POINT',
      payload: { key_point_id: randomUUID(), playback_cursor: serviceCommand(randomUUID(), randomUUID()).payload.playback_cursor },
    })
    await expect(service.apply(orphanedEdit, identity)).resolves.toMatchObject({ code: 'ROOM_AUTHORIZATION_STALE' })
    const stale = serviceCommand(randomUUID(), randomUUID())
    stale.base_revision = '3'
    const firstStale = await service.apply(stale, identity)
    expect(firstStale).toMatchObject({
      code: 'REVISION_CONFLICT', expected_revision: '3', actual_revision: '0',
    })
    const retriedStale = await service.apply(structuredClone(stale), identity)
    expect(JSON.stringify(retriedStale)).toBe(JSON.stringify(firstStale))
    for (const command of [orphanedEdit, stale]) {
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

  it('moves, deletes, reopens and voids only the mutable Rally draft', async () => {
    const rallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const contact = await service.apply(contactCommand(randomUUID(), rallyId), identity)
    expect(contact).toMatchObject({ type: 'command_ack', result_revision: '2' })
    const keyPointId = contact.type === 'command_ack' ? contact.effects.created_key_point_id : null
    expect(keyPointId).toBeTruthy()

    const move = parseAnnotationCommand({
      ...serviceCommand(randomUUID(), rallyId), base_revision: '2', kind: 'MOVE_KEY_POINT',
      payload: { key_point_id: keyPointId, playback_cursor: serviceCommand(randomUUID(), rallyId).payload.playback_cursor },
    })
    await expect(service.apply(move, identity)).resolves.toMatchObject({ type: 'command_ack', operation_kind: 'MOVE_KEY_POINT', result_revision: '3' })

    const remove = parseAnnotationCommand({ ...serviceCommand(randomUUID(), rallyId), base_revision: '3', kind: 'DELETE_KEY_POINT', payload: { key_point_id: keyPointId } })
    await expect(service.apply(remove, identity)).resolves.toMatchObject({ type: 'command_ack', operation_kind: 'DELETE_KEY_POINT', result_revision: '4', effects: { deleted_key_point_id: keyPointId } })
    await expect(db.keyPoint.findUniqueOrThrow({ where: { id: keyPointId! } })).resolves.toMatchObject({ deletedAt: expect.any(Date) })

    const nextContact = await service.apply(contactCommand(randomUUID(), rallyId, '4'), identity)
    const terminalId = nextContact.type === 'command_ack' ? nextContact.effects.created_key_point_id : null
    await expect(service.apply(closeCommand(randomUUID(), rallyId, terminalId!, '5', 'left'), identity)).resolves.toMatchObject({ type: 'command_ack', result_revision: '6' })
    const reopen = parseAnnotationCommand({ ...serviceCommand(randomUUID(), rallyId), base_revision: '6', kind: 'REOPEN_RALLY', payload: {} })
    await expect(service.apply(reopen, identity)).resolves.toMatchObject({ type: 'command_ack', operation_kind: 'REOPEN_RALLY', result_revision: '7', effects: { annotation_status: 'open', score_resolution: 'pending' } })
    await expect(db.keyPoint.findUniqueOrThrow({ where: { id: terminalId! } })).resolves.toMatchObject({ isTerminal: false })

    const voidCommand = parseAnnotationCommand({ ...serviceCommand(randomUUID(), rallyId), base_revision: '7', kind: 'VOID_RALLY', payload: { reason: 'fixture_cleanup' } })
    await expect(service.apply(voidCommand, identity)).resolves.toMatchObject({ type: 'command_ack', operation_kind: 'VOID_RALLY', result_revision: '8', effects: { annotation_status: 'voided' } })
    await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({ annotationStatus: 'VOIDED', annotationRevision: 8n, voidedAt: expect.any(Date) })
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
    const early = { ...anchor, capture_time_us: '9007199254740994', capture_frame_index: '9007199254740995', resolved_player_media_time_us: '1235' }
    const late = { ...anchor, capture_time_us: '9007199254741083', capture_frame_index: '9007199254740996', resolved_player_media_time_us: '1324' }
    const resolver = createAnnotationCommandService({ database: db, resolveCursor: async (cursor) => cursor.player_media_time_us === '1' ? early : late })
    const first = contactCommand(randomUUID(), rallyId); first.payload.playback_cursor.player_media_time_us = '1'; await resolver.apply(first, identity)
    const second = contactCommand(randomUUID(), rallyId, '2'); second.payload.playback_cursor.player_media_time_us = '2'; await resolver.apply(second, identity)
    const middle = { ...anchor, capture_time_us: '9007199254741043', capture_frame_index: '9007199254740995', resolved_player_media_time_us: '1284' }
    const middleService = createAnnotationCommandService({ database: db, resolveCursor: async () => middle }); await middleService.apply(contactCommand(randomUUID(), rallyId, '3'), identity)
    await expect(db.keyPoint.findMany({ where: { rallyId }, orderBy: { sequenceIndex: 'asc' }, select: { markerKind: true, sequenceIndex: true, captureTimeUs: true } })).resolves.toEqual([{ markerKind: 'SERVICE', sequenceIndex: 0, captureTimeUs: 9007199254740993n }, { markerKind: 'CONTACT', sequenceIndex: 1, captureTimeUs: 9007199254740994n }, { markerKind: 'CONTACT', sequenceIndex: 2, captureTimeUs: 9007199254741043n }, { markerKind: 'CONTACT', sequenceIndex: 3, captureTimeUs: 9007199254741083n }])
  })

  it.each(['left', 'right', 'unknown'] as const)('closes with %s outcome without creating forbidden rows', async (outcome) => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const before = await db.keyPoint.findMany({ where: { rallyId }, select: { id: true, captureTimeUs: true, captureFrameIndex: true, sourcePts: true, captureEpochId: true, timingPrecision: true, isTerminal: true } })
    const target = before[0]!.id
    const closeCommandValue = closeCommand(randomUUID(), rallyId, target, '1', outcome)
    const response = await service.apply(closeCommandValue, identity)
    expect(response).toMatchObject({ type: 'command_ack', operation_kind: 'CLOSE_RALLY', resolved_anchor: null, effects: { annotation_status: 'ready', score_resolution: outcome === 'unknown' ? 'unknown' : 'resolved', scoring_court_side: outcome === 'unknown' ? null : outcome } })
    const after = await db.keyPoint.findMany({ where: { rallyId }, select: { id: true, captureTimeUs: true, captureFrameIndex: true, sourcePts: true, captureEpochId: true, timingPrecision: true, isTerminal: true } })
    expect(after).toHaveLength(before.length); expect(after[0]).toMatchObject({ id: before[0]!.id, captureTimeUs: before[0]!.captureTimeUs, captureFrameIndex: before[0]!.captureFrameIndex, sourcePts: before[0]!.sourcePts, captureEpochId: before[0]!.captureEpochId, timingPrecision: before[0]!.timingPrecision, isTerminal: true }); await expect(db.rallySubmission.count({ where: { rallyId } })).resolves.toBe(0); await expect(db.pointAward.count()).resolves.toBe(0)
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

  it('serializes a contact-vs-close race from one base revision with a durable loser', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const contact = contactCommand(randomUUID(), rallyId, '1')
    const close = closeCommand(randomUUID(), rallyId, (await db.keyPoint.findFirstOrThrow({ where: { rallyId } })).id, '1', 'unknown')
    const responses = await Promise.all([service.apply(contact, identity), service.apply(close, identity)])
    expect(responses.filter((r) => r.type === 'command_ack')).toHaveLength(1)
    expect(responses.filter((r) => r.type === 'command_rejected')).toHaveLength(1)
    expect(await db.annotationCommandReceipt.count({ where: { commandId: { in: [contact.command_id, close.command_id] } } })).toBe(2)
    expect((await db.rally.findUniqueOrThrow({ where: { id: rallyId } })).annotationRevision).toBe(2n)
  })

  it('durably rejects contact after membership is revoked during cursor resolution', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const stale = createAnnotationCommandService({ database: db, resolveCursor: async () => { await db.matchMember.delete({ where: { matchId_userId: { matchId: ids.match, userId: ids.operator } } }); return anchor } })
    const command = contactCommand(randomUUID(), rallyId, '1')
    try { await expect(stale.apply(command, identity)).resolves.toMatchObject({ code: 'ROOM_AUTHORIZATION_STALE' }) } finally { await db.matchMember.create({ data: { matchId: ids.match, role: 'OPERATOR', userId: ids.operator } }) }
  })

  it('durably rejects close when room authorization becomes stale before its transaction', async () => {
    const rallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const target = await db.keyPoint.findFirstOrThrow({ where: { rallyId } })
    const command = closeCommand(randomUUID(), rallyId, target.id, '1', 'left')
    const acceptedOutboxBefore = await db.outboxEvent.count({
      where: { aggregateId: rallyId, eventType: 'annotation.command_accepted.v2' },
    })
    const stale = createAnnotationCommandService({
      beforeTransaction: async (candidate) => {
        if (candidate.kind === 'CLOSE_RALLY') {
          await db.matchMember.delete({
            where: { matchId_userId: { matchId: ids.match, userId: ids.operator } },
          })
        }
      },
      database: db,
      resolveCursor: async () => anchor,
    })

    try {
      await expect(stale.apply(command, identity)).resolves.toMatchObject({
        code: 'ROOM_AUTHORIZATION_STALE',
        type: 'command_rejected',
      })
      await expect(db.annotationCommandReceipt.findUnique({
        where: { commandId: command.command_id },
      })).resolves.toMatchObject({ accepted: false })
      await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({
        annotationRevision: 1n,
        annotationStatus: 'OPEN',
        scoreResolutionState: 'PENDING',
        scoringCourtSide: null,
      })
      await expect(db.keyPoint.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({
        isTerminal: false,
      })
      await expect(db.annotationOperation.findUnique({
        where: { clientMutationId: command.command_id },
      })).resolves.toBeNull()
      await expect(db.outboxEvent.count({
        where: { aggregateId: rallyId, eventType: 'annotation.command_accepted.v2' },
      })).resolves.toBe(acceptedOutboxBefore)
    } finally {
      await db.matchMember.create({
        data: { matchId: ids.match, role: 'OPERATOR', userId: ids.operator },
      })
    }
  })

  it('rejects revoked devices, anchor-before-service, and foreign playback mappings durably', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    await db.deviceSession.update({ data: { revokedAt: new Date() }, where: { id: ids.device } })
    try { await expect(service.apply(contactCommand(randomUUID(), rallyId), identity)).rejects.toThrow('Authenticated device session is not active') } finally { await db.deviceSession.update({ data: { revokedAt: null }, where: { id: ids.device } }) }
    const variants = [
      { ...anchor, capture_time_us: '1', capture_frame_index: '1' },
      { ...anchor, dvr_segment_id: randomUUID() },
      { ...anchor, dvr_segment_id: ids.foreignProgramSegment },
      { ...anchor, capture_epoch_id: ids.foreignEpoch, dvr_segment_id: ids.foreignEpochSegment },
    ]
    for (const variant of variants) {
      const invalid = createAnnotationCommandService({ database: db, resolveCursor: async () => variant })
      const command = contactCommand(randomUUID(), rallyId)
      await expect(invalid.apply(command, identity)).resolves.toMatchObject({ code: 'ANNOTATION_NOT_READY' })
      await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toMatchObject({ accepted: false })
    }
  })

  it('rolls back contact domain mutation when the late operation write fails', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const command = contactCommand(randomUUID(), rallyId)
    await db.annotationOperation.create({ data: { baseRevision: 99n, clientMutationId: command.command_id, deviceSessionId: ids.device, operationKind: 'LEGACY_TEST', payload: {}, payloadHash: 'legacy', rallyId, resultRevision: 99n, userId: ids.operator } })
    await expect(service.apply(command, identity)).rejects.toMatchObject({ code: 'P2002' })
    await expect(db.keyPoint.count({ where: { rallyId } })).resolves.toBe(1); await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({ annotationRevision: 1n }); await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toBeNull()
  })

  it('rolls back close terminal/outcome when the late operation write fails', async () => {
    const rallyId = randomUUID(); await service.apply(serviceCommand(randomUUID(), rallyId), identity); const point = await db.keyPoint.findFirstOrThrow({ where: { rallyId } })
    const command = closeCommand(randomUUID(), rallyId, point.id, '1', 'unknown')
    await db.annotationOperation.create({ data: { baseRevision: 99n, clientMutationId: command.command_id, deviceSessionId: ids.device, operationKind: 'LEGACY_TEST', payload: {}, payloadHash: 'legacy', rallyId, resultRevision: 99n, userId: ids.operator } })
    await expect(service.apply(command, identity)).rejects.toMatchObject({ code: 'P2002' })
    await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({ annotationRevision: 1n, annotationStatus: 'OPEN', scoreResolutionState: 'PENDING' }); await expect(db.keyPoint.findUniqueOrThrow({ where: { id: point.id } })).resolves.toMatchObject({ isTerminal: false }); await expect(db.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })).resolves.toBeNull()
  })

  it('keeps a correction READY beside the current OPEN rally and blocks a second open editor', async () => {
    const submittedRallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), submittedRallyId), identity)
    const submittedPoint = await db.keyPoint.findFirstOrThrow({ where: { rallyId: submittedRallyId } })
    await service.apply(closeCommand(randomUUID(), submittedRallyId, submittedPoint.id, '1', 'unknown'), identity)
    const submitted = await service.apply(submitCommand(randomUUID(), submittedRallyId, '2'), identity)
    const submissionId = submitted.type === 'command_ack' ? submitted.effects.submission_id : null
    expect(submissionId).toBeTruthy()

    const openRallyId = randomUUID()
    const laterAnchor = {
      ...anchor,
      capture_frame_index: (BigInt(anchor.capture_frame_index) + 300n).toString(),
      capture_time_us: (BigInt(anchor.capture_time_us) + 10_000_000n).toString(),
      resolved_player_media_time_us: (BigInt(anchor.resolved_player_media_time_us) + 10_000_000n).toString(),
    }
    await Promise.all([
      db.playbackWindow.update({ data: { captureEndUs: BigInt(laterAnchor.capture_time_us) + 1n }, where: { id: ids.window } }),
      db.dvrSegment.update({ data: { captureEndUs: BigInt(laterAnchor.capture_time_us) + 1n, frameCount: 303n }, where: { id: ids.segment } }),
    ])
    const laterService = createAnnotationCommandService({ database: db, resolveCursor: async () => laterAnchor })
    await expect(laterService.apply(serviceCommand(randomUUID(), openRallyId), identity)).resolves.toMatchObject({
      type: 'command_ack', effects: { annotation_status: 'open' },
    })
    await expect(createCorrectionDraft(db, submissionId!, identity)).resolves.toMatchObject({
      annotation_status: 'ready', revision: '4', supersedes_submission_id: submissionId,
    })

    const reopen = parseAnnotationCommand({
      ...serviceCommand(randomUUID(), submittedRallyId),
      base_revision: '4',
      kind: 'REOPEN_RALLY',
      payload: {},
    })
    await expect(service.apply(reopen, identity)).resolves.toMatchObject({
      type: 'command_rejected', code: 'ACTIVE_RALLY_EXISTS',
    })
    await expect(db.rally.findMany({
      where: { id: { in: [submittedRallyId, openRallyId] } },
      orderBy: { ordinal: 'asc' },
      select: { id: true, annotationStatus: true },
    })).resolves.toEqual([
      { id: submittedRallyId, annotationStatus: 'READY' },
      { id: openRallyId, annotationStatus: 'OPEN' },
    ])
  })

  it('opens a correction draft and applies winner/unknown changes through one CAS score ledger', async () => {
    const rallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const servicePoint = await db.keyPoint.findFirstOrThrow({ where: { rallyId } })
    await service.apply(closeCommand(randomUUID(), rallyId, servicePoint.id, '1', 'left'), identity)
    const firstResponse = await service.apply(submitCommand(randomUUID(), rallyId, '2'), identity)
    const firstSubmissionId = firstResponse.type === 'command_ack' ? firstResponse.effects.submission_id : null
    expect(firstSubmissionId).toBeTruthy()
    await expect(db.matchSet.findUniqueOrThrow({ where: { id: ids.set } })).resolves.toMatchObject({ leftScore: 1, rightScore: 0, scoreRevision: 1 })
    await expect(db.scoreLedgerEntry.findMany({ where: { setId: ids.set }, orderBy: { scoreRevisionAfter: 'asc' } })).resolves.toMatchObject([
      { kind: 'POINT_AWARD', leftDelta: 1, rightDelta: 0, scoreRevisionBefore: 0, scoreRevisionAfter: 1 },
    ])
    await expect(db.pointAward.findUnique({ where: { submissionId: firstSubmissionId! } })).resolves.toMatchObject({ ledgerEntryId: expect.any(String) })

    await expect(createCorrectionDraft(db, firstSubmissionId!, identity)).resolves.toMatchObject({
      annotation_status: 'ready', revision: '4', supersedes_submission_id: firstSubmissionId,
    })
    const restored = await db.keyPoint.findMany({ where: { rallyId, deletedAt: null }, orderBy: { sequenceIndex: 'asc' } })
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: servicePoint.id, isTerminal: true, markerKind: 'SERVICE' })
    await service.apply(parseAnnotationCommand({ ...serviceCommand(randomUUID(), rallyId), base_revision: '4', kind: 'REOPEN_RALLY', payload: {} }), identity)
    await service.apply(closeCommand(randomUUID(), rallyId, servicePoint.id, '5', 'right'), identity)
    const secondResponse = await service.apply(submitCommand(randomUUID(), rallyId, '6'), identity)
    const secondSubmissionId = secondResponse.type === 'command_ack' ? secondResponse.effects.submission_id : null
    expect(secondSubmissionId).toBeTruthy()
    await expect(db.matchSet.findUniqueOrThrow({ where: { id: ids.set } })).resolves.toMatchObject({ leftScore: 0, rightScore: 1, scoreRevision: 2 })
    await expect(db.rallySubmission.findUniqueOrThrow({ where: { id: firstSubmissionId! } })).resolves.toMatchObject({ status: 'SUPERSEDED' })
    await expect(db.rallySubmission.findUniqueOrThrow({ where: { id: secondSubmissionId! } })).resolves.toMatchObject({ status: 'ACTIVE', supersedesSubmissionId: firstSubmissionId })
    await expect(db.scoreLedgerEntry.findMany({ where: { setId: ids.set }, orderBy: { scoreRevisionAfter: 'asc' } })).resolves.toMatchObject([
      { kind: 'POINT_AWARD', leftDelta: 1, rightDelta: 0, scoreRevisionBefore: 0, scoreRevisionAfter: 1 },
      { kind: 'CORRECTION', leftDelta: -1, rightDelta: 1, scoreRevisionBefore: 1, scoreRevisionAfter: 2, supersededSubmissionId: firstSubmissionId },
    ])
    await expect(db.clipJob.findFirstOrThrow({ where: { submissionId: firstSubmissionId! } })).resolves.toMatchObject({ status: 'SUPERSEDED' })

    await createCorrectionDraft(db, secondSubmissionId!, identity)
    await service.apply(parseAnnotationCommand({ ...serviceCommand(randomUUID(), rallyId), base_revision: '8', kind: 'REOPEN_RALLY', payload: {} }), identity)
    await service.apply(closeCommand(randomUUID(), rallyId, servicePoint.id, '9', 'unknown'), identity)
    const thirdResponse = await service.apply(submitCommand(randomUUID(), rallyId, '10'), identity)
    const thirdSubmissionId = thirdResponse.type === 'command_ack' ? thirdResponse.effects.submission_id : null
    expect(thirdSubmissionId).toBeTruthy()
    await expect(db.matchSet.findUniqueOrThrow({ where: { id: ids.set } })).resolves.toMatchObject({ leftScore: 0, rightScore: 0, scoreRevision: 3 })
    await expect(db.rallySubmission.findUniqueOrThrow({ where: { id: thirdSubmissionId! } })).resolves.toMatchObject({
      leftScoreAfter: null, leftScoreBefore: null, rightScoreAfter: null, rightScoreBefore: null,
      scoreResolutionState: 'UNKNOWN', scoreRevisionAfter: null, scoreRevisionBefore: null,
      supersedesSubmissionId: secondSubmissionId,
    })
    await expect(db.pointAward.findUnique({ where: { submissionId: thirdSubmissionId! } })).resolves.toBeNull()
    await expect(db.scoreLedgerEntry.findUnique({ where: { submissionId: thirdSubmissionId! } })).resolves.toMatchObject({
      kind: 'CORRECTION', leftDelta: 0, rightDelta: -1, scoreRevisionBefore: 2, scoreRevisionAfter: 3,
    })
  })

  it('cancels a correction and restores the active immutable submission', async () => {
    const rallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const servicePoint = await db.keyPoint.findFirstOrThrow({ where: { rallyId } })
    await service.apply(closeCommand(randomUUID(), rallyId, servicePoint.id, '1', 'left'), identity)
    const submitted = await service.apply(submitCommand(randomUUID(), rallyId, '2'), identity)
    const submissionId = submitted.type === 'command_ack' ? submitted.effects.submission_id : null
    expect(submissionId).toBeTruthy()

    await createCorrectionDraft(db, submissionId!, identity)
    await service.apply(closeCommand(randomUUID(), rallyId, servicePoint.id, '4', 'right'), identity)
    await expect(cancelCorrectionDraft(db, rallyId, identity)).resolves.toMatchObject({
      active_submission_id: submissionId,
      annotation_status: 'submitted',
      rally_id: rallyId,
      revision: '6',
    })
    await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({
      activeSubmissionId: submissionId,
      annotationStatus: 'SUBMITTED',
      scoringCourtSide: 'LEFT',
      scoreResolutionState: 'RESOLVED',
    })
    await expect(db.keyPoint.findMany({ where: { rallyId, deletedAt: null } })).resolves.toMatchObject([
      { id: servicePoint.id, isTerminal: true, markerKind: 'SERVICE' },
    ])
  })

  it('reuses completed clip, AI geometry and overlay assets for an outcome-only correction', async () => {
    const rallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const draftPoint = await db.keyPoint.findFirstOrThrow({ where: { rallyId } })
    await service.apply(closeCommand(randomUUID(), rallyId, draftPoint.id, '1', 'unknown'), identity)
    const initial = await service.apply(submitCommand(randomUUID(), rallyId, '2'), identity)
    const sourceSubmissionId = initial.type === 'command_ack' ? initial.effects.submission_id : null
    const sourceSubmission = await db.rallySubmission.findUniqueOrThrow({
      where: { id: sourceSubmissionId! }, include: { keyPoints: { orderBy: { sequenceIndex: 'asc' } } },
    })
    const sourcePoint = sourceSubmission.keyPoints[0]!
    const clipAssetId = randomUUID(); const timingAssetId = randomUUID(); const overlayAssetId = randomUUID()
    await db.mediaAsset.createMany({ data: [
      { id: clipAssetId, kind: 'CANONICAL_CLIP', bucket: 'reuse-test', objectKey: `${rallyId}.mp4`, contentType: 'video/mp4', byteLength: 10n, sha256: 'a'.repeat(64), state: 'READY', readyAt: new Date() },
      { id: timingAssetId, kind: 'TIMING_MANIFEST', bucket: 'reuse-test', objectKey: `${rallyId}.json`, contentType: 'application/json', byteLength: 10n, sha256: 'b'.repeat(64), state: 'READY', readyAt: new Date() },
      { id: overlayAssetId, kind: 'OVERLAY_CHUNK', bucket: 'reuse-test', objectKey: `${rallyId}.bin`, contentType: 'application/vnd.volleyball.overlay-chunk+flatbuffers', byteLength: 8n, sha256: 'c'.repeat(64), state: 'READY', readyAt: new Date() },
    ] })
    const sourceClip = await db.clipJob.findFirstOrThrow({ where: { submissionId: sourceSubmission.id } })
    await db.clipJob.update({ where: { id: sourceClip.id }, data: {
      status: 'COMPLETED', actualStartCaptureUs: sourcePoint.captureTimeUs - 1n, actualEndCaptureUs: sourcePoint.captureTimeUs + 1n,
      clipAssetId, timingManifestAssetId: timingAssetId, completedAt: new Date(),
    } })
    await db.clipKeyPointMapping.create({ data: { clipJobId: sourceClip.id, submissionKeyPointId: sourcePoint.id, clipPts: 0n, clipTimeUs: 1n, clipFrameIndex: 0n } })
    const integration = await db.aiIntegration.create({ data: { name: `reuse-${rallyId}`, submitUrl: 'http://reuse.invalid/v1/jobs', authSecretRef: 'reuse-test' } })
    const sourceAi = await db.aiJob.create({ data: {
      integrationId: integration.id, submissionId: sourceSubmission.id, clipJobId: sourceClip.id, status: 'COMPLETED',
      idempotencyKey: `reuse-source:${rallyId}`, requestPayload: { ai_job_id: 'source', rally_submission_id: sourceSubmission.id, annotation_revision: sourceSubmission.annotationRevision.toString(), key_points: [{ key_point_id: sourcePoint.id }], outcome: { score_resolution: 'unknown', scoring_court_side: null } },
      requestPayloadHash: 'd'.repeat(64), jobSchemaVersion: '1.1.0', callbackTokenHash: 'e'.repeat(64), callbackTokenExpiresAt: new Date(), completedAt: new Date(),
    } })
    const sourceAnalysis = await db.analysisRun.create({ data: {
      aiJobId: sourceAi.id, submissionId: sourceSubmission.id, analysisId: `reuse-analysis-${rallyId}`, analysisVersion: 'reuse-v1', resultSchemaVersion: '1.0.0', overlaySchemaVersion: '1.0.0', inputClipSha256: 'a'.repeat(64), producerName: 'fixture', producerBuildId: 'fixture', status: 'COMPLETED', activatedAt: new Date(),
    } })
    await db.contactEvent.create({ data: {
      analysisRunId: sourceAnalysis.id, keyPointId: sourcePoint.id, sequenceIndex: 0, anchorFrameIndex: sourcePoint.captureFrameIndex, anchorTimeUs: sourcePoint.captureTimeUs,
      markerKind: sourcePoint.markerKind, isTerminal: true, associationState: 'NO_PLAYER', ballState: 'MISSING', qualityFlags: [],
    } })
    await db.ballPathSegment.create({ data: {
      analysisRunId: sourceAnalysis.id, sequenceIndex: 0, startKeyPointId: sourcePoint.id, endKeyPointId: sourcePoint.id,
      startFrameIndex: sourcePoint.captureFrameIndex, endFrameIndex: sourcePoint.captureFrameIndex, renderState: 'UNAVAILABLE', isTerminalSegment: true, qualityFlags: [],
    } })
    await db.overlayManifest.create({ data: {
      analysisRunId: sourceAnalysis.id, schemaVersion: '1.0.0', overlayVersion: '1.0.0', videoWidth: 1920, videoHeight: 1080, fpsNum: 60, fpsDen: 1, totalFrames: 1n, chunkFrameCount: 60,
      chunks: { create: { chunkIndex: 0, startFrameIndex: 0n, frameCount: 1, assetId: overlayAssetId, byteLength: 8n, sha256: 'c'.repeat(64) } },
    } })

    await createCorrectionDraft(db, sourceSubmission.id, identity)
    await service.apply(parseAnnotationCommand({ ...serviceCommand(randomUUID(), rallyId), base_revision: '4', kind: 'REOPEN_RALLY', payload: {} }), identity)
    await service.apply(closeCommand(randomUUID(), rallyId, draftPoint.id, '5', 'right'), identity)
    const corrected = await service.apply(submitCommand(randomUUID(), rallyId, '6'), identity)
    const correctedSubmissionId = corrected.type === 'command_ack' ? corrected.effects.submission_id : null
    const reusedClip = await db.clipJob.findFirstOrThrow({ where: { submissionId: correctedSubmissionId! } })
    const reusedAi = await db.aiJob.findFirstOrThrow({ where: { submissionId: correctedSubmissionId! }, include: { analysisRun: { include: { contactEvents: true, overlayManifest: { include: { chunks: true } } } } } })
    const correctedPoint = await db.rallySubmissionKeyPoint.findFirstOrThrow({ where: { submissionId: correctedSubmissionId! } })
    expect(reusedClip).toMatchObject({ status: 'COMPLETED', clipAssetId, timingManifestAssetId: timingAssetId })
    expect(reusedAi).toMatchObject({ status: 'COMPLETED', stage: 'geometry_reused' })
    expect(reusedAi.analysisRun).toMatchObject({ status: 'COMPLETED', contactEvents: [{ keyPointId: correctedPoint.id }], overlayManifest: { chunks: [{ assetId: overlayAssetId }] } })
    await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({ processingStatus: 'COMPLETED', activeSubmissionId: correctedSubmissionId })
    await expect(db.clipJob.findUniqueOrThrow({ where: { id: sourceClip.id } })).resolves.toMatchObject({ status: 'SUPERSEDED' })
    await expect(db.analysisRun.findUniqueOrThrow({ where: { id: sourceAnalysis.id } })).resolves.toMatchObject({ status: 'SUPERSEDED' })
  })

  it('durably rejects a correction submission with no immutable content changes', async () => {
    const rallyId = randomUUID()
    await service.apply(serviceCommand(randomUUID(), rallyId), identity)
    const point = await db.keyPoint.findFirstOrThrow({ where: { rallyId } })
    await service.apply(closeCommand(randomUUID(), rallyId, point.id, '1', 'unknown'), identity)
    const first = await service.apply(submitCommand(randomUUID(), rallyId, '2'), identity)
    const submissionId = first.type === 'command_ack' ? first.effects.submission_id : null
    await createCorrectionDraft(db, submissionId!, identity)
    const duplicate = await service.apply(submitCommand(randomUUID(), rallyId, '4'), identity)
    expect(duplicate).toMatchObject({ type: 'command_rejected', code: 'ANNOTATION_NOT_READY' })
    await expect(db.rallySubmission.count({ where: { rallyId } })).resolves.toBe(1)
    await expect(db.rally.findUniqueOrThrow({ where: { id: rallyId } })).resolves.toMatchObject({
      activeSubmissionId: submissionId, annotationStatus: 'READY', annotationRevision: 4n,
    })
  })
})
