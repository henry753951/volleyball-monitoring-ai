import {
  ANALYSIS_BALL_FLAG,
  ANALYSIS_MISSING_ACTION_LABEL,
  ANALYSIS_PLAYER_FLAG,
  parseAnalysisFrameChunk,
  parsePersonPoseEvidenceChunk,
  PERSON_POSE_BBOX_SOURCE,
  PERSON_POSE_KEYPOINT_COUNT,
  PERSON_POSE_STATUS,
  type AnalysisFrameChunk,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, Prisma } from '@volleyball-monitoring/db/client'
import {
  associateContactActor,
  type ContactAssociationInput,
  type ContactAssociationPlayer,
  type ContactAssociationPose,
  type NormalizedBBox,
} from '../services/contact-actor-association.js'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'
import { createWorkflowMinio, readVerifiedObject, type WorkflowMinio } from '../workflow/minio.js'

const LEASE_MS = 2 * 60_000
const RETRY_BASE_MS = 2_000
const FRAME_CHUNK_MAX_BYTES = 64n * 1024n * 1024n
const POSE_CHUNK_MAX_BYTES = 64n * 1024n * 1024n
const QUANTIZED_MAX = 65_535

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function loadAssociationJob(database: PrismaClient, jobId: string) {
  return database.analysisContactAssociationJob.findUnique({
    where: { id: jobId },
    include: {
      projection: true,
      analysisRun: {
        include: {
          analysisDataManifest: {
            include: { chunks: { orderBy: { chunkIndex: 'asc' }, include: { asset: true } } },
          },
          personPoseEvidenceManifests: {
            where: { status: ArtifactState.READY },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              chunks: { orderBy: { chunkIndex: 'asc' }, include: { asset: true } },
            },
          },
          ballCorrections: true,
          actionCorrections: true,
          playerBBoxCorrections: true,
        },
      },
    },
  })
}

type LoadedAssociationJob = NonNullable<Awaited<ReturnType<typeof loadAssociationJob>>>

export class ContactAssociationWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ContactAssociationWorkerError'
  }
}

function containingFrameChunk(job: LoadedAssociationJob) {
  const manifest = job.analysisRun.analysisDataManifest
  if (!manifest)
    throw new ContactAssociationWorkerError(
      'analysis frame manifest is unavailable',
      'ANALYSIS_EVIDENCE_UNAVAILABLE',
      true,
    )
  const chunk = [...manifest.chunks].reverse().find(item => {
    const end = item.startFrameIndex + BigInt(item.frameCount)
    return item.startFrameIndex <= job.frameIndex && job.frameIndex < end
  })
  if (!chunk)
    throw new ContactAssociationWorkerError(
      'corrected frame is not covered by AnalysisData',
      'ANALYSIS_FRAME_NOT_COVERED',
      false,
    )
  return { manifest, chunk }
}

function normalizedBBox(
  chunk: AnalysisFrameChunk,
  sourceIndex: number,
  correction: { frameX1: number; frameY1: number; frameX2: number; frameY2: number } | undefined,
  videoWidth: number,
  videoHeight: number,
): NormalizedBBox | null {
  if (correction)
    return {
      x1: correction.frameX1 / videoWidth,
      y1: correction.frameY1 / videoHeight,
      x2: correction.frameX2 / videoWidth,
      y2: correction.frameY2 / videoHeight,
    }
  if (!((chunk.playerFlags[sourceIndex] ?? 0) & ANALYSIS_PLAYER_FLAG.frameBBox)) return null
  const bbox = chunk.frameBboxes[sourceIndex]
  return bbox
    ? {
        x1: bbox.x1 / QUANTIZED_MAX,
        y1: bbox.y1 / QUANTIZED_MAX,
        x2: bbox.x2 / QUANTIZED_MAX,
        y2: bbox.y2 / QUANTIZED_MAX,
      }
    : null
}

function actionLabels(value: Prisma.JsonValue | null): string[] {
  if (!isRecord(value) || !Array.isArray(value.labels)) return []
  return value.labels.filter((label): label is string => typeof label === 'string')
}

