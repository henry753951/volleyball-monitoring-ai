import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OperationalMutationError,
  requestCaptureCompletion,
  retryProcessing,
  startCapture,
  stopCapture,
  updateCaptureSourceMetadata,
} from '../src/services/capture-processing.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `capture_processing_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  assignment: '94000000-0000-4000-8000-000000000001',
  baseCapture: '94000000-0000-4000-8000-000000000002',
  left: '94000000-0000-4000-8000-000000000003',
  match: '94000000-0000-4000-8000-000000000004',
  operator: '94000000-0000-4000-8000-000000000005',
  program: '94000000-0000-4000-8000-000000000006',
  right: '94000000-0000-4000-8000-000000000007',
  set: '94000000-0000-4000-8000-000000000008',
}
const operator = { id: ids.operator, role: UserRole.OPERATOR }

let db: typeof DatabaseClient
let createdDatabase = false

async function createFailedRally(kind: 'clip' | 'ai') {
  const rallyId = randomUUID()
  const submissionId = randomUUID()
  await db.rally.create({ data: {
    id: rallyId, matchId: ids.match, setId: ids.set, dvrProgramId: ids.program, sideAssignmentId: ids.assignment,
    ordinal: kind === 'clip' ? 1 : 2, annotationRevision: 2n, annotationStatus: 'SUBMITTED', processingStatus: 'FAILED',
    scoreResolutionState: 'UNKNOWN',
  } })
  await db.rallySubmission.create({ data: {
    id: submissionId, rallyId, annotationRevision: 1n, contentHash: `${kind}-${randomUUID()}`, status: 'ACTIVE',
    scoreResolutionState: 'UNKNOWN', leftTeamId: ids.left, rightTeamId: ids.right, sideAssignmentId: ids.assignment,
    clipPolicyVersion: 'clip-policy-v1', clipPreRollUs: 3_000_000n, clipPostRollUs: 3_000_000n, submittedByUserId: ids.operator,
  } })
  await db.rally.update({ where: { id: rallyId }, data: { activeSubmissionId: submissionId } })
  return { rallyId, submissionId }
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
  await db.user.create({ data: { id: ids.operator, email: 'operator@capture.local', displayName: 'Operator' } })
  await db.team.createMany({ data: [
    { id: ids.left, name: 'Left', shortName: 'L' },
    { id: ids.right, name: 'Right', shortName: 'R' },
  ] })
  await db.match.create({ data: { id: ids.match, title: 'Capture processing', members: { create: { userId: ids.operator, role: 'OPERATOR' } } } })
  await db.matchTeam.createMany({ data: [{ matchId: ids.match, teamId: ids.left }, { matchId: ids.match, teamId: ids.right }] })
  await db.matchSet.create({ data: { id: ids.set, matchId: ids.match, setNumber: 1, status: 'LIVE' } })
  await db.courtSideAssignment.create({ data: { id: ids.assignment, setId: ids.set, effectiveFromRallyOrdinal: 1, leftTeamId: ids.left, rightTeamId: ids.right } })
  await db.captureSession.create({ data: { id: ids.baseCapture, matchId: ids.match, sourceKind: 'fixture', ingestPath: 'fixture/base', status: 'FINISHED', health: 'OFFLINE' } })
  await db.dvrProgram.create({ data: { id: ids.program, captureSessionId: ids.baseCapture, status: 'FINISHED', fpsNum: 60, fpsDen: 1, timeBaseNum: 1, timeBaseDen: 60_000 } })
}, 120_000)

afterAll(async () => {
  if (db) await db.$disconnect()
  if (createdDatabase) {
    await maintenancePool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [databaseName])
    await maintenancePool.query(`DROP DATABASE "${databaseName}"`)
  }
  await maintenancePool.end()
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
}, 120_000)

