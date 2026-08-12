import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import {
  buildSampleIndex,
  serializeSampleIndex,
  type SampleIndex,
} from '@volleyball-monitoring/media'
import type { db as databaseClient } from '@volleyball-monitoring/db'
import type { MediaObjectReadRequest } from '../src/media/playback-domain.js'
import type { MediaCursorRouteDependencies } from '../src/media/cursor-routes.js'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `mediacursor_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  asset1: '52000000-0000-4000-8000-000000000001',
  asset2: '52000000-0000-4000-8000-000000000002',
  epoch: '52000000-0000-4000-8000-000000000003',
  fullWindow: '52000000-0000-4000-8000-000000000004',
  match: '52000000-0000-4000-8000-000000000005',
  operator: '52000000-0000-4000-8000-000000000006',
  outsider: '52000000-0000-4000-8000-000000000007',
  program: '52000000-0000-4000-8000-000000000008',
  segment1: '52000000-0000-4000-8000-000000000009',
  segment2: '52000000-0000-4000-8000-000000000010',
  session: '52000000-0000-4000-8000-000000000011',
  singleWindow: '52000000-0000-4000-8000-000000000012',
}

const now = new Date('2026-08-07T04:00:00.000Z')
const captureOriginUs = 9_007_199_254_740_993n
const captureFrameOrigin = 9_007_199_254_741_993n
const sourcePtsOrigin = -9_007_199_254_740_993n
const sampleDurationPts = 1_002n
const timeBase = { num: 1n, den: 60_000n }
const epochOrigin = {
  captureFrameOrigin,
  captureTimeOriginUs: captureOriginUs,
  epochId: ids.epoch,
  sourcePtsOrigin,
  timeBase,
}

function sampleFrame(sourcePts: bigint, keyFrame = false) {
  return {
    key_frame: keyFrame ? 1 : 0,
    media_type: 'video' as const,
    pkt_duration: sampleDurationPts.toString(),
    pts: sourcePts.toString(),
  }
}

const firstIndex = buildSampleIndex(
  [
    sampleFrame(sourcePtsOrigin, true),
    sampleFrame(sourcePtsOrigin + sampleDurationPts),
  ],
  epochOrigin,
)
const secondIndex = buildSampleIndex(
  [
    sampleFrame(sourcePtsOrigin + 2n * sampleDurationPts),
    sampleFrame(sourcePtsOrigin + 3n * sampleDurationPts),
  ],
  { ...epochOrigin, captureFrameOrigin: captureFrameOrigin + 2n },
)
const bytesByLocation = new Map<string, Uint8Array>()
const reads: MediaObjectReadRequest[] = []
const keys = {
  first: 'fixtures/cursor/first.json',
  second: 'fixtures/cursor/second.json',
}
const bucket = 'dvr-media'

let app: FastifyInstance
let db: typeof databaseClient
let createdDatabase = false

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function indexBytes(index: SampleIndex): Uint8Array {
  return Buffer.from(JSON.stringify(serializeSampleIndex(index)))
}

async function createUser(id: string, label: string): Promise<void> {
  await db.user.create({
    data: {
      displayName: label,
      email: `${id}@cursor.integration.local`,
      id,
    },
  })
}

async function createIndexAsset(input: {
  id: string
  index: SampleIndex
  key: string
}): Promise<void> {
  const bytes = indexBytes(input.index)
  bytesByLocation.set(`${bucket}/${input.key}`, bytes)
  await db.mediaAsset.create({
    data: {
      bucket,
      byteLength: BigInt(bytes.byteLength),
      contentType: 'application/json',
      id: input.id,
      internalSchemaVersion: '1.0.0',
      kind: 'SAMPLE_INDEX',
      objectKey: input.key,
      readyAt: now,
      sha256: sha256(bytes),
      state: 'READY',
    },
  })
}

async function createSegment(input: {
  assetId: string
  id: string
  index: SampleIndex
  sequenceNumber: bigint
}): Promise<void> {
  const first = input.index.samples[0]!
  const last = input.index.samples.at(-1)!
  await db.dvrSegment.create({
    data: {
      captureEndUs: input.index.availableEndUs,
      captureEpochId: ids.epoch,
      captureStartUs: input.index.availableStartUs,
      discontinuitySequence: 0,
      durationUs: input.index.availableEndUs - input.index.availableStartUs,
      dvrProgramId: ids.program,
      firstFrameIndex: first.captureFrameIndex,
      frameCount: BigInt(input.index.samples.length),
      id: input.id,
      readyAt: now,
      sampleIndexAssetId: input.assetId,
      sequenceNumber: input.sequenceNumber,
      sourcePtsEnd: last.sourcePts + last.durationPts,
      sourcePtsStart: first.sourcePts,
    },
  })
}

async function createWindow(input: {
  endUs: bigint
  id: string
  segmentIds: readonly string[]
}): Promise<void> {
  await db.playbackWindow.create({
    data: {
      captureEndUs: input.endUs,
      captureSessionId: ids.session,
      captureStartUs: firstIndex.availableStartUs,
      createdByUserId: ids.operator,
      dvrProgramId: ids.program,
      expiresAt: new Date(now.getTime() + 60_000),
      id: input.id,
      mappingVersion: 3,
      mode: 'ARCHIVE',
      presentationOriginCaptureUs: captureOriginUs,
      segments: {
        create: input.segmentIds.map((dvrSegmentId, sequenceIndex) => ({
          dvrSegmentId,
          sequenceIndex,
        })),
      },
      targetPlayerMediaTimeUs: 0n,
      timelineVersion: 1n,
    },
  })
}

async function seedFixture(): Promise<void> {
  await Promise.all([
    createUser(ids.operator, 'Operator'),
    createUser(ids.outsider, 'Outsider'),
  ])
  await db.match.create({
    data: {
      id: ids.match,
      members: {
        create: { role: 'OPERATOR', userId: ids.operator },
      },
      title: 'Cursor integration fixture',
    },
  })
  await db.captureSession.create({
    data: {
      id: ids.session,
      ingestPath: `/cursor/${ids.session}`,
      matchId: ids.match,
      sourceKind: 'fixture',
    },
  })
  await db.captureEpoch.create({
    data: {
      captureFrameOrigin,
      captureSessionId: ids.session,
      captureTimeOriginUs: captureOriginUs,
      id: ids.epoch,
      sequenceIndex: 0,
      sourcePtsOrigin,
      sourceTimeBaseDen: 60_000,
      sourceTimeBaseNum: 1,
      startedAtCaptureUs: captureOriginUs,
    },
  })
  await db.dvrProgram.create({
    data: {
      captureSessionId: ids.session,
      durationUs: secondIndex.availableEndUs - firstIndex.availableStartUs,
      fpsDen: 1_001,
      fpsNum: 60_000,
      id: ids.program,
      liveEdgeUs: secondIndex.availableEndUs,
      status: 'LIVE',
      timeBaseDen: 60_000,
      timeBaseNum: 1,
    },
  })
  await createIndexAsset({ id: ids.asset1, index: firstIndex, key: keys.first })
  await createIndexAsset({ id: ids.asset2, index: secondIndex, key: keys.second })
  await createSegment({
    assetId: ids.asset1,
    id: ids.segment1,
    index: firstIndex,
    sequenceNumber: 0n,
  })
  await createSegment({
    assetId: ids.asset2,
    id: ids.segment2,
    index: secondIndex,
    sequenceNumber: 1n,
  })
  await createWindow({
    endUs: secondIndex.availableEndUs,
    id: ids.fullWindow,
    segmentIds: [ids.segment1, ids.segment2],
  })
  await createWindow({
    endUs: firstIndex.availableEndUs,
    id: ids.singleWindow,
    segmentIds: [ids.segment1],
  })
}

function cursorPayload(windowId: string, playerMediaTimeUs: bigint) {
  return {
    cursor_status: 'ready',
    mapping_version: 3,
    observation_source: 'request_video_frame_callback',
    playback_window_id: windowId,
    player_media_time_us: playerMediaTimeUs.toString(),
    schema_version: '1.0.0',
    seek_generation: 1,
  }
}

function stepPayload(
  windowId: string,
  frame: bigint,
  direction: 'previous' | 'next',
  count = 1,
) {
  return {
    capture_frame_index: frame.toString(),
    capture_session_id: ids.session,
    direction,
    count,
    mapping_version: 3,
    playback_window_id: windowId,
    schema_version: '1.1.0',
  }
}

function headers(user: 'operator' | 'outsider') {
  return { 'x-test-user': user }
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
  const routeModule = await import('../src/media/cursor-routes.js')
  db = dbModule.db
  await seedFixture()

  const dependencies: MediaCursorRouteDependencies = {
    authenticate: async (request) => {
      const key = request.headers['x-test-user']
      if (key === 'operator') return { id: ids.operator, role: 'OPERATOR' }
      if (key === 'outsider') return { id: ids.outsider, role: 'OPERATOR' }
      return null
    },
    database: db,
    now: () => now,
    objectReader: async (request) => {
      reads.push(request)
      const bytes = bytesByLocation.get(`${request.bucket}/${request.key}`)
      if (!bytes) throw new Error('private missing object')
      if (
        BigInt(bytes.byteLength) !== request.expectedByteLength
        || sha256(bytes) !== request.expectedSha256
      ) throw new Error('private corrupt object')
      return bytes
    },
  }
  app = Fastify({ logger: false })
  await app.register(routeModule.mediaCursorRoutes(dependencies))
  await app.ready()
}, 120_000)

afterAll(async () => {
  if (app) await app.close()
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

describe('media cursor persistence integration', () => {
  it('membership-filters a persisted window and resolves only its ordered mappings', async () => {
    const earlier = firstIndex.samples.at(-1)!
    const later = secondIndex.samples[0]!
    const midpoint = earlier.captureTimeUs
      + (later.captureTimeUs - earlier.captureTimeUs) / 2n

    const anonymous = await app.inject({
      method: 'POST',
      payload: cursorPayload(ids.fullWindow, midpoint - captureOriginUs),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(anonymous.statusCode).toBe(401)

    const outsider = await app.inject({
      headers: headers('outsider'),
      method: 'POST',
      payload: cursorPayload(ids.fullWindow, midpoint - captureOriginUs),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(outsider.statusCode).toBe(404)

    reads.length = 0
    const operator = await app.inject({
      headers: headers('operator'),
      method: 'POST',
      payload: cursorPayload(ids.fullWindow, midpoint - captureOriginUs),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(operator.statusCode).toBe(200)
    expect(operator.json()).toMatchObject({
      capture_frame_index: earlier.captureFrameIndex.toString(),
      capture_time_us: earlier.captureTimeUs.toString(),
      dvr_segment_id: ids.segment1,
      source_pts: earlier.sourcePts.toString(),
      timing_precision: 'frame_exact',
    })
    expect(reads.map((read) => read.key)).toEqual([keys.first, keys.second])
  })

  it('steps across a persisted segment and detects the bounded playback edge', async () => {
    const current = firstIndex.samples.at(-1)!
    const expected = secondIndex.samples[0]!
    const across = await app.inject({
      headers: headers('operator'),
      method: 'POST',
      payload: stepPayload(ids.fullWindow, current.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })
    expect(across.statusCode).toBe(200)
    expect(across.json()).toMatchObject({
      capture_frame_index: expected.captureFrameIndex.toString(),
      dvr_segment_id: ids.segment2,
      player_media_time_us: (
        expected.captureTimeUs - captureOriginUs
      ).toString(),
    })

    const bounded = await app.inject({
      headers: headers('operator'),
      method: 'POST',
      payload: stepPayload(ids.singleWindow, current.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })
    expect(bounded.statusCode).toBe(409)
    expect(bounded.json().code).toBe('WINDOW_BOUNDARY')
  })
})
