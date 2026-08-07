import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { db as databaseClient } from '@volleyball-monitoring/db'
import { rescalePtsToUs } from '@volleyball-monitoring/media'
import type {
  MediaObjectReader,
  MediaObjectReadRequest,
} from '../src/media/playback-domain.js'
import type {
  SampleIndexRepository as SampleIndexRepositoryType,
  SampleIndexRepositoryError,
  SampleIndexRepositoryErrorCode,
} from '../src/media/sample-index-repository.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `sampleindex_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  asset1: '41000000-0000-4000-8000-000000000031',
  asset2: '41000000-0000-4000-8000-000000000032',
  epoch1: '41000000-0000-4000-8000-000000000012',
  epoch2: '41000000-0000-4000-8000-000000000014',
  match: '41000000-0000-4000-8000-000000000010',
  program1: '41000000-0000-4000-8000-000000000013',
  program2: '41000000-0000-4000-8000-000000000015',
  segment1: '41000000-0000-4000-8000-000000000021',
  segment2: '41000000-0000-4000-8000-000000000022',
  session: '41000000-0000-4000-8000-000000000011',
}

const now = new Date('2026-08-07T04:00:00.000Z')
const captureOriginUs = 9_007_199_254_740_993n
const captureFrameOrigin = 9_007_199_254_741_093n
const sourcePtsOrigin = -9_007_199_254_740_993n
const sourceTimeBaseDen = 60_000
const sourceTimeBaseNum = 1
const timeBase = {
  den: BigInt(sourceTimeBaseDen),
  num: BigInt(sourceTimeBaseNum),
}
const sampleDurationPts = 1_001n
const segmentSampleCount = 2
const segment1SourceStart = sourcePtsOrigin
const segment1SourceEnd = sourcePtsOrigin + 2n * sampleDurationPts
const segment2SourceStart = segment1SourceEnd
const segment2SourceEnd = segment2SourceStart + 2n * sampleDurationPts
const segment1CaptureStart = captureOriginUs
const segment1CaptureEnd = captureOriginUs + rescalePtsToUs(
  segment1SourceEnd - sourcePtsOrigin,
  timeBase,
)
const segment2CaptureStart = segment1CaptureEnd
const segment2CaptureEnd = captureOriginUs + rescalePtsToUs(
  segment2SourceEnd - sourcePtsOrigin,
  timeBase,
)
const bucket = 'dvr-media'
const keys = {
  asset1: 'sample-index/segment-one.json',
  asset2: 'sample-index/segment-two.json',
}

type EpochDocumentOrigin = {
  epochId: string
  sourcePtsOrigin: bigint
  captureTimeOriginUs: bigint
  captureFrameOrigin: bigint
  timeBase: { num: bigint; den: bigint }
}

function sampleIndexBytes(input: {
  origin: EpochDocumentOrigin
  firstSourcePts: bigint
  firstFrameIndex: bigint
  durationPts?: bigint
  sampleCount?: number
  documentEpochId?: string
  documentTimeBase?: { num: bigint; den: bigint }
}): Uint8Array {
  const durationPts = input.durationPts ?? sampleDurationPts
  const sampleCount = input.sampleCount ?? segmentSampleCount
  return Buffer.from(JSON.stringify({
    epochId: input.documentEpochId ?? input.origin.epochId,
    samples: Array.from({ length: sampleCount }, (_value, index) => {
      const ordinal = BigInt(index)
      const sourcePts = input.firstSourcePts + ordinal * durationPts
      return {
        captureFrameIndex: (input.firstFrameIndex + ordinal).toString(),
        captureTimeUs: (
          input.origin.captureTimeOriginUs
          + rescalePtsToUs(
            sourcePts - input.origin.sourcePtsOrigin,
            input.origin.timeBase,
          )
        ).toString(),
        durationPts: durationPts.toString(),
        keyframe: index === 0,
        sourcePts: sourcePts.toString(),
      }
    }),
    schemaVersion: '1.0.0',
    timeBase: {
      den: (input.documentTimeBase ?? input.origin.timeBase).den.toString(),
      num: (input.documentTimeBase ?? input.origin.timeBase).num.toString(),
    },
  }))
}