function framePlayers(job: LoadedAssociationJob, chunk: AnalysisFrameChunk) {
  const manifest = job.analysisRun.analysisDataManifest!
  const localFrame = Number(job.frameIndex - chunk.startFrameIndex)
  const start = chunk.frameOffsets[localFrame]!
  const end = chunk.frameOffsets[localFrame + 1]!
  const bboxCorrections = new Map(
    job.analysisRun.playerBBoxCorrections
      .filter(item => item.frameIndex === job.frameIndex)
      .map(item => [item.trackId, item]),
  )
  const actionCorrections = new Map(
    job.analysisRun.actionCorrections
      .filter(item => item.frameIndex === job.frameIndex)
      .map(item => [item.trackId, item.action]),
  )
  const labels = actionLabels(manifest.actionTaxonomy)
  const players: ContactAssociationPlayer[] = []
  for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
    const trackId = chunk.trackIds[sourceIndex]
    if (trackId === undefined) continue
    const bbox = normalizedBBox(
      chunk,
      sourceIndex,
      bboxCorrections.get(trackId),
      manifest.videoWidth,
      manifest.videoHeight,
    )
    if (!bbox) continue
    const labelId = chunk.actionLabelIds[sourceIndex] ?? ANALYSIS_MISSING_ACTION_LABEL
    players.push({
      trackId,
      bbox,
      action:
        actionCorrections.get(trackId) ??
        (labelId === ANALYSIS_MISSING_ACTION_LABEL ? null : (labels[labelId] ?? null)),
    })
  }
  return players
}

function frameBall(job: LoadedAssociationJob, chunk: AnalysisFrameChunk) {
  const manifest = job.analysisRun.analysisDataManifest!
  const correction = job.analysisRun.ballCorrections.find(
    item => item.frameIndex === job.frameIndex,
  )
  if (correction)
    return correction.visible && correction.frameX !== null && correction.frameY !== null
      ? { x: correction.frameX / manifest.videoWidth, y: correction.frameY / manifest.videoHeight }
      : null
  const localFrame = Number(job.frameIndex - chunk.startFrameIndex)
  if (!((chunk.ballFlags[localFrame] ?? 0) & ANALYSIS_BALL_FLAG.framePosition)) return null
  const position = chunk.ballFramePositions[localFrame]
  return position ? { x: position.x / QUANTIZED_MAX, y: position.y / QUANTIZED_MAX } : null
}

async function framePoses(
  job: LoadedAssociationJob,
  storage: WorkflowMinio,
  readObject: typeof readVerifiedObject,
) {
  const manifest = job.analysisRun.personPoseEvidenceManifests[0]
  if (!manifest)
    return {
      poses: [] as ContactAssociationPose[],
      poseRecipeNamespace: null,
      fallbackReason: 'pose_evidence_unavailable',
      provenance: null,
    }
  const row = [...manifest.chunks]
    .reverse()
    .find(item => item.startFrameIndex <= job.frameIndex && job.frameIndex <= item.endFrameIndex)
  if (!row)
    return {
      poses: [] as ContactAssociationPose[],
      poseRecipeNamespace: manifest.recipeNamespace,
      fallbackReason: 'pose_frame_not_covered',
      provenance: null,
    }
  try {
    const bytes = await readObject(storage.client, row.asset, POSE_CHUNK_MAX_BYTES)
    const chunk = parsePersonPoseEvidenceChunk(bytes)
    if (
      chunk.poseRecipeNamespace !== manifest.recipeNamespace ||
      chunk.startFrameIndex !== row.startFrameIndex ||
      job.frameIndex < chunk.startFrameIndex ||
      job.frameIndex >= chunk.startFrameIndex + BigInt(chunk.frameCount)
    )
      throw new TypeError('pose chunk provenance does not match its registered frame range')
    const localFrame = Number(job.frameIndex - chunk.startFrameIndex)
    const start = chunk.frameOffsets[localFrame]!
    const end = chunk.frameOffsets[localFrame + 1]!
    const statusNames = ['AVAILABLE', 'NO_USABLE_BBOX', 'INFERENCE_FAILED', 'LOW_QUALITY'] as const
    const sourceNames = ['DETECTOR', 'TRACKER_PROPAGATED'] as const
    const poses: ContactAssociationPose[] = []
    for (let observation = start; observation < end; observation += 1) {
      const trackId = chunk.trackIds[observation]
      const status = statusNames[chunk.statuses[observation] ?? PERSON_POSE_STATUS.inferenceFailed]
      const bboxSource =
        sourceNames[chunk.bboxSources[observation] ?? PERSON_POSE_BBOX_SOURCE.trackerPropagated]
      if (trackId === undefined || !status || !bboxSource) continue
      const keypointStart = observation * PERSON_POSE_KEYPOINT_COUNT
      poses.push({
        trackId,
        status,
        bbox: {
          x1: chunk.bboxX1[observation]!,
          y1: chunk.bboxY1[observation]!,
          x2: chunk.bboxX2[observation]!,
          y2: chunk.bboxY2[observation]!,
        },
        bboxSource,
        keypoints: Array.from({ length: PERSON_POSE_KEYPOINT_COUNT }, (_, index) => ({
          x: chunk.keypointX[keypointStart + index]!,
          y: chunk.keypointY[keypointStart + index]!,
          confidence: chunk.keypointConfidence[keypointStart + index]!,
        })),
      })
    }
    return {
      poses,
      poseRecipeNamespace: manifest.recipeNamespace,
      fallbackReason: null,
      provenance: {
        manifest_id: manifest.id,
        manifest_content_sha256: manifest.contentSha256,
        chunk_index: row.chunkIndex,
        chunk_asset_id: row.assetId,
        chunk_sha256: row.sha256,
      },
    }
  } catch (error) {
    return {
      poses: [] as ContactAssociationPose[],
      poseRecipeNamespace: manifest.recipeNamespace,
      fallbackReason: 'pose_evidence_corrupt',
      provenance: {
        manifest_id: manifest.id,
        chunk_index: row.chunkIndex,
        chunk_asset_id: row.assetId,
        error: error instanceof Error ? error.name : 'UnknownError',
      },
    }
  }
}

