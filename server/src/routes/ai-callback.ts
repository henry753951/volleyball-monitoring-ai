import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { chunkAnalysisData, encodeAnalysisFrameChunk, parseAnalysisData, type AnalysisData } from '@volleyball-monitoring/contracts'
import { db } from '@volleyball-monitoring/db'
import { AnalysisReviewStatus, ArtifactState, AssociationState, BallObservationState, CallbackKind, JobStatus, MarkerKind, MediaAssetKind, Prisma, ProcessingStatus, SegmentEndpoint, SegmentRenderState, TrackCourtSide } from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { Client } from 'minio'
import type { AiProgressService } from '../realtime/ai-progress.js'
import { FixedRosterReidError, ingestFixedRosterReid, parseFixedRosterReidExtension } from '../services/fixed-roster-reid.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addFormat('uuid', uuid)
const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const callbackSchema = JSON.parse(await readFile(new URL('callback.schema.json', contractsRoot), 'utf8'))
const analysisDataDomainSchema = JSON.parse(await readFile(new URL('analysis-data-domain.schema.json', contractsRoot), 'utf8'))
const validateCallback = ajv.compile(callbackSchema)
const validateAnalysisDataDomain = ajv.compile(analysisDataDomainSchema)
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : []
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function storage() {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000')
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey) throw new Error('MinIO credentials are required')
  return { client: new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), useSSL: endpoint.protocol === 'https:', accessKey, secretKey, pathStyle: true }), bucket: process.env.MINIO_ANALYSIS_BUCKET ?? 'analysis-artifacts' }
}

function reject(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ schema_version: '1.0.0', code, message })
}

function bearerToken(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header ?? '')
  return match?.[1] ?? null
}

function authenticated(token: string | null, expectedHash: string) {
  if (!token || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const actual = Buffer.from(sha256(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function writeBounded(stream: NodeJS.ReadableStream, path: string, maximum: number) {
  const digest = createHash('sha256')
  let bytes = 0
  const verifier = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.byteLength; if (bytes > maximum) return callback(new Error('PAYLOAD_TOO_LARGE')); digest.update(chunk); callback(null, chunk) } })
  await pipeline(stream, verifier, createWriteStream(path))
  return { bytes, sha256: digest.digest('hex') }
}

function invariantError(result: Record<string, unknown>, job: Awaited<ReturnType<typeof loadJob>>) {
  if (!job) return 'AI job not found'
  const expected = { ai_job_id: job.id, rally_submission_id: job.submissionId, rally_id: job.submission.rallyId, match_id: job.submission.rally.matchId, annotation_revision: job.submission.annotationRevision.toString(), clip_asset_id: job.clipJob.clipAssetId, input_clip_sha256: job.clipJob.clipAsset?.sha256 }
  for (const [key, value] of Object.entries(expected)) if (result[key] !== value) return `${key} passthrough mismatch`
  const events = result.contact_events
  if (!Array.isArray(events)) return 'contact events are missing'
  const inputById = new Map(job.submission.keyPoints.map(point => [point.id, point]))
  const mappingByPoint = new Map(job.clipJob.keyPointMappings.map(mapping => [mapping.submissionKeyPointId, mapping]))
  const seenIds = new Set<string>()
  const humanIds: string[] = []
  let previousAnchorFrame = -1n
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!isRecord(event) || event.sequence_index !== index || typeof event.key_point_id !== 'string' || seenIds.has(event.key_point_id)) return 'contact event identity/order mismatch'
    if (typeof event.anchor_frame_index !== 'string' || !/^(0|[1-9][0-9]*)$/.test(event.anchor_frame_index)) return 'contact event anchor frame is invalid'
    const anchorFrame = BigInt(event.anchor_frame_index)
    if (anchorFrame <= previousAnchorFrame) return 'contact event anchor frames must be strictly increasing'
    previousAnchorFrame = anchorFrame
    seenIds.add(event.key_point_id)
    if (event.anchor_origin === 'human_anchor') {
      const sourceId = typeof event.source_key_point_id === 'string' ? event.source_key_point_id : ''
      const point = inputById.get(sourceId)
      const mapping = mappingByPoint.get(sourceId)
      if (!point || !mapping || event.marker_kind !== point.markerKind.toLowerCase() || event.is_terminal !== point.isTerminal || event.anchor_frame_index !== mapping.clipFrameIndex.toString()) return 'human contact event passthrough mismatch'
      humanIds.push(sourceId)
    } else if (event.anchor_origin !== 'ai_detected' || event.source_key_point_id !== null || event.marker_kind !== 'contact' || event.is_terminal !== false) {
      return 'AI-detected contact event provenance is invalid'
    }
  }
  if (humanIds.join(':') !== job.submission.keyPoints.map(point => point.id).join(':')) return 'human contact events do not preserve immutable key points in order'
  return null
}

