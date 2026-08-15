import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  ArtifactState,
  CallbackKind,
  JobStatus,
  MediaAssetKind,
  Prisma,
  ProcessingStatus,
  ProviderArtifactDirection,
  ProviderWorkKind,
} from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { Client } from 'minio'
import { acceptedProviderResultKinds, providerResultShapeError } from '../services/provider-jobs.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[a-f0-9]{64}$/i
const ajv = new Ajv2020({ allErrors: true, strict: false })
const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const callbackSchema = JSON.parse(
  await readFile(new URL('provider-work-callback.schema.json', contractsRoot), 'utf8'),
)
const validateCallback = ajv.compile(callbackSchema)
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function reject(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ schema_version: '1.0.0', code, message })
}

function bearerToken(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/.exec(header ?? '')
  return match?.[1] ?? null
}

function authenticated(token: string | null, expectedHash: string) {
  if (!token || !sha256Pattern.test(expectedHash)) return false
  const actual = Buffer.from(sha256(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function writeBounded(stream: NodeJS.ReadableStream, path: string, maximum: number) {
  const digest = createHash('sha256')
  let bytes = 0
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > maximum) return callback(new Error('PAYLOAD_TOO_LARGE'))
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(stream, verifier, createWriteStream(path))
  return { bytes, sha256: digest.digest('hex') }
}

export interface ProviderResultStorage {
  bucket: string
  put(path: string, objectKey: string, contentType: string): Promise<void>
  remove(objectKey: string): Promise<void>
}

function createProviderResultStorage(): ProviderResultStorage {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000')
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey) throw new Error('MinIO credentials are required')
  const client = new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey,
    secretKey,
    pathStyle: true,
  })
  const bucket = process.env.MINIO_ANALYSIS_BUCKET ?? 'analysis-artifacts'
  return {
    bucket,
    put: async (path, objectKey, contentType) => {
      await client.fPutObject(bucket, objectKey, path, { 'Content-Type': contentType })
    },
    remove: async objectKey => {
      await client.removeObject(bucket, objectKey)
    },
  }
}

function maximumArtifactBytes() {
  const value = Number(process.env.PROVIDER_CALLBACK_ARTIFACT_MAX_BYTES ?? 512 * 1024 * 1024)
  return Number.isSafeInteger(value) && value >= 1 ? value : 512 * 1024 * 1024
}

function maximumCallbackBytes() {
  const value = Number(process.env.PROVIDER_CALLBACK_TOTAL_MAX_BYTES ?? 2 * 1024 * 1024 * 1024)
  return Number.isSafeInteger(value) && value >= 1 ? value : 2 * 1024 * 1024 * 1024
}

function maximumCallbackFiles() {
  const value = Number(process.env.PROVIDER_CALLBACK_MAX_FILES ?? 512)
  return Number.isSafeInteger(value) && value >= 1 && value <= 4096 ? value : 512
}

function mediaKind(artifactKind: string): MediaAssetKind {
  if (artifactKind === 'ANALYSIS_DATA') return MediaAssetKind.ANALYSIS_DATA
  if (artifactKind.startsWith('PERSON_POSE_')) return MediaAssetKind.PERSON_POSE_EVIDENCE
  if (artifactKind.startsWith('REID_') || artifactKind === 'JERSEY_VLM_RESPONSE')
    return MediaAssetKind.REID_EVIDENCE
  if (artifactKind === 'IDENTITY_PREVIEW') return MediaAssetKind.IDENTITY_PREVIEW
  return MediaAssetKind.PROVIDER_ARTIFACT
}

type UploadedPart = {
  fieldname: string
  path: string
  contentType: string
  bytes: number
  sha256: string
}

type ResultDescriptor = {
  part_name: string
  kind: string
  schema_version: string
  sha256: string
  byte_length: string
  content_type: string
}

function resultDescriptors(metadata: Record<string, unknown>): ResultDescriptor[] {
  return Array.isArray(metadata.artifacts)
    ? metadata.artifacts.filter(isRecord).map(value => value as unknown as ResultDescriptor)
    : []
}

export interface ProviderJobCallbackDependencies {
  database: PrismaClient
  storage?: ProviderResultStorage
}

