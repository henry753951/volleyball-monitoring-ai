import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { chunkProviderOverlay, encodeBrowserOverlayChunk, parseProviderOverlaySequence, type ProviderOverlaySequence } from '@volleyball-monitoring/contracts'
import multipart from '@fastify/multipart'
import { db } from '@volleyball-monitoring/db'
import { ArtifactState, AssociationState, BallObservationState, CallbackKind, JobStatus, MarkerKind, MediaAssetKind, Prisma, ProcessingStatus, SegmentEndpoint, SegmentRenderState, TrackCourtSide } from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { Client } from 'minio'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addFormat('uuid', uuid)
const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const callbackSchema = JSON.parse(await readFile(new URL('callback.schema.json', contractsRoot), 'utf8'))
const resultSchema = JSON.parse(await readFile(new URL('result.schema.json', contractsRoot), 'utf8'))
const validateCallback = ajv.compile(callbackSchema)
const validateResult = ajv.compile(resultSchema)
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

async function readBounded(stream: NodeJS.ReadableStream, maximum: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maximum) throw new Error('PAYLOAD_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
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
  if (!Array.isArray(events) || events.length !== job.submission.keyPoints.length) return 'contact event count does not match immutable key points'
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const point = job.submission.keyPoints[index]
    if (!isRecord(event) || !point || event.key_point_id !== point.id || event.sequence_index !== point.sequenceIndex || event.marker_kind !== point.markerKind.toLowerCase() || event.is_terminal !== point.isTerminal) return 'contact event passthrough/order mismatch'
  }
  return null
}

function overlayInvariantError(overlay: ProviderOverlaySequence, result: Record<string, unknown>, job: NonNullable<Awaited<ReturnType<typeof loadJob>>>) {
  const expected = {
    aiJobId: job.id,
    rallySubmissionId: job.submissionId,
    rallyId: job.submission.rallyId,
    matchId: job.submission.rally.matchId,
    annotationRevision: job.submission.annotationRevision.toString(),
    clipAssetId: job.clipJob.clipAssetId ?? '',
    analysisId: String(result.analysis_id),
    analysisVersion: String(result.analysis_version),
  }
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === 'annotationRevision' ? overlay.annotationRevision.toString() : overlay[key as keyof ProviderOverlaySequence]
    if (actual !== value) return `overlay ${key} passthrough mismatch`
  }
  const payload = isRecord(job.requestPayload) ? job.requestPayload : null
  const clip = payload && isRecord(payload.clip) ? payload.clip : null
  const video = clip && isRecord(clip.video) ? clip.video : null
  const fps = video && isRecord(video.fps) ? video.fps : null
  if (!video || !fps) return 'AI request video metadata is unavailable'
  if (overlay.videoWidth !== video.width || overlay.videoHeight !== video.height || overlay.fpsNum !== fps.num || overlay.fpsDen !== fps.den || overlay.totalFrames.toString() !== video.total_frames) return 'overlay video metadata mismatch'
  return null
}

function loadJob(aiJobId: string) {
  return db.aiJob.findUnique({ where: { id: aiJobId }, include: { submission: { include: { rally: true, keyPoints: { orderBy: { sequenceIndex: 'asc' } } } }, clipJob: { include: { clipAsset: true, keyPointMappings: true } } } })
}

