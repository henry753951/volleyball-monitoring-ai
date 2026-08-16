import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  chunkAnalysisData,
  encodeAnalysisFrameChunk,
  parseAnalysisData,
  type AnalysisData,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import type {
  AssociationState,
  BallObservationState,
  MarkerKind,
  SegmentRenderState,
  TrackCourtSide,
} from '@volleyball-monitoring/db/client'
import {
  AnalysisReviewStatus,
  ArtifactState,
  JobStatus,
  MediaAssetKind,
  Prisma,
  ProcessingStatus,
  ProviderArtifactDirection,
  ProviderWorkKind,
  SegmentEndpoint,
} from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'
import { createWorkflowMinio, readVerifiedObject, type WorkflowMinio } from '../workflow/minio.js'

const MATERIALIZATION_LEASE_MS = 5 * 60_000
const ANALYSIS_DATA_MAX_BYTES = 512n * 1024n * 1024n
const JSON_ARTIFACT_MAX_BYTES = 16n * 1024n * 1024n
export const SYSTEM_TRACK_METADATA_KEY = '__volleyball_system'
export const OBSERVED_FRAME_RANGES_KEY = 'observed_frame_ranges_v1'
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : [])

export type ObservedFrameRange = { start: string; end: string }

/**
 * Build exact per-track frame presence from the canonical frame columns.
 *
 * AnalysisTrack.firstFrame/lastFrame are only bounds and are not sufficient
 * for identity-conflict decisions: a tracker can keep a local id alive across
 * missed detections. These ranges are persisted as system metadata so the
 * coach assignment path can replace an assignment only when both local ids
 * are actually present in at least one frame.
 */
export function buildObservedFrameRanges(
  analysisData: Pick<AnalysisData, 'frameOffsets' | 'trackIds'>,
): Map<number, ObservedFrameRange[]> {
  const ranges = new Map<number, ObservedFrameRange[]>()
  const lastFrameByTrack = new Map<number, number>()
  for (let frameIndex = 0; frameIndex < analysisData.frameOffsets.length - 1; frameIndex += 1) {
    const start = analysisData.frameOffsets[frameIndex]!
    const end = analysisData.frameOffsets[frameIndex + 1]!
    const present = new Set<number>()
    for (let detectionIndex = start; detectionIndex < end; detectionIndex += 1) {
      const trackId = analysisData.trackIds[detectionIndex]
      if (trackId === undefined || present.has(trackId)) continue
      present.add(trackId)
      const trackRanges = ranges.get(trackId) ?? []
      const previousFrame = lastFrameByTrack.get(trackId)
      const current = trackRanges.at(-1)
      if (current && previousFrame === frameIndex - 1) current.end = String(frameIndex)
      else trackRanges.push({ start: String(frameIndex), end: String(frameIndex) })
      ranges.set(trackId, trackRanges)
      lastFrameByTrack.set(trackId, frameIndex)
    }
  }
  return ranges
}

function trackMetadataWithObservedFrames(
  metadata: unknown,
  observedFrameRanges: ObservedFrameRange[],
) {
  const providerMetadata = isRecord(metadata) ? metadata : {}
  const systemMetadata = isRecord(providerMetadata[SYSTEM_TRACK_METADATA_KEY])
    ? providerMetadata[SYSTEM_TRACK_METADATA_KEY]
    : {}
  return {
    ...providerMetadata,
    [SYSTEM_TRACK_METADATA_KEY]: {
      ...systemMetadata,
      [OBSERVED_FRAME_RANGES_KEY]: observedFrameRanges,
    },
  }
}

const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const analysisDataDomainSchema = JSON.parse(
  await readFile(new URL('analysis-data-domain.schema.json', contractsRoot), 'utf8'),
)
const validateAnalysisDataDomain = new Ajv2020({ allErrors: true, strict: false }).compile(
  analysisDataDomainSchema,
)

export type ProviderAnalysisOutputArtifact = {
  artifactKind: string
  schemaVersion: string
  sha256: string
  byteLength: bigint
  contentType: string
  mediaAsset: {
    id: string
    bucket: string
    objectKey: string
    byteLength: bigint | null
    sha256: string | null
  }
}

type LoadedAnalysisJob = NonNullable<Awaited<ReturnType<typeof loadAnalysisJob>>>

function findPriorRun(
  tx: Prisma.TransactionClient,
  submissionId: string,
  predecessorSubmissionId: string | null,
) {
  return tx.analysisRun.findFirst({
    where: {
      submissionId: predecessorSubmissionId
        ? { in: [submissionId, predecessorSubmissionId] }
        : submissionId,
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
    },
  })
}

type PriorRun = NonNullable<Awaited<ReturnType<typeof findPriorRun>>>

export class ProviderAnalysisMaterializationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ProviderAnalysisMaterializationError'
  }
}

