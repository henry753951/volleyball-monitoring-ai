import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelProcessingRally } from '../src/services/processing-rally-cancellation.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `processing_cancel_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  aiJob: '97000000-0000-4000-8000-000000000001',
  assignment: '97000000-0000-4000-8000-000000000002',
  capture: '97000000-0000-4000-8000-000000000003',
  clipJob: '97000000-0000-4000-8000-000000000004',
  device: '97000000-0000-4000-8000-000000000005',
  integration: '97000000-0000-4000-8000-000000000006',
  left: '97000000-0000-4000-8000-000000000007',
  match: '97000000-0000-4000-8000-000000000008',
  operator: '97000000-0000-4000-8000-000000000009',
  program: '97000000-0000-4000-8000-00000000000a',
  rally: '97000000-0000-4000-8000-00000000000b',
  right: '97000000-0000-4000-8000-00000000000c',
  set: '97000000-0000-4000-8000-00000000000d',
  submission: '97000000-0000-4000-8000-00000000000e',
  correctionAiJob: '97000000-0000-4000-8000-00000000000f',
  correctionAssignment: '97000000-0000-4000-8000-000000000010',
  correctionClipJob: '97000000-0000-4000-8000-000000000011',
  correctionRally: '97000000-0000-4000-8000-000000000012',
  correctionSet: '97000000-0000-4000-8000-000000000013',
  correctionSubmission: '97000000-0000-4000-8000-000000000014',
  previousSubmission: '97000000-0000-4000-8000-000000000015',
}