export const aiCallbackRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, { limits: { fields: 4, files: 2, fileSize: 512 * 1024 * 1024, parts: 6 } })
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
      let analysisBytes: Buffer | null = null
      let overlayPath: string | null = null
      let overlayInfo: { bytes: number; sha256: string } | null = null
      const contentType = request.headers['content-type'] ?? ''
      if (request.isMultipart()) {
        for await (const part of request.parts()) {
          if (part.type === 'field' && part.fieldname === 'metadata') metadata = typeof part.value === 'string' ? JSON.parse(part.value) : part.value
          else if (part.type === 'file' && part.fieldname === 'analysis') analysisBytes = await readBounded(part.file, 10 * 1024 * 1024)
          else if (part.type === 'file' && part.fieldname === 'overlay') { overlayPath = join(directory, 'overlay.fb'); overlayInfo = await writeBounded(part.file, overlayPath, 512 * 1024 * 1024) }
          else if (part.type === 'file') part.file.resume()
        }
      } else {
        metadata = request.body
      }
      if (!validateCallback(metadata) || !isRecord(metadata) || metadata.ai_job_id !== aiJobId) return reject(reply, 422, 'INVALID_CALLBACK', 'Callback metadata failed schema or job validation')
      const kind = String(metadata.kind)
      if (kind === 'completed' && (!analysisBytes || !overlayPath || !overlayInfo)) return reject(reply, 422, 'INVALID_CALLBACK', 'Completed callback requires analysis and overlay parts')

      const analysisHash = analysisBytes ? sha256(analysisBytes) : null
      const payloadHash = sha256(`${JSON.stringify(metadata)}:${analysisHash ?? ''}:${overlayInfo?.sha256 ?? ''}`)
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
        return reply.send(response)
      }

      if (!analysisBytes || !overlayPath || !overlayInfo || analysisHash !== String(metadata.analysis_sha256).toLowerCase() || overlayInfo.sha256 !== String(metadata.overlay_sha256).toLowerCase() || analysisBytes.byteLength !== Number(metadata.analysis_bytes) || overlayInfo.bytes !== Number(metadata.overlay_bytes)) return reject(reply, 422, 'CHECKSUM_MISMATCH', 'Completed callback artifact checksum or length mismatch')
      const overlayBytes = await readFile(overlayPath)
      if (overlayInfo.bytes < 16 || overlayBytes.subarray(4, 8).toString('ascii') !== 'VOV1') return reject(reply, 415, 'INVALID_OVERLAY', 'Overlay is not a VOV1 FlatBuffer')
      const result = JSON.parse(analysisBytes.toString('utf8')) as unknown
      if (!validateResult(result) || !isRecord(result)) return reject(reply, 422, 'INVALID_ANALYSIS', 'Analysis result failed schema validation')
      const invariant = invariantError(result, job)
      if (invariant) return reject(reply, 409, 'PASSTHROUGH_MISMATCH', invariant)
      let overlaySequence: ProviderOverlaySequence
      try { overlaySequence = parseProviderOverlaySequence(overlayBytes) }
      catch { return reject(reply, 415, 'INVALID_OVERLAY', 'Overlay FlatBuffer failed schema or column validation') }
      const overlayInvariant = overlayInvariantError(overlaySequence, result, job)
      if (overlayInvariant) return reject(reply, 409, 'PASSTHROUGH_MISMATCH', overlayInvariant)
      const overlayChunkFrameCount = Number(process.env.OVERLAY_CHUNK_FRAME_COUNT ?? 120)
      if (!Number.isSafeInteger(overlayChunkFrameCount) || overlayChunkFrameCount < 1 || overlayChunkFrameCount > 3_600) return reject(reply, 503, 'OVERLAY_CONFIGURATION_INVALID', 'Overlay chunk configuration is invalid')
      const browserChunks = chunkProviderOverlay(overlaySequence, overlayChunkFrameCount).map((chunk) => {
        const bytes = Buffer.from(encodeBrowserOverlayChunk(chunk))
        return { chunk, bytes, sha256: sha256(bytes) }
      })

      const objectStore = storage()
      const analysisKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}.json`
      const overlayKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}.fb`
      await objectStore.client.putObject(objectStore.bucket, analysisKey, analysisBytes, analysisBytes.byteLength, { 'Content-Type': 'application/json', 'x-amz-meta-sha256': analysisHash, 'x-amz-meta-byte-length': String(analysisBytes.byteLength), 'x-amz-meta-artifact-kind': 'analysis-json' })
      await objectStore.client.fPutObject(objectStore.bucket, overlayKey, overlayPath, { 'Content-Type': 'application/vnd.volleyball.overlay+flatbuffers;version=1', 'x-amz-meta-sha256': overlayInfo.sha256, 'x-amz-meta-byte-length': String(overlayInfo.bytes), 'x-amz-meta-artifact-kind': 'overlay-sequence' })
      for (const item of browserChunks) {
        const chunkKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}/chunks/${item.chunk.chunkIndex}.fb`
        await objectStore.client.putObject(objectStore.bucket, chunkKey, item.bytes, item.bytes.byteLength, { 'Content-Type': 'application/vnd.volleyball.overlay-chunk+flatbuffers;version=1', 'x-amz-meta-sha256': item.sha256, 'x-amz-meta-byte-length': String(item.bytes.byteLength), 'x-amz-meta-artifact-kind': 'overlay-chunk' })
      }
      const producer = isRecord(result.producer) ? result.producer : {}
      const response = { schema_version: '1.0.0', accepted: true, callback_id: metadata.callback_id, analysis_id: result.analysis_id }
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AiJob" WHERE id = ${aiJobId}::uuid FOR UPDATE`
        const current = await tx.aiJob.findUnique({ where: { id: aiJobId }, select: { status: true, submission: { select: { rally: { select: { voidedAt: true } } } } } })
        if (!current || current.status === JobStatus.CANCELLED || current.status === JobStatus.SUPERSEDED || current.submission.rally.voidedAt) throw new Error('AI_JOB_NOT_ACTIVE')
        const rawAnalysis = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.ANALYSIS_JSON, bucket: objectStore.bucket, objectKey: analysisKey, contentType: 'application/json', byteLength: BigInt(analysisBytes!.byteLength), sha256: analysisHash!, internalSchemaVersion: '1.0.0', state: ArtifactState.READY, readyAt: new Date() } })
        const rawOverlay = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.OVERLAY_SEQUENCE, bucket: objectStore.bucket, objectKey: overlayKey, contentType: 'application/vnd.volleyball.overlay+flatbuffers;version=1', byteLength: BigInt(overlayInfo!.bytes), sha256: overlayInfo!.sha256, internalSchemaVersion: '1.0.0', state: ArtifactState.READY, readyAt: new Date() } })
        const analysisRun = await tx.analysisRun.create({ data: { aiJobId, submissionId: job.submissionId, analysisId: String(result.analysis_id), analysisVersion: String(result.analysis_version), resultSchemaVersion: '1.0.0', overlaySchemaVersion: 'flatbuffers_v1', inputClipSha256: String(result.input_clip_sha256), producerName: String(producer.name), producerBuildId: String(producer.build_id), producerSdkVersion: typeof producer.sdk_version === 'string' ? producer.sdk_version : null, status: JobStatus.COMPLETED, rawAnalysisAssetId: rawAnalysis.id, rawOverlayAssetId: rawOverlay.id, summary: json(result.summary), activatedAt: new Date() } })
        await tx.overlayManifest.create({ data: { analysisRunId: analysisRun.id, schemaVersion: '1.0.0', overlayVersion: '1', videoWidth: overlaySequence.videoWidth, videoHeight: overlaySequence.videoHeight, fpsNum: overlaySequence.fpsNum, fpsDen: overlaySequence.fpsDen, totalFrames: overlaySequence.totalFrames, chunkFrameCount: overlayChunkFrameCount, actionTaxonomy: overlaySequence.actionTaxonomyId ? json({ id: overlaySequence.actionTaxonomyId, version: overlaySequence.actionTaxonomyVersion, labels: overlaySequence.actionLabels }) : Prisma.JsonNull } })
        for (const item of browserChunks) {
          const chunkKey = `analysis/${job.submissionId}/${aiJobId}/${metadata.callback_id}/chunks/${item.chunk.chunkIndex}.fb`
          const asset = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.OVERLAY_CHUNK, bucket: objectStore.bucket, objectKey: chunkKey, contentType: 'application/vnd.volleyball.overlay-chunk+flatbuffers;version=1', byteLength: BigInt(item.bytes.byteLength), sha256: item.sha256, internalSchemaVersion: '1.0.0', state: ArtifactState.READY, readyAt: new Date() } })
          await tx.overlayChunk.create({ data: { analysisRunId: analysisRun.id, chunkIndex: item.chunk.chunkIndex, startFrameIndex: item.chunk.startFrameIndex, frameCount: item.chunk.frameCount, assetId: asset.id, byteLength: BigInt(item.bytes.byteLength), sha256: item.sha256 } })
          await tx.analysisArtifact.create({ data: { analysisRunId: analysisRun.id, kind: MediaAssetKind.OVERLAY_CHUNK, assetId: asset.id } })
        }
        const tracks = records(result.tracks)
        if (tracks.length) await tx.analysisTrack.createMany({ data: tracks.map(track => ({ analysisRunId: analysisRun.id, trackId: Number(track.track_id), courtSide: String(track.court_side).toUpperCase() as TrackCourtSide, firstFrame: BigInt(String(track.first_frame_index)), lastFrame: BigInt(String(track.last_frame_index)), meanConfidence: typeof track.mean_confidence === 'number' ? track.mean_confidence : null, metadata: track.metadata === undefined ? Prisma.JsonNull : json(track.metadata) })) })
        const mappingByPoint = new Map(job.clipJob.keyPointMappings.map(mapping => [mapping.submissionKeyPointId, mapping]))
        for (const event of records(result.contact_events)) {
          const keyPointId = String(event.key_point_id)
          const mapping = mappingByPoint.get(keyPointId)
          const ball = isRecord(event.ball) ? event.ball : {}
          if (!mapping) throw new Error('analysis contact event has no immutable clip mapping')
          await tx.contactEvent.create({ data: { analysisRunId: analysisRun.id, keyPointId, sequenceIndex: Number(event.sequence_index), anchorFrameIndex: BigInt(String(event.anchor_frame_index)), resolvedFrameIndex: event.resolved_frame_index === undefined ? null : BigInt(String(event.resolved_frame_index)), anchorTimeUs: mapping.clipTimeUs, markerKind: String(event.marker_kind).toUpperCase() as MarkerKind, isTerminal: Boolean(event.is_terminal), associationState: String(event.association_state).toUpperCase() as AssociationState, ballState: String(ball.state).toUpperCase() as BallObservationState, ballFrameIndex: ball.sample_frame_index === undefined ? null : BigInt(String(ball.sample_frame_index)), ballFrameX: isRecord(ball.frame_pos) && typeof ball.frame_pos.x === 'number' ? ball.frame_pos.x : null, ballFrameY: isRecord(ball.frame_pos) && typeof ball.frame_pos.y === 'number' ? ball.frame_pos.y : null, qualityFlags: Array.isArray(event.quality_flags) ? event.quality_flags.map(String) : [] } })
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
        await tx.aiCallbackReceipt.create({ data: { aiJobId, callbackId: String(metadata.callback_id), kind: CallbackKind.COMPLETED, requestContentType: contentType, requestMetadata: json(metadata), payloadHash, responseStatus: 200, responseBody: json(response) } })
        await tx.aiJob.update({ where: { id: aiJobId }, data: { status: JobStatus.COMPLETED, progress: 1, stage: 'completed', lastCallbackAt: new Date(), completedAt: new Date(), leasedUntil: null } })
        await tx.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.COMPLETED } })
      })
      return reply.send(response)
    }
    catch (error) {
      if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') return reject(reply, 413, 'PAYLOAD_TOO_LARGE', 'Callback payload exceeds the configured limit')
      if (error instanceof Error && error.message === 'AI_JOB_NOT_ACTIVE') return reject(reply, 409, 'JOB_NOT_ACTIVE', 'AI job was cancelled or superseded')
      request.log.error({ error }, 'AI callback ingest failed')
      return reject(reply, 503, 'CALLBACK_INGEST_FAILED', 'Callback could not be ingested')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