function loadAnalysisJob(database: PrismaClient, aiJobId: string) {
  return database.aiJob.findUnique({
    where: { id: aiJobId },
    include: {
      submission: {
        include: {
          rally: { include: { program: true, set: true } },
          keyPoints: { orderBy: { sequenceIndex: 'asc' } },
        },
      },
      clipJob: { include: { clipAsset: true, keyPointMappings: true } },
    },
  })
}

function linkedAiJobId(payload: Prisma.JsonValue): string | null {
  return isRecord(payload) && typeof payload.ai_job_id === 'string' ? payload.ai_job_id : null
}

function exactlyOneArtifact(
  artifacts: ProviderAnalysisOutputArtifact[],
  kind: string,
): ProviderAnalysisOutputArtifact {
  const found = artifacts.filter(artifact => artifact.artifactKind === kind)
  if (found.length !== 1)
    throw new ProviderAnalysisMaterializationError(
      `provider analysis requires exactly one ${kind} artifact`,
      false,
    )
  return found[0]!
}

function passthroughError(result: Record<string, unknown>, job: LoadedAnalysisJob) {
  const expected = {
    ai_job_id: job.id,
    rally_submission_id: job.submissionId,
    rally_id: job.submission.rallyId,
    match_id: job.submission.rally.matchId,
    annotation_revision: job.submission.annotationRevision.toString(),
    clip_asset_id: job.clipJob.clipAssetId,
    input_clip_sha256: job.clipJob.clipAsset?.sha256,
  }
  for (const [key, value] of Object.entries(expected))
    if (result[key] !== value) return `${key} passthrough mismatch`

  const inputById = new Map(job.submission.keyPoints.map(point => [point.id, point]))
  const mappingByPoint = new Map(
    job.clipJob.keyPointMappings.map(mapping => [mapping.submissionKeyPointId, mapping]),
  )
  const events = records(result.contact_events)
  const seenIds = new Set<string>()
  const humanIds: string[] = []
  let previousAnchorFrame = -1n
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    const keyPointId = typeof event.key_point_id === 'string' ? event.key_point_id : ''
    if (event.sequence_index !== index || !keyPointId || seenIds.has(keyPointId))
      return 'contact event identity/order mismatch'
    if (
      typeof event.anchor_frame_index !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(event.anchor_frame_index)
    )
      return 'contact event anchor frame is invalid'
    const anchorFrame = BigInt(event.anchor_frame_index)
    if (anchorFrame <= previousAnchorFrame)
      return 'contact event anchor frames must be strictly increasing'
    previousAnchorFrame = anchorFrame
    seenIds.add(keyPointId)
    if (event.anchor_origin === 'human_anchor') {
      const sourceId =
        typeof event.source_key_point_id === 'string' ? event.source_key_point_id : ''
      const point = inputById.get(sourceId)
      const mapping = mappingByPoint.get(sourceId)
      if (
        !point ||
        !mapping ||
        event.marker_kind !== point.markerKind.toLowerCase() ||
        event.is_terminal !== point.isTerminal ||
        event.anchor_frame_index !== mapping.clipFrameIndex.toString()
      )
        return 'human contact event passthrough mismatch'
      humanIds.push(sourceId)
    } else if (
      event.anchor_origin !== 'ai_detected' ||
      event.source_key_point_id !== null ||
      event.marker_kind !== 'contact' ||
      event.is_terminal !== false
    ) {
      return 'AI-detected contact event provenance is invalid'
    }
  }
  if (humanIds.join(':') !== job.submission.keyPoints.map(point => point.id).join(':'))
    return 'human contact events do not preserve immutable key points in order'
  return null
}

function analysisDataError(
  analysisData: AnalysisData,
  domain: Record<string, unknown>,
  job: LoadedAnalysisJob,
) {
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
    const actual =
      key === 'annotationRevision'
        ? analysisData.annotationRevision.toString()
        : analysisData[key as keyof AnalysisData]
    if (actual !== value) return `AnalysisData ${key} passthrough mismatch`
  }
  const payload = isRecord(job.requestPayload) ? job.requestPayload : null
  const clip = payload && isRecord(payload.clip) ? payload.clip : null
  const video = clip && isRecord(clip.video) ? clip.video : null
  const fps = video && isRecord(video.fps) ? video.fps : null
  if (!video || !fps) return 'AI request video metadata is unavailable'
  if (
    analysisData.videoWidth !== video.width ||
    analysisData.videoHeight !== video.height ||
    analysisData.fpsNum !== fps.num ||
    analysisData.fpsDen !== fps.den ||
    analysisData.totalFrames.toString() !== video.total_frames
  )
    return 'AnalysisData video metadata mismatch'
  if (
    analysisData.domainJson.length === 0 ||
    analysisData.inputClipSha256 !== domain.input_clip_sha256
  )
    return 'AnalysisData domain metadata mismatch'
  return null
}