describe('capture lifecycle and processing retry', () => {
  it('starts and terminally stops an authorized OME ingest path', async () => {
    const capture = await startCapture(db, operator, {
      matchId: ids.match, ingestPath: 'court/main', sourceKind: 'rtmp', sourceLabel: 'Main court', sourceConfigSecretRef: 'secret://capture/main',
    })
    expect(capture).toMatchObject({ matchId: ids.match, ingestPath: 'court/main', status: 'STARTING', health: 'STARTING', timeline: null })
    await expect(db.match.findUniqueOrThrow({ where: { id: ids.match } })).resolves.toMatchObject({ status: 'LIVE' })
    const program = await db.dvrProgram.create({ data: { captureSessionId: capture.id, status: 'LIVE', liveEdgeUs: 9_000_000n, durationUs: 9_000_000n, fpsNum: 60, fpsDen: 1, timeBaseNum: 1, timeBaseDen: 60_000 } })
    const epoch = await db.captureEpoch.create({ data: { captureSessionId: capture.id, sequenceIndex: 0, sourceTimeBaseNum: 1, sourceTimeBaseDen: 60_000, sourcePtsOrigin: 0n, captureTimeOriginUs: 0n, captureFrameOrigin: 0n, startedAtCaptureUs: 0n } })
    const stopped = await stopCapture(db, operator, capture.id)
    expect(stopped).toMatchObject({ status: 'FINISHED', health: 'OFFLINE', timeline: null, endedAt: expect.any(Date) })
    await expect(db.dvrProgram.findUniqueOrThrow({ where: { id: program.id } })).resolves.toMatchObject({ status: 'FINISHED' })
    await expect(db.captureEpoch.findUniqueOrThrow({ where: { id: epoch.id } })).resolves.toMatchObject({ endedAtCaptureUs: 9_000_000n })
    await expect(db.outboxEvent.count({ where: { aggregateId: capture.id } })).resolves.toBe(2)
  })

  it('rejects unsafe paths and non-operator identities', async () => {
    await expect(startCapture(db, operator, { matchId: ids.match, ingestPath: '../escape', sourceKind: 'rtmp' })).rejects.toMatchObject({ code: 'BAD_USER_INPUT' })
    await expect(startCapture(db, { id: ids.operator, role: UserRole.COACH }, { matchId: ids.match, ingestPath: 'court/coach', sourceKind: 'rtmp' })).rejects.toBeInstanceOf(OperationalMutationError)
  })

  it('allows only one active media source per match', async () => {
    const attempts = await Promise.allSettled([
      startCapture(db, operator, {
        ingestPath: `single-source-${randomUUID()}`,
        matchId: ids.match,
        sourceKind: 'rtmp',
      }),
      startCapture(db, operator, {
        ingestPath: `second-source-${randomUUID()}`,
        matchId: ids.match,
        sourceKind: 'rtmp',
      }),
    ])
    const fulfilled = attempts.find(result => result.status === 'fulfilled')
    const rejected = attempts.find(result => result.status === 'rejected')
    expect(fulfilled?.status).toBe('fulfilled')
    expect(rejected?.status).toBe('rejected')
    if (fulfilled?.status !== 'fulfilled' || rejected?.status !== 'rejected') {
      throw new Error('Expected exactly one concurrent capture start to succeed')
    }
    expect(rejected.reason).toMatchObject({
      code: 'BAD_USER_INPUT',
      message: 'Match already has an active media source',
    })
    await stopCapture(db, operator, fulfilled.value.id)
  })

  it('persists source classification and finalizes an empty sealed import idempotently', async () => {
    const capture = await startCapture(db, operator, {
      ingestPath: `local-${randomUUID()}`,
      matchId: ids.match,
      sourceKind: 'local_mp4',
    })
    await updateCaptureSourceMetadata(db, capture.id, {
      sourceDurationUs: 9_055_000_000n,
      sourceKind: 'youtube_vod',
    })
    const finished = await requestCaptureCompletion(db, capture.id, {
      expectedSegments: 0,
      sourceDurationUs: 9_055_000_000n,
      sourceKind: 'youtube_live',
    })
    expect(finished).toMatchObject({
      sourceDurationUs: 9_055_000_000n,
      sourceKind: 'youtube_live',
      status: 'FINISHED',
    })
    await expect(requestCaptureCompletion(db, capture.id, {
      expectedSegments: 0,
      sourceDurationUs: 9_055_000_000n,
      sourceKind: 'youtube_live',
    })).resolves.toMatchObject({ status: 'FINISHED' })
    await expect(db.outboxEvent.count({
      where: { dedupeKey: `capture-source-completed:${capture.id}` },
    })).resolves.toBe(1)
  })

  it('keeps a sealed capture draining until READY coverage reaches its declared duration', async () => {
    const capture = await startCapture(db, operator, {
      ingestPath: `youtube-${randomUUID()}`,
      matchId: ids.match,
      sourceKind: 'youtube',
    })
    const program = await db.dvrProgram.create({
      data: {
        captureSessionId: capture.id,
        fpsDen: 1,
        fpsNum: 60,
        status: 'LIVE',
        timeBaseDen: 60_000,
        timeBaseNum: 1,
      },
    })
    const draining = await requestCaptureCompletion(db, capture.id, {
      expectedSegments: 4,
      sourceDurationUs: 2_000_000n,
      sourceKind: 'youtube_vod',
    })
    expect(draining).toMatchObject({
      completionExpectedSegments: 4,
      status: 'STOPPING',
    })
    await expect(db.dvrProgram.findFirstOrThrow({
      where: { captureSessionId: capture.id },
    })).resolves.toMatchObject({ status: 'STOPPING' })
    const epoch = await db.captureEpoch.create({
      data: {
        captureFrameOrigin: 0n,
        captureSessionId: capture.id,
        captureTimeOriginUs: 0n,
        sequenceIndex: 0,
        sourcePtsOrigin: 0n,
        sourceTimeBaseDen: 60_000,
        sourceTimeBaseNum: 1,
        startedAtCaptureUs: 0n,
      },
    })
    await db.dvrSegment.createMany({
      data: [
        {
          captureEndUs: 2_000_000n,
          captureEpochId: epoch.id,
          captureStartUs: 0n,
          durationUs: 2_000_000n,
          dvrProgramId: program.id,
          frameCount: 120n,
          readyAt: new Date(),
          sequenceNumber: 0n,
        },
      ],
    })
    await db.dvrProgram.update({
      data: { durationUs: 2_000_000n, liveEdgeUs: 2_000_000n },
      where: { id: program.id },
    })

    const finished = await requestCaptureCompletion(db, capture.id, {
      expectedSegments: 4,
      sourceDurationUs: 2_000_000n,
      sourceKind: 'youtube_vod',
    })

    expect(finished).toMatchObject({ status: 'FINISHED', health: 'OFFLINE' })
    await expect(db.dvrProgram.findUniqueOrThrow({
      where: { id: program.id },
    })).resolves.toMatchObject({ status: 'FINISHED' })
  })

  it('resets a terminal failed clip job without creating a second job', async () => {
    const target = await createFailedRally('clip')
    const clip = await db.clipJob.create({ data: {
      submissionId: target.submissionId, status: 'FAILED', idempotencyKey: `failed-clip:${target.submissionId}`,
      canonicalizationProfileVersion: 'canonical-v1', requestedStartCaptureUs: 0n, requestedEndCaptureUs: 1n,
      attemptCount: 5, maxAttempts: 5, errorCode: 'CLIP_GENERATION_FAILED', errorMessage: 'fixture',
    } })
    await expect(retryProcessing(db, operator, target.rallyId, 'x'.repeat(32))).resolves.toMatchObject({ retriedStage: 'clip', status: 'CLIP_QUEUED' })
    await expect(db.clipJob.findUniqueOrThrow({ where: { id: clip.id } })).resolves.toMatchObject({ status: 'QUEUED', attemptCount: 0, errorCode: null, errorMessage: null })
    await expect(db.clipJob.count({ where: { submissionId: target.submissionId } })).resolves.toBe(1)
  })

  it('supersedes a failed AI attempt and queues a new job with refreshed callback scope', async () => {
    const target = await createFailedRally('ai')
    const clipAsset = await db.mediaAsset.create({ data: { kind: 'CANONICAL_CLIP', bucket: 'retry', objectKey: `${target.rallyId}.mp4`, contentType: 'video/mp4', byteLength: 10n, sha256: 'a'.repeat(64), state: 'READY', readyAt: new Date() } })
    const clip = await db.clipJob.create({ data: {
      submissionId: target.submissionId, status: 'COMPLETED', idempotencyKey: `completed-clip:${target.submissionId}`,
      canonicalizationProfileVersion: 'canonical-v1', requestedStartCaptureUs: 0n, requestedEndCaptureUs: 1n, actualStartCaptureUs: 0n, actualEndCaptureUs: 1n, clipAssetId: clipAsset.id,
    } })
    const failed = await db.aiJob.create({ data: {
      submissionId: target.submissionId, clipJobId: clip.id, status: 'FAILED', idempotencyKey: `failed-ai:${target.submissionId}`,
      requestPayload: { ai_job_id: 'old-job', clip: { clip_asset_id: clipAsset.id, download_url: 'expired', download_url_expires_at: 'expired' }, callback: { token: '[redacted]' } },
      requestPayloadHash: 'b'.repeat(64), jobSchemaVersion: '1.1.0', callbackTokenHash: 'c'.repeat(64), callbackTokenExpiresAt: new Date(0), attemptCount: 5, maxAttempts: 5,
    } })
    const state = await retryProcessing(db, operator, target.rallyId, 's'.repeat(32))
    expect(state).toMatchObject({ retriedStage: 'ai', status: 'AI_QUEUED', submissionId: target.submissionId })
    await expect(db.aiJob.findUniqueOrThrow({ where: { id: failed.id } })).resolves.toMatchObject({ status: 'SUPERSEDED' })
    const queued = await db.aiJob.findFirstOrThrow({ where: { submissionId: target.submissionId, status: 'QUEUED' } })
    expect(queued).toMatchObject({ attemptCount: 0, callbackTokenExpiresAt: expect.any(Date) })
    expect(queued.requestPayload).toMatchObject({ ai_job_id: queued.id, clip: { clip_asset_id: clipAsset.id } })
    expect(JSON.stringify(queued.requestPayload)).not.toContain('download_url')
    expect(JSON.stringify(queued.requestPayload)).not.toContain('callback')
  })
})
