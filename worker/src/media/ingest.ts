import type { SampleIndex, SampleIndexDocument } from './sample-index'
import {
  buildArtifactPlan,
  metadataFor,
  recordingAttemptKey,
  validateBucketName,
  type ArtifactKind,
  type ArtifactMetadata,
  type ArtifactSourceBytes,
  type MediaArtifact,
} from './artifacts'
import {
  assertFinalizedRecording,
  type FinalizedRecording,
} from './finalized-recording'

export type { FinalizedRecording } from './finalized-recording'
export {
  parseFinalizedRecording,
  normalizeSourceIdentity,
} from './finalized-recording'
export {
  buildArtifactPlan,
  idempotencyKey,
  planObjectLocation,
  sha256,
  validateBucketName,
} from './artifacts'
export type {
  ArtifactKind,
  ArtifactMetadata,
  ArtifactSourceBytes,
  MediaArtifact,
  ObjectLocation,
} from './artifacts'

export type IngestClaim = 'CLAIMED' | 'ALREADY_READY' | 'LEASED'
export type IngestResult = 'published' | 'already_ready' | 'retry'
export type IngestFailureCode =
  | 'ARTIFACT_SOURCE_FAILED'
  | 'CLAIM_FAILED'
  | 'RECORD_UPLOADING_FAILED'
  | 'UPLOAD_FAILED'
  | 'VERIFY_FAILED'
  | 'PUBLISH_FAILED'
export type IngestFailureStage =
  | 'ARTIFACT_SOURCE'
  | 'CLAIM'
  | 'RECORD_UPLOADING'
  | 'UPLOAD_INIT'
  | 'UPLOAD_MEDIA'
  | 'UPLOAD_SAMPLE_INDEX'
  | 'VERIFY_INIT'
  | 'VERIFY_MEDIA'
  | 'VERIFY_SAMPLE_INDEX'
  | 'PUBLISH_READY'

export type RetryableFailure = {
  idempotencyKey: string
  stage: IngestFailureStage
  code: IngestFailureCode
  message: string
}

export type UploadingRecord = {
  idempotencyKey: string
  captureSessionId: string
  sourceIdentityHash: string
  sourceContentSha256: string
  sourceByteLength: bigint
  sourceMtimeNs: bigint
  artifacts: readonly ArtifactMetadata[]
}

export type ReadyTransaction = {
  idempotencyKey: string
  captureSessionId: string
  artifacts: readonly ArtifactMetadata[]
  sampleIndex: SampleIndexDocument
}

export interface ArtifactSource {
  read(recording: FinalizedRecording): Promise<ArtifactSourceBytes>
}

export interface MediaObjectStore {
  upload(artifact: MediaArtifact): Promise<void>
  verify(artifact: ArtifactMetadata): Promise<void>
}

export interface MediaIngestRepository {
  claim(idempotencyKey: string): Promise<IngestClaim>
  recordUploading(record: UploadingRecord): Promise<void>
  publishReadyTransaction(transaction: ReadyTransaction): Promise<void>
  markRetryableFailure(failure: RetryableFailure): Promise<void>
}

export type IngestPorts = {
  bucket: string
  artifactSource: ArtifactSource
  store: MediaObjectStore
  repository: MediaIngestRepository
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function markFailure(
  repository: MediaIngestRepository,
  idempotencyKey: string,
  stage: IngestFailureStage,
  code: IngestFailureCode,
  error: unknown,
): Promise<IngestResult> {
  await repository.markRetryableFailure({
    idempotencyKey,
    stage,
    code,
    message: errorMessage(error),
  })
  return 'retry'
}

function uploadStage(kind: ArtifactKind): IngestFailureStage {
  if (kind === 'init') return 'UPLOAD_INIT'
  if (kind === 'media') return 'UPLOAD_MEDIA'
  return 'UPLOAD_SAMPLE_INDEX'
}

function verifyStage(kind: ArtifactKind): IngestFailureStage {
  if (kind === 'init') return 'VERIFY_INIT'
  if (kind === 'media') return 'VERIFY_MEDIA'
  return 'VERIFY_SAMPLE_INDEX'
}

export async function ingestFinalizedSegment(
  recording: FinalizedRecording,
  ports: IngestPorts,
  sampleIndex: SampleIndex,
): Promise<IngestResult> {
  assertFinalizedRecording(recording)
  const bucket = validateBucketName(ports.bucket)
  const attemptKey = recordingAttemptKey(recording)

  let plan: ReturnType<typeof buildArtifactPlan>
  try {
    const source = await ports.artifactSource.read(recording)
    plan = buildArtifactPlan(bucket, recording, source, sampleIndex)
  } catch (error) {
    return markFailure(
      ports.repository,
      attemptKey,
      'ARTIFACT_SOURCE',
      'ARTIFACT_SOURCE_FAILED',
      error,
    )
  }

  let claim: IngestClaim
  try {
    claim = await ports.repository.claim(plan.idempotencyKey)
  } catch (error) {
    return markFailure(
      ports.repository,
      plan.idempotencyKey,
      'CLAIM',
      'CLAIM_FAILED',
      error,
    )
  }

  if (claim === 'ALREADY_READY') return 'already_ready'
  if (claim === 'LEASED') return 'retry'

  const artifactMetadata = metadataFor(plan.artifacts)
  try {
    await ports.repository.recordUploading({
      idempotencyKey: plan.idempotencyKey,
      captureSessionId: recording.captureSessionId,
      sourceIdentityHash: plan.sourceIdentityHash,
      sourceContentSha256: plan.sourceContentSha256,
      sourceByteLength: recording.byteLength,
      sourceMtimeNs: recording.mtimeNs,
      artifacts: artifactMetadata,
    })
  } catch (error) {
    return markFailure(
      ports.repository,
      plan.idempotencyKey,
      'RECORD_UPLOADING',
      'RECORD_UPLOADING_FAILED',
      error,
    )
  }

  for (const artifact of plan.artifacts) {
    try {
      await ports.store.upload(artifact)
    } catch (error) {
      return markFailure(
        ports.repository,
        plan.idempotencyKey,
        uploadStage(artifact.kind),
        'UPLOAD_FAILED',
        error,
      )
    }
  }

  for (const artifact of artifactMetadata) {
    try {
      await ports.store.verify(artifact)
    } catch (error) {
      return markFailure(
        ports.repository,
        plan.idempotencyKey,
        verifyStage(artifact.kind),
        'VERIFY_FAILED',
        error,
      )
    }
  }

  try {
    await ports.repository.publishReadyTransaction({
      idempotencyKey: plan.idempotencyKey,
      captureSessionId: recording.captureSessionId,
      artifacts: artifactMetadata,
      sampleIndex: plan.sampleIndex,
    })
  } catch (error) {
    return markFailure(
      ports.repository,
      plan.idempotencyKey,
      'PUBLISH_READY',
      'PUBLISH_FAILED',
      error,
    )
  }

  return 'published'
}