async function verifiedJson(
  storage: WorkflowMinio,
  artifact: ProviderAnalysisOutputArtifact,
): Promise<Record<string, unknown>> {
  const bytes = await readVerifiedObject(
    storage.client,
    artifact.mediaAsset,
    JSON_ARTIFACT_MAX_BYTES,
  )
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ProviderAnalysisMaterializationError(
      `${artifact.artifactKind} is not valid JSON`,
      false,
    )
  }
  if (!isRecord(value))
    throw new ProviderAnalysisMaterializationError(
      `${artifact.artifactKind} root must be an object`,
      false,
    )
  return value
}

function semanticContentSha(value: Record<string, unknown>, kind: string): string {
  const contentSha = value.content_sha256
  if (typeof contentSha !== 'string' || !/^[a-f0-9]{64}$/i.test(contentSha))
    throw new ProviderAnalysisMaterializationError(`${kind} content hash is invalid`, false)
  return contentSha.toLowerCase()
}

function artifactByReference(
  artifacts: ProviderAnalysisOutputArtifact[],
  reference: unknown,
  expectedKind: string,
): ProviderAnalysisOutputArtifact {
  if (
    !isRecord(reference) ||
    reference.kind !== expectedKind ||
    typeof reference.sha256 !== 'string'
  )
    throw new ProviderAnalysisMaterializationError(`${expectedKind} reference is invalid`, false)
  const referenceSha256 = reference.sha256.toLowerCase()
  const artifact = artifacts.find(
    candidate =>
      candidate.artifactKind === expectedKind && candidate.sha256.toLowerCase() === referenceSha256,
  )
  if (!artifact)
    throw new ProviderAnalysisMaterializationError(
      `${expectedKind} reference does not match a callback artifact`,
      false,
    )
  return artifact
}

