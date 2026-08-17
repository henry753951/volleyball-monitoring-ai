import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  ArtifactState,
  JobStatus,
  Prisma,
  ProviderArtifactDirection,
  ProviderWorkKind,
} from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  canonicalJson,
  isRecord,
  sha256Hex,
  verifiedSemanticContentSha,
} from '../services/reid-artifacts.js'
import { createPollingLifecycle } from '../workflow/poller.js'
import { createWorkflowMinio, readVerifiedObject, type WorkflowMinio } from '../workflow/minio.js'

const PREVIEW_LEASE_MS = 5 * 60_000
const JSON_MAX_BYTES = 2n * 1024n * 1024n
const PREVIEW_RECIPE = 'identity-preview/animated-webp/v1'
const PREVIEW_FRAME_COUNT = 12
const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const ajv = new Ajv2020({ allErrors: true, strict: false })
const validatePreviewRequest = ajv.compile(
  JSON.parse(await readFile(new URL('identity-preview-job.schema.json', contractsRoot), 'utf8')),
)
const validatePreviewResult = ajv.compile(
  JSON.parse(await readFile(new URL('identity-preview-result.schema.json', contractsRoot), 'utf8')),
)

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

type PreviewArtifact = {
  artifactKind: string
  sha256: string
  byteLength: bigint
  contentType: string
  mediaAsset: {
    id: string
    bucket: string
    objectKey: string
    byteLength: bigint | null
    sha256: string | null
    contentType: string
  }
}

export class IdentityPreviewMaterializationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'IdentityPreviewMaterializationError'
  }
}

function materializationError(error: unknown, retryable = false): never {
  if (error instanceof IdentityPreviewMaterializationError) throw error
  throw new IdentityPreviewMaterializationError(
    error instanceof Error ? error.message : 'invalid identity preview artifact',
    retryable,
  )
}

function oneArtifact(artifacts: PreviewArtifact[], kind: string) {
  const matches = artifacts.filter(artifact => artifact.artifactKind === kind)
  if (matches.length !== 1)
    throw new IdentityPreviewMaterializationError(
      `identity preview requires exactly one ${kind} artifact`,
      false,
    )
  return matches[0]!
}

export function selectIdentityPreviewFrames(input: {
  firstFrameIndex: bigint
  lastFrameIndex: bigint
  vectorFrameIndices: bigint[][]
}) {
  if (input.lastFrameIndex < input.firstFrameIndex)
    throw new TypeError('identity preview tracklet has inverted frame bounds')
  const withinBounds = (value: bigint) =>
    value >= input.firstFrameIndex && value <= input.lastFrameIndex
  let candidates = [...new Set(input.vectorFrameIndices.flat().filter(withinBounds).map(String))]
    .map(BigInt)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  if (candidates.length === 0) {
    const span = input.lastFrameIndex - input.firstFrameIndex
    const count = Math.min(PREVIEW_FRAME_COUNT, Number(span + 1n))
    candidates =
      count <= 1
        ? [input.firstFrameIndex]
        : Array.from(
            { length: count },
            (_, index) =>
              input.firstFrameIndex + (span * BigInt(index)) / BigInt(Math.max(1, count - 1)),
          )
  }
  if (candidates.length <= PREVIEW_FRAME_COUNT) return candidates
  const last = candidates.length - 1
  return [
    ...new Set(
      Array.from(
        { length: PREVIEW_FRAME_COUNT },
        (_, index) => candidates[Math.round((index * last) / (PREVIEW_FRAME_COUNT - 1))]!,
      ).map(String),
    ),
  ].map(BigInt)
}

