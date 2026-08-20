import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serializeSampleIndex } from '@volleyball-monitoring/media'
import {
  createPrismaIngestRepository,
  PrismaIngestRepositoryError,
  type FinalizedSegmentReservation,
  type FinalizedSegmentReservationInput,
  type IngestArtifactExpectation,
} from '../src/media/prisma-ingest-repository'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  originalDatabaseUrl ??
  'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `phase2a_ingest_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const canonicalOriginUs = 9_007_199_254_740_993n
const canonicalFrameOrigin = 9_107_199_254_740_993n
const fixedReadyAt = new Date('2026-08-07T08:00:00.000Z')
const profile = {
  fpsNum: 60,
  fpsDen: 1,
  timeBaseNum: 1,
  timeBaseDen: 90_000,
}

let db: (typeof import('@volleyball-monitoring/db'))['db']
let repository: ReturnType<typeof createPrismaIngestRepository>
let extentOnlyRepository: ReturnType<typeof createPrismaIngestRepository>
let createdDatabase = false

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uuidFor(index: number): string {
  return `40000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
}

let identityIndex = 1

async function createSession(
  status: 'STARTING' | 'LIVE' | 'STOPPING' | 'FINISHED' | 'FAILED' = 'STARTING',
  sourceKind = 'fixture',
) {
  const index = identityIndex++
  const matchId = uuidFor(index * 10)
  const captureSessionId = uuidFor(index * 10 + 1)
  await db.match.create({ data: { id: matchId, title: `Ingest fixture ${index}` } })
  await db.captureSession.create({
    data: {
      id: captureSessionId,
      matchId,
      sourceKind,
      ingestPath: `/fixture/${captureSessionId}`,
      status,
      health: 'STARTING',
    },
  })
  return { captureSessionId, matchId }
}

function samples(firstPts: bigint, durations: readonly bigint[] = [3_003n, 1_501n, 3_003n]) {
  let pts = firstPts
  return durations.map((durationPts, index) => {
    const sample = {
      sourcePts: pts,
      durationPts,
      keyframe: index === 0,
    }
    pts += durationPts
    return sample
  })
}

function reservationInput(
  captureSessionId: string,
  label: string,
  overrides: Partial<FinalizedSegmentReservationInput> = {},
): FinalizedSegmentReservationInput {
  const idempotencyKey = digest(`attempt:${label}`)
  return {
    captureSessionId,
    idempotencyKey,
    sourceIdentityHash: digest('recorder-lifetime-one'),
    newEpochId: randomUUID(),
    programProfile: profile,
    sourceOrder: 9_207_199_254_740_993n + BigInt(identityIndex),
    timeBase: { num: 1n, den: 90_000n },
    samples: samples(-9_007_199_254_740_993n),
    sourceRestart: false,
    timestampDiscontinuity: false,
    artifacts: [
      {
        kind: 'init',
        location: {
          bucket: 'volleyball-dvr',
          key: `dvr/${captureSessionId}/${idempotencyKey}/init.mp4`,
        },
        contentType: 'video/mp4',
        internalSchemaVersion: '1.0.0',
      },
      {
        kind: 'media',
        location: {
          bucket: 'volleyball-dvr',
          key: `dvr/${captureSessionId}/${idempotencyKey}/media.mp4`,
        },
        contentType: 'video/mp4',
        internalSchemaVersion: '1.0.0',
      },
      {
        kind: 'sample-index',
        location: {
          bucket: 'volleyball-dvr',
          key: `dvr/${captureSessionId}/${idempotencyKey}/sample-index.json`,
        },
        contentType: 'application/json',
        internalSchemaVersion: '1.0.0',
      },
    ],
    ...overrides,
  }
}

function expectations(
  reservation: FinalizedSegmentReservation,
): readonly IngestArtifactExpectation[] {
  const document = serializeSampleIndex(reservation.sampleIndex)
  const indexBytes = Buffer.from(JSON.stringify(document), 'utf8')
  return [
    {
      ...reservation.artifacts.init,
      byteLength: 17n,
      sha256: digest('init-bytes'),
    },
    {
      ...reservation.artifacts.media,
      byteLength: 23n,
      sha256: digest('media-bytes'),
    },
    {
      ...reservation.artifacts['sample-index'],
      byteLength: BigInt(indexBytes.byteLength),
      sha256: createHash('sha256').update(indexBytes).digest('hex'),
    },
  ].map(({ id: _id, state: _state, readyAt: _readyAt, ...artifact }) => artifact)
}

async function prepareAndPublish(reservation: FinalizedSegmentReservation) {
  const artifactExpectations = expectations(reservation)
  await repository.recordArtifactExpectations({
    reservation: reservation.reference,
    artifacts: artifactExpectations,
    sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
  })
  return {
    artifactExpectations,
    published: await repository.publishReady({
      reservation: reservation.reference,
      verifiedArtifacts: artifactExpectations,
    }),
  }
}

async function forbiddenCounts() {
  const [rallies, keyPoints, operations, submissions, clips, aiJobs, analyses] = await Promise.all([
    db.rally.count(),
    db.keyPoint.count(),
    db.annotationOperation.count(),
    db.rallySubmission.count(),
    db.clipJob.count(),
    db.aiJob.count(),
    db.analysisRun.count(),
  ])
  return { rallies, keyPoints, operations, submissions, clips, aiJobs, analyses }
}

function expectSafeError(
  error: unknown,
  code: PrismaIngestRepositoryError['code'],
  forbidden: readonly string[],
) {
  expect(error).toBeInstanceOf(PrismaIngestRepositoryError)
  expect(error).toMatchObject({ code })
  const message = error instanceof Error ? error.message : String(error)
  for (const value of forbidden) expect(message).not.toContain(value)
  expect(message).not.toMatch(/dvr\//i)
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
  repository = createPrismaIngestRepository(db, {
    maxTransactionAttempts: 5,
    now: () => fixedReadyAt,
    plannerConfig: {
      canonicalSessionOriginUs: canonicalOriginUs,
      canonicalFrameOrigin,
      timestampToleranceUs: 5n,
    },
  })
  extentOnlyRepository = createPrismaIngestRepository(db, {
    liveArchiveBackend: 'media_extent',
    maxTransactionAttempts: 5,
    now: () => fixedReadyAt,
    plannerConfig: {
      canonicalSessionOriginUs: canonicalOriginUs,
      canonicalFrameOrigin,
      timestampToleranceUs: 5n,
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
    const databaseRows = await maintenancePool.query(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [databaseName],
    )
    expect(databaseRows.rowCount).toBe(0)
    const roleRows = await maintenancePool.query(
      'SELECT rolname FROM pg_roles WHERE rolname = $1',
      [databaseName],
    )
    expect(roleRows.rowCount).toBe(0)
  }
  await maintenancePool.end()
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
}, 120_000)

describe('Prisma finalized media ingest repository', () => {
  it('atomically creates the first unready reservation and resumes exact concurrent duplicates', async () => {
    const beforeForbidden = await forbiddenCounts()
    const { captureSessionId } = await createSession()
    const input = reservationInput(captureSessionId, 'concurrent-first')
    const [left, right] = await Promise.all([
      repository.reserveUploading(input),
      repository.reserveUploading(input),
    ])
    expect([left.disposition, right.disposition].sort()).toEqual(['RESERVED', 'RESUMED'])
    expect(right.reference).toEqual(left.reference)
    expect(right.captureEpochId).toBe(left.captureEpochId)
    expect(right.plan).toEqual(left.plan)
    expect(left.sampleIndex.epochId).toBe(left.captureEpochId)
    expect(left.sampleIndex.availableStartUs).toBe(canonicalOriginUs)
    expect(left.sampleIndex.samples[0]!.captureFrameIndex).toBe(canonicalFrameOrigin)
    expect(left.plan.segment.sourcePtsStart).toBe(-9_007_199_254_740_993n)
    expect(input.sourceOrder).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))

    const [programs, epochs, assets, segments] = await Promise.all([
      db.dvrProgram.findMany({ where: { captureSessionId } }),
      db.captureEpoch.findMany({ where: { captureSessionId } }),
      db.mediaAsset.findMany({
        where: { id: { in: Object.values(left.artifacts).map(value => value.id) } },
      }),
      db.dvrSegment.findMany({ where: { dvrProgramId: left.reference.dvrProgramId } }),
    ])
    expect(programs).toHaveLength(1)
    expect(programs[0]).toMatchObject({ status: 'STARTING', playlistRevision: 0n })
    expect(epochs).toHaveLength(1)
    expect(epochs[0]).toMatchObject({
      id: left.captureEpochId,
      sequenceIndex: 0,
      sourcePtsOrigin: -9_007_199_254_740_993n,
      captureTimeOriginUs: canonicalOriginUs,
      captureFrameOrigin: canonicalFrameOrigin,
      endedAtCaptureUs: null,
      discontinuityReason: '["SESSION_START"]',
    })
    expect(assets).toHaveLength(3)
    expect(
      assets.every(
        asset => asset.state === 'UPLOADING' && asset.byteLength === null && asset.sha256 === null,
      ),
    ).toBe(true)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      readyAt: null,
      isGap: false,
      sequenceNumber: 0n,
      captureEpochId: left.captureEpochId,
      firstFrameIndex: canonicalFrameOrigin,
      frameCount: 3n,
    })
    expect(await forbiddenCounts()).toEqual(beforeForbidden)
  })

  it('keeps the packaged program profile stable when a source epoch changes time base', async () => {
    const { captureSessionId } = await createSession()
    const firstInput = reservationInput(captureSessionId, 'time-base-first')
    const first = await repository.reserveUploading(firstInput)
    await prepareAndPublish(first)

    const changed = await repository.reserveUploading(
      reservationInput(captureSessionId, 'time-base-change', {
        sourceOrder: firstInput.sourceOrder + 1n,
        samples: samples(first.plan.segment.sourcePtsEndExclusive),
        timeBase: { num: 1n, den: 60_000n },
      }),
    )

    expect(changed.createdNewEpoch).toBe(true)
    expect(changed.plan.epoch.reasons).toContain('TIME_BASE_CHANGE')
    expect(changed.captureEpochId).not.toBe(first.captureEpochId)
    expect(changed.plan.segment.captureStartUs).toBe(first.plan.segment.captureEndUs)
    await prepareAndPublish(changed)

    const [program, firstEpoch, changedEpoch] = await Promise.all([
      db.dvrProgram.findUniqueOrThrow({ where: { id: first.reference.dvrProgramId } }),
      db.captureEpoch.findUniqueOrThrow({ where: { id: first.captureEpochId } }),
      db.captureEpoch.findUniqueOrThrow({ where: { id: changed.captureEpochId } }),
    ])
    expect(program).toMatchObject({
      fpsNum: profile.fpsNum,
      fpsDen: profile.fpsDen,
      timeBaseNum: profile.timeBaseNum,
      timeBaseDen: profile.timeBaseDen,
      playlistRevision: 2n,
    })
    expect(firstEpoch.endedAtCaptureUs).toBe(changed.plan.segment.captureStartUs)
    expect(changedEpoch).toMatchObject({
      sourceTimeBaseNum: 1,
      sourceTimeBaseDen: 60_000,
      endedAtCaptureUs: null,
    })
  })

  it('adopts a live provisional epoch when the matching OME extent is finalized', async () => {
    const { captureSessionId } = await createSession()
    const firstInput = reservationInput(captureSessionId, 'provisional-first', {
      samples: samples(0n),
    })
    const first = await repository.reserveUploading(firstInput)
    await prepareAndPublish(first)

    const provisionalId = randomUUID()
    const provisionalFrameOrigin =
      first.plan.segment.firstFrameIndex + BigInt(first.plan.segment.sampleIndex.samples.length)
    await db.captureEpoch.create({
      data: {
        id: provisionalId,
        captureSessionId,
        sequenceIndex: first.plan.epoch.epochSequence + 1,
        sourceTimeBaseNum: 1,
        sourceTimeBaseDen: 90_000,
        sourcePtsOrigin: 0n,
        captureTimeOriginUs: first.plan.segment.captureEndUs,
        captureFrameOrigin: provisionalFrameOrigin,
        startedAtCaptureUs: first.plan.segment.captureEndUs,
        discontinuityReason: 'OME_RECORDING_EXTENT_PROVISIONAL',
      },
    })

    const finalizedInput = reservationInput(captureSessionId, 'provisional-finalized', {
      newEpochId: randomUUID(),
      samples: samples(0n),
      sourceOrder: firstInput.sourceOrder + 1n,
      timestampDiscontinuity: false,
    })
    const finalized = await repository.reserveUploading(finalizedInput)

    expect(finalized.createdNewEpoch).toBe(true)
    expect(finalized.captureEpochId).toBe(provisionalId)
    expect(finalized.sampleIndex.epochId).toBe(provisionalId)
    expect(finalized.plan.segment.captureStartUs).toBe(first.plan.segment.captureEndUs)
    expect(finalized.plan.segment.firstFrameIndex).toBe(provisionalFrameOrigin)
    const adopted = await db.captureEpoch.findUniqueOrThrow({ where: { id: provisionalId } })
    expect(adopted.discontinuityReason).not.toBe('OME_RECORDING_EXTENT_PROVISIONAL')
  })

  it('rejects an invalid source time base without creating persistence rows', async () => {
    const { captureSessionId } = await createSession()
    const input = reservationInput(captureSessionId, 'invalid-time-base', {
      timeBase: { num: 0n, den: 60_000n },
    })

    await expect(repository.reserveUploading(input)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    const [programs, epochs, assets, segments, session] = await Promise.all([
      db.dvrProgram.count({ where: { captureSessionId } }),
      db.captureEpoch.count({ where: { captureSessionId } }),
      db.mediaAsset.count({
        where: {
          OR: input.artifacts.map(artifact => ({
            bucket: artifact.location.bucket,
            objectKey: artifact.location.key,
          })),
        },
      }),
      db.dvrSegment.count({
        where: { program: { captureSessionId } },
      }),
      db.captureSession.findUniqueOrThrow({ where: { id: captureSessionId } }),
    ])
    expect({ programs, epochs, assets }).toEqual({
      programs: 0,
      epochs: 0,
      assets: 0,
    })
    expect(segments).toBe(0)
    expect(session).toMatchObject({
      status: 'STARTING',
      health: 'STARTING',
      startedAt: null,
    })
  })

  it('records exact expectations idempotently and publishes all readiness exactly once', async () => {
    const { captureSessionId } = await createSession()
    const sourceJobId = randomUUID()
    const finalizedAt = new Date('2026-08-07T07:59:55.000Z')
    const extent = {
      sourceJobId,
      localPath: 'ome/fixture-publish-once.mp4',
      finalizedAt,
    }
    const reservation = await repository.reserveUploading(
      reservationInput(captureSessionId, 'publish-once'),
    )
    const artifactExpectations = expectations(reservation)
    const recordInput = {
      reservation: reservation.reference,
      artifacts: artifactExpectations,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    }
    await repository.recordArtifactExpectations(recordInput)
    await repository.recordArtifactExpectations(recordInput)
    const uploading = await db.mediaAsset.findMany({
      where: { id: { in: Object.values(reservation.artifacts).map(value => value.id) } },
    })
    expect(
      uploading.every(
        asset => asset.state === 'UPLOADING' && asset.byteLength !== null && asset.sha256 !== null,
      ),
    ).toBe(true)

    const published = await repository.publishReady({
      reservation: reservation.reference,
      verifiedArtifacts: artifactExpectations,
      extent,
    })
    expect(published).toEqual({
      disposition: 'PUBLISHED',
      readyAt: fixedReadyAt,
      playlistRevision: 1n,
    })
    const [segment, program, session, readyAssets, mediaExtent] = await Promise.all([
      db.dvrSegment.findUniqueOrThrow({ where: { id: reservation.reference.dvrSegmentId } }),
      db.dvrProgram.findUniqueOrThrow({ where: { id: reservation.reference.dvrProgramId } }),
      db.captureSession.findUniqueOrThrow({ where: { id: captureSessionId } }),
      db.mediaAsset.findMany({
        where: { id: { in: Object.values(reservation.artifacts).map(value => value.id) } },
      }),
      db.mediaExtent.findUniqueOrThrow({
        where: { dvrSegmentId: reservation.reference.dvrSegmentId },
      }),
    ])
    expect(segment.readyAt).toEqual(fixedReadyAt)
    expect(
      readyAssets.every(
        asset => asset.state === 'READY' && asset.readyAt?.getTime() === fixedReadyAt.getTime(),
      ),
    ).toBe(true)
    expect(program).toMatchObject({
      status: 'LIVE',
      liveEdgeUs: reservation.plan.segment.captureEndUs,
      durationUs: reservation.plan.segment.durationUs,
      playlistRevision: 1n,
    })
    expect(session).toMatchObject({ status: 'LIVE', health: 'HEALTHY', startedAt: fixedReadyAt })
    expect(mediaExtent).toMatchObject({
      captureSessionId,
      dvrProgramId: reservation.reference.dvrProgramId,
      dvrSegmentId: reservation.reference.dvrSegmentId,
      captureEpochId: reservation.captureEpochId,
      sequenceNumber: reservation.sequenceNumber,
      discontinuitySequence: reservation.plan.segment.discontinuitySequence,
      sourceJobId,
      source: 'fixture',
      startUs: reservation.plan.segment.captureStartUs,
      endUs: reservation.plan.segment.captureEndUs,
      sourcePtsStart: reservation.plan.segment.sourcePtsStart,
      sourcePtsEnd: reservation.plan.segment.sourcePtsEndExclusive,
      firstFrameIndex: reservation.plan.segment.firstFrameIndex,
      frameCount: reservation.plan.segment.frameCount,
      localPath: extent.localPath,
      bucket: artifactExpectations.find(artifact => artifact.kind === 'media')!.location.bucket,
      objectKey: artifactExpectations.find(artifact => artifact.kind === 'media')!.location.key,
      mediaSha256: artifactExpectations.find(artifact => artifact.kind === 'media')!.sha256,
      mediaSchemaVersion: artifactExpectations.find(artifact => artifact.kind === 'media')!
        .internalSchemaVersion,
      initBucket: artifactExpectations.find(artifact => artifact.kind === 'init')!.location.bucket,
      initObjectKey: artifactExpectations.find(artifact => artifact.kind === 'init')!.location.key,
      initSha256: artifactExpectations.find(artifact => artifact.kind === 'init')!.sha256,
      initBytes: artifactExpectations.find(artifact => artifact.kind === 'init')!.byteLength,
      initSchemaVersion: artifactExpectations.find(artifact => artifact.kind === 'init')!
        .internalSchemaVersion,
      sampleIndexBucket: artifactExpectations.find(artifact => artifact.kind === 'sample-index')!
        .location.bucket,
      sampleIndexObjectKey: artifactExpectations.find(artifact => artifact.kind === 'sample-index')!
        .location.key,
      sampleIndexSha256: artifactExpectations.find(artifact => artifact.kind === 'sample-index')!
        .sha256,
      sampleIndexBytes: artifactExpectations.find(artifact => artifact.kind === 'sample-index')!
        .byteLength,
      sampleIndexSchemaVersion: artifactExpectations.find(
        artifact => artifact.kind === 'sample-index',
      )!.internalSchemaVersion,
      status: 'ARCHIVE_VERIFIED',
      bytes: artifactExpectations.find(artifact => artifact.kind === 'media')!.byteLength,
      finalizedAt,
      catalogedAt: fixedReadyAt,
      archiveVerifiedAt: fixedReadyAt,
    })
    await expect(
      db.mediaExtent.update({
        data: { captureEpochId: null },
        where: { id: mediaExtent.id },
      }),
    ).rejects.toBeDefined()
    await db.mediaExtent.update({
      data: {
        captureEpochId: null,
        sequenceNumber: null,
        discontinuitySequence: null,
        initBucket: null,
        initBytes: null,
        initObjectKey: null,
        initSchemaVersion: null,
        initSha256: null,
        mediaSchemaVersion: null,
        mediaSha256: null,
        firstFrameIndex: null,
        frameCount: null,
        sampleIndexBucket: null,
        sampleIndexBytes: null,
        sampleIndexObjectKey: null,
        sampleIndexSchemaVersion: null,
        sampleIndexSha256: null,
        sourcePtsEnd: null,
        sourcePtsStart: null,
      },
      where: { id: mediaExtent.id },
    })

    const replay = await repository.reserveUploading(
      reservationInput(captureSessionId, 'publish-once', {
        newEpochId: reservation.plan.epoch.epochKey,
      }),
    )
    expect(replay.disposition).toBe('ALREADY_READY')
    await repository.recordArtifactExpectations(recordInput)
    await expect(
      repository.recordArtifactExpectations({
        ...recordInput,
        artifacts: artifactExpectations.map(artifact =>
          artifact.kind === 'init'
            ? { ...artifact, sha256: digest('forbidden-ready-mutation') }
            : artifact,
        ),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    const redelivery = await repository.publishReady({
      reservation: reservation.reference,
      verifiedArtifacts: artifactExpectations,
      extent,
    })
    expect(redelivery).toEqual({
      disposition: 'ALREADY_READY',
      readyAt: fixedReadyAt,
      playlistRevision: 1n,
    })
    await expect(
      db.dvrProgram.findUniqueOrThrow({ where: { id: program.id } }),
    ).resolves.toMatchObject({ playlistRevision: 1n })
    await expect(db.mediaExtent.count({ where: { sourceJobId } })).resolves.toBe(1)
    await expect(
      db.mediaExtent.findUniqueOrThrow({ where: { sourceJobId } }),
    ).resolves.toMatchObject({
      captureEpochId: reservation.captureEpochId,
      sequenceNumber: reservation.sequenceNumber,
      discontinuitySequence: reservation.plan.segment.discontinuitySequence,
      firstFrameIndex: reservation.plan.segment.firstFrameIndex,
      frameCount: reservation.plan.segment.frameCount,
      sourcePtsEnd: reservation.plan.segment.sourcePtsEndExclusive,
      sourcePtsStart: reservation.plan.segment.sourcePtsStart,
    })
    await db.dvrSegment.delete({ where: { id: reservation.reference.dvrSegmentId } })
    await expect(
      db.mediaExtent.findUniqueOrThrow({ where: { sourceJobId } }),
    ).resolves.toMatchObject({
      captureEpochId: reservation.captureEpochId,
      dvrSegmentId: null,
      sampleIndexObjectKey: artifactExpectations.find(artifact => artifact.kind === 'sample-index')!
        .location.key,
    })
  })

  it('publishes live recordings directly through MediaExtent without legacy media rows', async () => {
    const { captureSessionId } = await createSession('STARTING', 'youtube_live')
    const sourceJobId = randomUUID()
    const extentPublication = {
      sourceJobId,
      localPath: 'live/20260818120000_0.mp4',
      finalizedAt: new Date('2026-08-18T12:01:00.000Z'),
    }
    const reservation = await extentOnlyRepository.reserveUploading(
      reservationInput(captureSessionId, 'extent-only-live', { extent: extentPublication }),
    )
    expect(reservation.reference.mediaExtentId).toBeTruthy()
    await expect(
      Promise.all([
        db.dvrSegment.count({ where: { dvrProgramId: reservation.reference.dvrProgramId } }),
        db.mediaAsset.count({
          where: {
            OR: Object.values(reservation.artifacts).map(artifact => ({
              bucket: artifact.location.bucket,
              objectKey: artifact.location.key,
            })),
          },
        }),
      ]),
    ).resolves.toEqual([0, 0])

    const artifactExpectations = expectations(reservation)
    await extentOnlyRepository.recordArtifactExpectations({
      reservation: reservation.reference,
      artifacts: artifactExpectations,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    })
    const published = await extentOnlyRepository.publishReady({
      reservation: reservation.reference,
      verifiedArtifacts: artifactExpectations,
      extent: extentPublication,
    })
    expect(published).toMatchObject({ disposition: 'PUBLISHED', playlistRevision: 1n })
    await expect(
      db.mediaExtent.findUniqueOrThrow({ where: { id: reservation.reference.mediaExtentId } }),
    ).resolves.toMatchObject({
      dvrSegmentId: null,
      sourceJobId,
      source: 'youtube_live',
      status: 'ARCHIVE_VERIFIED',
      captureEpochId: reservation.captureEpochId,
      sequenceNumber: 0n,
    })
  })

  it('publishes a draining reservation without resurrecting stopping lifecycle state', async () => {
    const { captureSessionId } = await createSession()
    const reservation = await repository.reserveUploading(
      reservationInput(captureSessionId, 'stopping-publish'),
    )
    const artifactExpectations = expectations(reservation)
    await repository.recordArtifactExpectations({
      reservation: reservation.reference,
      artifacts: artifactExpectations,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    })
    await Promise.all([
      db.captureSession.update({
        data: { status: 'STOPPING' },
        where: { id: captureSessionId },
      }),
      db.dvrProgram.update({
        data: { status: 'STOPPING' },
        where: { id: reservation.reference.dvrProgramId },
      }),
    ])

    await expect(
      repository.publishReady({
        reservation: reservation.reference,
        verifiedArtifacts: artifactExpectations,
      }),
    ).resolves.toEqual({
      disposition: 'PUBLISHED',
      readyAt: fixedReadyAt,
      playlistRevision: 1n,
    })
    const [session, program, segment, assets] = await Promise.all([
      db.captureSession.findUniqueOrThrow({ where: { id: captureSessionId } }),
      db.dvrProgram.findUniqueOrThrow({ where: { id: reservation.reference.dvrProgramId } }),
      db.dvrSegment.findUniqueOrThrow({ where: { id: reservation.reference.dvrSegmentId } }),
      db.mediaAsset.findMany({
        where: { id: { in: Object.values(reservation.artifacts).map(artifact => artifact.id) } },
      }),
    ])
    expect(session).toMatchObject({
      status: 'STOPPING',
      health: 'HEALTHY',
      startedAt: fixedReadyAt,
    })
    expect(program).toMatchObject({
      status: 'STOPPING',
      playlistRevision: 1n,
      liveEdgeUs: reservation.plan.segment.captureEndUs,
      durationUs: reservation.plan.segment.durationUs,
    })
    expect(segment.readyAt).toEqual(fixedReadyAt)
    expect(
      assets.every(
        asset => asset.state === 'READY' && asset.readyAt?.getTime() === fixedReadyAt.getTime(),
      ),
    ).toBe(true)
  })

  it('finalizes a sealed capture when the final expected segment becomes ready', async () => {
    const { captureSessionId } = await createSession()
    const reservation = await repository.reserveUploading(
      reservationInput(captureSessionId, 'sealed-final-segment'),
    )
    const artifactExpectations = expectations(reservation)
    await repository.recordArtifactExpectations({
      reservation: reservation.reference,
      artifacts: artifactExpectations,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    })
    await Promise.all([
      db.captureSession.update({
        data: {
          completionExpectedSegments: 1,
          completionRequestedAt: fixedReadyAt,
          sourceDurationUs: reservation.plan.segment.captureEndUs,
          status: 'STOPPING',
        },
        where: { id: captureSessionId },
      }),
      db.dvrProgram.update({
        data: { status: 'STOPPING' },
        where: { id: reservation.reference.dvrProgramId },
      }),
    ])

    await expect(
      repository.publishReady({
        reservation: reservation.reference,
        verifiedArtifacts: artifactExpectations,
      }),
    ).resolves.toMatchObject({ disposition: 'PUBLISHED' })

    const [session, program, epoch, completionEvents] = await Promise.all([
      db.captureSession.findUniqueOrThrow({ where: { id: captureSessionId } }),
      db.dvrProgram.findUniqueOrThrow({ where: { id: reservation.reference.dvrProgramId } }),
      db.captureEpoch.findUniqueOrThrow({ where: { id: reservation.captureEpochId } }),
      db.outboxEvent.findMany({
        where: {
          aggregateId: captureSessionId,
          eventType: 'capture.source_completed.v1',
        },
      }),
    ])
    expect(session).toMatchObject({
      status: 'FINISHED',
      health: 'OFFLINE',
      endedAt: fixedReadyAt,
      sourceDurationUs: reservation.plan.segment.captureEndUs,
    })
    expect(program).toMatchObject({
      status: 'FINISHED',
      liveEdgeUs: reservation.plan.segment.captureEndUs,
      durationUs: reservation.plan.segment.durationUs,
      playlistRevision: 1n,
    })
    expect(epoch.endedAtCaptureUs).toBe(reservation.plan.segment.captureEndUs)
    expect(completionEvents).toHaveLength(1)
  })

  it('keeps a sealed capture stopping when a failure record replaces missing READY media', async () => {
    const { captureSessionId } = await createSession()
    const reservation = await repository.reserveUploading(
      reservationInput(captureSessionId, 'sealed-missing-ready-segment'),
    )
    const artifactExpectations = expectations(reservation)
    await repository.recordArtifactExpectations({
      reservation: reservation.reference,
      artifacts: artifactExpectations,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    })
    await Promise.all([
      db.captureSession.update({
        data: {
          completionExpectedSegments: 2,
          completionRequestedAt: fixedReadyAt,
          status: 'STOPPING',
        },
        where: { id: captureSessionId },
      }),
      db.dvrProgram.update({
        data: { status: 'STOPPING' },
        where: { id: reservation.reference.dvrProgramId },
      }),
      db.mediaIngestFailure.create({
        data: {
          captureSessionId,
          code: 'NO_VIDEO_SAMPLES',
          sourceJobId: randomUUID(),
        },
      }),
    ])

    await expect(
      repository.publishReady({
        reservation: reservation.reference,
        verifiedArtifacts: artifactExpectations,
      }),
    ).resolves.toMatchObject({ disposition: 'PUBLISHED' })

    const [session, program, completionEvents] = await Promise.all([
      db.captureSession.findUniqueOrThrow({ where: { id: captureSessionId } }),
      db.dvrProgram.findUniqueOrThrow({ where: { id: reservation.reference.dvrProgramId } }),
      db.outboxEvent.findMany({
        where: {
          aggregateId: captureSessionId,
          eventType: 'capture.source_completed.v1',
        },
      }),
    ])
    expect(session).toMatchObject({ status: 'STOPPING', health: 'HEALTHY' })
    expect(program).toMatchObject({ status: 'STOPPING', playlistRevision: 1n })
    expect(completionEvents).toHaveLength(0)
  })

  it('rolls back every readiness, program, epoch, and session write on a late database failure', async () => {
    const { captureSessionId } = await createSession()
    const reservation = await repository.reserveUploading(
      reservationInput(captureSessionId, 'rollback'),
    )
    const artifactExpectations = expectations(reservation)
    await repository.recordArtifactExpectations({
      reservation: reservation.reference,
      artifacts: artifactExpectations,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    })
    await db.$executeRawUnsafe(`
      CREATE FUNCTION reject_ingest_session_publish() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'secret late failure ${captureSessionId}'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_ingest_session_publish
      BEFORE UPDATE ON "CaptureSession"
      FOR EACH ROW EXECUTE FUNCTION reject_ingest_session_publish();
    `)
    try {
      const error = await repository
        .publishReady({
          reservation: reservation.reference,
          verifiedArtifacts: artifactExpectations,
        })
        .catch((value: unknown) => value)
      expectSafeError(error, 'DATABASE_FAILURE', [captureSessionId, 'secret late failure'])
      const [segment, assets, program, session, epoch] = await Promise.all([
        db.dvrSegment.findUniqueOrThrow({ where: { id: reservation.reference.dvrSegmentId } }),
        db.mediaAsset.findMany({
          where: { id: { in: Object.values(reservation.artifacts).map(value => value.id) } },
        }),
        db.dvrProgram.findUniqueOrThrow({ where: { id: reservation.reference.dvrProgramId } }),
        db.captureSession.findUniqueOrThrow({ where: { id: captureSessionId } }),
        db.captureEpoch.findUniqueOrThrow({ where: { id: reservation.captureEpochId } }),
      ])
      expect(segment.readyAt).toBeNull()
      expect(assets.every(asset => asset.state === 'UPLOADING' && asset.readyAt === null)).toBe(
        true,
      )
      expect(program).toMatchObject({
        status: 'STARTING',
        playlistRevision: 0n,
        liveEdgeUs: 0n,
        durationUs: 0n,
      })
      expect(session).toMatchObject({ status: 'STARTING', health: 'STARTING', startedAt: null })
      expect(epoch.endedAtCaptureUs).toBeNull()
    } finally {
      await db.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS reject_ingest_session_publish ON "CaptureSession";
        DROP FUNCTION IF EXISTS reject_ingest_session_publish();
      `)
    }
  })

  it('continues the exact VFR epoch, then opens and closes epochs for PTS reset, restart, and gap', async () => {
    const { captureSessionId } = await createSession()
    const firstInput = reservationInput(captureSessionId, 'timeline-first')
    const first = await repository.reserveUploading(firstInput)
    await prepareAndPublish(first)

    const firstEndPts = first.plan.segment.sourcePtsEndExclusive
    const second = await repository.reserveUploading(
      reservationInput(captureSessionId, 'timeline-second', {
        samples: samples(firstEndPts, [1_501n, 3_003n]),
        sourceOrder: firstInput.sourceOrder + 1n,
      }),
    )
    expect(second.sequenceNumber).toBe(1n)
    expect(second.createdNewEpoch).toBe(false)
    expect(second.captureEpochId).toBe(first.captureEpochId)
    expect(second.plan.segment.captureStartUs).toBe(first.plan.segment.captureEndUs)
    expect(second.plan.segment.firstFrameIndex).toBe(first.plan.nextCaptureFrameIndex)
    await prepareAndPublish(second)

    const reset = await repository.reserveUploading(
      reservationInput(captureSessionId, 'timeline-reset', {
        samples: samples(first.plan.segment.sourcePtsStart - 100n, [1n, 2n, 1n]),
        sourceOrder: firstInput.sourceOrder + 2n,
      }),
    )
    expect(reset.createdNewEpoch).toBe(true)
    expect(reset.plan.epoch.reasons).toContain('PTS_RESET')
    expect(reset.plan.segment.captureStartUs).toBe(second.plan.segment.captureEndUs)
    await prepareAndPublish(reset)
    await expect(
      db.captureEpoch.findUniqueOrThrow({ where: { id: first.captureEpochId } }),
    ).resolves.toMatchObject({
      endedAtCaptureUs: reset.plan.segment.captureStartUs,
    })
    await expect(
      db.captureEpoch.findUniqueOrThrow({ where: { id: reset.captureEpochId } }),
    ).resolves.toMatchObject({ endedAtCaptureUs: null })

    const restart = await repository.reserveUploading(
      reservationInput(captureSessionId, 'timeline-restart-gap', {
        samples: samples(reset.plan.segment.sourcePtsStart - 100n, [2n, 1n]),
        sourceOrder: firstInput.sourceOrder + 3n,
        sourceRestart: true,
        timestampDiscontinuity: true,
        explicitGapBeforeUs: 250_000n,
      }),
    )
    expect(restart.plan.epoch.reasons).toEqual(
      expect.arrayContaining([
        'SOURCE_RESTART',
        'TIMESTAMP_DISCONTINUITY',
        'PTS_RESET',
        'EXPLICIT_GAP',
      ]),
    )
    expect(restart.plan.gap).toMatchObject({
      startUs: reset.plan.segment.captureEndUs,
      endUs: reset.plan.segment.captureEndUs + 250_000n,
    })
    expect(restart.plan.segment.captureStartUs).toBe(reset.plan.segment.captureEndUs + 250_000n)
    await prepareAndPublish(restart)
    await expect(
      db.captureEpoch.findUniqueOrThrow({ where: { id: reset.captureEpochId } }),
    ).resolves.toMatchObject({
      endedAtCaptureUs: restart.plan.segment.captureStartUs,
    })
    expect(await db.captureEpoch.count({ where: { captureSessionId } })).toBe(3)
    expect(
      await db.dvrSegment.count({
        where: { dvrProgramId: first.reference.dvrProgramId, isGap: true },
      }),
    ).toBe(0)
  })

  it('fails closed on expectation conflicts and incomplete or mismatched verified metadata', async () => {
    const { captureSessionId } = await createSession()
    const reservation = await repository.reserveUploading(
      reservationInput(captureSessionId, 'metadata-conflicts'),
    )
    const expected = expectations(reservation)
    const badSample = expected.map(artifact =>
      artifact.kind === 'sample-index'
        ? { ...artifact, sha256: digest('wrong-sample-document') }
        : artifact,
    )
    await expect(
      repository.recordArtifactExpectations({
        reservation: reservation.reference,
        artifacts: badSample,
        sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await repository.recordArtifactExpectations({
      reservation: reservation.reference,
      artifacts: expected,
      sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
    })
    const badInit = expected.map(artifact =>
      artifact.kind === 'init' ? { ...artifact, sha256: digest('different-init') } : artifact,
    )
    await expect(
      repository.recordArtifactExpectations({
        reservation: reservation.reference,
        artifacts: badInit,
        sampleIndexDocument: serializeSampleIndex(reservation.sampleIndex),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(
      repository.publishReady({
        reservation: reservation.reference,
        verifiedArtifacts: badInit,
      }),
    ).rejects.toMatchObject({ code: 'EXPECTATIONS_REQUIRED' })
    await expect(
      db.dvrSegment.findUniqueOrThrow({ where: { id: reservation.reference.dvrSegmentId } }),
    ).resolves.toMatchObject({ readyAt: null })
  })

  it('rejects terminal sessions, program ambiguity/profile drift, FIFO bypass, and replay conflicts with sanitized errors', async () => {
    for (const status of ['FINISHED', 'FAILED'] as const) {
      const { captureSessionId } = await createSession(status)
      const input = reservationInput(captureSessionId, `terminal-${status}`)
      const error = await repository.reserveUploading(input).catch((value: unknown) => value)
      expectSafeError(error, 'SESSION_TERMINAL', [
        captureSessionId,
        input.artifacts[0]!.location.key,
      ])
    }

    const profileSession = await createSession()
    const firstInput = reservationInput(profileSession.captureSessionId, 'profile')
    const first = await repository.reserveUploading(firstInput)
    const profileError = await repository
      .reserveUploading(
        reservationInput(profileSession.captureSessionId, 'profile-other', {
          programProfile: { ...profile, fpsNum: 30 },
        }),
      )
      .catch((value: unknown) => value)
    expectSafeError(profileError, 'PROGRAM_CONFLICT', [profileSession.captureSessionId])

    const fifoInput = reservationInput(profileSession.captureSessionId, 'fifo-later')
    const fifoError = await repository.reserveUploading(fifoInput).catch((value: unknown) => value)
    expectSafeError(fifoError, 'FIFO_BLOCKED', [fifoInput.artifacts[2]!.location.key])

    const artifactConflictInput = {
      ...firstInput,
      artifacts: firstInput.artifacts.map(artifact =>
        artifact.kind === 'media'
          ? {
              ...artifact,
              location: { ...artifact.location, key: `${artifact.location.key}.conflict` },
            }
          : artifact,
      ),
    }
    const artifactError = await repository
      .reserveUploading(artifactConflictInput)
      .catch((value: unknown) => value)
    expectSafeError(artifactError, 'ARTIFACT_CONFLICT', [
      artifactConflictInput.artifacts[1]!.location.key,
    ])

    const timelineError = await repository
      .reserveUploading({
        ...firstInput,
        samples: samples(123n),
      })
      .catch((value: unknown) => value)
    expectSafeError(timelineError, 'TIMELINE_CONFLICT', [first.reference.dvrSegmentId])

    const multiple = await createSession()
    await Promise.all(
      [0, 1].map(offset =>
        db.dvrProgram.create({
          data: {
            captureSessionId: multiple.captureSessionId,
            fpsNum: profile.fpsNum,
            fpsDen: profile.fpsDen,
            timeBaseNum: profile.timeBaseNum,
            timeBaseDen: profile.timeBaseDen,
            playlistRevision: BigInt(offset),
          },
        }),
      ),
    )
    await expect(
      repository.reserveUploading(reservationInput(multiple.captureSessionId, 'multiple-programs')),
    ).rejects.toMatchObject({ code: 'PROGRAM_CONFLICT' })
  })
})