export async function materializeProviderAnalysis(
  database: PrismaClient,
  storage: WorkflowMinio,
  providerJob: {
    id: string
    requestPayload: Prisma.JsonValue
    artifacts: ProviderAnalysisOutputArtifact[]
  },
): Promise<string> {
  const aiJobId = linkedAiJobId(providerJob.requestPayload)
  if (!aiJobId)
    throw new ProviderAnalysisMaterializationError(
      'analysis provider job has no linked AI job',
      false,
    )
  const job = await loadAnalysisJob(database, aiJobId)
  if (!job) throw new ProviderAnalysisMaterializationError('linked AI job no longer exists', false)
  if (job.submission.rally.voidedAt)
    throw new ProviderAnalysisMaterializationError('linked Rally was voided', false)

  const analysisArtifact = exactlyOneArtifact(providerJob.artifacts, 'ANALYSIS_DATA')
  const analysisBytes = await readVerifiedObject(
    storage.client,
    analysisArtifact.mediaAsset,
    ANALYSIS_DATA_MAX_BYTES,
  )
  if (analysisBytes.byteLength < 16 || analysisBytes.subarray(4, 8).toString('ascii') !== 'VAD1')
    throw new ProviderAnalysisMaterializationError('AnalysisData is not a VAD1 FlatBuffer', false)

  let analysisData: AnalysisData
  try {
    analysisData = parseAnalysisData(analysisBytes)
  } catch {
    throw new ProviderAnalysisMaterializationError(
      'AnalysisData FlatBuffer failed schema or column validation',
      false,
    )
  }
  let domain: unknown
  try {
    domain = JSON.parse(analysisData.domainJson)
  } catch {
    throw new ProviderAnalysisMaterializationError('AnalysisData domain JSON is invalid', false)
  }
  if (!validateAnalysisDataDomain(domain) || !isRecord(domain))
    throw new ProviderAnalysisMaterializationError(
      'AnalysisData domain failed schema validation',
      false,
    )
  const passthrough = passthroughError(domain, job) ?? analysisDataError(analysisData, domain, job)
  if (passthrough) throw new ProviderAnalysisMaterializationError(passthrough, false)

  const chunkFrameCount = Number(process.env.ANALYSIS_FRAME_CHUNK_COUNT ?? 120)
  if (!Number.isSafeInteger(chunkFrameCount) || chunkFrameCount < 1 || chunkFrameCount > 3_600)
    throw new ProviderAnalysisMaterializationError(
      'AnalysisData chunk configuration is invalid',
      false,
    )
  const browserChunks = chunkAnalysisData(analysisData, chunkFrameCount).map(chunk => {
    const bytes = Buffer.from(encodeAnalysisFrameChunk(chunk))
    return { chunk, bytes, sha256: sha256(bytes) }
  })
  const observedFrameRanges = buildObservedFrameRanges(analysisData)
  for (const item of browserChunks) {
    const objectKey = `analysis/${job.submissionId}/${providerJob.id}/frame-chunks/${item.chunk.chunkIndex}.fb`
    await storage.client.putObject(
      storage.analysisBucket,
      objectKey,
      item.bytes,
      item.bytes.byteLength,
      {
        'Content-Type': 'application/vnd.volleyball.analysis-frame-chunk+flatbuffers;version=1',
        'x-amz-meta-sha256': item.sha256,
        'x-amz-meta-byte-length': String(item.bytes.byteLength),
        'x-amz-meta-artifact-kind': 'analysis-frame-chunk',
      },
    )
  }

  const evidenceArtifact = exactlyOneArtifact(providerJob.artifacts, 'ANALYSIS_EVIDENCE_MANIFEST')
  const evidence = await verifiedJson(storage, evidenceArtifact)
  const poseArtifact = artifactByReference(
    providerJob.artifacts,
    evidence.pose_manifest_artifact,
    'PERSON_POSE_EVIDENCE_MANIFEST',
  )
  const cropArtifact = artifactByReference(
    providerJob.artifacts,
    evidence.crop_source_manifest_artifact,
    'PLAYER_CROP_SOURCE_MANIFEST',
  )
  const poseManifest = await verifiedJson(storage, poseArtifact)
  if (
    evidence.analysis_run_id !== domain.analysis_id ||
    evidence.match_id !== job.submission.rally.matchId ||
    evidence.rally_submission_id !== job.submissionId ||
    poseManifest.analysis_run_id !== domain.analysis_id
  )
    throw new ProviderAnalysisMaterializationError('evidence passthrough mismatch', false)

  const producer = isRecord(domain.producer) ? domain.producer : {}
  const requestPayloadRoot = isRecord(job.requestPayload) ? job.requestPayload : {}
  const requestAnalysisPlan = isRecord(requestPayloadRoot.analysis_plan)
    ? requestPayloadRoot.analysis_plan
    : {}
  const preserveManualCorrections = requestAnalysisPlan.preserve_manual_corrections !== false
  const result = await database.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ProviderJob" WHERE id = ${providerJob.id}::uuid FOR UPDATE`
    const already = await tx.analysisRun.findUnique({ where: { aiJobId } })
    if (already) return already.id

    const predecessorSubmissionId = job.submission.supersedesSubmissionId
    const priorRun = preserveManualCorrections
      ? await findPriorRun(tx, job.submissionId, predecessorSubmissionId)
      : null
    const analysisRun = await tx.analysisRun.create({
      data: {
        aiJobId,
        submissionId: job.submissionId,
        analysisId: String(domain.analysis_id),
        analysisVersion: String(domain.analysis_version),
        analysisDataSchemaVersion: String(domain.schema_version),
        inputClipSha256: String(domain.input_clip_sha256),
        producerName: String(producer.name),
        producerBuildId: String(producer.build_id),
        producerSdkVersion: typeof producer.sdk_version === 'string' ? producer.sdk_version : null,
        status: JobStatus.COMPLETED,
        rawAnalysisDataAssetId: analysisArtifact.mediaAsset.id,
        summary: json(domain.summary),
        activatedAt: new Date(),
        ...(priorRun
          ? {
              reviewRevision: priorRun.reviewRevision,
              reviewStatus: AnalysisReviewStatus.EDITING,
            }
          : {}),
      },
    })
    await tx.analysisDataManifest.create({
      data: {
        analysisRunId: analysisRun.id,
        schemaVersion: '1.0.0',
        analysisDataVersion: '1',
        videoWidth: analysisData.videoWidth,
        videoHeight: analysisData.videoHeight,
        fpsNum: analysisData.fpsNum,
        fpsDen: analysisData.fpsDen,
        totalFrames: analysisData.totalFrames,
        chunkFrameCount,
        actionTaxonomy: analysisData.actionTaxonomyId
          ? json({
              id: analysisData.actionTaxonomyId,
              version: analysisData.actionTaxonomyVersion,
              labels: analysisData.actionLabels,
            })
          : Prisma.JsonNull,
      },
    })
    for (const item of browserChunks) {
      const objectKey = `analysis/${job.submissionId}/${providerJob.id}/frame-chunks/${item.chunk.chunkIndex}.fb`
      const asset = await tx.mediaAsset.create({
        data: {
          kind: MediaAssetKind.ANALYSIS_FRAME_CHUNK,
          bucket: storage.analysisBucket,
          objectKey,
          contentType: 'application/vnd.volleyball.analysis-frame-chunk+flatbuffers;version=1',
          byteLength: BigInt(item.bytes.byteLength),
          sha256: item.sha256,
          internalSchemaVersion: '1.0.0',
          state: ArtifactState.READY,
          readyAt: new Date(),
        },
      })
      await tx.analysisFrameChunk.create({
        data: {
          analysisRunId: analysisRun.id,
          chunkIndex: item.chunk.chunkIndex,
          startFrameIndex: item.chunk.startFrameIndex,
          frameCount: item.chunk.frameCount,
          assetId: asset.id,
          byteLength: BigInt(item.bytes.byteLength),
          sha256: item.sha256,
        },
      })
      await tx.analysisArtifact.create({
        data: {
          analysisRunId: analysisRun.id,
          kind: MediaAssetKind.ANALYSIS_FRAME_CHUNK,
          assetId: asset.id,
        },
      })
    }

    const tracks = records(domain.tracks)
    if (tracks.length)
      await tx.analysisTrack.createMany({
        data: tracks.map(track => ({
          analysisRunId: analysisRun.id,
          trackId: Number(track.track_id),
          courtSide: String(track.court_side).toUpperCase() as TrackCourtSide,
          firstFrame: BigInt(String(track.first_frame_index)),
          lastFrame: BigInt(String(track.last_frame_index)),
          meanConfidence: typeof track.mean_confidence === 'number' ? track.mean_confidence : null,
          metadata: json(
            trackMetadataWithObservedFrames(
              track.metadata,
              observedFrameRanges.get(Number(track.track_id)) ?? [],
            ),
          ),
        })),
      })

    const mappingByPoint = new Map(
      job.clipJob.keyPointMappings.map(mapping => [mapping.submissionKeyPointId, mapping]),
    )
    const requestClip = isRecord(requestPayloadRoot.clip) ? requestPayloadRoot.clip : {}
    const requestVideo = isRecord(requestClip.video) ? requestClip.video : {}
    const requestFps = isRecord(requestVideo.fps) ? requestVideo.fps : {}
    const fpsNum = BigInt(String(requestFps.num))
    const fpsDen = BigInt(String(requestFps.den))
    for (const event of records(domain.contact_events)) {
      const keyPointId = String(event.key_point_id)
      const generated = event.anchor_origin === 'ai_detected'
      const claimedSourceId =
        typeof event.source_key_point_id === 'string' ? event.source_key_point_id : keyPointId
      const mapping = generated ? undefined : mappingByPoint.get(claimedSourceId)
      if (!mapping && !generated)
        throw new ProviderAnalysisMaterializationError(
          'AnalysisData human contact has no immutable clip mapping',
          false,
        )
      const ball = isRecord(event.ball) ? event.ball : {}
      const anchorFrameIndex = BigInt(String(event.anchor_frame_index))
      const anchorTimeUs = mapping?.clipTimeUs ?? (anchorFrameIndex * 1_000_000n * fpsDen) / fpsNum
      const eventExtensions = isRecord(event.extensions) ? event.extensions : {}
      const detectionEvidence = isRecord(eventExtensions.detection)
        ? eventExtensions.detection
        : null
      await tx.contactEvent.create({
        data: {
          analysisRunId: analysisRun.id,
          keyPointId,
          sourceKeyPointId: mapping ? claimedSourceId : null,
          anchorOrigin: generated ? 'ai_detected' : 'human_anchor',
          detectionConfidence:
            typeof event.detection_confidence === 'number' ? event.detection_confidence : null,
          detectionEvidence: detectionEvidence ? json(detectionEvidence) : Prisma.JsonNull,
          sequenceIndex: Number(event.sequence_index),
          anchorFrameIndex,
          resolvedFrameIndex:
            event.resolved_frame_index == null ? null : BigInt(String(event.resolved_frame_index)),
          anchorTimeUs,
          markerKind: String(event.marker_kind).toUpperCase() as MarkerKind,
          isTerminal: Boolean(event.is_terminal),
          associationState: String(event.association_state).toUpperCase() as AssociationState,
          ballState: String(ball.state).toUpperCase() as BallObservationState,
          ballFrameIndex:
            ball.sample_frame_index == null ? null : BigInt(String(ball.sample_frame_index)),
          ballFrameX:
            isRecord(ball.frame_pos) && typeof ball.frame_pos.x === 'number'
              ? ball.frame_pos.x
              : null,
          ballFrameY:
            isRecord(ball.frame_pos) && typeof ball.frame_pos.y === 'number'
              ? ball.frame_pos.y
              : null,
          qualityFlags: Array.isArray(event.quality_flags) ? event.quality_flags.map(String) : [],
        },
      })
      const actors = records(event.actors)
      if (actors.length)
        await tx.contactEventActor.createMany({
          data: actors.map(actor => {
            const bbox = isRecord(actor.frame_bbox) ? actor.frame_bbox : {}
            const foot = isRecord(actor.frame_foot_pos) ? actor.frame_foot_pos : {}
            const court = isRecord(actor.court_pos) ? actor.court_pos : {}
            return {
              analysisRunId: analysisRun.id,
              keyPointId,
              trackId: Number(actor.track_id),
              observationFrameIndex: BigInt(String(actor.observation_frame_index)),
              associationConfidence:
                typeof actor.association_confidence === 'number'
                  ? actor.association_confidence
                  : null,
              frameX1: typeof bbox.x1 === 'number' ? bbox.x1 : null,
              frameY1: typeof bbox.y1 === 'number' ? bbox.y1 : null,
              frameX2: typeof bbox.x2 === 'number' ? bbox.x2 : null,
              frameY2: typeof bbox.y2 === 'number' ? bbox.y2 : null,
              frameFootX: typeof foot.x === 'number' ? foot.x : null,
              frameFootY: typeof foot.y === 'number' ? foot.y : null,
              courtX: typeof court.x === 'number' ? court.x : null,
              courtY: typeof court.y === 'number' ? court.y : null,
              action: actor.action === undefined ? Prisma.JsonNull : json(actor.action),
            }
          }),
        })
      const candidates = records(event.actor_candidates)
      if (candidates.length)
        await tx.contactEventCandidate.createMany({
          data: candidates.map(candidate => ({
            analysisRunId: analysisRun.id,
            keyPointId,
            trackId: Number(candidate.track_id),
            rank: Number(candidate.rank),
            confidence: typeof candidate.confidence === 'number' ? candidate.confidence : null,
          })),
        })
      const positions = records(event.representative_court_positions)
      if (positions.length)
        await tx.contactEventPosition.createMany({
          data: positions.map((position, positionIndex) => {
            const court = isRecord(position.court_pos) ? position.court_pos : {}
            return {
              analysisRunId: analysisRun.id,
              keyPointId,
              positionIndex,
              trackId: typeof position.track_id === 'number' ? position.track_id : null,
              basis: String(position.basis),
              courtX: Number(court.x),
              courtY: Number(court.y),
              confidence: typeof position.confidence === 'number' ? position.confidence : null,
            }
          }),
        })
    }

    for (const path of records(domain.path_segments)) {
      const segment = await tx.ballPathSegment.create({
        data: {
          analysisRunId: analysisRun.id,
          sequenceIndex: Number(path.sequence_index),
          startKeyPointId: String(path.start_key_point_id),
          endKeyPointId: String(path.end_key_point_id),
          startFrameIndex:
            path.start_frame_index === undefined ? null : BigInt(String(path.start_frame_index)),
          endFrameIndex:
            path.end_frame_index === undefined ? null : BigInt(String(path.end_frame_index)),
          renderState: String(path.render_state).toUpperCase() as SegmentRenderState,
          isTerminalSegment: Boolean(path.is_terminal_segment),
          qualityFlags: Array.isArray(path.quality_flags) ? path.quality_flags.map(String) : [],
        },
      })
      const endpoints = [
        [SegmentEndpoint.START, records(path.start_court_positions)],
        [SegmentEndpoint.END, records(path.end_court_positions)],
      ] as const
      for (const [endpoint, positions] of endpoints)
        if (positions.length)
          await tx.ballPathSegmentPosition.createMany({
            data: positions.map((position, positionIndex) => {
              const court = isRecord(position.court_pos) ? position.court_pos : {}
              return {
                segmentId: segment.id,
                endpoint,
                positionIndex,
                trackId: typeof position.track_id === 'number' ? position.track_id : null,
                basis: String(position.basis),
                courtX: Number(court.x),
                courtY: Number(court.y),
                confidence: typeof position.confidence === 'number' ? position.confidence : null,
              }
            }),
          })
    }

    await registerProviderAnalysisEvidence(tx, {
      analysisRunId: analysisRun.id,
      analysisData,
      evidence,
      evidenceArtifact,
      poseManifest,
      poseArtifact,
      cropArtifact,
      artifacts: providerJob.artifacts,
    })
    if (priorRun) await copyCorrections(tx, priorRun, analysisRun.id, tracks, domain)
    if (priorRun)
      await tx.analysisRun.update({
        where: { id: priorRun.id },
        data: { status: JobStatus.SUPERSEDED, supersededAt: new Date() },
      })
    await tx.providerJob.update({
      where: { id: providerJob.id },
      data: {
        analysisRunId: analysisRun.id,
        stage: 'materialized',
        leasedUntil: null,
        errorCode: null,
        errorMessage: null,
      },
    })
    await tx.aiJob.update({
      where: { id: aiJobId },
      data: {
        status: JobStatus.COMPLETED,
        progress: 1,
        stage: 'provider_materialized',
        lastCallbackAt: new Date(),
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    })
    await tx.rally.update({
      where: { id: job.submission.rallyId },
      data: { processingStatus: ProcessingStatus.COMPLETED },
    })
    return analysisRun.id
  })
  return result
}