export const providerJobCallbackRoutes =
  (dependencies: ProviderJobCallbackDependencies): FastifyPluginAsync =>
  async app => {
    const database = dependencies.database
    const storage = dependencies.storage ?? createProviderResultStorage()

    app.post<{ Params: { providerJobId: string } }>(
      '/api/v1/provider-jobs/:providerJobId/callback',
      async (request, reply) => {
        const providerJobId = request.params.providerJobId
        if (!uuid.test(providerJobId))
          return reject(reply, 404, 'NOT_FOUND', 'Provider job not found')
        const job = await database.providerJob.findUnique({ where: { id: providerJobId } })
        const token = bearerToken(request.headers.authorization)
        if (
          !job ||
          job.callbackTokenExpiresAt <= new Date() ||
          !authenticated(token, job.callbackTokenHash)
        )
          return reject(reply, 401, 'UNAUTHENTICATED', 'Callback token is invalid or expired')

        const directory = await mkdtemp(join(tmpdir(), 'volleyball-provider-callback-'))
        const uploaded: UploadedPart[] = []
        const storedObjectKeys: string[] = []
        try {
          let metadata: unknown
          const contentType = request.headers['content-type'] ?? ''
          if (request.isMultipart()) {
            const maximumBytes = maximumArtifactBytes()
            const maximumTotalBytes = maximumCallbackBytes()
            const maximumFiles = maximumCallbackFiles()
            let totalBytes = 0
            for await (const part of request.parts({
              limits: {
                fields: 2,
                files: maximumFiles,
                fileSize: maximumBytes,
                parts: maximumFiles + 3,
              },
            })) {
              if (part.type === 'field' && part.fieldname === 'metadata') {
                metadata = typeof part.value === 'string' ? JSON.parse(part.value) : part.value
              } else if (part.type === 'file') {
                const path = join(directory, `${uploaded.length.toString().padStart(2, '0')}.bin`)
                const info = await writeBounded(part.file, path, maximumBytes)
                totalBytes += info.bytes
                if (totalBytes > maximumTotalBytes) throw new Error('PAYLOAD_TOO_LARGE')
                uploaded.push({
                  fieldname: part.fieldname,
                  path,
                  contentType: part.mimetype,
                  ...info,
                })
              }
            }
          } else {
            metadata = request.body
          }
          if (
            !validateCallback(metadata) ||
            !isRecord(metadata) ||
            metadata.provider_job_id !== providerJobId ||
            metadata.work_kind !== job.workKind
          )
            return reject(
              reply,
              422,
              'INVALID_CALLBACK',
              'Callback metadata failed schema or provider job validation',
            )

          const callbackId = String(metadata.callback_id)
          const linkedAiJobId =
            isRecord(job.requestPayload) && typeof job.requestPayload.ai_job_id === 'string'
              ? job.requestPayload.ai_job_id
              : null
          const descriptors = resultDescriptors(metadata)
          const payloadHash = sha256(
            `${JSON.stringify(metadata)}:${uploaded
              .map(part => `${part.fieldname}:${part.sha256}:${part.bytes}`)
              .sort()
              .join('|')}`,
          )
          const existing = await database.providerCallbackReceipt.findUnique({
            where: { callbackId },
          })
          if (existing) {
            if (existing.providerJobId !== providerJobId || existing.payloadHash !== payloadHash)
              return reject(
                reply,
                409,
                'CALLBACK_ID_CONFLICT',
                'Callback ID was already used for another payload',
              )
            return reply.status(existing.responseStatus).send(existing.responseBody)
          }
          if (
            job.status === JobStatus.CANCELLED ||
            job.status === JobStatus.SUPERSEDED ||
            job.status === JobStatus.COMPLETED
          )
            return reject(reply, 409, 'JOB_NOT_ACTIVE', 'Provider job is not active')

          const response = {
            schema_version: '1.0.0',
            accepted: true,
            callback_id: callbackId,
          }
          const kind = String(metadata.kind)
          if (kind === 'processing') {
            if (uploaded.length > 0)
              return reject(
                reply,
                422,
                'INVALID_CALLBACK',
                'Processing callback cannot upload artifacts',
              )
            await database.$transaction(async transaction => {
              await transaction.providerCallbackReceipt.create({
                data: {
                  providerJobId,
                  callbackId,
                  kind: CallbackKind.PROCESSING,
                  requestContentType: contentType,
                  requestMetadata: json(metadata),
                  payloadHash,
                  responseStatus: 200,
                  responseBody: json(response),
                },
              })
              await transaction.providerJob.update({
                where: { id: providerJobId },
                data: {
                  status: JobStatus.RUNNING,
                  progress: Number(metadata.progress),
                  stage: typeof metadata.stage === 'string' ? metadata.stage : null,
                  lastCallbackAt: new Date(),
                },
              })
              if (job.workKind === ProviderWorkKind.ANALYSIS && linkedAiJobId) {
                const linked = await transaction.aiJob.findUnique({
                  where: { id: linkedAiJobId },
                  select: { submission: { select: { rallyId: true } } },
                })
                if (linked) {
                  await transaction.aiJob.update({
                    where: { id: linkedAiJobId },
                    data: {
                      progress: Number(metadata.progress),
                      stage:
                        typeof metadata.stage === 'string' ? metadata.stage : 'provider_running',
                      lastCallbackAt: new Date(),
                    },
                  })
                  await transaction.rally.update({
                    where: { id: linked.submission.rallyId },
                    data: { processingStatus: ProcessingStatus.AI_PROCESSING },
                  })
                }
              }
            })
            return reply.send(response)
          }

          if (kind === 'failed') {
            if (uploaded.length > 0)
              return reject(
                reply,
                422,
                'INVALID_CALLBACK',
                'Failed callback cannot upload artifacts',
              )
            const failure = isRecord(metadata.error) ? metadata.error : {}
            const retry = failure.retryable === true && job.attemptCount < job.maxAttempts
            const now = new Date()
            await database.$transaction(async transaction => {
              await transaction.providerCallbackReceipt.create({
                data: {
                  providerJobId,
                  callbackId,
                  kind: CallbackKind.FAILED,
                  requestContentType: contentType,
                  requestMetadata: json(metadata),
                  payloadHash,
                  responseStatus: 200,
                  responseBody: json(response),
                },
              })
              await transaction.providerJob.update({
                where: { id: providerJobId },
                data: {
                  status: retry ? JobStatus.QUEUED : JobStatus.FAILED,
                  providerInstanceId: retry ? null : job.providerInstanceId,
                  deliveryId: retry ? null : job.deliveryId,
                  leasedUntil: null,
                  availableAt: now,
                  errorCode: String(failure.code ?? 'PROVIDER_FAILED').slice(0, 128),
                  errorMessage: String(failure.message ?? 'provider failed').slice(0, 1_000),
                  stage: retry ? 'provider_retry_queued' : 'provider_failed',
                  lastCallbackAt: now,
                  completedAt: retry ? null : now,
                },
              })
              if (job.workKind === ProviderWorkKind.ANALYSIS && linkedAiJobId && !retry) {
                const linked = await transaction.aiJob.findUnique({
                  where: { id: linkedAiJobId },
                  select: { submission: { select: { rallyId: true } } },
                })
                if (linked) {
                  await transaction.aiJob.update({
                    where: { id: linkedAiJobId },
                    data: {
                      status: JobStatus.FAILED,
                      errorCode: String(failure.code ?? 'PROVIDER_FAILED').slice(0, 128),
                      errorMessage: String(failure.message ?? 'provider failed').slice(0, 500),
                      lastCallbackAt: now,
                      completedAt: now,
                    },
                  })
                  await transaction.rally.update({
                    where: { id: linked.submission.rallyId },
                    data: { processingStatus: ProcessingStatus.FAILED },
                  })
                }
              }
            })
            return reply.send(response)
          }

          if (String(metadata.result_schema_version) !== job.resultSchemaVersion)
            return reject(
              reply,
              422,
              'RESULT_SCHEMA_MISMATCH',
              'Result schema version does not match the provider job',
            )
          const acceptedKinds = new Set(
            acceptedProviderResultKinds(job.workKind).map(value => String(value)),
          )
          const resultShapeError = providerResultShapeError(
            job.workKind,
            descriptors.map(descriptor => descriptor.kind),
          )
          const uploadedByName = new Map(uploaded.map(part => [part.fieldname, part]))
          if (
            resultShapeError !== null ||
            descriptors.length !== uploaded.length ||
            descriptors.some(
              descriptor =>
                !acceptedKinds.has(descriptor.kind) ||
                !uploadedByName.has(descriptor.part_name) ||
                uploadedByName.get(descriptor.part_name)!.sha256.toLowerCase() !==
                  descriptor.sha256.toLowerCase() ||
                uploadedByName.get(descriptor.part_name)!.bytes.toString() !==
                  descriptor.byte_length ||
                uploadedByName.get(descriptor.part_name)!.contentType !== descriptor.content_type,
            )
          )
            return reject(
              reply,
              422,
              'ARTIFACT_MISMATCH',
              resultShapeError ?? 'Uploaded artifacts do not match the completed callback manifest',
            )

          const assets = [] as Array<{
            id: string
            descriptor: ResultDescriptor
            objectKey: string
            part: UploadedPart
          }>
          for (const descriptor of descriptors) {
            const part = uploadedByName.get(descriptor.part_name)!
            const id = randomUUID()
            const objectKey = `provider-jobs/${providerJobId}/${callbackId}/${id}-${descriptor.part_name}`
            await storage.put(part.path, objectKey, descriptor.content_type)
            storedObjectKeys.push(objectKey)
            assets.push({ id, descriptor, objectKey, part })
          }
          const now = new Date()
          await database.$transaction(async transaction => {
            for (const [ordinal, asset] of assets.entries()) {
              await transaction.mediaAsset.create({
                data: {
                  id: asset.id,
                  kind: mediaKind(asset.descriptor.kind),
                  bucket: storage.bucket,
                  objectKey: asset.objectKey,
                  contentType: asset.descriptor.content_type,
                  byteLength: BigInt(asset.part.bytes),
                  sha256: asset.part.sha256,
                  internalSchemaVersion: asset.descriptor.schema_version,
                  state: ArtifactState.READY,
                  readyAt: now,
                },
              })
              await transaction.providerJobArtifact.create({
                data: {
                  providerJobId,
                  mediaAssetId: asset.id,
                  direction: ProviderArtifactDirection.OUTPUT,
                  artifactKind: asset.descriptor.kind,
                  ordinal,
                  schemaVersion: asset.descriptor.schema_version,
                  sha256: asset.part.sha256,
                  byteLength: BigInt(asset.part.bytes),
                  contentType: asset.descriptor.content_type,
                },
              })
            }
            await transaction.providerCallbackReceipt.create({
              data: {
                providerJobId,
                callbackId,
                kind: CallbackKind.COMPLETED,
                requestContentType: contentType,
                requestMetadata: json(metadata),
                payloadHash,
                responseStatus: 200,
                responseBody: json(response),
              },
            })
            await transaction.providerJob.update({
              where: { id: providerJobId },
              data: {
                status: JobStatus.COMPLETED,
                progress: 1,
                stage: job.workKind === ProviderWorkKind.ANALYSIS ? 'artifacts_ready' : 'completed',
                lastCallbackAt: now,
                completedAt: now,
                leasedUntil: null,
                errorCode: null,
                errorMessage: null,
              },
            })
            if (job.workKind === ProviderWorkKind.ANALYSIS && linkedAiJobId) {
              const linked = await transaction.aiJob.findUnique({
                where: { id: linkedAiJobId },
                select: { submission: { select: { rallyId: true } } },
              })
              if (linked) {
                await transaction.aiJob.update({
                  where: { id: linkedAiJobId },
                  data: {
                    stage: 'provider_artifacts_ready',
                    progress: 1,
                    lastCallbackAt: now,
                  },
                })
                await transaction.rally.update({
                  where: { id: linked.submission.rallyId },
                  data: { processingStatus: ProcessingStatus.ARTIFACT_INGESTING },
                })
                await transaction.outboxEvent.create({
                  data: {
                    aggregateType: 'ProviderJob',
                    aggregateId: providerJobId,
                    eventType: 'provider.analysis_artifacts_ready.v1',
                    dedupeKey: `provider-analysis-artifacts:${providerJobId}:${callbackId}`,
                    payload: json({
                      provider_job_id: providerJobId,
                      ai_job_id: linkedAiJobId,
                      output_assets: assets.map(asset => ({
                        media_asset_id: asset.id,
                        kind: asset.descriptor.kind,
                        schema_version: asset.descriptor.schema_version,
                        sha256: asset.descriptor.sha256,
                        byte_length: asset.descriptor.byte_length,
                        content_type: asset.descriptor.content_type,
                      })),
                    }),
                  },
                })
              }
            }
          })
          storedObjectKeys.length = 0
          return reply.send(response)
        } catch (error) {
          if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE')
            return reject(reply, 413, 'PAYLOAD_TOO_LARGE', 'Provider result artifact is too large')
          throw error
        } finally {
          await Promise.allSettled(storedObjectKeys.map(objectKey => storage.remove(objectKey)))
          await rm(directory, { recursive: true, force: true })
        }
      },
    )
  }