function analysisDataInvariantError(analysisData: AnalysisData, domain: Record<string, unknown>, job: NonNullable<Awaited<ReturnType<typeof loadJob>>>) {
  const expected = {
    aiJobId: job.id,
    rallySubmissionId: job.submissionId,
    rallyId: job.submission.rallyId,
    matchId: job.submission.rally.matchId,
    annotationRevision: job.submission.annotationRevision.toString(),
    clipAssetId: job.clipJob.clipAssetId ?? '',
    analysisId: String(domain.analysis_id),
    analysisVersion: String(domain.analysis_version),
  }
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === 'annotationRevision' ? analysisData.annotationRevision.toString() : analysisData[key as keyof AnalysisData]
    if (actual !== value) return `AnalysisData ${key} passthrough mismatch`
  }
  const payload = isRecord(job.requestPayload) ? job.requestPayload : null
  const clip = payload && isRecord(payload.clip) ? payload.clip : null
  const video = clip && isRecord(clip.video) ? clip.video : null
  const fps = video && isRecord(video.fps) ? video.fps : null
  if (!video || !fps) return 'AI request video metadata is unavailable'
  if (analysisData.videoWidth !== video.width || analysisData.videoHeight !== video.height || analysisData.fpsNum !== fps.num || analysisData.fpsDen !== fps.den || analysisData.totalFrames.toString() !== video.total_frames) return 'AnalysisData video metadata mismatch'
  if (analysisData.domainJson.length === 0 || analysisData.inputClipSha256 !== domain.input_clip_sha256) return 'AnalysisData domain metadata mismatch'
  return null
}

function analysisDataMaximumBytes() {
  const value = Number(process.env.AI_CALLBACK_ANALYSIS_DATA_MAX_BYTES ?? 512 * 1024 * 1024)
  return Number.isSafeInteger(value) && value >= 1 ? value : 512 * 1024 * 1024
}

function loadJob(aiJobId: string) {
  return db.aiJob.findUnique({ where: { id: aiJobId }, include: { submission: { include: { rally: { include: { program: true, set: true } }, keyPoints: { orderBy: { sequenceIndex: 'asc' } } } }, clipJob: { include: { clipAsset: true, keyPointMappings: true } } } })
}

export interface AiCallbackRouteDependencies {
  progress?: AiProgressService
  onAnalysisStateChanged?: (matchId: string) => void | Promise<void>
}