export async function registerProviderAnalysisEvidence(
  tx: Prisma.TransactionClient,
  input: {
    analysisRunId: string
    analysisData: AnalysisData
    evidence: Record<string, unknown>
    evidenceArtifact: ProviderAnalysisOutputArtifact
    poseManifest: Record<string, unknown>
    poseArtifact: ProviderAnalysisOutputArtifact
    cropArtifact: ProviderAnalysisOutputArtifact
    artifacts: ProviderAnalysisOutputArtifact[]
  },
) {
  const canonicalFrameCount = BigInt(String(input.poseManifest.canonical_frame_count))
  const playerObservationCount = BigInt(String(input.poseManifest.player_observation_count))
  const poseObservationCount = BigInt(String(input.poseManifest.pose_observation_count))
  const missingObservationCount = BigInt(String(input.poseManifest.missing_observation_count))
  if (
    canonicalFrameCount !== input.analysisData.totalFrames ||
    playerObservationCount !== poseObservationCount + missingObservationCount
  )
    throw new ProviderAnalysisMaterializationError('pose evidence accounting mismatch', false)
  const poseRecipe = isRecord(input.poseManifest.pose_recipe)
    ? input.poseManifest.pose_recipe
    : null
  if (!poseRecipe || typeof poseRecipe.namespace !== 'string')
    throw new ProviderAnalysisMaterializationError('pose evidence recipe is invalid', false)

  const chunkRows = records(input.poseManifest.chunks)
  let expectedStart = 0n
  let chunkPlayers = 0n
  let chunkAvailable = 0n
  let chunkMissing = 0n
  const chunks = chunkRows.map((chunk, index) => {
    if (Number(chunk.index) !== index || !isRecord(chunk.artifact))
      throw new ProviderAnalysisMaterializationError('pose evidence chunk order is invalid', false)
    const start = BigInt(String(chunk.start_frame_index))
    const end = BigInt(String(chunk.end_frame_index))
    if (start !== expectedStart || end < start)
      throw new ProviderAnalysisMaterializationError(
        'pose evidence frame coverage has a gap',
        false,
      )
    expectedStart = end + 1n
    const playerCount = BigInt(String(chunk.player_observation_count))
    const poseCount = BigInt(String(chunk.pose_observation_count))
    const missingCount = BigInt(String(chunk.missing_observation_count))
    if (playerCount !== poseCount + missingCount)
      throw new ProviderAnalysisMaterializationError(
        'pose evidence chunk accounting mismatch',
        false,
      )
    chunkPlayers += playerCount
    chunkAvailable += poseCount
    chunkMissing += missingCount
    const artifact = artifactByReference(
      input.artifacts,
      chunk.artifact,
      'PERSON_POSE_EVIDENCE_CHUNK',
    )
    return { index, start, end, playerCount, poseCount, missingCount, artifact }
  })
  if (
    expectedStart !== canonicalFrameCount ||
    chunkPlayers !== playerObservationCount ||
    chunkAvailable !== poseObservationCount ||
    chunkMissing !== missingObservationCount
  )
    throw new ProviderAnalysisMaterializationError(
      'pose evidence manifest does not cover every canonical frame',
      false,
    )

  const bundle = await tx.analysisEvidenceBundle.create({
    data: {
      analysisRunId: input.analysisRunId,
      schemaVersion: String(input.evidence.schema_version),
      manifestAssetId: input.evidenceArtifact.mediaAsset.id,
      cropSourceManifestAssetId: input.cropArtifact.mediaAsset.id,
      contentSha256: semanticContentSha(input.evidence, 'analysis evidence manifest'),
      canonicalFrameCount,
      status: ArtifactState.READY,
      readyAt: new Date(),
    },
  })
  const pose = await tx.personPoseEvidenceManifest.create({
    data: {
      analysisRunId: input.analysisRunId,
      analysisEvidenceBundleId: bundle.id,
      recipeNamespace: poseRecipe.namespace,
      schemaVersion: String(input.poseManifest.schema_version),
      manifestAssetId: input.poseArtifact.mediaAsset.id,
      contentSha256: semanticContentSha(input.poseManifest, 'pose evidence manifest'),
      canonicalFrameCount,
      playerObservationCount,
      poseObservationCount,
      missingObservationCount,
      status: ArtifactState.READY,
      readyAt: new Date(),
    },
  })
  if (chunks.length)
    await tx.personPoseEvidenceChunk.createMany({
      data: chunks.map(chunk => ({
        poseManifestId: pose.id,
        chunkIndex: chunk.index,
        startFrameIndex: chunk.start,
        endFrameIndex: chunk.end,
        playerObservationCount: chunk.playerCount,
        poseObservationCount: chunk.poseCount,
        missingObservationCount: chunk.missingCount,
        assetId: chunk.artifact.mediaAsset.id,
        sha256: chunk.artifact.sha256,
        byteLength: chunk.artifact.byteLength,
      })),
    })
}

