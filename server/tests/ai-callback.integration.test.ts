import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? originalDatabaseUrl
  ?? 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `ai_callback_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const ids = {
  aiJob: '95000000-0000-4000-8000-000000000001',
  assignment: '95000000-0000-4000-8000-000000000002',
  capture: '95000000-0000-4000-8000-000000000003',
  clipAsset: '95000000-0000-4000-8000-000000000004',
  clipJob: '95000000-0000-4000-8000-000000000005',
  left: '95000000-0000-4000-8000-000000000007',
  match: '95000000-0000-4000-8000-000000000008',
  operator: '95000000-0000-4000-8000-000000000009',
  program: '95000000-0000-4000-8000-00000000000a',
  rally: '95000000-0000-4000-8000-00000000000b',
  right: '95000000-0000-4000-8000-00000000000c',
  set: '95000000-0000-4000-8000-00000000000d',
  submission: '95000000-0000-4000-8000-00000000000e',
}
const callbackToken = 'callback-token-1234567890-abcdefghijklmnop'
const callbackTokenHash = createHash('sha256').update(callbackToken).digest('hex')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

let app: FastifyInstance
let db: typeof DatabaseClient
let createdDatabase = false

function processingCallback(callbackId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '2.0.0',
    callback_id: callbackId,
    ai_job_id: ids.aiJob,
    kind: 'processing',
    progress: 0.5,
    stage: 'tracking',
    ...overrides,
  }
}

function multipartBody(metadata: Record<string, unknown>, analysisData: string) {
  const boundary = `vmai-${randomUUID()}`
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="analysis_data"; filename="analysis-data.fb"\r\nContent-Type: application/vnd.volleyball.analysis-data+flatbuffers;version=1\r\n\r\n${analysisData}\r\n`,
    `--${boundary}--\r\n`,
  ].join('')
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
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
  const { aiCallbackRoutes } = await import('../src/routes/ai-callback.js')
  app = Fastify()
  await app.register(multipart, {
    limits: { fields: 4, files: 2, fileSize: 512 * 1024 * 1024, parts: 6 },
  })
  await app.register(aiCallbackRoutes)
  await app.ready()

  await db.user.create({ data: { id: ids.operator, email: 'operator@callback.local', displayName: 'Operator' } })
  await db.team.createMany({ data: [
    { id: ids.left, name: 'Left', shortName: 'L' },
    { id: ids.right, name: 'Right', shortName: 'R' },
  ] })
  await db.match.create({ data: { id: ids.match, title: 'AI callback acceptance' } })
  await db.matchTeam.createMany({ data: [
    { matchId: ids.match, teamId: ids.left },
    { matchId: ids.match, teamId: ids.right },
  ] })
  await db.matchSet.create({ data: { id: ids.set, matchId: ids.match, setNumber: 1, status: 'LIVE' } })
  await db.courtSideAssignment.create({ data: { id: ids.assignment, setId: ids.set, effectiveFromRallyOrdinal: 1, leftTeamId: ids.left, rightTeamId: ids.right } })
  await db.captureSession.create({ data: { id: ids.capture, matchId: ids.match, sourceKind: 'fixture', ingestPath: 'fixture/callback', status: 'FINISHED', health: 'OFFLINE' } })
  await db.dvrProgram.create({ data: { id: ids.program, captureSessionId: ids.capture, status: 'FINISHED', fpsNum: 60, fpsDen: 1, timeBaseNum: 1, timeBaseDen: 60_000 } })
  await db.rally.create({ data: {
    id: ids.rally, matchId: ids.match, setId: ids.set, dvrProgramId: ids.program, sideAssignmentId: ids.assignment,
    ordinal: 1, annotationRevision: 1n, annotationStatus: 'SUBMITTED', processingStatus: 'AI_QUEUED', scoreResolutionState: 'UNKNOWN',
  } })
  await db.rallySubmission.create({ data: {
    id: ids.submission, rallyId: ids.rally, annotationRevision: 1n, contentHash: 'callback-submission', status: 'ACTIVE',
    scoreResolutionState: 'UNKNOWN', leftTeamId: ids.left, rightTeamId: ids.right, sideAssignmentId: ids.assignment,
    clipPolicyVersion: 'clip-policy-v1', clipPreRollUs: 3_000_000n, clipPostRollUs: 3_000_000n, submittedByUserId: ids.operator,
  } })
  await db.rally.update({ where: { id: ids.rally }, data: { activeSubmissionId: ids.submission } })
  await db.mediaAsset.create({ data: {
    id: ids.clipAsset, kind: 'CANONICAL_CLIP', bucket: 'rally-media', objectKey: 'callback/clip.mp4', contentType: 'video/mp4',
    byteLength: 16n, sha256: 'a'.repeat(64), state: 'READY', readyAt: new Date(),
  } })
  await db.clipJob.create({ data: {
    id: ids.clipJob, submissionId: ids.submission, status: 'COMPLETED', idempotencyKey: 'callback-clip', canonicalizationProfileVersion: 'canonical-v1',
    requestedStartCaptureUs: 0n, requestedEndCaptureUs: 1_000_000n, actualStartCaptureUs: 0n, actualEndCaptureUs: 1_000_000n, clipAssetId: ids.clipAsset,
  } })
  await db.aiJob.create({ data: {
    id: ids.aiJob, submissionId: ids.submission, clipJobId: ids.clipJob, status: 'QUEUED', idempotencyKey: 'callback-ai',
    requestPayload: {}, requestPayloadHash: 'b'.repeat(64), jobSchemaVersion: '3.0.0', callbackTokenHash,
    callbackTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } })
}, 120_000)

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.$disconnect()
  if (createdDatabase) {
    await maintenancePool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [databaseName])
    await maintenancePool.query(`DROP DATABASE "${databaseName}"`)
  }
  await maintenancePool.end()
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
}, 120_000)

