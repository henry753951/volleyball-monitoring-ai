import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  deleteRallyWithMedia,
  updateRallyDisplayPlacement,
} from '../src/services/rally-administration.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  originalDatabaseUrl ??
  'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `rally_admin_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })
const id = (suffix: string) => `98000000-0000-4000-8000-${suffix.padStart(12, '0')}`
let db: typeof DatabaseClient
let createdDatabase = false

const ids = {
  actor: id('1'),
  assignment: id('2'),
  capture: id('3'),
  clip: id('4'),
  left: id('6'),
  match: id('7'),
  media: id('8'),
  program: id('9'),
  rally: id('10'),
  right: id('11'),
  set: id('12'),
  submission: id('13'),
  aiJob: id('14'),
  secondSet: id('15'),
  secondAssignment: id('16'),
  providerInstance: id('17'),
  delivery: id('18'),
  draftRally: id('19'),
  captureEpoch: id('20'),
  rallyBoundary: id('21'),
  submissionBoundary: id('22'),
  earlyRally: id('24'),
  lateRally: id('25'),
  earlyBoundary: id('26'),
  lateBoundary: id('27'),
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
  await db.user.create({
    data: { id: ids.actor, email: 'operator@rally-admin.local', displayName: 'Operator' },
  })
  await db.team.createMany({
    data: [
      { id: ids.left, name: 'Left', shortName: 'L' },
      { id: ids.right, name: 'Right', shortName: 'R' },
    ],
  })
  await db.match.create({
    data: {
      id: ids.match,
      title: 'Rally administration',
      members: { create: { role: 'OPERATOR', userId: ids.actor } },
    },
  })
  await db.matchTeam.createMany({
    data: [
      { matchId: ids.match, teamId: ids.left },
      { matchId: ids.match, teamId: ids.right },
    ],
  })
  await db.matchSet.createMany({
    data: [
      { id: ids.set, matchId: ids.match, setNumber: 1, status: 'LIVE' },
      { id: ids.secondSet, matchId: ids.match, setNumber: 2, status: 'PLANNED' },
    ],
  })
  await db.courtSideAssignment.createMany({
    data: [
      {
        id: ids.assignment,
        setId: ids.set,
        effectiveFromRallyOrdinal: 1,
        leftTeamId: ids.left,
        rightTeamId: ids.right,
      },
      {
        id: ids.secondAssignment,
        setId: ids.secondSet,
        effectiveFromRallyOrdinal: 1,
        leftTeamId: ids.left,
        rightTeamId: ids.right,
      },
    ],
  })
  await db.captureSession.create({
    data: {
      id: ids.capture,
      health: 'OFFLINE',
      ingestPath: 'fixture/rally-admin',
      matchId: ids.match,
      sourceKind: 'fixture',
      status: 'FINISHED',
    },
  })
  await db.captureEpoch.create({
    data: {
      captureFrameOrigin: 0n,
      captureSessionId: ids.capture,
      captureTimeOriginUs: 0n,
      id: ids.captureEpoch,
      sequenceIndex: 0,
      sourcePtsOrigin: 0n,
      sourceTimeBaseDen: 60_000,
      sourceTimeBaseNum: 1,
      startedAtCaptureUs: 0n,
    },
  })
  await db.dvrProgram.create({
    data: {
      id: ids.program,
      captureSessionId: ids.capture,
      fpsDen: 1,
      fpsNum: 60,
      status: 'FINISHED',
      timeBaseDen: 60_000,
      timeBaseNum: 1,
    },
  })
  await db.rally.create({
    data: {
      id: ids.rally,
      annotationRevision: 1n,
      annotationStatus: 'SUBMITTED',
      displayOrdinal: 1,
      displaySetNumber: 1,
      dvrProgramId: ids.program,
      matchId: ids.match,
      ordinal: 1,
      processingStatus: 'AI_PROCESSING',
      scoreResolutionState: 'UNKNOWN',
      setId: ids.set,
      sideAssignmentId: ids.assignment,
    },
  })
  await db.rallyBoundary.create({
    data: {
      captureEpochId: ids.captureEpoch,
      captureFrameIndex: 60n,
      captureTimeUs: 1_000_000n,
      createdByUserId: ids.actor,
      deviceSessionId: id('23'),
      id: ids.rallyBoundary,
      kind: 'START',
      originalPlaybackCursor: {},
      rallyId: ids.rally,
      sourcePts: 60_000n,
      timingPrecision: 'FRAME_EXACT',
      updatedByUserId: ids.actor,
    },
  })
  await db.rallySubmission.create({
    data: {
      id: ids.submission,
      annotationRevision: 1n,
      clipPolicyVersion: 'v1',
      clipPostRollUs: 3_000_000n,
      clipPreRollUs: 3_000_000n,
      contentHash: 'a'.repeat(64),
      leftTeamId: ids.left,
      rallyId: ids.rally,
      rightTeamId: ids.right,
      scoreResolutionState: 'UNKNOWN',
      sideAssignmentId: ids.assignment,
      submittedByUserId: ids.actor,
    },
  })
  await db.rallySubmissionBoundary.create({
    data: {
      captureEpochId: ids.captureEpoch,
      captureFrameIndex: 60n,
      captureTimeUs: 1_000_000n,
      id: ids.submissionBoundary,
      kind: 'START',
      sourceDraftBoundaryId: ids.rallyBoundary,
      sourcePts: 60_000n,
      submissionId: ids.submission,
      timingPrecision: 'FRAME_EXACT',
    },
  })
  await db.rally.update({ data: { activeSubmissionId: ids.submission }, where: { id: ids.rally } })
  await db.mediaAsset.create({
    data: {
      bucket: 'clips',
      byteLength: 123n,
      contentType: 'video/mp4',
      id: ids.media,
      kind: 'CANONICAL_CLIP',
      objectKey: 'rallies/delete-me.mp4',
      state: 'READY',
    },
  })
  await db.clipJob.create({
    data: {
      canonicalizationProfileVersion: 'v1',
      clipAssetId: ids.media,
      id: ids.clip,
      idempotencyKey: 'rally-admin-clip',
      requestedEndCaptureUs: 1_000_000n,
      requestedStartCaptureUs: 0n,
      status: 'COMPLETED',
      submissionId: ids.submission,
    },
  })
  await db.aiProviderInstance.create({
    data: {
      capabilities: {},
      id: ids.providerInstance,
      instanceKey: 'rally-admin-instance',
      lastSeenAt: new Date(),
      maxConcurrency: 1,
      providerBuildId: 'test',
      sdkVersion: 'test',
    },
  })
  await db.aiJob.create({
    data: {
      callbackTokenExpiresAt: new Date(Date.now() + 60_000),
      callbackTokenHash: 'b'.repeat(64),
      clipJobId: ids.clip,
      deliveryId: ids.delivery,
      id: ids.aiJob,
      idempotencyKey: 'rally-admin-ai',
      jobSchemaVersion: '1.1.0',
      providerInstanceId: ids.providerInstance,
      requestPayload: {},
      requestPayloadHash: 'c'.repeat(64),
      status: 'RUNNING',
      submissionId: ids.submission,
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

describe('rally administration', () => {
  it('moves a segment between sets and derives every rally number from capture order', async () => {
    await db.rally.createMany({
      data: [
        {
          id: ids.earlyRally,
          annotationRevision: 1n,
          annotationStatus: 'SUBMITTED',
          displayOrdinal: 7,
          displaySetNumber: 2,
          dvrProgramId: ids.program,
          matchId: ids.match,
          ordinal: 1,
          scoreResolutionState: 'UNKNOWN',
          setId: ids.secondSet,
          sideAssignmentId: ids.secondAssignment,
        },
        {
          id: ids.lateRally,
          annotationRevision: 1n,
          annotationStatus: 'SUBMITTED',
          displayOrdinal: 9,
          displaySetNumber: 2,
          dvrProgramId: ids.program,
          matchId: ids.match,
          ordinal: 2,
          scoreResolutionState: 'UNKNOWN',
          setId: ids.secondSet,
          sideAssignmentId: ids.secondAssignment,
        },
      ],
    })
    await db.rallyBoundary.createMany({
      data: [
        {
          captureEpochId: ids.captureEpoch,
          captureFrameIndex: 30n,
          captureTimeUs: 500_000n,
          createdByUserId: ids.actor,
          deviceSessionId: id('23'),
          id: ids.earlyBoundary,
          kind: 'START',
          originalPlaybackCursor: {},
          rallyId: ids.earlyRally,
          sourcePts: 30_000n,
          timingPrecision: 'FRAME_EXACT',
          updatedByUserId: ids.actor,
        },
        {
          captureEpochId: ids.captureEpoch,
          captureFrameIndex: 120n,
          captureTimeUs: 2_000_000n,
          createdByUserId: ids.actor,
          deviceSessionId: id('23'),
          id: ids.lateBoundary,
          kind: 'START',
          originalPlaybackCursor: {},
          rallyId: ids.lateRally,
          sourcePts: 120_000n,
          timingPrecision: 'FRAME_EXACT',
          updatedByUserId: ids.actor,
        },
      ],
    })
    const result = await updateRallyDisplayPlacement(
      { id: ids.actor, role: UserRole.OPERATOR },
      { ordinal: 999, rallyId: ids.rally, setNumber: 2 },
      { database: db },
    )
    expect(result).toMatchObject({ displayOrdinal: 2, displaySetNumber: 2 })
    // The legacy column is intentionally not rewritten. Product reads derive
    // these values from the START boundaries instead.
    await expect(
      db.rally.findMany({
        where: { id: { in: [ids.earlyRally, ids.rally, ids.lateRally] } },
        orderBy: { id: 'asc' },
        select: { id: true, displayOrdinal: true },
      }),
    ).resolves.toEqual([
      { id: ids.rally, displayOrdinal: 1 },
      { id: ids.earlyRally, displayOrdinal: 7 },
      { id: ids.lateRally, displayOrdinal: 9 },
    ])
    const submission = await db.rallySubmission.findUniqueOrThrow({ where: { id: ids.submission } })
    expect(submission.annotationRevision).toBe(1n)
    expect(submission.rallyId).toBe(ids.rally)
  })

  it('deletes an editable draft without requiring a submission or processing job', async () => {
    await db.rally.create({
      data: {
        annotationStatus: 'OPEN',
        displayOrdinal: 2,
        displaySetNumber: 1,
        dvrProgramId: ids.program,
        id: ids.draftRally,
        matchId: ids.match,
        ordinal: 2,
        processingStatus: 'IDLE',
        scoreResolutionState: 'PENDING',
        setId: ids.set,
        sideAssignmentId: ids.assignment,
      },
    })
    const receipt = await deleteRallyWithMedia(
      { id: ids.actor, role: UserRole.OPERATOR },
      ids.draftRally,
      { database: db },
    )
    expect(receipt).toMatchObject({ abortedJobCount: 0, removedAssetCount: 0 })
    expect(await db.rally.findUnique({ where: { id: ids.draftRally } })).toBeNull()
  })

  it('aborts active work, purges dependencies, and removes unreferenced media', async () => {
    const objectRemover = vi.fn(async () => undefined)
    const receipt = await deleteRallyWithMedia(
      { id: ids.actor, role: UserRole.OPERATOR },
      ids.rally,
      { database: db, objectRemover },
    )
    expect(receipt).toMatchObject({ abortedJobCount: 1, removedAssetCount: 1, removedBytes: '123' })
    expect(await db.rally.findUnique({ where: { id: ids.rally } })).toBeNull()
    expect(await db.rallySubmission.findUnique({ where: { id: ids.submission } })).toBeNull()
    expect(
      await db.rallySubmissionBoundary.findUnique({ where: { id: ids.submissionBoundary } }),
    ).toBeNull()
    expect(await db.mediaAsset.findUnique({ where: { id: ids.media } })).toBeNull()
    await expect(
      db.rally.findMany({
        where: { id: { in: [ids.earlyRally, ids.lateRally] } },
        orderBy: { id: 'asc' },
        select: { id: true, displayOrdinal: true },
      }),
    ).resolves.toEqual([
      { id: ids.earlyRally, displayOrdinal: 7 },
      { id: ids.lateRally, displayOrdinal: 9 },
    ])
    expect(
      await db.outboxEvent.findUnique({ where: { dedupeKey: `ai-abort:purge:${ids.aiJob}` } }),
    ).toMatchObject({
      payload: expect.objectContaining({
        delivery_id: ids.delivery,
        provider_instance_id: ids.providerInstance,
      }),
    })
    expect(objectRemover).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'clips', objectKey: 'rallies/delete-me.mp4' }),
    )
  })
})