let db: typeof DatabaseClient
let createdDatabase = false

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
  await db.user.create({ data: { id: ids.operator, email: 'operator@cancel.local', displayName: 'Operator' } })
  await db.deviceSession.create({ data: { id: ids.device, userId: ids.operator } })
  await db.team.createMany({ data: [{ id: ids.left, name: 'Left', shortName: 'L' }, { id: ids.right, name: 'Right', shortName: 'R' }] })
  await db.match.create({ data: { id: ids.match, title: 'Processing cancellation', members: { create: { userId: ids.operator, role: 'OPERATOR' } } } })
  await db.matchTeam.createMany({ data: [{ matchId: ids.match, teamId: ids.left }, { matchId: ids.match, teamId: ids.right }] })
  await db.matchSet.create({ data: { id: ids.set, matchId: ids.match, setNumber: 1, status: 'LIVE' } })
  await db.courtSideAssignment.create({ data: { id: ids.assignment, setId: ids.set, effectiveFromRallyOrdinal: 1, leftTeamId: ids.left, rightTeamId: ids.right } })
  await db.captureSession.create({ data: { id: ids.capture, matchId: ids.match, sourceKind: 'fixture', ingestPath: 'fixture/cancel', status: 'FINISHED', health: 'OFFLINE' } })
  await db.dvrProgram.create({ data: { id: ids.program, captureSessionId: ids.capture, status: 'FINISHED', fpsNum: 60, fpsDen: 1, timeBaseNum: 1, timeBaseDen: 60_000 } })
  await db.rally.create({ data: { id: ids.rally, matchId: ids.match, setId: ids.set, dvrProgramId: ids.program, sideAssignmentId: ids.assignment, ordinal: 1, annotationRevision: 1n, annotationStatus: 'SUBMITTED', processingStatus: 'AI_PROCESSING', scoreResolutionState: 'UNKNOWN' } })
  await db.rallySubmission.create({ data: { id: ids.submission, rallyId: ids.rally, annotationRevision: 1n, contentHash: 'a'.repeat(64), status: 'ACTIVE', scoreResolutionState: 'UNKNOWN', leftTeamId: ids.left, rightTeamId: ids.right, sideAssignmentId: ids.assignment, clipPolicyVersion: 'clip-policy-v1', clipPreRollUs: 3_000_000n, clipPostRollUs: 3_000_000n, submittedByUserId: ids.operator } })
  await db.rally.update({ where: { id: ids.rally }, data: { activeSubmissionId: ids.submission } })
  await db.clipJob.create({ data: { id: ids.clipJob, submissionId: ids.submission, status: 'COMPLETED', idempotencyKey: 'cancel-clip', canonicalizationProfileVersion: 'canonical-v1', requestedStartCaptureUs: 0n, requestedEndCaptureUs: 1_000_000n, completedAt: new Date() } })
  await db.aiIntegration.create({ data: { id: ids.integration, name: 'cancel-worker', transportMode: 'WS_AGENT', submitUrl: null, authSecretRef: 'env:AI_PROVIDER_WS_TOKEN' } })
  await db.aiJob.create({ data: { id: ids.aiJob, integrationId: ids.integration, submissionId: ids.submission, clipJobId: ids.clipJob, status: 'RUNNING', idempotencyKey: 'cancel-ai', requestPayload: {}, requestPayloadHash: 'b'.repeat(64), jobSchemaVersion: '1.1.0', callbackTokenHash: 'c'.repeat(64), callbackTokenExpiresAt: new Date(Date.now() + 60_000) } })

  await db.matchSet.create({ data: { id: ids.correctionSet, matchId: ids.match, setNumber: 2, status: 'LIVE', leftScore: 0, rightScore: 1, scoreRevision: 2 } })
  await db.courtSideAssignment.create({ data: { id: ids.correctionAssignment, setId: ids.correctionSet, effectiveFromRallyOrdinal: 1, leftTeamId: ids.left, rightTeamId: ids.right } })
  await db.rally.create({ data: { id: ids.correctionRally, matchId: ids.match, setId: ids.correctionSet, dvrProgramId: ids.program, sideAssignmentId: ids.correctionAssignment, ordinal: 1, annotationRevision: 2n, annotationStatus: 'SUBMITTED', processingStatus: 'AI_PROCESSING', scoreResolutionState: 'RESOLVED', scoringCourtSide: 'RIGHT', scoringTeamId: ids.right, leftScoreAfter: 0, rightScoreAfter: 1 } })
  await db.rallySubmission.create({ data: { id: ids.previousSubmission, rallyId: ids.correctionRally, annotationRevision: 1n, contentHash: 'd'.repeat(64), status: 'SUPERSEDED', scoreResolutionState: 'RESOLVED', scoringCourtSide: 'LEFT', scoringTeamId: ids.left, leftTeamId: ids.left, rightTeamId: ids.right, sideAssignmentId: ids.correctionAssignment, leftScoreBefore: 0, rightScoreBefore: 0, leftScoreAfter: 1, rightScoreAfter: 0, scoreRevisionBefore: 0, scoreRevisionAfter: 1, clipPolicyVersion: 'clip-policy-v1', clipPreRollUs: 3_000_000n, clipPostRollUs: 3_000_000n, submittedByUserId: ids.operator } })
  await db.scoreLedgerEntry.create({ data: { kind: 'POINT_AWARD', setId: ids.correctionSet, submissionId: ids.previousSubmission, leftDelta: 1, rightDelta: 0, leftScoreBefore: 0, rightScoreBefore: 0, leftScoreAfter: 1, rightScoreAfter: 0, scoreRevisionBefore: 0, scoreRevisionAfter: 1 } })
  await db.rallySubmission.create({ data: { id: ids.correctionSubmission, rallyId: ids.correctionRally, annotationRevision: 2n, contentHash: 'e'.repeat(64), status: 'ACTIVE', scoreResolutionState: 'RESOLVED', scoringCourtSide: 'RIGHT', scoringTeamId: ids.right, leftTeamId: ids.left, rightTeamId: ids.right, sideAssignmentId: ids.correctionAssignment, leftScoreBefore: 1, rightScoreBefore: 0, leftScoreAfter: 0, rightScoreAfter: 1, scoreRevisionBefore: 1, scoreRevisionAfter: 2, clipPolicyVersion: 'clip-policy-v1', clipPreRollUs: 3_000_000n, clipPostRollUs: 3_000_000n, submittedByUserId: ids.operator, supersedesSubmissionId: ids.previousSubmission } })
  await db.scoreLedgerEntry.create({ data: { kind: 'CORRECTION', setId: ids.correctionSet, submissionId: ids.correctionSubmission, supersededSubmissionId: ids.previousSubmission, leftDelta: -1, rightDelta: 1, leftScoreBefore: 1, rightScoreBefore: 0, leftScoreAfter: 0, rightScoreAfter: 1, scoreRevisionBefore: 1, scoreRevisionAfter: 2 } })
  await db.rally.update({ where: { id: ids.correctionRally }, data: { activeSubmissionId: ids.correctionSubmission } })
  await db.clipJob.create({ data: { id: ids.correctionClipJob, submissionId: ids.correctionSubmission, status: 'COMPLETED', idempotencyKey: 'cancel-correction-clip', canonicalizationProfileVersion: 'canonical-v1', requestedStartCaptureUs: 0n, requestedEndCaptureUs: 1_000_000n, completedAt: new Date() } })
  await db.aiJob.create({ data: { id: ids.correctionAiJob, integrationId: ids.integration, submissionId: ids.correctionSubmission, clipJobId: ids.correctionClipJob, status: 'RUNNING', idempotencyKey: 'cancel-correction-ai', requestPayload: {}, requestPayloadHash: 'f'.repeat(64), jobSchemaVersion: '1.1.0', callbackTokenHash: '1'.repeat(64), callbackTokenExpiresAt: new Date(Date.now() + 60_000) } })
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

