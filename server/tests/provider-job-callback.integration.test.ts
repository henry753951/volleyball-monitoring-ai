import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderResultStorage } from '../src/routes/provider-job-callback.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(process.cwd(), '..')
const databasePackageRoot = resolve(repositoryRoot, 'packages/db')
const originalDatabaseUrl = process.env.DATABASE_URL
const sourceDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  originalDatabaseUrl ??
  'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const databaseName = `provider_callback_${randomUUID().replaceAll('-', '')}`
const maintenanceUrl = new URL(sourceDatabaseUrl)
maintenanceUrl.pathname = '/postgres'
maintenanceUrl.searchParams.delete('schema')
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl)
isolatedDatabaseUrl.pathname = `/${databaseName}`
isolatedDatabaseUrl.searchParams.set('schema', 'public')
const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() })

const callbackToken = 'provider-callback-token-1234567890-abcdefghijklmnop'
const callbackTokenHash = createHash('sha256').update(callbackToken).digest('hex')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

let app: FastifyInstance
let db: typeof DatabaseClient
let createdDatabase = false
const stored = new Map<string, Buffer>()
const storage: ProviderResultStorage = {
  bucket: 'provider-test',
  put: async (path, objectKey) => {
    stored.set(objectKey, await readFile(path))
  },
  remove: async objectKey => {
    stored.delete(objectKey)
  },
}

async function createJob(
  status: 'QUEUED' | 'RUNNING' = 'RUNNING',
  workKind:
    | 'ANALYSIS'
    | 'REID_FEATURE_EXTRACTION'
    | 'REID_ASSOCIATION'
    | 'PERSON_POSE_EVIDENCE_REBUILD'
    | 'IDENTITY_PREVIEW_GENERATION' = 'REID_FEATURE_EXTRACTION',
) {
  const id = randomUUID()
  return db.providerJob.create({
    data: {
      id,
      workKind,
      status,
      idempotencyKey: `feature:${id}`,
      requestSchemaVersion: '1.0.0',
      resultSchemaVersion: '1.0.0',
      requestPayload: { schema_version: '1.0.0', provider_job_id: id },
      requestPayloadHash: 'a'.repeat(64),
      callbackTokenHash,
      callbackTokenExpiresAt: new Date(Date.now() + 60_000),
      attemptCount: 1,
    },
  })
}

function multipartBody(metadata: Record<string, unknown>, files: Record<string, Buffer>) {
  const boundary = `vmai-${randomUUID()}`
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    ),
  ]
  for (const [name, data] of Object.entries(files)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from('\r\n'),
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
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
  const { providerJobCallbackRoutes } = await import('../src/routes/provider-job-callback.js')
  app = Fastify()
  await app.register(multipart)
  await app.register(providerJobCallbackRoutes({ database: db, storage }))
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  process.env.DATABASE_URL = originalDatabaseUrl
  if (createdDatabase) {
    await maintenancePool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    )
    await maintenancePool.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
  }
  await maintenancePool.end()
})