export async function scheduleIdentityPreview(database: PrismaClient): Promise<boolean> {
  const candidate = await database.reidTracklet.findFirst({
    where: {
      evidenceSet: { status: ArtifactState.READY, supersededAt: null },
      previews: { none: { recipeNamespace: PREVIEW_RECIPE } },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      vectors: { select: { sourceFrameIndices: true } },
      evidenceSet: {
        include: {
          providerJob: true,
          analysisRun: {
            include: { aiJob: { include: { clipJob: { include: { clipAsset: true } } } } },
          },
          analysisEvidenceBundle: {
            include: {
              cropSourceManifestAsset: true,
              poseManifests: {
                where: { status: ArtifactState.READY },
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: {
                  manifestAsset: true,
                  chunks: { orderBy: { chunkIndex: 'asc' }, include: { asset: true } },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!candidate) return false
  const pose = candidate.evidenceSet.analysisEvidenceBundle.poseManifests[0]
  const cropAsset = candidate.evidenceSet.analysisEvidenceBundle.cropSourceManifestAsset
  const clipAsset = candidate.evidenceSet.analysisRun.aiJob.clipJob.clipAsset
  if (!pose || !cropAsset || !clipAsset) return false
  const frames = selectIdentityPreviewFrames({
    firstFrameIndex: candidate.firstFrameIndex,
    lastFrameIndex: candidate.lastFrameIndex,
    vectorFrameIndices: candidate.vectors.map(vector => vector.sourceFrameIndices),
  })
  const idempotencyKey = `identity-preview:${candidate.id}:${PREVIEW_RECIPE}`
  return database.$transaction(async tx => {
    if (await tx.providerJob.findUnique({ where: { idempotencyKey } })) return false
    const providerJobId = randomUUID()
    const previewId = randomUUID()
    const cropManifestInput = {
      id: randomUUID(),
      mediaAsset: cropAsset,
      artifactKind: 'PLAYER_CROP_SOURCE_MANIFEST',
      schemaVersion: '1.0.0',
    }
    const poseManifestInput = {
      id: randomUUID(),
      mediaAsset: pose.manifestAsset,
      artifactKind: 'PERSON_POSE_EVIDENCE_MANIFEST',
      schemaVersion: pose.schemaVersion,
    }
    const inputs = [
      {
        id: randomUUID(),
        mediaAsset: clipAsset,
        artifactKind: 'CANONICAL_CLIP',
        schemaVersion: clipAsset.internalSchemaVersion ?? '1.0.0',
      },
      cropManifestInput,
      poseManifestInput,
      ...pose.chunks.map(chunk => ({
        id: randomUUID(),
        mediaAsset: chunk.asset,
        artifactKind: 'PERSON_POSE_EVIDENCE_CHUNK',
        schemaVersion: pose.schemaVersion,
      })),
    ]
    const request = {
      schema_version: '1.1.0',
      provider_job_id: providerJobId,
      preview_id: previewId,
      analysis_run_id: candidate.evidenceSet.analysisRun.analysisId,
      tracklet_id: candidate.id,
      canonical_track_id: candidate.canonicalTrackId,
      crop_source_manifest_artifact_id: cropManifestInput.id,
      pose_manifest_artifact_id: poseManifestInput.id,
      selected_frame_indices: frames.map(String),
      recipe: {
        namespace: PREVIEW_RECIPE,
        output_format: 'ANIMATED_WEBP',
        target_width: 256,
        crop_padding_ratio: 0.15,
        frame_duration_ms: 160,
      },
    }
    if (!validatePreviewRequest(request))
      throw new IdentityPreviewMaterializationError(
        'generated identity preview request is invalid',
        false,
      )
    if (
      inputs.some(
        input =>
          input.mediaAsset.state !== ArtifactState.READY ||
          input.mediaAsset.sha256 === null ||
          input.mediaAsset.byteLength === null,
      )
    )
      throw new IdentityPreviewMaterializationError(
        'identity preview input artifact is not ready',
        true,
      )
    const token = randomBytes(32).toString('base64url')
    await tx.providerJob.create({
      data: {
        id: providerJobId,
        workKind: ProviderWorkKind.IDENTITY_PREVIEW_GENERATION,
        idempotencyKey,
        requestSchemaVersion: '1.1.0',
        resultSchemaVersion: '1.0.0',
        requestPayload: json(request),
        requestPayloadHash: sha256Hex(canonicalJson(request)),
        callbackTokenHash: sha256Hex(token),
        callbackTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
        analysisRunId: candidate.evidenceSet.analysisRunId,
        parentProviderJobId: candidate.evidenceSet.providerJobId,
        stage: 'preview_queued',
        artifacts: {
          create: inputs.map((input, ordinal) => ({
            id: input.id,
            mediaAssetId: input.mediaAsset.id,
            direction: ProviderArtifactDirection.INPUT,
            artifactKind: input.artifactKind,
            ordinal,
            required: true,
            schemaVersion: input.schemaVersion,
            sha256: input.mediaAsset.sha256!,
            byteLength: input.mediaAsset.byteLength!,
            contentType: input.mediaAsset.contentType,
          })),
        },
      },
    })
    await tx.reidIdentityPreview.create({
      data: {
        id: previewId,
        trackletId: candidate.id,
        providerJobId,
        recipeNamespace: PREVIEW_RECIPE,
        mediaAssetId: null,
        startFrameIndex: frames[0]!,
        endFrameIndex: frames.at(-1)!,
        frameCount: frames.length,
        contentSha256: null,
        status: ArtifactState.UPLOADING,
      },
    })
    return true
  })
}

export async function materializeIdentityPreview(
  database: PrismaClient,
  storage: WorkflowMinio,
  providerJob: {
    id: string
    requestPayload: Prisma.JsonValue
    artifacts: PreviewArtifact[]
  },
) {
  const request = isRecord(providerJob.requestPayload) ? providerJob.requestPayload : null
  if (!request)
    throw new IdentityPreviewMaterializationError('identity preview request is invalid', false)
  const resultArtifact = oneArtifact(providerJob.artifacts, 'IDENTITY_PREVIEW_RESULT')
  const mediaArtifact = oneArtifact(providerJob.artifacts, 'IDENTITY_PREVIEW')
  let result: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(
      (
        await readVerifiedObject(storage.client, resultArtifact.mediaAsset, JSON_MAX_BYTES)
      ).toString('utf8'),
    )
    if (!isRecord(parsed))
      throw new IdentityPreviewMaterializationError(
        'identity preview result must be an object',
        false,
      )
    result = parsed
  } catch (error) {
    materializationError(error, !(error instanceof SyntaxError))
  }
  if (!validatePreviewResult(result))
    throw new IdentityPreviewMaterializationError(
      'identity preview result failed schema validation',
      false,
    )
  try {
    verifiedSemanticContentSha(result, 'identity preview result')
  } catch (error) {
    materializationError(error)
  }
  for (const [key, expected] of Object.entries({
    provider_job_id: providerJob.id,
    preview_id: request.preview_id,
    tracklet_id: request.tracklet_id,
    recipe_namespace: isRecord(request.recipe) ? request.recipe.namespace : null,
  }))
    if (result[key] !== expected)
      throw new IdentityPreviewMaterializationError(
        `identity preview ${key} passthrough mismatch`,
        false,
      )
  const expectedFrames = Array.isArray(request.selected_frame_indices)
    ? request.selected_frame_indices
    : []
  if (
    !Array.isArray(result.source_frame_indices) ||
    result.source_frame_indices.length !== expectedFrames.length ||
    result.source_frame_indices.some((value, index) => value !== expectedFrames[index])
  )
    throw new IdentityPreviewMaterializationError(
      'identity preview source frames do not match the immutable request',
      false,
    )
  const media = isRecord(result.media_artifact) ? result.media_artifact : null
  if (
    !media ||
    media.sha256 !== mediaArtifact.sha256 ||
    media.byte_length !== mediaArtifact.byteLength.toString() ||
    media.content_type !== mediaArtifact.contentType ||
    mediaArtifact.mediaAsset.sha256 !== mediaArtifact.sha256 ||
    mediaArtifact.mediaAsset.byteLength !== mediaArtifact.byteLength
  )
    throw new IdentityPreviewMaterializationError(
      'identity preview media metadata does not match the uploaded artifact',
      false,
    )
  const tracklet = await database.reidTracklet.findUnique({
    where: { id: String(request.tracklet_id) },
    include: { evidenceSet: { include: { analysisRun: { select: { analysisId: true } } } } },
  })
  if (
    !tracklet ||
    tracklet.canonicalTrackId !== request.canonical_track_id ||
    tracklet.evidenceSet.analysisRun.analysisId !== request.analysis_run_id
  )
    throw new IdentityPreviewMaterializationError(
      'identity preview request does not match its tracklet',
      false,
    )
  return database.$transaction(async tx => {
    const existing = await tx.reidIdentityPreview.findUnique({
      where: { providerJobId: providerJob.id },
    })
    if (!existing)
      throw new IdentityPreviewMaterializationError(
        'identity preview database record is missing',
        false,
      )
    if (existing.status === ArtifactState.READY) return existing.id
    const updated = await tx.reidIdentityPreview.update({
      where: { id: existing.id },
      data: {
        mediaAssetId: mediaArtifact.mediaAsset.id,
        startFrameIndex: BigInt(String(result.start_frame_index)),
        endFrameIndex: BigInt(String(result.end_frame_index)),
        frameCount: Number(result.frame_count),
        contentSha256: String(result.content_sha256).toLowerCase(),
        status: ArtifactState.READY,
        readyAt: new Date(),
      },
    })
    await tx.providerJob.update({
      where: { id: providerJob.id },
      data: { stage: 'materialized', leasedUntil: null, errorCode: null, errorMessage: null },
    })
    return updated.id
  })
}

export function createIdentityPreviewWorker(
  database: PrismaClient,
  options: {
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
    now?: () => Date
    storage?: WorkflowMinio
  } = {},
) {
  const storage = options.storage ?? createWorkflowMinio()
  const now = options.now ?? (() => new Date())
  async function processNext(): Promise<boolean> {
    const currentTime = now()
    const candidate = await database.providerJob.findFirst({
      where: {
        workKind: ProviderWorkKind.IDENTITY_PREVIEW_GENERATION,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'completed' },
          { stage: 'preview_materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        artifacts: {
          where: { direction: ProviderArtifactDirection.OUTPUT },
          include: { mediaAsset: true },
          orderBy: { ordinal: 'asc' },
        },
      },
    })
    if (!candidate) {
      const failed = await database.reidIdentityPreview.updateMany({
        where: { status: ArtifactState.UPLOADING, providerJob: { status: JobStatus.FAILED } },
        data: { status: ArtifactState.FAILED },
      })
      if (failed.count > 0) return true
      return scheduleIdentityPreview(database)
    }
    const claimed = await database.providerJob.updateMany({
      where: {
        id: candidate.id,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'completed' },
          { stage: 'preview_materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      data: {
        stage: 'preview_materializing',
        leasedUntil: new Date(currentTime.getTime() + PREVIEW_LEASE_MS),
        errorCode: null,
        errorMessage: null,
      },
    })
    if (claimed.count !== 1) return false
    try {
      await materializeIdentityPreview(database, storage, candidate)
    } catch (error) {
      const terminal = error instanceof IdentityPreviewMaterializationError && !error.retryable
      await database.$transaction(async tx => {
        await tx.providerJob.update({
          where: { id: candidate.id },
          data: {
            stage: terminal ? 'preview_materialization_failed' : 'completed',
            leasedUntil: null,
            availableAt: new Date(now().getTime() + (terminal ? 0 : 30_000)),
            errorCode: terminal
              ? 'INVALID_IDENTITY_PREVIEW_ARTIFACT'
              : 'IDENTITY_PREVIEW_MATERIALIZATION_RETRY',
            errorMessage: (error instanceof Error
              ? error.message
              : 'unknown identity preview materialization failure'
            ).slice(0, 1_000),
          },
        })
        if (terminal)
          await tx.reidIdentityPreview.updateMany({
            where: { providerJobId: candidate.id, status: ArtifactState.UPLOADING },
            data: { status: ArtifactState.FAILED },
          })
      })
    }
    return true
  }
  return createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: error => {
      console.error(
        'identity-preview-worker loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