async function copyCorrections(
  tx: Prisma.TransactionClient,
  priorRun: PriorRun,
  analysisRunId: string,
  tracks: Record<string, unknown>[],
  domain: Record<string, unknown>,
) {
  const validKeyPointIds = new Set(
    records(domain.contact_events).map(event => String(event.key_point_id)),
  )
  const validTrackIds = new Set(tracks.map(track => Number(track.track_id)))
  if (priorRun.ballCorrections.length)
    await tx.analysisBallCorrection.createMany({
      data: priorRun.ballCorrections.map(item => ({
        analysisRunId,
        frameIndex: item.frameIndex,
        frameX: item.frameX,
        frameY: item.frameY,
        visible: item.visible,
        revision: item.revision,
        updatedByUserId: item.updatedByUserId,
      })),
    })
  const bboxCorrections = priorRun.playerBBoxCorrections.filter(item =>
    validTrackIds.has(item.trackId),
  )
  if (bboxCorrections.length)
    await tx.analysisPlayerBBoxCorrection.createMany({
      data: bboxCorrections.map(item => ({
        analysisRunId,
        frameIndex: item.frameIndex,
        trackId: item.trackId,
        frameX1: item.frameX1,
        frameY1: item.frameY1,
        frameX2: item.frameX2,
        frameY2: item.frameY2,
        revision: item.revision,
        updatedByUserId: item.updatedByUserId,
      })),
    })
  const actionCorrections = priorRun.actionCorrections.filter(item =>
    validTrackIds.has(item.trackId),
  )
  if (actionCorrections.length)
    await tx.analysisActionCorrection.createMany({
      data: actionCorrections.map(item => ({
        analysisRunId,
        frameIndex: item.frameIndex,
        trackId: item.trackId,
        action: item.action,
        revision: item.revision,
        updatedByUserId: item.updatedByUserId,
      })),
    })
  const actorCorrections = priorRun.contactActorCorrections.filter(
    item =>
      validKeyPointIds.has(item.keyPointId) &&
      (item.trackId === null || validTrackIds.has(item.trackId)),
  )
  if (actorCorrections.length)
    await tx.analysisContactActorCorrection.createMany({
      data: actorCorrections.map(item => ({
        analysisRunId,
        keyPointId: item.keyPointId,
        trackId: item.trackId,
        revision: item.revision,
        updatedByUserId: item.updatedByUserId,
      })),
    })
  const timeCorrections = priorRun.contactTimeCorrections.filter(item =>
    validKeyPointIds.has(item.keyPointId),
  )
  if (timeCorrections.length)
    await tx.analysisContactTimeCorrection.createMany({
      data: timeCorrections.map(item => ({
        analysisRunId,
        keyPointId: item.keyPointId,
        frameIndex: item.frameIndex,
        revision: item.revision,
        updatedByUserId: item.updatedByUserId,
      })),
    })
  if (priorRun.contactEdits.length)
    await tx.analysisContactEdit.createMany({
      data: priorRun.contactEdits.map(item => ({
        analysisRunId,
        contactId: item.contactId,
        baseKeyPointId: item.baseKeyPointId,
        frameIndex: item.frameIndex,
        trackId: item.trackId !== null && validTrackIds.has(item.trackId) ? item.trackId : null,
        deleted: item.deleted,
        revision: item.revision,
        updatedByUserId: item.updatedByUserId,
      })),
    })
}

