import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { db as databaseClient } from '@volleyball-monitoring/db'
import type { MediaIdentity, MediaPlaybackDeps } from '../src/routes/media-playback.js'
import type { MediaObjectReadRequest } from '../src/media/playback-domain.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  originalDatabaseUrl ??
  'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `phase2media_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  admin: '30000000-0000-4000-8000-000000000001',
  operator: '30000000-0000-4000-8000-000000000002',
  outsider: '30000000-0000-4000-8000-000000000003',
  match: '30000000-0000-4000-8000-000000000010',
  session: '30000000-0000-4000-8000-000000000011',
  epoch: '30000000-0000-4000-8000-000000000012',
  resetEpoch: '30000000-0000-4000-8000-000000000014',
  program: '30000000-0000-4000-8000-000000000013',
  segment1: '30000000-0000-4000-8000-000000000021',
  segment2: '30000000-0000-4000-8000-000000000022',
  gap: '30000000-0000-4000-8000-000000000023',
  segment3: '30000000-0000-4000-8000-000000000024',
  notReady: '30000000-0000-4000-8000-000000000025',
  init: '30000000-0000-4000-8000-000000000031',
  media1: '30000000-0000-4000-8000-000000000032',
  index1: '30000000-0000-4000-8000-000000000033',
  media2: '30000000-0000-4000-8000-000000000034',
  index2: '30000000-0000-4000-8000-000000000035',
  media3: '30000000-0000-4000-8000-000000000036',
  index3: '30000000-0000-4000-8000-000000000037',
  expiredWindow: '30000000-0000-4000-8000-000000000041',
}

const baseUs = 9_007_199_254_740_992n
const now = new Date('2026-08-07T04:00:00.000Z')
const objectBytes = new Map<string, Uint8Array>()
const reads: MediaObjectReadRequest[] = []
const identities: Record<string, MediaIdentity> = {
  admin: { id: ids.admin, role: 'ADMIN' },
  operator: { id: ids.operator, role: 'OPERATOR' },
  outsider: { id: ids.outsider, role: 'OPERATOR' },
}

let db: typeof databaseClient
let app: FastifyInstance
let createdDatabase = false