describe('generic provider callback', () => {
  it('stores an opaque callback ID idempotently and advances progress', async () => {
    const job = await createJob()
    const payload = {
      schema_version: '1.0.0',
      callback_id: 'provider-progress-one',
      provider_job_id: job.id,
      work_kind: 'REID_FEATURE_EXTRACTION',
      kind: 'processing',
      progress: 0.45,
      stage: 'selecting_frames',
    }
    const request = {
      method: 'POST' as const,
      url: `/api/v1/provider-jobs/${job.id}/callback`,
      headers: { authorization: `Bearer ${callbackToken}` },
      payload,
    }
    expect((await app.inject(request)).statusCode).toBe(200)
    expect((await app.inject(request)).statusCode).toBe(200)
    await expect(
      db.providerCallbackReceipt.count({ where: { providerJobId: job.id } }),
    ).resolves.toBe(1)
    await expect(
      db.providerJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      progress: 0.45,
      stage: 'selecting_frames',
      status: 'RUNNING',
    })
  })

  it('verifies and commits independently versioned output artifacts', async () => {
    const job = await createJob()
    const result = Buffer.from('{"schema_version":"1.0.0"}')
    const descriptors = Buffer.from('descriptor-bytes')
    const metadata = {
      schema_version: '1.0.0',
      callback_id: 'provider-completed-one',
      provider_job_id: job.id,
      work_kind: 'REID_FEATURE_EXTRACTION',
      kind: 'completed',
      result_schema_version: '1.0.0',
      artifacts: [
        {
          part_name: 'reid_feature_result',
          kind: 'REID_FEATURE_RESULT',
          schema_version: '1.0.0',
          sha256: sha256(result),
          byte_length: String(result.byteLength),
          content_type: 'application/octet-stream',
        },
        {
          part_name: 'descriptor_bundle',
          kind: 'REID_DESCRIPTOR_BUNDLE',
          schema_version: '1.0.0',
          sha256: sha256(descriptors),
          byte_length: String(descriptors.byteLength),
          content_type: 'application/octet-stream',
        },
      ],
    }
    const multipart = multipartBody(metadata, {
      reid_feature_result: result,
      descriptor_bundle: descriptors,
    })
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/provider-jobs/${job.id}/callback`,
      headers: {
        authorization: `Bearer ${callbackToken}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    })
    expect(response.statusCode, response.body).toBe(200)
    await expect(
      db.providerJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      progress: 1,
      status: 'COMPLETED',
    })
    const outputs = await db.providerJobArtifact.findMany({
      where: { providerJobId: job.id, direction: 'OUTPUT' },
      include: { mediaAsset: true },
      orderBy: { ordinal: 'asc' },
    })
    expect(outputs.map(output => output.artifactKind)).toEqual([
      'REID_FEATURE_RESULT',
      'REID_DESCRIPTOR_BUNDLE',
    ])
    expect(outputs.every(output => output.mediaAsset.state === 'READY')).toBe(true)
    expect(stored.size).toBeGreaterThanOrEqual(2)
  })

  it('rejects a completed callback when bytes do not match the manifest', async () => {
    const job = await createJob()
    const data = Buffer.from('actual')
    const metadata = {
      schema_version: '1.0.0',
      callback_id: 'provider-invalid-artifact',
      provider_job_id: job.id,
      work_kind: 'REID_FEATURE_EXTRACTION',
      kind: 'completed',
      result_schema_version: '1.0.0',
      artifacts: [
        {
          part_name: 'reid_feature_result',
          kind: 'REID_FEATURE_RESULT',
          schema_version: '1.0.0',
          sha256: sha256('different'),
          byte_length: String(data.byteLength),
          content_type: 'application/octet-stream',
        },
      ],
    }
    const multipart = multipartBody(metadata, { reid_feature_result: data })
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/provider-jobs/${job.id}/callback`,
      headers: {
        authorization: `Bearer ${callbackToken}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    })
    expect(response.statusCode).toBe(422)
    await expect(db.providerJobArtifact.count({ where: { providerJobId: job.id } })).resolves.toBe(
      0,
    )
  })

  it('hands a complete base-analysis artifact set to the durable materializer', async () => {
    const job = await createJob('RUNNING', 'ANALYSIS')
    const files: Record<string, Buffer> = {
      analysis_data: Buffer.from('\x00\x00\x00\x00VAD1fixture'),
      analysis_evidence_manifest: Buffer.from('{"schema_version":"1.0.0"}'),
      pose_manifest: Buffer.from('{"schema_version":"1.0.0"}'),
      crop_source_manifest: Buffer.from('{"schema_version":"1.0.0"}'),
    }
    const kinds: Record<string, string> = {
      analysis_data: 'ANALYSIS_DATA',
      analysis_evidence_manifest: 'ANALYSIS_EVIDENCE_MANIFEST',
      pose_manifest: 'PERSON_POSE_EVIDENCE_MANIFEST',
      crop_source_manifest: 'PLAYER_CROP_SOURCE_MANIFEST',
    }
    for (let index = 0; index < 40; index += 1) {
      const partName = `pose_chunk_${index.toString().padStart(4, '0')}`
      files[partName] = Buffer.from(`\x00\x00\x00\x00VPE1fixture-${index}`)
      kinds[partName] = 'PERSON_POSE_EVIDENCE_CHUNK'
    }
    const metadata = {
      schema_version: '1.0.0',
      callback_id: 'provider-analysis-completed-one',
      provider_job_id: job.id,
      work_kind: 'ANALYSIS',
      kind: 'completed',
      result_schema_version: '1.0.0',
      artifacts: Object.entries(files).map(([partName, data]) => ({
        part_name: partName,
        kind: kinds[partName],
        schema_version: '1.0.0',
        sha256: sha256(data),
        byte_length: String(data.byteLength),
        content_type: 'application/octet-stream',
      })),
    }
    const multipart = multipartBody(metadata, files)
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/provider-jobs/${job.id}/callback`,
      headers: {
        authorization: `Bearer ${callbackToken}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    })

    expect(response.statusCode, response.body).toBe(200)
    await expect(
      db.providerJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
      stage: 'artifacts_ready',
    })
    await expect(
      db.providerJobArtifact.count({ where: { providerJobId: job.id, direction: 'OUTPUT' } }),
    ).resolves.toBe(44)
  })
})