export function createProviderAnalysisMaterializerWorker(
  database: PrismaClient,
  options: {
    storage?: WorkflowMinio
    now?: () => Date
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
  } = {},
): PollingLifecycle {
  const storage = options.storage ?? createWorkflowMinio()
  const now = options.now ?? (() => new Date())

  async function processNext(): Promise<boolean> {
    const currentTime = now()
    const candidate = await database.providerJob.findFirst({
      where: {
        workKind: ProviderWorkKind.ANALYSIS,
        status: JobStatus.COMPLETED,
        availableAt: { lte: currentTime },
        OR: [
          { stage: 'artifacts_ready' },
          { stage: 'materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      orderBy: [{ availableAt: 'asc' }, { completedAt: 'asc' }, { id: 'asc' }],
      include: {
        artifacts: {
          where: { direction: ProviderArtifactDirection.OUTPUT },
          include: { mediaAsset: true },
          orderBy: { ordinal: 'asc' },
        },
      },
    })
    if (!candidate) return false

    const claimed = await database.providerJob.updateMany({
      where: {
        id: candidate.id,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'artifacts_ready' },
          { stage: 'materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      data: {
        stage: 'materializing',
        leasedUntil: new Date(currentTime.getTime() + MATERIALIZATION_LEASE_MS),
        errorCode: null,
        errorMessage: null,
      },
    })
    if (claimed.count !== 1) return false

    try {
      await materializeProviderAnalysis(database, storage, candidate)
    } catch (error) {
      const terminal = error instanceof ProviderAnalysisMaterializationError && !error.retryable
      const message = error instanceof Error ? error.message : 'unknown materialization failure'
      await database.$transaction(async tx => {
        await tx.providerJob.update({
          where: { id: candidate.id },
          data: {
            stage: terminal ? 'materialization_failed' : 'artifacts_ready',
            leasedUntil: null,
            availableAt: new Date(now().getTime() + (terminal ? 0 : 30_000)),
            errorCode: terminal ? 'INVALID_ANALYSIS_ARTIFACTS' : 'MATERIALIZATION_RETRY',
            errorMessage: message.slice(0, 1_000),
          },
        })
        const aiJobId = linkedAiJobId(candidate.requestPayload)
        if (terminal && aiJobId) {
          const linked = await tx.aiJob.findUnique({
            where: { id: aiJobId },
            select: { submission: { select: { rallyId: true } } },
          })
          if (linked) {
            await tx.aiJob.update({
              where: { id: aiJobId },
              data: {
                status: JobStatus.FAILED,
                stage: 'provider_materialization_failed',
                errorMessage: message.slice(0, 500),
                completedAt: new Date(),
              },
            })
            await tx.rally.update({
              where: { id: linked.submission.rallyId },
              data: { processingStatus: ProcessingStatus.FAILED },
            })
          }
        }
      })
    }
    return true
  }

  return createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: error => {
      console.error(
        'provider-analysis-materializer loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