function objectMapKey(location: { bucket: string; key: string }): string {
  return `${location.bucket}/${location.key}`
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function createUser(id: string, label: string) {
  await db.user.create({
    data: {
      displayName: label,
      email: `${id}@media.integration.local`,
      id,
    },
  })
}

async function createAsset(input: {
  id: string
  kind: 'DVR_INIT' | 'DVR_SEGMENT' | 'SAMPLE_INDEX'
  key: string
  contentType: 'video/mp4' | 'application/json'
  bytes: Uint8Array
}) {
  objectBytes.set(`dvr-media/${input.key}`, input.bytes)
  await db.mediaAsset.create({
    data: {
      bucket: 'dvr-media',
      byteLength: BigInt(input.bytes.byteLength),
      contentType: input.contentType,
      id: input.id,
      internalSchemaVersion: '1.0.0',
      kind: input.kind,
      objectKey: input.key,
      readyAt: now,
      sha256: sha256(input.bytes),
      state: 'READY',
    },
  })
}

async function seedMediaFixture() {
  await Promise.all([
    createUser(ids.admin, 'Admin'),
    createUser(ids.operator, 'Operator'),
    createUser(ids.outsider, 'Outsider'),
  ])
  await db.match.create({
    data: {
      id: ids.match,
      members: { create: { role: 'OPERATOR', userId: ids.operator } },
      title: 'Phase 2 media fixture',
    },
  })
  await db.captureSession.create({
    data: {
      health: 'HEALTHY',
      id: ids.session,
      ingestPath: `/fixture/${ids.session}`,
      matchId: ids.match,
      sourceKind: 'fixture',
      status: 'LIVE',
    },
  })
  await db.captureEpoch.create({
    data: {
      captureFrameOrigin: 0n,
      captureSessionId: ids.session,
      captureTimeOriginUs: baseUs,
      endedAtCaptureUs: baseUs + 1_000_000n,
      id: ids.epoch,
      sequenceIndex: 0,
      sourcePtsOrigin: 0n,
      sourceTimeBaseDen: 30,
      sourceTimeBaseNum: 1,
      startedAtCaptureUs: baseUs,
    },
  })
  await db.captureEpoch.create({
    data: {
      captureFrameOrigin: 30n,
      captureSessionId: ids.session,
      captureTimeOriginUs: baseUs + 1_000_000n,
      discontinuityReason: 'PTS_RESET',
      id: ids.resetEpoch,
      sequenceIndex: 1,
      sourcePtsOrigin: 0n,
      sourceTimeBaseDen: 30,
      sourceTimeBaseNum: 1,
      startedAtCaptureUs: baseUs + 1_000_000n,
    },
  })
  await db.dvrProgram.create({
    data: {
      captureSessionId: ids.session,
      durationUs: 6_000_000n,
      fpsDen: 1,
      fpsNum: 30,
      id: ids.program,
      liveEdgeUs: baseUs + 5_000_000n,
      playlistRevision: 9_007_199_254_740_993n,
      status: 'LIVE',
      timeBaseDen: 30,
      timeBaseNum: 1,
    },
  })

  await Promise.all([
    createAsset({
      bytes: Buffer.from('init-bytes'),
      contentType: 'video/mp4',
      id: ids.init,
      key: 'fixture/init.mp4',
      kind: 'DVR_INIT',
    }),
    createAsset({
      bytes: Buffer.from('media-one'),
      contentType: 'video/mp4',
      id: ids.media1,
      key: 'fixture/one.m4s',
      kind: 'DVR_SEGMENT',
    }),
    createAsset({
      bytes: Buffer.from('{"samples":[1]}'),
      contentType: 'application/json',
      id: ids.index1,
      key: 'fixture/one.json',
      kind: 'SAMPLE_INDEX',
    }),
    createAsset({
      bytes: Buffer.from('media-two'),
      contentType: 'video/mp4',
      id: ids.media2,
      key: 'fixture/two.m4s',
      kind: 'DVR_SEGMENT',
    }),
    createAsset({
      bytes: Buffer.from('{"samples":[2]}'),
      contentType: 'application/json',
      id: ids.index2,
      key: 'fixture/two.json',
      kind: 'SAMPLE_INDEX',
    }),
    createAsset({
      bytes: Buffer.from('media-three'),
      contentType: 'video/mp4',
      id: ids.media3,
      key: 'fixture/three.m4s',
      kind: 'DVR_SEGMENT',
    }),
    createAsset({
      bytes: Buffer.from('{"samples":[3]}'),
      contentType: 'application/json',
      id: ids.index3,
      key: 'fixture/three.json',
      kind: 'SAMPLE_INDEX',
    }),
  ])

  await db.dvrSegment.createMany({
    data: [
      {
        captureEndUs: baseUs + 1_000_000n,
        captureEpochId: ids.epoch,
        captureStartUs: baseUs,
        discontinuitySequence: 0,
        durationUs: 1_000_000n,
        frameCount: 30n,
        id: ids.segment1,
        initAssetId: ids.init,
        mediaAssetId: ids.media1,
        readyAt: now,
        sampleIndexAssetId: ids.index1,
        dvrProgramId: ids.program,
        sequenceNumber: 0n,
      },
      {
        captureEndUs: baseUs + 2_000_000n,
        captureEpochId: ids.resetEpoch,
        captureStartUs: baseUs + 1_000_000n,
        discontinuitySequence: 0,
        durationUs: 1_000_000n,
        frameCount: 30n,
        id: ids.segment2,
        initAssetId: ids.init,
        mediaAssetId: ids.media2,
        readyAt: now,
        sampleIndexAssetId: ids.index2,
        dvrProgramId: ids.program,
        sequenceNumber: 1n,
      },
      {
        captureEndUs: baseUs + 4_000_000n,
        captureEpochId: ids.epoch,
        captureStartUs: baseUs + 2_000_000n,
        discontinuitySequence: 1,
        durationUs: 2_000_000n,
        frameCount: 0n,
        id: ids.gap,
        isGap: true,
        dvrProgramId: ids.program,
        sequenceNumber: 2n,
      },
      {
        captureEndUs: baseUs + 5_000_000n,
        captureEpochId: ids.epoch,
        captureStartUs: baseUs + 4_000_000n,
        discontinuitySequence: 1,
        durationUs: 1_000_000n,
        frameCount: 30n,
        id: ids.segment3,
        initAssetId: ids.init,
        mediaAssetId: ids.media3,
        readyAt: now,
        sampleIndexAssetId: ids.index3,
        dvrProgramId: ids.program,
        sequenceNumber: 3n,
      },
      {
        captureEndUs: baseUs + 6_000_000n,
        captureEpochId: ids.epoch,
        captureStartUs: baseUs + 5_000_000n,
        discontinuitySequence: 1,
        durationUs: 1_000_000n,
        frameCount: 30n,
        id: ids.notReady,
        dvrProgramId: ids.program,
        sequenceNumber: 4n,
      },
    ],
  })
}

function authHeaders(user: keyof typeof identities) {
  return { 'x-test-user': user }
}

function createRequestBody(targetUs: bigint) {
  return {
    schema_version: '1.0.0',
    capture_session_id: ids.session,
    mode: 'archive',
    target_capture_time_us: targetUs.toString(),
    requested_back_us: '2000000',
    requested_forward_us: '1000000',
  }
}

function errorBody(response: { json(): unknown }) {
  return response.json() as {
    schema_version: string
    code: string
    message: string
    request_id: string
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
  const dbModule = await import('@volleyball-monitoring/db')
  const routeModule = await import('../src/routes/media-playback.js')
  db = dbModule.db
  await seedMediaFixture()

  const dependencies: MediaPlaybackDeps = {
    authenticate: async request => {
      const key = request.headers['x-test-user']
      return typeof key === 'string' ? (identities[key] ?? null) : null
    },
    limits: {
      defaultBackUs: 1_000_000n,
      defaultForwardUs: 1_000_000n,
      maxBackUs: 2_000_000n,
      maxForwardUs: 2_000_000n,
    },
    now: () => now,
    objectReader: async request => {
      reads.push(request)
      const bytes = objectBytes.get(objectMapKey(request))
      if (!bytes) throw new Error('missing test object')
      if (
        BigInt(bytes.byteLength) !== request.expectedByteLength ||
        sha256(bytes) !== request.expectedSha256
      ) {
        throw new Error('corrupt test object')
      }
      return bytes
    },
    resolveSample: async ({ segments, targetUs }) => ({
      captureUs: targetUs === segments.at(-1)!.captureEndUs ? targetUs - 1n : targetUs,
      playerUs:
        (targetUs === segments.at(-1)!.captureEndUs ? targetUs - 1n : targetUs) -
        segments[0]!.captureStartUs,
    }),
    windowTtlMs: 300_000,
  }
  app = Fastify({ logger: false })
  await app.register(routeModule.mediaPlaybackRoutes(dependencies))
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

describe('Phase 2A playback-window HTTP', () => {
  it('creates and reads a bounded bigint window without forbidden domain writes', async () => {
    const forbiddenBefore = await Promise.all([
      db.rally.count(),
      db.keyPoint.count(),
      db.annotationOperation.count(),
      db.rallySubmission.count(),
      db.clipJob.count(),
      db.aiJob.count(),
    ])
    const response = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 1_500_000n),
      url: '/api/v1/media/playback-windows',
    })
    expect(response.statusCode).toBe(200)
    const descriptor = response.json()
    expect(descriptor).toMatchObject({
      schema_version: '1.0.0',
      capture_session_id: ids.session,
      timeline_capture_start_us: baseUs.toString(),
      timeline_capture_end_us: (baseUs + 5_000_000n).toString(),
      window_capture_start_us: baseUs.toString(),
      window_capture_end_us: (baseUs + 2_000_000n).toString(),
      presentation_origin_capture_us: baseUs.toString(),
      target_player_media_time_us: '1500000',
      live_edge_capture_time_us: (baseUs + 5_000_000n).toString(),
      has_more_before: false,
      has_more_after: true,
    })
    const windowId = String(descriptor.playback_window_id)
    expect(
      await db.playbackWindowSegment.count({
        where: { playbackWindowId: windowId },
      }),
    ).toBe(2)
    const fetched = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: `/api/v1/media/playback-windows/${windowId}`,
    })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json()).toEqual(descriptor)
    expect(
      await Promise.all([
        db.rally.count(),
        db.keyPoint.count(),
        db.annotationOperation.count(),
        db.rallySubmission.count(),
        db.clipJob.count(),
        db.aiJob.count(),
      ]),
    ).toEqual(forbiddenBefore)
  })

  it('extends one stable manifest without replacing the playback window', async () => {
    const created = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: {
        ...createRequestBody(baseUs + 500_000n),
        requested_back_us: '0',
        requested_forward_us: '0',
      },
      url: '/api/v1/media/playback-windows',
    })
    expect(created.statusCode).toBe(200)
    const original = created.json()
    expect(
      await db.playbackWindowSegment.count({
        where: { playbackWindowId: original.playback_window_id },
      }),
    ).toBe(1)

    await db.playbackWindow.update({
      data: { expiresAt: new Date(now.getTime() + 30_000) },
      where: { id: original.playback_window_id },
    })

    const unchanged = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: {
        schema_version: '1.0.0',
        target_capture_time_us: (baseUs + 500_000n).toString(),
        requested_forward_us: '0',
      },
      url: `/api/v1/media/playback-windows/${original.playback_window_id}/extend`,
    })
    expect(unchanged.statusCode).toBe(200)
    expect(unchanged.json()).toMatchObject({
      playback_window_id: original.playback_window_id,
      mapping_version: original.mapping_version,
      window_capture_end_us: original.window_capture_end_us,
    })
    expect(unchanged.json().expires_at).toBe(new Date(now.getTime() + 300_000).toISOString())
    expect(
      (
        await db.playbackWindow.findUniqueOrThrow({
          where: { id: original.playback_window_id },
        })
      ).expiresAt,
    ).toEqual(new Date(now.getTime() + 300_000))

    const extended = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: {
        schema_version: '1.0.0',
        target_capture_time_us: (baseUs + 500_000n).toString(),
        requested_forward_us: '1500000',
      },
      url: `/api/v1/media/playback-windows/${original.playback_window_id}/extend`,
    })
    expect(extended.statusCode).toBe(200)
    expect(extended.json()).toMatchObject({
      playback_window_id: original.playback_window_id,
      manifest_url: original.manifest_url,
      mapping_version: original.mapping_version + 1,
      presentation_origin_capture_us: original.presentation_origin_capture_us,
      window_capture_end_us: (baseUs + 2_000_000n).toString(),
    })
    expect(
      await db.playbackWindowSegment.count({
        where: { playbackWindowId: original.playback_window_id },
      }),
    ).toBe(2)

    const repeated = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: {
        schema_version: '1.0.0',
        target_capture_time_us: (baseUs + 500_000n).toString(),
        requested_forward_us: '1500000',
      },
      url: `/api/v1/media/playback-windows/${original.playback_window_id}/extend`,
    })
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json()).toMatchObject({
      playback_window_id: original.playback_window_id,
      mapping_version: original.mapping_version + 1,
      window_capture_end_us: (baseUs + 2_000_000n).toString(),
    })
    expect(
      await db.playbackWindowSegment.count({
        where: { playbackWindowId: original.playback_window_id },
      }),
    ).toBe(2)

    const manifest = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: original.manifest_url,
    })
    expect(manifest.body).toContain(`/segments/media-${ids.segment1}`)
    expect(manifest.body).toContain(`/segments/media-${ids.segment2}`)
    expect(manifest.body).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0')
    expect(manifest.body.match(/^#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1)
    expect(manifest.body).toContain('#EXT-X-ENDLIST')
  })

  it('serves a bounded manifest and verified init/media bytes through opaque tokens', async () => {
    const created = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 1_500_000n),
      url: '/api/v1/media/playback-windows',
    })
    const windowId = String(created.json().playback_window_id)
    const manifest = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: `/api/v1/media/playback-windows/${windowId}/manifest.m3u8`,
    })
    expect(manifest.statusCode).toBe(200)
    expect(manifest.headers['content-type']).toContain('application/vnd.apple.mpegurl')
    expect(manifest.body).toContain(`/segments/init-${ids.segment1}`)
    expect(manifest.body).toContain(`/segments/media-${ids.segment1}`)
    expect(manifest.body).toContain(`/segments/media-${ids.segment2}`)
    expect(manifest.body).not.toMatch(/fixture\/|objectKey|minio/i)

    reads.length = 0
    const init = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: `/api/v1/media/playback-windows/${windowId}/segments/init-${ids.segment1}`,
    })
    const media = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: `/api/v1/media/playback-windows/${windowId}/segments/media-${ids.segment2}`,
    })
    expect(init.statusCode).toBe(200)
    expect(init.rawPayload).toEqual(Buffer.from('init-bytes'))
    expect(media.statusCode).toBe(200)
    expect(media.rawPayload).toEqual(Buffer.from('media-two'))
    expect(reads).toEqual([
      {
        bucket: 'dvr-media',
        expectedByteLength: 10n,
        expectedContentType: 'video/mp4',
        expectedInternalSchemaVersion: '1.0.0',
        expectedKind: 'DVR_INIT',
        expectedSha256: sha256(Buffer.from('init-bytes')),
        key: 'fixture/init.mp4',
      },
      {
        bucket: 'dvr-media',
        expectedByteLength: 9n,
        expectedContentType: 'video/mp4',
        expectedInternalSchemaVersion: '1.0.0',
        expectedKind: 'DVR_SEGMENT',
        expectedSha256: sha256(Buffer.from('media-two')),
        key: 'fixture/two.m4s',
      },
    ])
  })

  it('enforces anonymous, outsider, admin, missing and expired access', async () => {
    const created = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 500_000n),
      url: '/api/v1/media/playback-windows',
    })
    const windowId = String(created.json().playback_window_id)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/media/playback-windows/${windowId}`,
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          headers: authHeaders('outsider'),
          method: 'GET',
          url: `/api/v1/media/playback-windows/${windowId}`,
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          headers: authHeaders('admin'),
          method: 'GET',
          url: `/api/v1/media/playback-windows/${windowId}`,
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          headers: authHeaders('operator'),
          method: 'GET',
          url: `/api/v1/media/playback-windows/${randomUUID()}`,
        })
      ).statusCode,
    ).toBe(404)

    await db.playbackWindow.create({
      data: {
        captureEndUs: baseUs + 1_000_000n,
        captureSessionId: ids.session,
        captureStartUs: baseUs,
        createdByUserId: ids.operator,
        dvrProgramId: ids.program,
        expiresAt: new Date(now.getTime() - 1),
        id: ids.expiredWindow,
        mappingVersion: 1,
        mode: 'ARCHIVE',
        presentationOriginCaptureUs: baseUs,
        targetPlayerMediaTimeUs: 0n,
        timelineVersion: 1n,
      },
    })
    const expired = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: `/api/v1/media/playback-windows/${ids.expiredWindow}`,
    })
    expect(expired.statusCode).toBe(410)
    expect(errorBody(expired).code).toBe('WINDOW_EXPIRED')
  })

  it('distinguishes capture gaps, not-ready media, and foreign resource tokens', async () => {
    const gap = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 2_500_000n),
      url: '/api/v1/media/playback-windows',
    })
    expect(gap.statusCode).toBe(422)
    expect(errorBody(gap).code).toBe('CAPTURE_GAP')

    const notReady = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 5_500_000n),
      url: '/api/v1/media/playback-windows',
    })
    expect(notReady.statusCode).toBe(409)
    expect(errorBody(notReady).code).toBe('MEDIA_NOT_READY')

    const created = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 500_000n),
      url: '/api/v1/media/playback-windows',
    })
    const windowId = String(created.json().playback_window_id)
    const foreign = await app.inject({
      headers: authHeaders('operator'),
      method: 'GET',
      url: `/api/v1/media/playback-windows/${windowId}/segments/media-${ids.segment3}`,
    })
    expect(foreign.statusCode).toBe(404)
    expect(errorBody(foreign).code).toBe('NOT_FOUND')
  })

  it('fails closed on object corruption', async () => {
    const created = await app.inject({
      headers: authHeaders('operator'),
      method: 'POST',
      payload: createRequestBody(baseUs + 500_000n),
      url: '/api/v1/media/playback-windows',
    })
    const windowId = String(created.json().playback_window_id)
    const key = 'dvr-media/fixture/one.m4s'
    const original = objectBytes.get(key)!
    objectBytes.set(key, Buffer.from('corrupt'))
    try {
      const response = await app.inject({
        headers: authHeaders('operator'),
        method: 'GET',
        url: `/api/v1/media/playback-windows/${windowId}/segments/media-${ids.segment1}`,
      })
      expect(response.statusCode).toBe(409)
      expect(errorBody(response).code).toBe('MEDIA_NOT_READY')
    } finally {
      objectBytes.set(key, original)
    }
  })

  it('rolls back the window when a persisted segment mapping fails', async () => {
    await db.$executeRawUnsafe(`
      CREATE FUNCTION reject_second_playback_mapping() RETURNS trigger AS $$
      BEGIN
        IF NEW."sequenceIndex" = 1 THEN RAISE EXCEPTION 'fixture mapping failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_second_playback_mapping
      BEFORE INSERT ON "PlaybackWindowSegment"
      FOR EACH ROW EXECUTE FUNCTION reject_second_playback_mapping();
    `)
    const before = await db.playbackWindow.count()
    try {
      const response = await app.inject({
        headers: authHeaders('operator'),
        method: 'POST',
        payload: createRequestBody(baseUs + 1_500_000n),
        url: '/api/v1/media/playback-windows',
      })
      expect(response.statusCode).toBe(409)
      expect(errorBody(response).code).toBe('MEDIA_NOT_READY')
      expect(await db.playbackWindow.count()).toBe(before)
    } finally {
      await db.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS reject_second_playback_mapping ON "PlaybackWindowSegment";
        DROP FUNCTION IF EXISTS reject_second_playback_mapping();
      `)
    }
  })
})
