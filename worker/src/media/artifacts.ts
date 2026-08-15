import { createHash } from 'node:crypto'
import { serializeSampleIndex, type SampleIndex, type SampleIndexDocument } from './sample-index'
import {
  normalizeSourceIdentity,
  validateCaptureSessionId,
  type FinalizedRecording,
} from './finalized-recording'

export const INTERNAL_MEDIA_SCHEMA_VERSION = '1.0.0' as const

export type ArtifactKind = 'init' | 'media' | 'sample-index'

export type ObjectLocation = {
  bucket: string
  key: string
}

export type ArtifactMetadata = {
  kind: ArtifactKind
  location: ObjectLocation
  sha256: string
  byteLength: bigint
  contentType: 'video/mp4' | 'application/json'
  internalSchemaVersion: typeof INTERNAL_MEDIA_SCHEMA_VERSION
}

export type MediaArtifact = ArtifactMetadata & {
  bytes: Uint8Array
}

export type ArtifactSourceBytes = {
  initBytes: Uint8Array
  mediaBytes: Uint8Array
}

export type ArtifactPlan = {
  idempotencyKey: string
  sourceIdentityHash: string
  sourceContentSha256: string
  artifacts: readonly [MediaArtifact, MediaArtifact, MediaArtifact]
  sampleIndex: SampleIndexDocument
}

const ARTIFACT_FILE_NAMES: Record<ArtifactKind, string> = {
  init: 'init.mp4',
  media: 'media.mp4',
  'sample-index': 'sample-index.json',
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalDigest(domain: string, fields: readonly (readonly [string, string])[]): string {
  const hash = createHash('sha256')
  for (const [name, value] of [['domain', domain] as const, ...fields]) {
    const nameBytes = Buffer.from(name, 'utf8')
    const valueBytes = Buffer.from(value, 'utf8')
    hash.update(`${nameBytes.byteLength}:`)
    hash.update(nameBytes)
    hash.update(`${valueBytes.byteLength}:`)
    hash.update(valueBytes)
  }
  return hash.digest('hex')
}

export function validateBucketName(bucket: string): string {
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    bucket.includes('.-') ||
    bucket.includes('-.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new Error('invalid DVR bucket')
  }
  return bucket
}

export function sourceIdentityHash(recording: FinalizedRecording): string {
  return canonicalDigest('media-source-identity-v1', [
    ['sourceIdentity', normalizeSourceIdentity(recording.sourceIdentity)],
  ])
}

export function recordingAttemptKey(recording: FinalizedRecording): string {
  return canonicalDigest('media-ingest-attempt-v1', [
    ['captureSessionId', validateCaptureSessionId(recording.captureSessionId)],
    ['sourceIdentity', normalizeSourceIdentity(recording.sourceIdentity)],
    ['byteLength', recording.byteLength.toString()],
    ['mtimeNs', recording.mtimeNs.toString()],
  ])
}

export function sourceContentSha256(source: ArtifactSourceBytes): string {
  const hash = createHash('sha256')
  hash.update('media-artifact-source-v1')
  for (const [kind, bytes] of [
    ['init', source.initBytes] as const,
    ['media', source.mediaBytes] as const,
  ]) {
    hash.update(`${kind.length}:${kind}:${bytes.byteLength}:`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

export function idempotencyKey(recording: FinalizedRecording, contentSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw new Error('invalid source content checksum')
  }
  return canonicalDigest('media-ingest-idempotency-v1', [
    ['captureSessionId', validateCaptureSessionId(recording.captureSessionId)],
    ['sourceIdentity', normalizeSourceIdentity(recording.sourceIdentity)],
    ['byteLength', recording.byteLength.toString()],
    ['mtimeNs', recording.mtimeNs.toString()],
    ['contentSha256', contentSha256],
  ])
}

export function planObjectLocation(
  bucket: string,
  captureSessionId: string,
  hashedSource: string,
  kind: ArtifactKind,
): ObjectLocation {
  validateBucketName(bucket)
  validateCaptureSessionId(captureSessionId)
  if (!/^[a-f0-9]{64}$/.test(hashedSource)) {
    throw new Error('invalid hashed source')
  }
  return {
    bucket,
    key: `dvr/${captureSessionId}/${hashedSource}/${ARTIFACT_FILE_NAMES[kind]}`,
  }
}

function artifact(
  bucket: string,
  captureSessionId: string,
  hashedSource: string,
  kind: ArtifactKind,
  bytes: Uint8Array,
  contentType: ArtifactMetadata['contentType'],
): MediaArtifact {
  if (bytes.byteLength === 0) throw new Error(`${kind} artifact is empty`)
  const immutableBytes = Buffer.from(bytes)
  return {
    kind,
    location: planObjectLocation(bucket, captureSessionId, hashedSource, kind),
    bytes: immutableBytes,
    sha256: sha256(immutableBytes),
    byteLength: BigInt(immutableBytes.byteLength),
    contentType,
    internalSchemaVersion: INTERNAL_MEDIA_SCHEMA_VERSION,
  }
}

export function buildArtifactPlan(
  bucket: string,
  recording: FinalizedRecording,
  source: ArtifactSourceBytes,
  sampleIndex: SampleIndex,
): ArtifactPlan {
  validateBucketName(bucket)
  const sourceHash = sourceIdentityHash(recording)
  const contentHash = sourceContentSha256(source)
  const ingestKey = idempotencyKey(recording, contentHash)
  const sampleIndexDocument = serializeSampleIndex(sampleIndex)
  const indexBytes = Buffer.from(JSON.stringify(sampleIndexDocument), 'utf8')

  return {
    idempotencyKey: ingestKey,
    sourceIdentityHash: sourceHash,
    sourceContentSha256: contentHash,
    artifacts: [
      artifact(
        bucket,
        recording.captureSessionId,
        ingestKey,
        'init',
        source.initBytes,
        'video/mp4',
      ),
      artifact(
        bucket,
        recording.captureSessionId,
        ingestKey,
        'media',
        source.mediaBytes,
        'video/mp4',
      ),
      artifact(
        bucket,
        recording.captureSessionId,
        ingestKey,
        'sample-index',
        indexBytes,
        'application/json',
      ),
    ],
    sampleIndex: sampleIndexDocument,
  }
}

export function metadataFor(artifacts: readonly MediaArtifact[]): ArtifactMetadata[] {
  return artifacts.map(
    ({ kind, location, sha256: checksum, byteLength, contentType, internalSchemaVersion }) => ({
      kind,
      location,
      sha256: checksum,
      byteLength,
      contentType,
      internalSchemaVersion,
    }),
  )
}