export const aiCallbackRoutesWithDependencies = (
  dependencies: AiCallbackRouteDependencies = {},
): FastifyPluginAsync => async (app) => {
  async function notifyCoach(matchId: string) {
    try { await dependencies.onAnalysisStateChanged?.(matchId) }
    catch (error) { app.log.warn({ error, matchId }, 'Coach analysis invalidation failed') }
  }

  app.post<{ Params: { aiJobId: string } }>('/api/v1/ai/callback/:aiJobId', async (request, reply) => {
    const aiJobId = request.params.aiJobId
    if (!uuid.test(aiJobId)) return reject(reply, 404, 'NOT_FOUND', 'AI job not found')
    const job = await loadJob(aiJobId)
    const token = bearerToken(request.headers.authorization)
    if (!job || job.callbackTokenExpiresAt <= new Date() || !authenticated(token, job.callbackTokenHash)) return reject(reply, 401, 'UNAUTHENTICATED', 'Callback token is invalid or expired')
    if (job.status === JobStatus.CANCELLED || job.status === JobStatus.SUPERSEDED || job.submission.rally.voidedAt) {
      return reject(reply, 409, 'JOB_NOT_ACTIVE', 'AI job was cancelled or superseded')
    }

    const directory = await mkdtemp(join(tmpdir(), 'volleyball-callback-'))
    try {
      let metadata: unknown
      let analysisDataPath: string | null = null
      let analysisDataInfo: { bytes: number; sha256: string } | null = null
      const contentType = request.headers['content-type'] ?? ''
      if (request.isMultipart()) {
        const maximumBytes = analysisDataMaximumBytes()
        for await (const part of request.parts({
          limits: { fields: 2, files: 1, fileSize: maximumBytes, parts: 4 },
        })) {
          if (part.type === 'field' && part.fieldname === 'metadata') metadata = typeof part.value === 'string' ? JSON.parse(part.value) : part.value
          else if (part.type === 'file' && part.fieldname === 'analysis_data') { analysisDataPath = join(directory, 'analysis-data.fb'); analysisDataInfo = await writeBounded(part.file, analysisDataPath, maximumBytes) }
          else if (part.type === 'file') part.file.resume()
        }
      } else {
        metadata = request.body
      }
      if (!validateCallback(metadata) || !isRecord(metadata) || metadata.ai_job_id !== aiJobId) return reject(reply, 422, 'INVALID_CALLBACK', 'Callback metadata failed schema or job validation')
      const kind = String(metadata.kind)
      if (kind === 'completed' && (!analysisDataPath || !analysisDataInfo)) return reject(reply, 422, 'INVALID_CALLBACK', 'Completed callback requires one AnalysisData part')

      const payloadHash = sha256(`${JSON.stringify(metadata)}:${analysisDataInfo?.sha256 ?? ''}`)
      const existing = await db.aiCallbackReceipt.findUnique({ where: { callbackId: String(metadata.callback_id) } })
      if (existing) {
        if (existing.aiJobId !== aiJobId || existing.payloadHash !== payloadHash) return reject(reply, 409, 'CALLBACK_ID_CONFLICT', 'Callback ID was already used for another payload')
        return reply.status(existing.responseStatus).send(existing.responseBody)
      }

      if (kind === 'processing') {
        const response = { schema_version: '1.0.0', accepted: true, callback_id: metadata.callback_id }
        await db.$transaction([
          db.aiCallbackReceipt.create({ data: { aiJobId, callbackId: String(metadata.callback_id), kind: CallbackKind.PROCESSING, requestContentType: contentType, requestMetadata: json(metadata), payloadHash, responseStatus: 200, responseBody: json(response) } }),
          db.aiJob.update({ where: { id: aiJobId }, data: { status: JobStatus.RUNNING, progress: typeof metadata.progress === 'number' ? metadata.progress : null, stage: typeof metadata.stage === 'string' ? metadata.stage : null, lastCallbackAt: new Date() } }),
          db.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.AI_PROCESSING } }),
        ])
        await publishCallbackProgress(job, 'ai_processing', {
          progress: typeof metadata.progress === 'number' ? metadata.progress : null,
          stage: typeof metadata.stage === 'string' ? metadata.stage : null,
        })
        await notifyCoach(job.submission.rally.matchId)
        return reply.send(response)
      }
      if (kind === 'failed') {
        const failure = isRecord(metadata.error) ? metadata.error : {}
        const response = { schema_version: '1.0.0', accepted: true, callback_id: metadata.callback_id }
        await db.$transaction([
          db.aiCallbackReceipt.create({ data: { aiJobId, callbackId: String(metadata.callback_id), kind: CallbackKind.FAILED, requestContentType: contentType, requestMetadata: json(metadata), payloadHash, responseStatus: 200, responseBody: json(response) } }),
          db.aiJob.update({ where: { id: aiJobId }, data: { status: JobStatus.FAILED, errorCode: String(failure.code ?? 'PROVIDER_FAILED').slice(0, 128), errorMessage: String(failure.message ?? 'provider failed').slice(0, 500), lastCallbackAt: new Date(), completedAt: new Date() } }),
          db.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.FAILED } }),
        ])
        await publishCallbackProgress(job, 'failed', {
          progress: job.progress,
          stage: 'failed',
          error: failure,
        })
        await notifyCoach(job.submission.rally.matchId)
        return reply.send(response)
      }

      if (!analysisDataPath || !analysisDataInfo || analysisDataInfo.sha256 !== String(metadata.analysis_data_sha256).toLowerCase() || analysisDataInfo.bytes !== Number(metadata.analysis_data_bytes)) return reject(reply, 422, 'CHECKSUM_MISMATCH', 'Completed callback AnalysisData checksum or length mismatch')
      const analysisDataBytes = await readFile(analysisDataPath)
      if (analysisDataInfo.bytes < 16 || analysisDataBytes.subarray(4, 8).toString('ascii') !== 'VAD1') return reject(reply, 415, 'INVALID_ANALYSIS_DATA', 'AnalysisData is not a VAD1 FlatBuffer')
      let analysisData: AnalysisData
      try { analysisData = parseAnalysisData(analysisDataBytes) }
      catch { return reject(reply, 415, 'INVALID_ANALYSIS_DATA', 'AnalysisData FlatBuffer failed schema or column validation') }
      let result: unknown
      try { result = JSON.parse(analysisData.domainJson) as unknown }
      catch { return reject(reply, 422, 'INVALID_ANALYSIS_DATA', 'AnalysisData domain payload is not valid JSON') }
      if (!validateAnalysisDataDomain(result) || !isRecord(result)) return reject(reply, 422, 'INVALID_ANALYSIS_DATA', 'AnalysisData domain payload failed schema validation')
      const invariant = invariantError(result, job)
      if (invariant) return reject(reply, 409, 'PASSTHROUGH_MISMATCH', invariant)
      let reidFeatureBank
      try { reidFeatureBank = parseFixedRosterReidExtension(result) }
      catch (error) {
        if (error instanceof FixedRosterReidError) return reject(reply, 422, 'INVALID_REID_FEATURE_BANK', error.message)
        throw error
      }
      const analysisDataInvariant = analysisDataInvariantError(analysisData, result, job)
      if (analysisDataInvariant) return reject(reply, 409, 'PASSTHROUGH_MISMATCH', analysisDataInvariant)
      const analysisFrameChunkCount = Number(process.env.ANALYSIS_FRAME_CHUNK_COUNT ?? 120)
      if (!Number.isSafeInteger(analysisFrameChunkCount) || analysisFrameChunkCount < 1 || analysisFrameChunkCount > 3_600) return reject(reply, 503, 'ANALYSIS_DATA_CONFIGURATION_INVALID', 'AnalysisData chunk configuration is invalid')
      const browserChunks = chunkAnalysisData(analysisData, analysisFrameChunkCount).map((chunk) => {
        const bytes = Buffer.from(encodeAnalysisFrameChunk(chunk))
        return { chunk, bytes, sha256: sha256(bytes) }
      })

      const objectStore = storage()
      const analysisDataKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}/analysis-data.fb`
      await objectStore.client.fPutObject(objectStore.bucket, analysisDataKey, analysisDataPath, { 'Content-Type': 'application/vnd.volleyball.analysis-data+flatbuffers;version=1', 'x-amz-meta-sha256': analysisDataInfo.sha256, 'x-amz-meta-byte-length': String(analysisDataInfo.bytes), 'x-amz-meta-artifact-kind': 'analysis-data' })
      for (const item of browserChunks) {
        const chunkKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}/frame-chunks/${item.chunk.chunkIndex}.fb`
        await objectStore.client.putObject(objectStore.bucket, chunkKey, item.bytes, item.bytes.byteLength, { 'Content-Type': 'application/vnd.volleyball.analysis-frame-chunk+flatbuffers;version=1', 'x-amz-meta-sha256': item.sha256, 'x-amz-meta-byte-length': String(item.bytes.byteLength), 'x-amz-meta-artifact-kind': 'analysis-frame-chunk' })
      }
      const producer = isRecord(result.producer) ? result.producer : {}
      const response = { schema_version: '1.0.0', accepted: true, callback_id: metadata.callback_id, analysis_id: result.analysis_id }
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AiJob" WHERE id = ${aiJobId}::uuid FOR UPDATE`
        const current = await tx.aiJob.findUnique({ where: { id: aiJobId }, select: { status: true, submission: { select: { rally: { select: { voidedAt: true } } } } } })
        if (!current || current.status === JobStatus.CANCELLED || current.status === JobStatus.SUPERSEDED || current.submission.rally.voidedAt) throw new Error('AI_JOB_NOT_ACTIVE')
        const analysisDataSchemaVersion = String(result.schema_version)
        const requestPayloadRoot = isRecord(job.requestPayload) ? job.requestPayload : {}
        const requestAnalysisPlan = isRecord(requestPayloadRoot.analysis_plan) ? requestPayloadRoot.analysis_plan : {}
        const preserveManualCorrections = requestAnalysisPlan.preserve_manual_corrections !== false
        const predecessorSubmissionId = job.submission.supersedesSubmissionId
        const priorRun = preserveManualCorrections ? await tx.analysisRun.findFirst({
          where: {
            submissionId: predecessorSubmissionId
              ? { in: [job.submissionId, predecessorSubmissionId] }
              : job.submissionId,
            status: JobStatus.COMPLETED,
          },
          orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
          include: {
            ballCorrections: true,
            playerBBoxCorrections: true,
            actionCorrections: true,
            contactActorCorrections: true,
            contactTimeCorrections: true,
            contactEdits: true,
            tracks: { include: { identityAssignments: true } },
          },
        }) : null
        const rawAnalysisData = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.ANALYSIS_DATA, bucket: objectStore.bucket, objectKey: analysisDataKey, contentType: 'application/vnd.volleyball.analysis-data+flatbuffers;version=1', byteLength: BigInt(analysisDataInfo!.bytes), sha256: analysisDataInfo!.sha256, internalSchemaVersion: analysisDataSchemaVersion, state: ArtifactState.READY, readyAt: new Date() } })
        const analysisRun = await tx.analysisRun.create({ data: { aiJobId, submissionId: job.submissionId, analysisId: String(result.analysis_id), analysisVersion: String(result.analysis_version), analysisDataSchemaVersion, inputClipSha256: String(result.input_clip_sha256), producerName: String(producer.name), producerBuildId: String(producer.build_id), producerSdkVersion: typeof producer.sdk_version === 'string' ? producer.sdk_version : null, status: JobStatus.COMPLETED, rawAnalysisDataAssetId: rawAnalysisData.id, summary: json(result.summary), activatedAt: new Date(), ...(priorRun ? { reviewRevision: priorRun.reviewRevision, reviewStatus: AnalysisReviewStatus.EDITING } : {}) } })
        await tx.analysisDataManifest.create({ data: { analysisRunId: analysisRun.id, schemaVersion: '1.0.0', analysisDataVersion: '1', videoWidth: analysisData.videoWidth, videoHeight: analysisData.videoHeight, fpsNum: analysisData.fpsNum, fpsDen: analysisData.fpsDen, totalFrames: analysisData.totalFrames, chunkFrameCount: analysisFrameChunkCount, actionTaxonomy: analysisData.actionTaxonomyId ? json({ id: analysisData.actionTaxonomyId, version: analysisData.actionTaxonomyVersion, labels: analysisData.actionLabels }) : Prisma.JsonNull } })
        for (const item of browserChunks) {
          const chunkKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}/frame-chunks/${item.chunk.chunkIndex}.fb`
          const asset = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.ANALYSIS_FRAME_CHUNK, bucket: objectStore.bucket, objectKey: chunkKey, contentType: 'application/vnd.volleyball.analysis-frame-chunk+flatbuffers;version=1', byteLength: BigInt(item.bytes.byteLength), sha256: item.sha256, internalSchemaVersion: '1.0.0', state: ArtifactState.READY, readyAt: new Date() } })
          await tx.analysisFrameChunk.create({ data: { analysisRunId: analysisRun.id, chunkIndex: item.chunk.chunkIndex, startFrameIndex: item.chunk.startFrameIndex, frameCount: item.chunk.frameCount, assetId: asset.id, byteLength: BigInt(item.bytes.byteLength), sha256: item.sha256 } })
          await tx.analysisArtifact.create({ data: { analysisRunId: analysisRun.id, kind: MediaAssetKind.ANALYSIS_FRAME_CHUNK, assetId: asset.id } })
        }
        const tracks = records(result.tracks)
        if (tracks.length) await tx.analysisTrack.createMany({ data: tracks.map(track => ({ analysisRunId: analysisRun.id, trackId: Number(track.track_id), courtSide: String(track.court_side).toUpperCase() as TrackCourtSide, firstFrame: BigInt(String(track.first_frame_index)), lastFrame: BigInt(String(track.last_frame_index)), meanConfidence: typeof track.mean_confidence === 'number' ? track.mean_confidence : null, metadata: track.metadata === undefined ? Prisma.JsonNull : json(track.metadata) })) })
        await ingestFixedRosterReid(tx, {
          analysisRunId: analysisRun.id,
          matchId: job.submission.rally.matchId,
          leftTeamId: job.submission.leftTeamId,
          rightTeamId: job.submission.rightTeamId,
          setNumber: job.submission.rally.set.setNumber,
          rallyOrdinal: job.submission.rally.ordinal,
          featureBank: reidFeatureBank,
        })
        const mappingByPoint = new Map(job.clipJob.keyPointMappings.map(mapping => [mapping.submissionKeyPointId, mapping]))
        const requestPayload = requestPayloadRoot
        const requestClip = isRecord(requestPayload.clip) ? requestPayload.clip : {}
        const requestVideo = isRecord(requestClip.video) ? requestClip.video : {}
        const requestFps = isRecord(requestVideo.fps) ? requestVideo.fps : {}
        const fpsNum = BigInt(String(requestFps.num))
        const fpsDen = BigInt(String(requestFps.den))
        for (const event of records(result.contact_events)) {
          const keyPointId = String(event.key_point_id)
          const generated = event.anchor_origin === 'ai_detected'
          const claimedSourceId = typeof event.source_key_point_id === 'string' ? event.source_key_point_id : keyPointId
          const mapping = generated ? undefined : mappingByPoint.get(claimedSourceId)
          const ball = isRecord(event.ball) ? event.ball : {}
          if (!mapping && !generated) throw new Error('AnalysisData human contact has no immutable clip mapping')
          const anchorFrameIndex = BigInt(String(event.anchor_frame_index))
          const anchorTimeUs = mapping?.clipTimeUs ?? anchorFrameIndex * 1_000_000n * fpsDen / fpsNum
          const eventExtensions = isRecord(event.extensions) ? event.extensions : {}
          const detectionEvidence = isRecord(eventExtensions.detection) ? eventExtensions.detection : null
          await tx.contactEvent.create({ data: { analysisRunId: analysisRun.id, keyPointId, sourceKeyPointId: mapping ? claimedSourceId : null, anchorOrigin: generated ? 'ai_detected' : 'human_anchor', detectionConfidence: typeof event.detection_confidence === 'number' ? event.detection_confidence : null, detectionEvidence: detectionEvidence ? json(detectionEvidence) : Prisma.JsonNull, sequenceIndex: Number(event.sequence_index), anchorFrameIndex, resolvedFrameIndex: event.resolved_frame_index == null ? null : BigInt(String(event.resolved_frame_index)), anchorTimeUs, markerKind: String(event.marker_kind).toUpperCase() as MarkerKind, isTerminal: Boolean(event.is_terminal), associationState: String(event.association_state).toUpperCase() as AssociationState, ballState: String(ball.state).toUpperCase() as BallObservationState, ballFrameIndex: ball.sample_frame_index == null ? null : BigInt(String(ball.sample_frame_index)), ballFrameX: isRecord(ball.frame_pos) && typeof ball.frame_pos.x === 'number' ? ball.frame_pos.x : null, ballFrameY: isRecord(ball.frame_pos) && typeof ball.frame_pos.y === 'number' ? ball.frame_pos.y : null, qualityFlags: Array.isArray(event.quality_flags) ? event.quality_flags.map(String) : [] } })
          const actors = records(event.actors)
          if (actors.length) await tx.contactEventActor.createMany({ data: actors.map(actor => { const bbox = isRecord(actor.frame_bbox) ? actor.frame_bbox : {}; const foot = isRecord(actor.frame_foot_pos) ? actor.frame_foot_pos : {}; const court = isRecord(actor.court_pos) ? actor.court_pos : {}; return { analysisRunId: analysisRun.id, keyPointId, trackId: Number(actor.track_id), observationFrameIndex: BigInt(String(actor.observation_frame_index)), associationConfidence: typeof actor.association_confidence === 'number' ? actor.association_confidence : null, frameX1: typeof bbox.x1 === 'number' ? bbox.x1 : null, frameY1: typeof bbox.y1 === 'number' ? bbox.y1 : null, frameX2: typeof bbox.x2 === 'number' ? bbox.x2 : null, frameY2: typeof bbox.y2 === 'number' ? bbox.y2 : null, frameFootX: typeof foot.x === 'number' ? foot.x : null, frameFootY: typeof foot.y === 'number' ? foot.y : null, courtX: typeof court.x === 'number' ? court.x : null, courtY: typeof court.y === 'number' ? court.y : null, action: actor.action === undefined ? Prisma.JsonNull : json(actor.action) } }) })
          const candidates = records(event.actor_candidates)
          if (candidates.length) await tx.contactEventCandidate.createMany({ data: candidates.map(candidate => ({ analysisRunId: analysisRun.id, keyPointId, trackId: Number(candidate.track_id), rank: Number(candidate.rank), confidence: typeof candidate.confidence === 'number' ? candidate.confidence : null })) })
          const positions = records(event.representative_court_positions)
          if (positions.length) await tx.contactEventPosition.createMany({ data: positions.map((position, positionIndex) => { const court = isRecord(position.court_pos) ? position.court_pos : {}; return { analysisRunId: analysisRun.id, keyPointId, positionIndex, trackId: typeof position.track_id === 'number' ? position.track_id : null, basis: String(position.basis), courtX: Number(court.x), courtY: Number(court.y), confidence: typeof position.confidence === 'number' ? position.confidence : null } }) })
        }
        for (const path of records(result.path_segments)) {
          const segment = await tx.ballPathSegment.create({ data: { analysisRunId: analysisRun.id, sequenceIndex: Number(path.sequence_index), startKeyPointId: String(path.start_key_point_id), endKeyPointId: String(path.end_key_point_id), startFrameIndex: path.start_frame_index === undefined ? null : BigInt(String(path.start_frame_index)), endFrameIndex: path.end_frame_index === undefined ? null : BigInt(String(path.end_frame_index)), renderState: String(path.render_state).toUpperCase() as SegmentRenderState, isTerminalSegment: Boolean(path.is_terminal_segment), qualityFlags: Array.isArray(path.quality_flags) ? path.quality_flags.map(String) : [] } })
          const endpoints = [[SegmentEndpoint.START, records(path.start_court_positions)], [SegmentEndpoint.END, records(path.end_court_positions)]] as const
          for (const [endpoint, positions] of endpoints) if (positions.length) await tx.ballPathSegmentPosition.createMany({ data: positions.map((position, positionIndex) => { const court = isRecord(position.court_pos) ? position.court_pos : {}; return { segmentId: segment.id, endpoint, positionIndex, trackId: typeof position.track_id === 'number' ? position.track_id : null, basis: String(position.basis), courtX: Number(court.x), courtY: Number(court.y), confidence: typeof position.confidence === 'number' ? position.confidence : null } }) })
        }
        if (priorRun) {
          const validKeyPointIds = new Set(records(result.contact_events).map(event => String(event.key_point_id)))
          const validTrackIds = new Set(tracks.map(track => Number(track.track_id)))
          if (priorRun.ballCorrections.length) await tx.analysisBallCorrection.createMany({ data: priorRun.ballCorrections.map(item => ({ analysisRunId: analysisRun.id, frameIndex: item.frameIndex, frameX: item.frameX, frameY: item.frameY, visible: item.visible, revision: item.revision, updatedByUserId: item.updatedByUserId })) })
          const bboxCorrections = priorRun.playerBBoxCorrections.filter(item => validTrackIds.has(item.trackId))
          if (bboxCorrections.length) await tx.analysisPlayerBBoxCorrection.createMany({ data: bboxCorrections.map(item => ({ analysisRunId: analysisRun.id, frameIndex: item.frameIndex, trackId: item.trackId, frameX1: item.frameX1, frameY1: item.frameY1, frameX2: item.frameX2, frameY2: item.frameY2, revision: item.revision, updatedByUserId: item.updatedByUserId })) })
          const actionCorrections = priorRun.actionCorrections.filter(item => validTrackIds.has(item.trackId))
          if (actionCorrections.length) await tx.analysisActionCorrection.createMany({ data: actionCorrections.map(item => ({ analysisRunId: analysisRun.id, frameIndex: item.frameIndex, trackId: item.trackId, action: item.action, revision: item.revision, updatedByUserId: item.updatedByUserId })) })
          const actorCorrections = priorRun.contactActorCorrections.filter(item => validKeyPointIds.has(item.keyPointId) && (item.trackId === null || validTrackIds.has(item.trackId)))
          if (actorCorrections.length) await tx.analysisContactActorCorrection.createMany({ data: actorCorrections.map(item => ({ analysisRunId: analysisRun.id, keyPointId: item.keyPointId, trackId: item.trackId, revision: item.revision, updatedByUserId: item.updatedByUserId })) })
          const timeCorrections = priorRun.contactTimeCorrections.filter(item => validKeyPointIds.has(item.keyPointId))
          if (timeCorrections.length) await tx.analysisContactTimeCorrection.createMany({ data: timeCorrections.map(item => ({ analysisRunId: analysisRun.id, keyPointId: item.keyPointId, frameIndex: item.frameIndex, revision: item.revision, updatedByUserId: item.updatedByUserId })) })
          if (priorRun.contactEdits.length) await tx.analysisContactEdit.createMany({ data: priorRun.contactEdits.map(item => ({ analysisRunId: analysisRun.id, contactId: item.contactId, baseKeyPointId: item.baseKeyPointId, frameIndex: item.frameIndex, trackId: item.trackId !== null && validTrackIds.has(item.trackId) ? item.trackId : null, deleted: item.deleted, revision: item.revision, updatedByUserId: item.updatedByUserId })) })
          const identityAssignments = priorRun.tracks.flatMap(track => track.identityAssignments).filter(item => validTrackIds.has(item.trackId))
          if (identityAssignments.length) await tx.trackIdentityAssignment.createMany({ data: identityAssignments.map(item => ({ analysisRunId: analysisRun.id, trackId: item.trackId, rosterEntryId: item.rosterEntryId, source: item.source, assignedByUserId: item.assignedByUserId, confidence: item.confidence, reidIdentityId: item.reidIdentityId, reidBindingId: item.reidBindingId, identityRevision: item.identityRevision })) })
          await tx.analysisRun.update({ where: { id: priorRun.id }, data: { status: JobStatus.SUPERSEDED, supersededAt: new Date() } })
        }
        await tx.aiCallbackReceipt.create({ data: { aiJobId, callbackId: String(metadata.callback_id), kind: CallbackKind.COMPLETED, requestContentType: contentType, requestMetadata: json(metadata), payloadHash, responseStatus: 200, responseBody: json(response) } })
        await tx.aiJob.update({ where: { id: aiJobId }, data: { status: JobStatus.COMPLETED, progress: 1, stage: 'completed', lastCallbackAt: new Date(), completedAt: new Date(), leasedUntil: null } })
        if (job.submission.supersedesSubmissionId) {
          await Promise.all([
            tx.clipJob.updateMany({ where: { submissionId: job.submission.supersedesSubmissionId }, data: { status: JobStatus.SUPERSEDED, leasedUntil: null } }),
            tx.aiJob.updateMany({ where: { submissionId: job.submission.supersedesSubmissionId }, data: { status: JobStatus.SUPERSEDED, leasedUntil: null } }),
            tx.analysisRun.updateMany({ where: { submissionId: job.submission.supersedesSubmissionId }, data: { status: JobStatus.SUPERSEDED } }),
          ])
        }
        await tx.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.COMPLETED } })
      })
      await publishCallbackProgress(job, 'completed', {
        progress: 1,
        stage: 'completed',
        analysisId: String(result.analysis_id),
        analysisDataVersion: '1',
      })
      await notifyCoach(job.submission.rally.matchId)
      return reply.send(response)
    }
    catch (error) {
      if (error instanceof Error && (error.message === 'PAYLOAD_TOO_LARGE' || ('code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE'))) return reject(reply, 413, 'PAYLOAD_TOO_LARGE', 'Callback payload exceeds the configured limit')
      if (error instanceof Error && error.message === 'AI_JOB_NOT_ACTIVE') return reject(reply, 409, 'JOB_NOT_ACTIVE', 'AI job was cancelled or superseded')
      if (error instanceof FixedRosterReidError) {
        request.log.warn({ err: error }, 'Fixed roster ReID callback rejected')
        return reject(reply, 422, 'INVALID_REID_FEATURE_BANK', error.message)
      }
      request.log.error({ err: error }, 'AI callback ingest failed')
      return reject(reply, 503, 'CALLBACK_INGEST_FAILED', 'Callback could not be ingested')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function publishCallbackProgress(
    job: NonNullable<Awaited<ReturnType<typeof loadJob>>>,
    processingStatus: 'ai_processing' | 'completed' | 'failed',
    details: {
      progress: number | null
      stage: string | null
      analysisId?: string
      analysisDataVersion?: string
      error?: Record<string, unknown>
    },
  ) {
    if (!dependencies.progress) return
    try {
      const provider = job.providerInstanceId
        ? await db.aiProviderInstance.findUnique({
            where: { id: job.providerInstanceId },
            select: { instanceKey: true, providerBuildId: true },
          })
        : null
      await dependencies.progress.publish({
        schema_version: '2.0.0',
        type: 'rally_processing_update',
        room_id: `match:${job.submission.rally.matchId}:capture:${job.submission.rally.program.captureSessionId}`,
        rally_id: job.submission.rally.id,
        submission_id: job.submission.id,
        processing_status: processingStatus,
        ai_job_id: job.id,
        worker_instance_key: provider?.instanceKey ?? null,
        provider_build_id: provider?.providerBuildId ?? null,
        progress: details.progress,
        stage: details.stage,
        updated_at: new Date().toISOString(),
        analysis_id: details.analysisId ?? null,
        analysis_data_version: details.analysisDataVersion ?? null,
        error: details.error ?? null,
      })
    }
    catch (error) {
      app.log.warn({ error, aiJobId: job.id }, 'AI callback progress publication failed')
    }
  }
}

export const aiCallbackRoutes = aiCallbackRoutesWithDependencies()