describe('processing rally cancellation', () => {
  it('soft-deletes the rally, cancels the AI job, and writes durable abort audit events', async () => {
    const result = await cancelProcessingRally(db, ids.rally, { deviceSessionId: ids.device, role: UserRole.OPERATOR, userId: ids.operator })

    expect(result.rally_id).toBe(ids.rally)
    const rally = await db.rally.findUniqueOrThrow({ where: { id: ids.rally } })
    expect(rally.processingStatus).toBe('CANCELLED')
    expect(rally.voidedAt).not.toBeNull()
    expect(rally.activeSubmissionId).toBeNull()
    expect((await db.rallySubmission.findUniqueOrThrow({ where: { id: ids.submission } })).status).toBe('SUPERSEDED')
    expect((await db.rallySubmission.findUniqueOrThrow({ where: { id: result.cancellation_submission_id } })).status).toBe('CANCELLED')
    const aiJob = await db.aiJob.findUniqueOrThrow({ where: { id: ids.aiJob } })
    expect(aiJob.status).toBe('CANCELLED')
    expect(aiJob.cancelRequestedAt).not.toBeNull()
    expect(await db.outboxEvent.findUnique({ where: { dedupeKey: `ai-abort:${ids.aiJob}` } })).not.toBeNull()
  })

  it('restores the previous completed submission when a processing correction is cancelled', async () => {
    await cancelProcessingRally(db, ids.correctionRally, { deviceSessionId: ids.device, role: UserRole.OPERATOR, userId: ids.operator })

    const rally = await db.rally.findUniqueOrThrow({ where: { id: ids.correctionRally } })
    expect(rally.processingStatus).toBe('COMPLETED')
    expect(rally.voidedAt).toBeNull()
    expect(rally.activeSubmissionId).toBe(ids.previousSubmission)
    expect(rally.scoreResolutionState).toBe('RESOLVED')
    expect(rally.scoringCourtSide).toBe('LEFT')
    expect(rally.scoringTeamId).toBe(ids.left)
    expect((await db.rallySubmission.findUniqueOrThrow({ where: { id: ids.previousSubmission } })).status).toBe('ACTIVE')
    expect((await db.rallySubmission.findUniqueOrThrow({ where: { id: ids.correctionSubmission } })).status).toBe('SUPERSEDED')
    const set = await db.matchSet.findUniqueOrThrow({ where: { id: ids.correctionSet } })
    expect({ left: set.leftScore, right: set.rightScore, revision: set.scoreRevision }).toEqual({ left: 1, right: 0, revision: 3 })
    const cancellationLedger = await db.scoreLedgerEntry.findFirstOrThrow({ where: { supersededSubmissionId: ids.correctionSubmission } })
    expect({ left: cancellationLedger.leftDelta, right: cancellationLedger.rightDelta }).toEqual({ left: 1, right: -1 })
    expect((await db.aiJob.findUniqueOrThrow({ where: { id: ids.correctionAiJob } })).status).toBe('CANCELLED')
  })
})