describe('AI callback route acceptance', () => {
  it('persists processing progress and returns the same receipt for an identical retry', async () => {
    const callbackId = randomUUID()
    const payload = processingCallback(callbackId)
    const first = await app.inject({ method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`, headers: { authorization: `Bearer ${callbackToken}` }, payload })
    const retry = await app.inject({ method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`, headers: { authorization: `Bearer ${callbackToken}` }, payload })

    expect(first.statusCode).toBe(200)
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual(first.json())
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(1)
    await expect(db.aiJob.findUniqueOrThrow({ where: { id: ids.aiJob } })).resolves.toMatchObject({ status: 'RUNNING', progress: 0.5, stage: 'tracking' })
    await expect(db.rally.findUniqueOrThrow({ where: { id: ids.rally } })).resolves.toMatchObject({ processingStatus: 'AI_PROCESSING' })
  })

  it('rejects reuse of a callback ID with a different payload', async () => {
    const callbackId = randomUUID()
    const first = await app.inject({ method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`, headers: { authorization: `Bearer ${callbackToken}` }, payload: processingCallback(callbackId) })
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`, headers: { authorization: `Bearer ${callbackToken}` }, payload: processingCallback(callbackId, { stage: 'pose' }) })

    expect(first.statusCode).toBe(200)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'CALLBACK_ID_CONFLICT' })
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(1)
  })

  it('rejects an expired job-scoped callback token without creating a receipt', async () => {
    await db.aiJob.update({ where: { id: ids.aiJob }, data: { callbackTokenExpiresAt: new Date(0) } })
    const callbackId = randomUUID()
    const response = await app.inject({ method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`, headers: { authorization: `Bearer ${callbackToken}` }, payload: processingCallback(callbackId) })
    await db.aiJob.update({ where: { id: ids.aiJob }, data: { callbackTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) } })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(0)
  })

  it('rejects completed artifacts with bad checksums before persistence', async () => {
    const callbackId = randomUUID()
    const analysisData = '0000VAD1invalid'
    const request = multipartBody({
      schema_version: '2.0.0', callback_id: callbackId, ai_job_id: ids.aiJob, kind: 'completed',
      analysis_data_sha256: '0'.repeat(64),
      analysis_data_bytes: String(Buffer.byteLength(analysisData)),
    }, analysisData)
    const response = await app.inject({
      method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`,
      headers: { authorization: `Bearer ${callbackToken}`, 'content-type': request.contentType },
      payload: request.body,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'CHECKSUM_MISMATCH' })
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(0)
    await expect(db.analysisRun.count({ where: { aiJobId: ids.aiJob } })).resolves.toBe(0)
  })

  it('rejects callback metadata that does not match the public schema', async () => {
    const callbackId = randomUUID()
    const response = await app.inject({
      method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`,
      headers: { authorization: `Bearer ${callbackToken}` },
      payload: { schema_version: '2.0.0', callback_id: callbackId, ai_job_id: ids.aiJob },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'INVALID_CALLBACK' })
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(0)
  })

  it('rejects a checksum-valid payload that is not a valid VAD1 FlatBuffer', async () => {
    const callbackId = randomUUID()
    const analysisData = '0000VAD1invalid!'
    const request = multipartBody({
      schema_version: '2.0.0', callback_id: callbackId, ai_job_id: ids.aiJob, kind: 'completed',
      analysis_data_sha256: sha256(analysisData),
      analysis_data_bytes: String(Buffer.byteLength(analysisData)),
    }, analysisData)
    const response = await app.inject({
      method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`,
      headers: { authorization: `Bearer ${callbackToken}`, 'content-type': request.contentType },
      payload: request.body,
    })

    expect(response.statusCode).toBe(415)
    expect(response.json()).toMatchObject({ code: 'INVALID_ANALYSIS_DATA' })
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(0)
    await expect(db.analysisRun.count({ where: { aiJobId: ids.aiJob } })).resolves.toBe(0)
  })

  it('rejects an AnalysisData part above the configured callback limit', async () => {
    const callbackId = randomUUID()
    const previousLimit = process.env.AI_CALLBACK_ANALYSIS_DATA_MAX_BYTES
    process.env.AI_CALLBACK_ANALYSIS_DATA_MAX_BYTES = '1024'
    const analysisData = 'x'.repeat(1025)
    const request = multipartBody({
      schema_version: '2.0.0', callback_id: callbackId, ai_job_id: ids.aiJob, kind: 'completed',
      analysis_data_sha256: sha256(analysisData),
      analysis_data_bytes: String(Buffer.byteLength(analysisData)),
    }, analysisData)
    const response = await app.inject({
      method: 'POST', url: `/api/v1/ai/callback/${ids.aiJob}`,
      headers: { authorization: `Bearer ${callbackToken}`, 'content-type': request.contentType },
      payload: request.body,
    })
    if (previousLimit === undefined) delete process.env.AI_CALLBACK_ANALYSIS_DATA_MAX_BYTES
    else process.env.AI_CALLBACK_ANALYSIS_DATA_MAX_BYTES = previousLimit

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    await expect(db.aiCallbackReceipt.count({ where: { callbackId } })).resolves.toBe(0)
  })
})