export async function materializeContactAssociationJob(
  database: PrismaClient,
  jobId: string,
  storage: WorkflowMinio = createWorkflowMinio(),
  readObject: typeof readVerifiedObject = readVerifiedObject,
) {
  const job = await loadAssociationJob(database, jobId)
  if (!job)
    throw new ContactAssociationWorkerError('association job is missing', 'JOB_MISSING', false)
  if (job.status === JobStatus.COMPLETED && job.projection) return job.projection.id
  if (job.status !== JobStatus.RUNNING)
    throw new ContactAssociationWorkerError('association job is not leased', 'JOB_NOT_LEASED', true)
  if (job.analysisRun.status !== JobStatus.COMPLETED)
    throw new ContactAssociationWorkerError(
      'analysis run is not available for association',
      'ANALYSIS_NOT_READY',
      true,
    )
  const { manifest, chunk: frameChunkRow } = containingFrameChunk(job)
  let frameChunk: AnalysisFrameChunk
  try {
    frameChunk = parseAnalysisFrameChunk(
      await readObject(storage.client, frameChunkRow.asset, FRAME_CHUNK_MAX_BYTES),
    )
  } catch (error) {
    throw new ContactAssociationWorkerError(
      `analysis frame evidence could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      'ANALYSIS_EVIDENCE_INVALID',
      true,
    )
  }
  if (
    frameChunk.analysisId !== job.analysisRun.analysisId ||
    frameChunk.startFrameIndex !== frameChunkRow.startFrameIndex ||
    job.frameIndex < frameChunk.startFrameIndex ||
    job.frameIndex >= frameChunk.startFrameIndex + BigInt(frameChunk.frameCount)
  )
    throw new ContactAssociationWorkerError(
      'analysis frame chunk provenance is invalid',
      'ANALYSIS_EVIDENCE_INVALID',
      false,
    )
  const pose = await framePoses(job, storage, readObject)
  const input: ContactAssociationInput = {
    frameIndex: job.frameIndex,
    videoWidth: manifest.videoWidth,
    videoHeight: manifest.videoHeight,
    ball: frameBall(job, frameChunk),
    players: framePlayers(job, frameChunk),
    poses: pose.poses,
    poseRecipeNamespace: pose.poseRecipeNamespace,
    poseEvidenceFallbackReason: pose.fallbackReason,
  }
  const result = associateContactActor(input)
  const evidence = {
    ...result.evidence,
    analysis_frame_chunk: {
      chunk_index: frameChunkRow.chunkIndex,
      asset_id: frameChunkRow.assetId,
      sha256: frameChunkRow.sha256,
    },
    pose_evidence: pose.provenance,
    corrections: {
      ball: job.analysisRun.ballCorrections.some(item => item.frameIndex === job.frameIndex),
      action_track_ids: job.analysisRun.actionCorrections
        .filter(item => item.frameIndex === job.frameIndex)
        .map(item => item.trackId),
      bbox_track_ids: job.analysisRun.playerBBoxCorrections
        .filter(item => item.frameIndex === job.frameIndex)
        .map(item => item.trackId),
    },
  }
  return database.$transaction(async tx => {
    const newer = await tx.analysisContactAssociationJob.findFirst({
      where: {
        analysisRunId: job.analysisRunId,
        keyPointId: job.keyPointId,
        reviewRevision: { gt: job.reviewRevision },
        status: { notIn: [JobStatus.CANCELLED, JobStatus.SUPERSEDED] },
      },
      select: { id: true },
    })
    if (newer) {
      await tx.analysisContactAssociationJob.updateMany({
        where: { id: job.id, status: JobStatus.RUNNING },
        data: { status: JobStatus.SUPERSEDED, leasedUntil: null, completedAt: new Date() },
      })
      return null
    }
    const current = await tx.analysisContactAssociationJob.findUnique({
      where: { id: job.id },
      include: { projection: true },
    })
    if (current?.projection) return current.projection.id
    if (current?.status !== JobStatus.RUNNING)
      throw new ContactAssociationWorkerError('association lease was lost', 'LEASE_LOST', true)
    const projection = await tx.analysisContactAssociationProjection.create({
      data: {
        jobId: job.id,
        analysisRunId: job.analysisRunId,
        keyPointId: job.keyPointId,
        reviewRevision: job.reviewRevision,
        frameIndex: job.frameIndex,
        observationFrameIndex: result.observationFrameIndex,
        trackId: result.trackId,
        source: result.source,
        confidence: result.confidence,
        algorithmNamespace: job.algorithmNamespace,
        poseRecipeNamespace: result.poseRecipeNamespace,
        fallbackReason: result.fallbackReason,
        evidence: json(evidence),
      },
    })
    await tx.analysisContactAssociationJob.update({
      where: { id: job.id },
      data: {
        status: JobStatus.COMPLETED,
        leasedUntil: null,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    })
    return projection.id
  })
}

async function claimContactAssociationJob(database: PrismaClient) {
  const now = new Date()
  const candidates = await database.analysisContactAssociationJob.findMany({
    where: {
      OR: [
        { status: JobStatus.QUEUED, availableAt: { lte: now } },
        { status: JobStatus.RUNNING, leasedUntil: { lt: now } },
      ],
    },
    orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
    take: 8,
    select: { id: true },
  })
  for (const candidate of candidates) {
    const claimed = await database.analysisContactAssociationJob.updateMany({
      where: {
        id: candidate.id,
        OR: [
          { status: JobStatus.QUEUED, availableAt: { lte: now } },
          { status: JobStatus.RUNNING, leasedUntil: { lt: now } },
        ],
      },
      data: {
        status: JobStatus.RUNNING,
        attemptCount: { increment: 1 },
        leasedUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    })
    if (claimed.count === 1) return candidate.id
  }
  return null
}

async function retryOrFail(database: PrismaClient, jobId: string, error: unknown) {
  const job = await database.analysisContactAssociationJob.findUnique({
    where: { id: jobId },
    select: { attemptCount: true, maxAttempts: true, status: true },
  })
  if (!job || job.status !== JobStatus.RUNNING) return
  const retryable = !(error instanceof ContactAssociationWorkerError) || error.retryable
  const failed = !retryable || job.attemptCount >= job.maxAttempts
  const code = error instanceof ContactAssociationWorkerError ? error.code : 'WORKER_ERROR'
  const message = error instanceof Error ? error.message.slice(0, 1_000) : 'unknown worker error'
  await database.analysisContactAssociationJob.updateMany({
    where: { id: jobId, status: JobStatus.RUNNING },
    data: failed
      ? {
          status: JobStatus.FAILED,
          leasedUntil: null,
          completedAt: new Date(),
          errorCode: code,
          errorMessage: message,
        }
      : {
          status: JobStatus.QUEUED,
          leasedUntil: null,
          availableAt: new Date(Date.now() + RETRY_BASE_MS * 2 ** (job.attemptCount - 1)),
          errorCode: code,
          errorMessage: message,
        },
  })
}

export function createContactAssociationWorker(
  database: PrismaClient,
  options: {
    storage?: WorkflowMinio
    onError?: (error: unknown) => void
    disconnectOnStop?: boolean
  } = {},
): PollingLifecycle {
  let storage: WorkflowMinio | null = options.storage ?? null
  return createPollingLifecycle(
    async () => {
      const jobId = await claimContactAssociationJob(database)
      if (!jobId) return false
      try {
        storage ??= createWorkflowMinio()
        await materializeContactAssociationJob(database, jobId, storage)
      } catch (error) {
        await retryOrFail(database, jobId, error)
        options.onError?.(error)
      }
      return true
    },
    {
      idleMs: 500,
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
    },
  )
}