const epoch1Origin: EpochDocumentOrigin = {
  captureFrameOrigin,
  captureTimeOriginUs: captureOriginUs,
  epochId: ids.epoch1,
  sourcePtsOrigin,
  timeBase,
}

const baselineBytes = {
  asset1: sampleIndexBytes({
    firstFrameIndex: captureFrameOrigin,
    firstSourcePts: segment1SourceStart,
    origin: epoch1Origin,
  }),
  asset2: sampleIndexBytes({
    firstFrameIndex: captureFrameOrigin + 2n,
    firstSourcePts: segment2SourceStart,
    origin: epoch1Origin,
  }),
}

const objectBytes = new Map<string, Uint8Array>()
const reads: MediaObjectReadRequest[] = []
let db: typeof databaseClient
let repository: SampleIndexRepositoryType
let SampleIndexRepositoryErrorClass: typeof SampleIndexRepositoryError
let createdDatabase = false
let expectedRowCounts: readonly number[]

function objectMapKey(location: { bucket: string; key: string }): string {
  return `${location.bucket}/${location.key}`
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const inMemoryReader: MediaObjectReader = async (request) => {
  reads.push(request)
  const bytes = objectBytes.get(objectMapKey(request))
  if (!bytes) throw new Error('secret missing object identity')
  if (
    BigInt(bytes.byteLength) !== request.expectedByteLength
    || sha256(bytes) !== request.expectedSha256.toLowerCase()
  ) {
    throw new Error('secret object verification failure')
  }
  return bytes
}

async function setAssetBytes(
  assetId: string,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  objectBytes.set(`${bucket}/${key}`, bytes)
  await db.mediaAsset.update({
    data: {
      byteLength: BigInt(bytes.byteLength),
      sha256: sha256(bytes),
    },
    where: { id: assetId },
  })
}

async function seedFixture(): Promise<void> {
  await db.match.create({ data: { id: ids.match, title: 'Sample index fixture' } })
  await db.captureSession.create({
    data: {
      id: ids.session,
      ingestPath: `/sample-index/${ids.session}`,
      matchId: ids.match,
      sourceKind: 'fixture',
    },
  })
  await db.captureEpoch.createMany({
    data: [
      {
        captureFrameOrigin,
        captureSessionId: ids.session,
        captureTimeOriginUs: captureOriginUs,
        id: ids.epoch1,
        sequenceIndex: 0,
        sourcePtsOrigin,
        sourceTimeBaseDen,
        sourceTimeBaseNum,
        startedAtCaptureUs: captureOriginUs,
      },
      {
        captureFrameOrigin: captureFrameOrigin + 2n,
        captureSessionId: ids.session,
        captureTimeOriginUs: segment2CaptureStart,
        id: ids.epoch2,
        sequenceIndex: 1,
        sourcePtsOrigin: segment2SourceStart,
        sourceTimeBaseDen,
        sourceTimeBaseNum,
        startedAtCaptureUs: segment2CaptureStart,
      },
    ],
  })
  await db.dvrProgram.createMany({
    data: [ids.program1, ids.program2].map((id) => ({
      captureSessionId: ids.session,
      durationUs: segment2CaptureEnd - segment1CaptureStart,
      fpsDen: 1,
      fpsNum: 60,
      id,
      liveEdgeUs: segment2CaptureEnd,
      status: 'LIVE' as const,
      timeBaseDen: sourceTimeBaseDen,
      timeBaseNum: sourceTimeBaseNum,
    })),
  })
  await Promise.all([
    db.mediaAsset.create({
      data: {
        bucket,
        byteLength: BigInt(baselineBytes.asset1.byteLength),
        contentType: 'application/json',
        id: ids.asset1,
        internalSchemaVersion: '1.0.0',
        kind: 'SAMPLE_INDEX',
        objectKey: keys.asset1,
        readyAt: now,
        sha256: sha256(baselineBytes.asset1),
        state: 'READY',
      },
    }),
    db.mediaAsset.create({
      data: {
        bucket,
        byteLength: BigInt(baselineBytes.asset2.byteLength),
        contentType: 'application/json',
        id: ids.asset2,
        internalSchemaVersion: '1.0.0',
        kind: 'SAMPLE_INDEX',
        objectKey: keys.asset2,
        readyAt: now,
        sha256: sha256(baselineBytes.asset2),
        state: 'READY',
      },
    }),
  ])
  await db.dvrSegment.createMany({
    data: [
      {
        captureEndUs: segment1CaptureEnd,
        captureEpochId: ids.epoch1,
        captureStartUs: segment1CaptureStart,
        discontinuitySequence: 0,
        durationUs: segment1CaptureEnd - segment1CaptureStart,
        firstFrameIndex: captureFrameOrigin,
        frameCount: 2n,
        id: ids.segment1,
        readyAt: now,
        sampleIndexAssetId: ids.asset1,
        dvrProgramId: ids.program1,
        sequenceNumber: 0n,
        sourcePtsEnd: segment1SourceEnd,
        sourcePtsStart: segment1SourceStart,
      },
      {
        captureEndUs: segment2CaptureEnd,
        captureEpochId: ids.epoch1,
        captureStartUs: segment2CaptureStart,
        discontinuitySequence: 0,
        durationUs: segment2CaptureEnd - segment2CaptureStart,
        firstFrameIndex: captureFrameOrigin + 2n,
        frameCount: 2n,
        id: ids.segment2,
        readyAt: now,
        sampleIndexAssetId: ids.asset2,
        dvrProgramId: ids.program1,
        sequenceNumber: 1n,
        sourcePtsEnd: segment2SourceEnd,
        sourcePtsStart: segment2SourceStart,
      },
    ],
  })
}

async function resetFixture(): Promise<void> {
  objectBytes.clear()
  objectBytes.set(`${bucket}/${keys.asset1}`, baselineBytes.asset1)
  objectBytes.set(`${bucket}/${keys.asset2}`, baselineBytes.asset2)
  reads.length = 0
  await db.captureEpoch.update({
    data: {
      captureFrameOrigin,
      captureSessionId: ids.session,
      captureTimeOriginUs: captureOriginUs,
      endedAtCaptureUs: null,
      sequenceIndex: 0,
      sourcePtsOrigin,
      sourceTimeBaseDen,
      sourceTimeBaseNum,
      startedAtCaptureUs: captureOriginUs,
    },
    where: { id: ids.epoch1 },
  })
  await Promise.all([
    db.mediaAsset.update({
      data: {
        bucket,
        byteLength: BigInt(baselineBytes.asset1.byteLength),
        contentType: 'application/json',
        deletedAt: null,
        internalSchemaVersion: '1.0.0',
        kind: 'SAMPLE_INDEX',
        objectKey: keys.asset1,
        readyAt: now,
        sha256: sha256(baselineBytes.asset1),
        state: 'READY',
      },
      where: { id: ids.asset1 },
    }),
    db.mediaAsset.update({
      data: {
        bucket,
        byteLength: BigInt(baselineBytes.asset2.byteLength),
        contentType: 'application/json',
        deletedAt: null,
        internalSchemaVersion: '1.0.0',
        kind: 'SAMPLE_INDEX',
        objectKey: keys.asset2,
        readyAt: now,
        sha256: sha256(baselineBytes.asset2),
        state: 'READY',
      },
      where: { id: ids.asset2 },
    }),
  ])
  await Promise.all([
    db.dvrSegment.update({
      data: {
        captureEndUs: segment1CaptureEnd,
        captureEpochId: ids.epoch1,
        captureStartUs: segment1CaptureStart,
        discontinuitySequence: 0,
        durationUs: segment1CaptureEnd - segment1CaptureStart,
        firstFrameIndex: captureFrameOrigin,
        frameCount: 2n,
        isGap: false,
        readyAt: now,
        sampleIndexAssetId: ids.asset1,
        dvrProgramId: ids.program1,
        sequenceNumber: 0n,
        sourcePtsEnd: segment1SourceEnd,
        sourcePtsStart: segment1SourceStart,
      },
      where: { id: ids.segment1 },
    }),
    db.dvrSegment.update({
      data: {
        captureEndUs: segment2CaptureEnd,
        captureEpochId: ids.epoch1,
        captureStartUs: segment2CaptureStart,
        discontinuitySequence: 0,
        durationUs: segment2CaptureEnd - segment2CaptureStart,
        firstFrameIndex: captureFrameOrigin + 2n,
        frameCount: 2n,
        isGap: false,
        readyAt: now,
        sampleIndexAssetId: ids.asset2,
        dvrProgramId: ids.program1,
        sequenceNumber: 1n,
        sourcePtsEnd: segment2SourceEnd,
        sourcePtsStart: segment2SourceStart,
      },
      where: { id: ids.segment2 },
    }),
  ])
}

async function rowCounts(): Promise<readonly number[]> {
  return Promise.all([
    db.captureEpoch.count(),
    db.dvrProgram.count(),
    db.dvrSegment.count(),
    db.mediaAsset.count(),
    db.playbackWindow.count(),
    db.rally.count(),
    db.keyPoint.count(),
    db.annotationOperation.count(),
    db.rallySubmission.count(),
    db.clipJob.count(),
    db.aiJob.count(),
  ])
}

async function expectRepositoryError(
  action: () => Promise<unknown>,
  code: SampleIndexRepositoryErrorCode,
): Promise<void> {
  let thrown: unknown
  try {
    await action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(SampleIndexRepositoryErrorClass)
  const error = thrown as SampleIndexRepositoryError
  expect(error.code).toBe(code)
  for (const secret of [
    ...Object.values(ids),
    bucket,
    ...Object.values(keys),
    'secret',
    'endpoint',
    'credential',
  ]) {
    expect(error.message.toLowerCase()).not.toContain(secret.toLowerCase())
  }
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
  const repositoryModule = await import(
    '../src/media/sample-index-repository.js'
  )
  db = dbModule.db
  SampleIndexRepositoryErrorClass = repositoryModule.SampleIndexRepositoryError
  await seedFixture()
  repository = repositoryModule.createSampleIndexRepository(db, inMemoryReader)
  expectedRowCounts = await rowCounts()
}, 120_000)

beforeEach(async () => {
  await resetFixture()
})

afterEach(async () => {
  expect(await rowCounts()).toEqual(expectedRowCounts)
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

describe('persisted sample index repository', () => {
  it('loads two touching segments in caller order with exact reads and no writes', async () => {
    const countsBefore = await rowCounts()
    const findMany = vi.spyOn(db.dvrSegment, 'findMany')
    const segments = await repository.loadOrderedSegments([
      ids.segment1,
      ids.segment2,
    ])

    expect(findMany).toHaveBeenCalledOnce()
    findMany.mockRestore()
    expect(segments.map((segment) => segment.segmentId)).toEqual([
      ids.segment1,
      ids.segment2,
    ])
    expect(segments[0]!.index.samples[0]!.sourcePts).toBe(sourcePtsOrigin)
    expect(segments[0]!.index.samples[0]!.sourcePts).toBeLessThan(0n)
    expect(segments[1]!.index.samples.at(-1)!.captureTimeUs).toBeGreaterThan(
      2n ** 53n,
    )
    expect(segments[1]!.index.samples.at(-1)!.captureFrameIndex).toBeGreaterThan(
      2n ** 53n,
    )
    expect(reads).toEqual([
      {
        bucket,
        expectedByteLength: BigInt(baselineBytes.asset1.byteLength),
        expectedContentType: 'application/json',
        expectedInternalSchemaVersion: '1.0.0',
        expectedKind: 'SAMPLE_INDEX',
        expectedSha256: sha256(baselineBytes.asset1),
        key: keys.asset1,
      },
      {
        bucket,
        expectedByteLength: BigInt(baselineBytes.asset2.byteLength),
        expectedContentType: 'application/json',
        expectedInternalSchemaVersion: '1.0.0',
        expectedKind: 'SAMPLE_INDEX',
        expectedSha256: sha256(baselineBytes.asset2),
        key: keys.asset2,
      },
    ])
    expect(await rowCounts()).toEqual(countsBefore)
  })

  it.each([
    ['empty', []],
    ['duplicate', [ids.segment1, ids.segment1]],
    ['invalid UUID', ['not-a-uuid']],
    [
      'too many',
      Array.from(
        { length: 129 },
        (_value, index) => `41000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      ),
    ],
  ])('rejects %s segment identities before object reads', async (_label, segmentIds) => {
    await expectRepositoryError(
      () => repository.loadOrderedSegments(segmentIds),
      'INVALID_REQUEST',
    )
    expect(reads).toHaveLength(0)
  })

  it('fails closed when a requested segment is missing', async () => {
    await expectRepositoryError(
      () => repository.loadOrderedSegments([randomUUID()]),
      'SEGMENT_NOT_FOUND',
    )
    expect(reads).toHaveLength(0)
  })

  it.each([
    ['gap', { isGap: true }],
    ['unready', { readyAt: null }],
  ] as const)('rejects a %s segment', async (_label, data) => {
    await db.dvrSegment.update({ data, where: { id: ids.segment1 } })
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'SEGMENT_NOT_READY',
    )
    expect(reads).toHaveLength(0)
  })

  it.each([
    ['missing relation', async () => db.dvrSegment.update({
      data: { sampleIndexAssetId: null },
      where: { id: ids.segment1 },
    })],
    ['uploading state', async () => db.mediaAsset.update({
      data: { state: 'UPLOADING' },
      where: { id: ids.asset1 },
    })],
    ['missing ready time', async () => db.mediaAsset.update({
      data: { readyAt: null },
      where: { id: ids.asset1 },
    })],
    ['deleted asset', async () => db.mediaAsset.update({
      data: { deletedAt: now },
      where: { id: ids.asset1 },
    })],
    ['wrong kind', async () => db.mediaAsset.update({
      data: { kind: 'DVR_SEGMENT' },
      where: { id: ids.asset1 },
    })],
    ['wrong content type', async () => db.mediaAsset.update({
      data: { contentType: 'video/mp4' },
      where: { id: ids.asset1 },
    })],
    ['wrong schema', async () => db.mediaAsset.update({
      data: { internalSchemaVersion: '2.0.0' },
      where: { id: ids.asset1 },
    })],
    ['nonpositive length', async () => db.mediaAsset.update({
      data: { byteLength: 0n },
      where: { id: ids.asset1 },
    })],
    ['invalid sha', async () => db.mediaAsset.update({
      data: { sha256: 'not-a-sha' },
      where: { id: ids.asset1 },
    })],
  ] as const)('rejects a sample-index asset with %s', async (_label, mutate) => {
    await mutate()
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'SAMPLE_INDEX_ASSET_NOT_READY',
    )
    expect(reads).toHaveLength(0)
  })

  it('rejects a duplicated sample-index asset relation', async () => {
    await db.dvrSegment.update({
      data: { sampleIndexAssetId: ids.asset1 },
      where: { id: ids.segment2 },
    })
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1, ids.segment2]),
      'INVALID_SEGMENT_METADATA',
    )
    expect(reads).toHaveLength(0)
  })

  it('sanitizes object-reader failures', async () => {
    const repositoryModule = await import(
      '../src/media/sample-index-repository.js'
    )
    const failingRepository = repositoryModule.createSampleIndexRepository(
      db,
      async () => {
        throw new Error(
          'secret credential at http://endpoint.internal/private-object',
        )
      },
    )
    await expectRepositoryError(
      () => failingRepository.loadOrderedSegments([ids.segment1]),
      'OBJECT_READ_FAILED',
    )
  })

  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'INVALID_UTF8'],
    ['invalid JSON', Buffer.from('{'), 'INVALID_JSON'],
    [
      'invalid strict document',
      Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', samples: [] })),
      'INVALID_DOCUMENT',
    ],
  ] as const)('rejects %s object bytes', async (_label, bytes, code) => {
    await setAssetBytes(ids.asset1, keys.asset1, bytes)
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      code,
    )
  })

  it.each([
    [
      'epoch identity',
      sampleIndexBytes({
        documentEpochId: ids.epoch2,
        firstFrameIndex: captureFrameOrigin,
        firstSourcePts: segment1SourceStart,
        origin: epoch1Origin,
      }),
    ],
    [
      'time base',
      sampleIndexBytes({
        documentTimeBase: { den: 90_000n, num: 1n },
        firstFrameIndex: captureFrameOrigin,
        firstSourcePts: segment1SourceStart,
        origin: epoch1Origin,
      }),
    ],
    [
      'epoch origin',
      sampleIndexBytes({
        firstFrameIndex: captureFrameOrigin,
        firstSourcePts: segment1SourceStart + sampleDurationPts,
        origin: {
          ...epoch1Origin,
          sourcePtsOrigin: sourcePtsOrigin + sampleDurationPts,
        },
      }),
    ],
  ] as const)('rejects a document with mismatched %s', async (_label, bytes) => {
    await setAssetBytes(ids.asset1, keys.asset1, bytes)
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'INVALID_DOCUMENT',
    )
  })

  it.each([
    ['capture start', { captureStartUs: segment1CaptureStart + 1n }],
    ['capture end', { captureEndUs: segment1CaptureEnd + 1n }],
    ['frame count', { frameCount: 3n }],
    ['first frame', { firstFrameIndex: captureFrameOrigin + 1n }],
    ['first PTS', { sourcePtsStart: segment1SourceStart + 1n }],
    ['last exclusive PTS', { sourcePtsEnd: segment1SourceEnd + 1n }],
  ] as const)('rejects a segment %s mismatch', async (label, data) => {
    if (label === 'capture start') {
      await db.dvrSegment.update({
        data: {
          ...data,
          durationUs: segment1CaptureEnd - (segment1CaptureStart + 1n),
        },
        where: { id: ids.segment1 },
      })
    } else if (label === 'capture end') {
      await db.dvrSegment.update({
        data: {
          ...data,
          durationUs: segment1CaptureEnd + 1n - segment1CaptureStart,
        },
        where: { id: ids.segment1 },
      })
    } else {
      await db.dvrSegment.update({ data, where: { id: ids.segment1 } })
    }
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'SEGMENT_INDEX_MISMATCH',
    )
  })

  it('rejects invalid segment duration metadata', async () => {
    await db.dvrSegment.update({
      data: { durationUs: segment1CaptureEnd - segment1CaptureStart + 1n },
      where: { id: ids.segment1 },
    })
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'INVALID_SEGMENT_METADATA',
    )
  })

  it.each([
    ['first frame', { firstFrameIndex: null }],
    ['first PTS', { sourcePtsStart: null }],
    ['last PTS', { sourcePtsEnd: null }],
  ] as const)('requires non-null ready segment %s metadata', async (_label, data) => {
    await db.dvrSegment.update({ data, where: { id: ids.segment1 } })
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'INVALID_SEGMENT_METADATA',
    )
  })

  it('rejects a nonpositive persisted epoch time base', async () => {
    await db.captureEpoch.update({
      data: { sourceTimeBaseNum: 0 },
      where: { id: ids.epoch1 },
    })
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'INVALID_SEGMENT_METADATA',
    )
  })

  it.each([
    ['wrong start/origin', async (): Promise<void> => {
      await db.captureEpoch.update({
        data: { startedAtCaptureUs: captureOriginUs + 1n },
        where: { id: ids.epoch1 },
      })
    }],
    ['sequence/discontinuity mismatch', async (): Promise<void> => {
      await db.dvrSegment.update({
        data: { discontinuitySequence: 1 },
        where: { id: ids.segment1 },
      })
    }],
    ['ended before segment', async (): Promise<void> => {
      await db.captureEpoch.update({
        data: { endedAtCaptureUs: segment1CaptureEnd - 1n },
        where: { id: ids.epoch1 },
      })
    }],
    ['empty epoch range', async (): Promise<void> => {
      await db.captureEpoch.update({
        data: { endedAtCaptureUs: captureOriginUs },
        where: { id: ids.epoch1 },
      })
    }],
    ['negative epoch sequence', async (): Promise<void> => {
      await db.captureEpoch.update({
        data: { sequenceIndex: -1 },
        where: { id: ids.epoch1 },
      })
    }],
  ] as const)('rejects persisted epoch corruption: %s', async (_label, mutate) => {
    await mutate()
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1]),
      'INVALID_SEGMENT_METADATA',
    )
    expect(reads).toHaveLength(0)
  })

  it.each([
    [
      'caller order',
      async (): Promise<void> => undefined,
      [ids.segment2, ids.segment1],
    ],
    ['program', async (): Promise<void> => {
      await db.dvrSegment.update({
        data: { dvrProgramId: ids.program2 },
        where: { id: ids.segment2 },
      })
    }, [ids.segment1, ids.segment2]],
    ['discontinuity', async (): Promise<void> => {
      await db.dvrSegment.update({
        data: { discontinuitySequence: 1 },
        where: { id: ids.segment2 },
      })
    }, [ids.segment1, ids.segment2]],
    ['epoch', async (): Promise<void> => {
      await db.dvrSegment.update({
        data: { captureEpochId: ids.epoch2 },
        where: { id: ids.segment2 },
      })
    }, [ids.segment1, ids.segment2]],
    ['frame continuity', async (): Promise<void> => {
      const bytes = sampleIndexBytes({
        firstFrameIndex: captureFrameOrigin + 3n,
        firstSourcePts: segment2SourceStart,
        origin: epoch1Origin,
      })
      await setAssetBytes(ids.asset2, keys.asset2, bytes)
      await db.dvrSegment.update({
        data: { firstFrameIndex: captureFrameOrigin + 3n },
        where: { id: ids.segment2 },
      })
    }, [ids.segment1, ids.segment2]],
  ] as const)('rejects an ordered set crossing %s', async (_label, mutate, order) => {
    await mutate()
    await expectRepositoryError(
      () => repository.loadOrderedSegments(order),
      'INVALID_SEGMENT_SET',
    )
  })

  it.each(['gap', 'overlap'] as const)(
    'rejects a canonical %s between persisted segments',
    async (failure) => {
      const delta = failure === 'gap' ? 1n : -1n
      const nextStart = segment2CaptureStart + delta
      await db.dvrSegment.update({
        data: {
          captureEndUs: segment2CaptureEnd + delta,
          captureStartUs: nextStart,
          durationUs: segment2CaptureEnd - segment2CaptureStart,
        },
        where: { id: ids.segment2 },
      })
      await expectRepositoryError(
        () => repository.loadOrderedSegments([ids.segment1, ids.segment2]),
        'INVALID_SEGMENT_SET',
      )
      expect(reads).toHaveLength(0)
    },
  )

  it('rejects cross-segment source timing discontinuity despite touching capture time', async () => {
    const roundedTimeBase = { num: 1n, den: 2_000_000n }
    const roundedOrigin: EpochDocumentOrigin = {
      ...epoch1Origin,
      sourcePtsOrigin: 0n,
      timeBase: roundedTimeBase,
    }
    const firstBytes = sampleIndexBytes({
      durationPts: 4_000n,
      firstFrameIndex: captureFrameOrigin,
      firstSourcePts: 0n,
      origin: roundedOrigin,
    })
    const secondBytes = sampleIndexBytes({
      durationPts: 4_000n,
      firstFrameIndex: captureFrameOrigin + 2n,
      firstSourcePts: 7_999n,
      origin: roundedOrigin,
    })
    const firstEnd = captureOriginUs + 4_000n
    const secondStart = firstEnd
    const secondEnd = captureOriginUs + 8_000n
    await db.captureEpoch.update({
      data: {
        sourcePtsOrigin: 0n,
        sourceTimeBaseDen: 2_000_000,
      },
      where: { id: ids.epoch1 },
    })
    await setAssetBytes(ids.asset1, keys.asset1, firstBytes)
    await setAssetBytes(ids.asset2, keys.asset2, secondBytes)
    await db.dvrSegment.update({
      data: {
        captureEndUs: firstEnd,
        durationUs: firstEnd - captureOriginUs,
        sourcePtsEnd: 8_000n,
        sourcePtsStart: 0n,
      },
      where: { id: ids.segment1 },
    })
    await db.dvrSegment.update({
      data: {
        captureEndUs: secondEnd,
        captureStartUs: secondStart,
        durationUs: secondEnd - secondStart,
        sourcePtsEnd: 15_999n,
        sourcePtsStart: 7_999n,
      },
      where: { id: ids.segment2 },
    })
    await expectRepositoryError(
      () => repository.loadOrderedSegments([ids.segment1, ids.segment2]),
      'INVALID_SEGMENT_SET',
    )
  })
})
