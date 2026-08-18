import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@volleyball-monitoring/db/client'
import {
  planNextCaptureSegment,
  parseSampleIndexDocument,
  serializeSampleIndex,
  type CaptureEpochPlannerConfig,
  type IncrementalFinalizedIndexedSegment,
  type PersistedCaptureHead,
  type PlanNextCaptureSegmentResult,
  type Rational,
  type SampleIndex,
  type SampleIndexDocument,
} from '@volleyball-monitoring/media'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const INT32_MAX = 2_147_483_647
const INT64_MAX = 9_223_372_036_854_775_807n
const LOCK_DOMAIN = 'volleyball-media-ingest-v1'
const INTERNAL_SCHEMA_VERSION = '1.0.0' as const
const OME_PROVISIONAL_EPOCH_REASON = 'OME_RECORDING_EXTENT_PROVISIONAL'
const LIVE_CAPTURE_SOURCE_KINDS = new Set([
  'live',
  'rtmp',
  'rtsp',
  'srt',
  'webrtc',
  'whip',
  'youtube_live',
  'hls_live',
])

export type IngestArtifactKind = 'init' | 'media' | 'sample-index'

export type IngestObjectLocation = {
  bucket: string
  key: string
}

export type IngestArtifactReservation = {
  kind: IngestArtifactKind
  location: IngestObjectLocation
  contentType: 'video/mp4' | 'application/json'
  internalSchemaVersion: typeof INTERNAL_SCHEMA_VERSION
}

export type IngestArtifactExpectation = IngestArtifactReservation & {
  byteLength: bigint
  sha256: string
}

export type DvrProgramProfile = {
  /** Stable packaged rendition metadata; source epoch timing is carried separately. */
  fpsNum: number
  fpsDen: number
  timeBaseNum: number
  timeBaseDen: number
}

export type FinalizedSegmentReservationInput = {
  captureSessionId: string
  idempotencyKey: string
  sourceIdentityHash: string
  newEpochId: string
  programProfile: DvrProgramProfile
  sourceOrder: bigint
  /** Authoritative source PTS unit for this epoch; reconnects may change it. */
  timeBase: Rational
  samples: IncrementalFinalizedIndexedSegment['samples']
  sourceRestart: boolean
  timestampDiscontinuity: boolean
  explicitGapBeforeUs?: bigint
  artifacts: readonly IngestArtifactReservation[]
  extent?: {
    sourceJobId: string
    localPath: string
    finalizedAt: Date
  }
}

export type IngestReservationReference = {
  captureSessionId: string
  dvrProgramId: string
  dvrSegmentId: string
  sampleIndexAssetId: string
  sampleIndexLocation: IngestObjectLocation
  mediaExtentId?: string
  captureEpochId?: string
}

export type ReservedArtifact = IngestArtifactReservation & {
  id: string
  state: 'UPLOADING' | 'READY'
  readyAt: Date | null
}

export type IngestReservationDisposition = 'RESERVED' | 'RESUMED' | 'ALREADY_READY'

export type FinalizedSegmentReservation = {
  disposition: IngestReservationDisposition
  reference: IngestReservationReference
  captureEpochId: string
  sequenceNumber: bigint
  createdNewEpoch: boolean
  plan: PlanNextCaptureSegmentResult
  sampleIndex: SampleIndex
  artifacts: Readonly<Record<IngestArtifactKind, ReservedArtifact>>
}

export type RecordArtifactExpectationsInput = {
  reservation: IngestReservationReference
  artifacts: readonly IngestArtifactExpectation[]
  sampleIndexDocument: SampleIndexDocument
}

export type PublishReadyInput = {
  reservation: IngestReservationReference
  verifiedArtifacts: readonly IngestArtifactExpectation[]
  extent?: {
    sourceJobId: string
    localPath: string
    finalizedAt: Date
  }
}

export type PublishReadyResult = {
  disposition: 'PUBLISHED' | 'ALREADY_READY'
  readyAt: Date
  playlistRevision: bigint
}

export type PrismaIngestRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_TERMINAL'
  | 'PROGRAM_CONFLICT'
  | 'FIFO_BLOCKED'
  | 'RESERVATION_CONFLICT'
  | 'TIMELINE_CONFLICT'
  | 'ARTIFACT_CONFLICT'
  | 'EXPECTATIONS_REQUIRED'
  | 'REVISION_EXHAUSTED'
  | 'TRANSACTION_RETRY_EXHAUSTED'
  | 'DATABASE_FAILURE'

const SAFE_MESSAGES: Record<PrismaIngestRepositoryErrorCode, string> = {
  INVALID_INPUT: 'Media ingest input is invalid.',
  SESSION_NOT_FOUND: 'Capture session was not found.',
  SESSION_TERMINAL: 'Capture session cannot accept media.',
  PROGRAM_CONFLICT: 'DVR program state conflicts with ingest.',
  FIFO_BLOCKED: 'An earlier media reservation is not ready.',
  RESERVATION_CONFLICT: 'Media reservation conflicts with persisted state.',
  TIMELINE_CONFLICT: 'Media timeline conflicts with persisted state.',
  ARTIFACT_CONFLICT: 'Media artifact metadata conflicts with persisted state.',
  EXPECTATIONS_REQUIRED: 'Media artifact expectations are incomplete.',
  REVISION_EXHAUSTED: 'Media playlist revision is exhausted.',
  TRANSACTION_RETRY_EXHAUSTED: 'Media ingest transaction could not be serialized.',
  DATABASE_FAILURE: 'Media ingest persistence failed.',
}

export class PrismaIngestRepositoryError extends Error {
  constructor(public readonly code: PrismaIngestRepositoryErrorCode) {
    super(SAFE_MESSAGES[code])
    this.name = 'PrismaIngestRepositoryError'
  }
}

export type PrismaIngestRepositoryOptions = {
  plannerConfig?: Partial<CaptureEpochPlannerConfig>
  maxTransactionAttempts?: number
  now?: () => Date
  liveArchiveBackend?: 'legacy' | 'media_extent'
}

type Tx = Prisma.TransactionClient
type ArtifactMap<T> = Record<IngestArtifactKind, T>

const artifactIncludes = {
  initAsset: true,
  mediaAsset: true,
  sampleIndexAsset: true,
  captureEpoch: true,
  program: true,
} as const

type SegmentWithArtifacts = Prisma.DvrSegmentGetPayload<{
  include: typeof artifactIncludes
}>

const extentIncludes = { captureEpoch: true, dvrProgram: true } as const
type ExtentWithEpoch = Prisma.MediaExtentGetPayload<{ include: typeof extentIncludes }>

function isLiveCaptureSourceKind(sourceKind: string): boolean {
  const normalized = sourceKind.trim().toLowerCase().replaceAll('-', '_')
  return LIVE_CAPTURE_SOURCE_KINDS.has(normalized) || normalized.endsWith('_live')
}

function fail(code: PrismaIngestRepositoryErrorCode): never {
  throw new PrismaIngestRepositoryError(code)
}

function requireUuid(value: string): void {
  if (!UUID.test(value)) fail('INVALID_INPUT')
}

function requireSha256(value: string): void {
  if (!SHA256.test(value)) fail('INVALID_INPUT')
}

function requirePositiveInt32(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > INT32_MAX) {
    fail('INVALID_INPUT')
  }
}

function requireSafeText(value: string): void {
  if (!value || value.length > 1_024 || value.includes('\0')) {
    fail('INVALID_INPUT')
  }
}

function validateObjectLocation(location: IngestObjectLocation): void {
  requireSafeText(location.bucket)
  requireSafeText(location.key)
  if (
    location.key.startsWith('/') ||
    location.key.includes('\\') ||
    location.key.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    fail('INVALID_INPUT')
  }
}

function expectedContentType(kind: IngestArtifactKind) {
  return kind === 'sample-index' ? 'application/json' : 'video/mp4'
}

function dbKind(kind: IngestArtifactKind) {
  if (kind === 'init') return 'DVR_INIT' as const
  if (kind === 'media') return 'DVR_SEGMENT' as const
  return 'SAMPLE_INDEX' as const
}

function artifactMap<T extends IngestArtifactReservation>(
  artifacts: readonly T[],
  withExpectations: boolean,
): ArtifactMap<T> {
  if (artifacts.length !== 3) fail('INVALID_INPUT')
  const result = {} as Partial<ArtifactMap<T>>
  const locations = new Set<string>()
  for (const artifact of artifacts) {
    if (!['init', 'media', 'sample-index'].includes(artifact.kind)) {
      fail('INVALID_INPUT')
    }
    if (result[artifact.kind]) fail('INVALID_INPUT')
    validateObjectLocation(artifact.location)
    if (
      artifact.contentType !== expectedContentType(artifact.kind) ||
      artifact.internalSchemaVersion !== INTERNAL_SCHEMA_VERSION
    ) {
      fail('INVALID_INPUT')
    }
    const locationIdentity = `${artifact.location.bucket.length}:${artifact.location.bucket}${artifact.location.key.length}:${artifact.location.key}`
    if (locations.has(locationIdentity)) fail('INVALID_INPUT')
    locations.add(locationIdentity)
    if (withExpectations) {
      const expectation = artifact as T & {
        byteLength?: bigint
        sha256?: string
      }
      if (typeof expectation.byteLength !== 'bigint' || expectation.byteLength <= 0n) {
        fail('INVALID_INPUT')
      }
      if (typeof expectation.sha256 !== 'string') fail('INVALID_INPUT')
      requireSha256(expectation.sha256)
    }
    result[artifact.kind] = artifact
  }
  if (!result.init || !result.media || !result['sample-index']) {
    fail('INVALID_INPUT')
  }
  return result as ArtifactMap<T>
}

function validateProfile(profile: DvrProgramProfile): void {
  requirePositiveInt32(profile.fpsNum)
  requirePositiveInt32(profile.fpsDen)
  requirePositiveInt32(profile.timeBaseNum)
  requirePositiveInt32(profile.timeBaseDen)
}

function validateReservationInput(input: FinalizedSegmentReservationInput) {
  requireUuid(input.captureSessionId)
  requireUuid(input.newEpochId)
  requireSha256(input.idempotencyKey)
  requireSha256(input.sourceIdentityHash)
  validateProfile(input.programProfile)
  if (
    input.timeBase.num <= 0n ||
    input.timeBase.den <= 0n ||
    input.timeBase.num > BigInt(INT32_MAX) ||
    input.timeBase.den > BigInt(INT32_MAX)
  ) {
    fail('INVALID_INPUT')
  }
  if (
    typeof input.sourceRestart !== 'boolean' ||
    typeof input.timestampDiscontinuity !== 'boolean'
  ) {
    fail('INVALID_INPUT')
  }
  if (input.extent) validateExtentPublication(input.extent)
  return artifactMap(input.artifacts, false)
}

function validateReference(reference: IngestReservationReference): void {
  requireUuid(reference.captureSessionId)
  requireUuid(reference.dvrProgramId)
  requireUuid(reference.dvrSegmentId)
  requireUuid(reference.sampleIndexAssetId)
  validateObjectLocation(reference.sampleIndexLocation)
  if (reference.mediaExtentId) {
    requireUuid(reference.mediaExtentId)
    if (!reference.captureEpochId) fail('INVALID_INPUT')
    requireUuid(reference.captureEpochId)
  }
}

function validateExtentPublication(extent: NonNullable<PublishReadyInput['extent']>): void {
  requireUuid(extent.sourceJobId)
  if (
    !extent.localPath ||
    extent.localPath.includes('\0') ||
    extent.localPath.startsWith('/') ||
    extent.localPath.includes('\\') ||
    extent.localPath.split('/').some(part => !part || part === '.' || part === '..') ||
    !(extent.finalizedAt instanceof Date) ||
    Number.isNaN(extent.finalizedAt.getTime())
  ) {
    fail('INVALID_INPUT')
  }
}

async function catalogVerifiedExtent(
  tx: Tx,
  input: {
    captureSessionId: string
    captureEpochId: string
    captureTimeOriginUs: bigint
    dvrProgramId: string
    dvrSegmentId: string
    sequenceNumber: bigint
    discontinuitySequence: number
    sourcePtsStart: bigint | null
    sourcePtsEnd: bigint | null
    firstFrameIndex: bigint | null
    frameCount: bigint
    source: string
    startUs: bigint
    endUs: bigint
    extent: NonNullable<PublishReadyInput['extent']>
    init: IngestArtifactExpectation
    media: IngestArtifactExpectation
    sampleIndex: IngestArtifactExpectation
    readyAt: Date
  },
): Promise<void> {
  if (
    input.sourcePtsStart === null ||
    input.sourcePtsEnd === null ||
    input.sourcePtsEnd <= input.sourcePtsStart ||
    input.firstFrameIndex === null ||
    input.frameCount <= 0n
  ) {
    return fail('TIMELINE_CONFLICT')
  }
  const expected = {
    captureSessionId: input.captureSessionId,
    dvrProgramId: input.dvrProgramId,
    dvrSegmentId: input.dvrSegmentId,
    captureEpochId: input.captureEpochId,
    sequenceNumber: input.sequenceNumber,
    discontinuitySequence: input.discontinuitySequence,
    sourceJobId: input.extent.sourceJobId,
    source: input.source,
    startUs: input.startUs,
    endUs: input.endUs,
    sourcePtsStart: input.sourcePtsStart,
    sourcePtsEnd: input.sourcePtsEnd,
    firstFrameIndex: input.firstFrameIndex,
    frameCount: input.frameCount,
    localPath: input.extent.localPath,
    bucket: input.media.location.bucket,
    objectKey: input.media.location.key,
    mediaSha256: input.media.sha256,
    mediaSchemaVersion: input.media.internalSchemaVersion,
    initBucket: input.init.location.bucket,
    initObjectKey: input.init.location.key,
    initSha256: input.init.sha256,
    initBytes: input.init.byteLength,
    initSchemaVersion: input.init.internalSchemaVersion,
    sampleIndexBucket: input.sampleIndex.location.bucket,
    sampleIndexObjectKey: input.sampleIndex.location.key,
    sampleIndexSha256: input.sampleIndex.sha256,
    sampleIndexBytes: input.sampleIndex.byteLength,
    sampleIndexSchemaVersion: input.sampleIndex.internalSchemaVersion,
    bytes: input.media.byteLength,
    finalizedAt: input.extent.finalizedAt,
  }
  const matches = await tx.mediaExtent.findMany({
    take: 2,
    where: {
      OR: [{ dvrSegmentId: input.dvrSegmentId }, { sourceJobId: input.extent.sourceJobId }],
    },
  })
  if (matches.length > 1) return fail('RESERVATION_CONFLICT')
  const existing = matches[0]
  if (existing) {
    const archiveProjectionValues = [
      existing.mediaSha256,
      existing.mediaSchemaVersion,
      existing.initBucket,
      existing.initObjectKey,
      existing.initSha256,
      existing.initBytes,
      existing.initSchemaVersion,
    ] as const
    const archiveProjectionIsEmpty = archiveProjectionValues.every(value => value === null)
    const archiveProjectionIsComplete = archiveProjectionValues.every(value => value !== null)
    if (!archiveProjectionIsEmpty && !archiveProjectionIsComplete)
      return fail('RESERVATION_CONFLICT')
    const projectionValues = [
      existing.captureEpochId,
      existing.sequenceNumber,
      existing.discontinuitySequence,
      existing.sourcePtsStart,
      existing.sourcePtsEnd,
      existing.firstFrameIndex,
      existing.frameCount,
      existing.sampleIndexBucket,
      existing.sampleIndexObjectKey,
      existing.sampleIndexSha256,
      existing.sampleIndexBytes,
      existing.sampleIndexSchemaVersion,
    ] as const
    const projectionIsEmpty = projectionValues.every(value => value === null)
    const projectionIsComplete = projectionValues.every(value => value !== null)
    if (!projectionIsEmpty && !projectionIsComplete) return fail('RESERVATION_CONFLICT')
    if (
      existing.captureSessionId !== expected.captureSessionId ||
      existing.dvrProgramId !== expected.dvrProgramId ||
      (existing.dvrSegmentId !== null && existing.dvrSegmentId !== expected.dvrSegmentId) ||
      (existing.sourceJobId !== null && existing.sourceJobId !== expected.sourceJobId) ||
      existing.source !== expected.source ||
      existing.startUs !== expected.startUs ||
      existing.endUs !== expected.endUs ||
      (projectionIsComplete &&
        (existing.captureEpochId !== expected.captureEpochId ||
          existing.sequenceNumber !== expected.sequenceNumber ||
          existing.discontinuitySequence !== expected.discontinuitySequence ||
          existing.sourcePtsStart !== expected.sourcePtsStart ||
          existing.sourcePtsEnd !== expected.sourcePtsEnd ||
          existing.firstFrameIndex !== expected.firstFrameIndex ||
          existing.frameCount !== expected.frameCount ||
          existing.sampleIndexBucket !== expected.sampleIndexBucket ||
          existing.sampleIndexObjectKey !== expected.sampleIndexObjectKey ||
          existing.sampleIndexSha256 !== expected.sampleIndexSha256 ||
          existing.sampleIndexBytes !== expected.sampleIndexBytes ||
          existing.sampleIndexSchemaVersion !== expected.sampleIndexSchemaVersion)) ||
      (existing.localPath !== null && existing.localPath !== expected.localPath) ||
      (existing.bucket !== null && existing.bucket !== expected.bucket) ||
      (existing.objectKey !== null && existing.objectKey !== expected.objectKey) ||
      (archiveProjectionIsComplete &&
        (existing.mediaSha256 !== expected.mediaSha256 ||
          existing.mediaSchemaVersion !== expected.mediaSchemaVersion ||
          existing.initBucket !== expected.initBucket ||
          existing.initObjectKey !== expected.initObjectKey ||
          existing.initSha256 !== expected.initSha256 ||
          existing.initBytes !== expected.initBytes ||
          existing.initSchemaVersion !== expected.initSchemaVersion)) ||
      (existing.bytes !== null && existing.bytes !== expected.bytes) ||
      (existing.finalizedAt !== null &&
        existing.finalizedAt.getTime() !== expected.finalizedAt.getTime())
    ) {
      return fail('RESERVATION_CONFLICT')
    }
    if (
      existing.status !== 'ARCHIVE_VERIFIED' ||
      existing.dvrSegmentId === null ||
      projectionIsEmpty ||
      archiveProjectionIsEmpty ||
      existing.sourceJobId === null ||
      existing.localPath === null ||
      existing.bucket === null ||
      existing.objectKey === null ||
      existing.bytes === null ||
      existing.finalizedAt === null ||
      existing.catalogedAt === null ||
      existing.archiveVerifiedAt === null
    ) {
      await tx.mediaExtent.update({
        data: {
          archiveVerifiedAt: existing.archiveVerifiedAt ?? input.readyAt,
          bucket: expected.bucket,
          bytes: expected.bytes,
          catalogedAt: existing.catalogedAt ?? input.readyAt,
          captureEpochId: expected.captureEpochId,
          sequenceNumber: expected.sequenceNumber,
          discontinuitySequence: expected.discontinuitySequence,
          dvrSegmentId: expected.dvrSegmentId,
          firstFrameIndex: expected.firstFrameIndex,
          frameCount: expected.frameCount,
          finalizedAt: expected.finalizedAt,
          localPath: expected.localPath,
          objectKey: expected.objectKey,
          mediaSchemaVersion: expected.mediaSchemaVersion,
          mediaSha256: expected.mediaSha256,
          initBucket: expected.initBucket,
          initBytes: expected.initBytes,
          initObjectKey: expected.initObjectKey,
          initSchemaVersion: expected.initSchemaVersion,
          initSha256: expected.initSha256,
          sampleIndexBucket: expected.sampleIndexBucket,
          sampleIndexBytes: expected.sampleIndexBytes,
          sampleIndexObjectKey: expected.sampleIndexObjectKey,
          sampleIndexSchemaVersion: expected.sampleIndexSchemaVersion,
          sampleIndexSha256: expected.sampleIndexSha256,
          sourceJobId: expected.sourceJobId,
          sourcePtsEnd: expected.sourcePtsEnd,
          sourcePtsStart: expected.sourcePtsStart,
          status: 'ARCHIVE_VERIFIED',
        },
        where: { id: existing.id },
      })
    }
    await validateOmePresentationAnchor(tx, input)
    return
  }
  await tx.mediaExtent.create({
    data: {
      ...expected,
      archiveVerifiedAt: input.readyAt,
      catalogedAt: input.readyAt,
      status: 'ARCHIVE_VERIFIED',
    },
  })
  await validateOmePresentationAnchor(tx, input)
}

export function omeRecordingStartTime(localPath: string): Date | null {
  const match = localPath.replaceAll('\\', '/').match(/(?:^|\/)(\d{14})_\d+\.mp4$/i)
  if (!match) return null
  const stamp = match[1]!
  const date = new Date(
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
    ),
  )
  return Number.isNaN(date.getTime()) ? null : date
}

async function validateOmePresentationAnchor(
  tx: Tx,
  input: {
    captureSessionId: string
    captureEpochId: string
    captureTimeOriginUs: bigint
    extent: NonNullable<PublishReadyInput['extent']>
    readyAt: Date
  },
): Promise<void> {
  const recordingStartedAt = omeRecordingStartTime(input.extent.localPath)
  if (!recordingStartedAt) return
  // OME names FILE extents from the output-stream start wall clock while
  // LL-HLS publishes the same first encoded frame with PROGRAM-DATE-TIME.
  // The XML startTime has a publisher-specific delay and is deliberately not
  // used as the canonical origin. A narrow wall-clock window only identifies
  // the generation; canonical time comes from the durable CaptureEpoch.
  const toleranceMs = 2_000
  const candidates = await tx.livePresentationAnchor.findMany({
    select: { id: true },
    take: 2,
    where: {
      captureEpochId: null,
      captureSessionId: input.captureSessionId,
      programDateTime: {
        gte: new Date(recordingStartedAt.getTime() - toleranceMs),
        lte: new Date(recordingStartedAt.getTime() + toleranceMs),
      },
      validatedAt: null,
    },
  })
  if (candidates.length !== 1) return
  await tx.livePresentationAnchor.updateMany({
    data: {
      captureEpochId: input.captureEpochId,
      captureTimeOriginUs: input.captureTimeOriginUs,
      validatedAt: input.readyAt,
    },
    where: { captureEpochId: null, id: candidates[0]!.id, validatedAt: null },
  })
}

function sameProfile(
  program: Pick<Prisma.DvrProgramModel, 'fpsNum' | 'fpsDen' | 'timeBaseNum' | 'timeBaseDen'>,
  profile: DvrProgramProfile,
): boolean {
  return (
    program.fpsNum === profile.fpsNum &&
    program.fpsDen === profile.fpsDen &&
    program.timeBaseNum === profile.timeBaseNum &&
    program.timeBaseDen === profile.timeBaseDen
  )
}

function sameLocation(
  asset: { bucket: string; objectKey: string },
  expected: IngestObjectLocation,
) {
  return asset.bucket === expected.bucket && asset.objectKey === expected.key
}

function sameReservationMetadata(
  asset: {
    kind: string
    bucket: string
    objectKey: string
    contentType: string
    internalSchemaVersion: string | null
  },
  expected: IngestArtifactReservation,
) {
  return (
    asset.kind === dbKind(expected.kind) &&
    sameLocation(asset, expected.location) &&
    asset.contentType === expected.contentType &&
    asset.internalSchemaVersion === expected.internalSchemaVersion
  )
}

function sameExpectation(
  asset: {
    byteLength: bigint | null
    sha256: string | null
  },
  expected: IngestArtifactExpectation,
) {
  return asset.byteLength === expected.byteLength && asset.sha256 === expected.sha256
}

function persistedReason(reasons: readonly string[]): string {
  return JSON.stringify(reasons)
}

function segmentAssets(segment: SegmentWithArtifacts) {
  if (!segment.initAsset || !segment.mediaAsset || !segment.sampleIndexAsset) {
    fail('RESERVATION_CONFLICT')
  }
  return {
    init: segment.initAsset,
    media: segment.mediaAsset,
    'sample-index': segment.sampleIndexAsset,
  }
}

function makeReference(segment: SegmentWithArtifacts): IngestReservationReference {
  if (!segment.sampleIndexAssetId || !segment.sampleIndexAsset) {
    return fail('RESERVATION_CONFLICT')
  }
  return {
    captureSessionId: segment.program.captureSessionId,
    dvrProgramId: segment.dvrProgramId,
    dvrSegmentId: segment.id,
    sampleIndexAssetId: segment.sampleIndexAssetId,
    sampleIndexLocation: {
      bucket: segment.sampleIndexAsset.bucket,
      key: segment.sampleIndexAsset.objectKey,
    },
  }
}

function reservedArtifacts(
  segment: SegmentWithArtifacts,
  expected: ArtifactMap<IngestArtifactReservation>,
): ArtifactMap<ReservedArtifact> {
  const assets = segmentAssets(segment)
  return Object.fromEntries(
    (['init', 'media', 'sample-index'] as const).map(kind => [
      kind,
      {
        ...expected[kind],
        id: assets[kind].id,
        state: assets[kind].state as 'UPLOADING' | 'READY',
        readyAt: assets[kind].readyAt,
      },
    ]),
  ) as ArtifactMap<ReservedArtifact>
}

function extentReservedArtifacts(
  extent: ExtentWithEpoch,
  expected: ArtifactMap<IngestArtifactReservation>,
): ArtifactMap<ReservedArtifact> {
  const ready = extent.status === 'ARCHIVE_VERIFIED' && extent.archiveVerifiedAt !== null
  return Object.fromEntries(
    (['init', 'media', 'sample-index'] as const).map(kind => [
      kind,
      {
        ...expected[kind],
        id: `${extent.id}:${kind}`,
        state: ready ? ('READY' as const) : ('UPLOADING' as const),
        readyAt: ready ? extent.archiveVerifiedAt : null,
      },
    ]),
  ) as ArtifactMap<ReservedArtifact>
}

function assertSegmentMatchesPlan(
  segment: SegmentWithArtifacts,
  plan: PlanNextCaptureSegmentResult,
  sequenceNumber: bigint,
): void {
  const planned = plan.segment
  const epoch = plan.epoch
  if (
    segment.sequenceNumber !== sequenceNumber ||
    segment.captureEpochId !== epoch.epochKey ||
    segment.discontinuitySequence !== planned.discontinuitySequence ||
    segment.captureStartUs !== planned.captureStartUs ||
    segment.captureEndUs !== planned.captureEndUs ||
    segment.sourcePtsStart !== planned.sourcePtsStart ||
    segment.sourcePtsEnd !== planned.sourcePtsEndExclusive ||
    segment.firstFrameIndex !== planned.firstFrameIndex ||
    segment.frameCount !== planned.frameCount ||
    segment.durationUs !== planned.durationUs ||
    segment.isGap
  ) {
    fail('TIMELINE_CONFLICT')
  }
  if (
    segment.captureEpoch.sequenceIndex !== epoch.epochSequence ||
    segment.captureEpoch.sourceTimeBaseNum !== Number(epoch.timeBase.num) ||
    segment.captureEpoch.sourceTimeBaseDen !== Number(epoch.timeBase.den) ||
    segment.captureEpoch.sourcePtsOrigin !== epoch.sourcePtsOrigin ||
    segment.captureEpoch.captureTimeOriginUs !== epoch.captureTimeOriginUs ||
    segment.captureEpoch.captureFrameOrigin !== epoch.captureFrameOrigin ||
    segment.captureEpoch.startedAtCaptureUs !== epoch.captureTimeOriginUs
  ) {
    fail('TIMELINE_CONFLICT')
  }
  if (
    epoch.disposition === 'CREATE_NEXT' &&
    segment.captureEpoch.discontinuityReason !== persistedReason(epoch.reasons)
  ) {
    fail('TIMELINE_CONFLICT')
  }
}

function assertArtifactRelationships(
  segment: SegmentWithArtifacts,
  expected: ArtifactMap<IngestArtifactReservation>,
): void {
  const assets = segmentAssets(segment)
  if (
    segment.initAssetId !== assets.init.id ||
    segment.mediaAssetId !== assets.media.id ||
    segment.sampleIndexAssetId !== assets['sample-index'].id
  ) {
    fail('RESERVATION_CONFLICT')
  }
  for (const kind of ['init', 'media', 'sample-index'] as const) {
    if (!sameReservationMetadata(assets[kind], expected[kind])) {
      fail('ARTIFACT_CONFLICT')
    }
  }
}

function buildHead(segment: SegmentWithArtifacts): PersistedCaptureHead {
  if (
    segment.isGap ||
    segment.readyAt === null ||
    segment.sourcePtsEnd === null ||
    segment.firstFrameIndex === null ||
    segment.frameCount <= 0n
  ) {
    return fail('TIMELINE_CONFLICT')
  }
  const assets = segmentAssets(segment)
  if (
    assets.init.state !== 'READY' ||
    assets.media.state !== 'READY' ||
    assets['sample-index'].state !== 'READY'
  ) {
    fail('TIMELINE_CONFLICT')
  }
  return {
    epochId: segment.captureEpoch.id,
    epochSequence: segment.captureEpoch.sequenceIndex,
    discontinuity: segment.discontinuitySequence,
    timeBase: {
      num: BigInt(segment.captureEpoch.sourceTimeBaseNum),
      den: BigInt(segment.captureEpoch.sourceTimeBaseDen),
    },
    sourcePtsOrigin: segment.captureEpoch.sourcePtsOrigin,
    captureTimeOriginUs: segment.captureEpoch.captureTimeOriginUs,
    captureFrameOrigin: segment.captureEpoch.captureFrameOrigin,
    lastSourcePtsEndExclusive: segment.sourcePtsEnd,
    lastCaptureEndUs: segment.captureEndUs,
    lastCaptureFrameIndex: segment.firstFrameIndex + segment.frameCount - 1n,
  }
}

function buildExtentHead(extent: ExtentWithEpoch): PersistedCaptureHead {
  if (
    extent.status !== 'ARCHIVE_VERIFIED' ||
    extent.archiveVerifiedAt === null ||
    !extent.captureEpoch ||
    extent.sequenceNumber === null ||
    extent.discontinuitySequence === null ||
    extent.sourcePtsEnd === null ||
    extent.firstFrameIndex === null ||
    extent.frameCount === null ||
    extent.frameCount <= 0n ||
    extent.sampleIndexObjectKey === null
  ) {
    return fail('TIMELINE_CONFLICT')
  }
  return {
    epochId: extent.captureEpoch.id,
    epochSequence: extent.captureEpoch.sequenceIndex,
    discontinuity: extent.discontinuitySequence,
    timeBase: {
      num: BigInt(extent.captureEpoch.sourceTimeBaseNum),
      den: BigInt(extent.captureEpoch.sourceTimeBaseDen),
    },
    sourcePtsOrigin: extent.captureEpoch.sourcePtsOrigin,
    captureTimeOriginUs: extent.captureEpoch.captureTimeOriginUs,
    captureFrameOrigin: extent.captureEpoch.captureFrameOrigin,
    lastSourcePtsEndExclusive: extent.sourcePtsEnd,
    lastCaptureEndUs: extent.endUs,
    lastCaptureFrameIndex: extent.firstFrameIndex + extent.frameCount - 1n,
  }
}

function assertExtentMatchesPlan(
  extent: ExtentWithEpoch,
  plan: PlanNextCaptureSegmentResult,
  sequenceNumber: bigint,
  requireProjection: boolean,
): void {
  const planned = plan.segment
  if (
    extent.sequenceNumber !== sequenceNumber ||
    extent.discontinuitySequence !== planned.discontinuitySequence ||
    extent.startUs !== planned.captureStartUs ||
    extent.endUs !== planned.captureEndUs
  ) {
    fail('TIMELINE_CONFLICT')
  }
  if (!requireProjection) return
  if (
    extent.captureEpochId !== plan.epoch.epochKey ||
    extent.sourcePtsStart !== planned.sourcePtsStart ||
    extent.sourcePtsEnd !== planned.sourcePtsEndExclusive ||
    extent.firstFrameIndex !== planned.firstFrameIndex ||
    extent.frameCount !== planned.frameCount ||
    !extent.captureEpoch ||
    extent.captureEpoch.sequenceIndex !== plan.epoch.epochSequence ||
    extent.captureEpoch.sourceTimeBaseNum !== Number(plan.epoch.timeBase.num) ||
    extent.captureEpoch.sourceTimeBaseDen !== Number(plan.epoch.timeBase.den) ||
    extent.captureEpoch.sourcePtsOrigin !== plan.epoch.sourcePtsOrigin ||
    extent.captureEpoch.captureTimeOriginUs !== plan.epoch.captureTimeOriginUs ||
    extent.captureEpoch.captureFrameOrigin !== plan.epoch.captureFrameOrigin
  ) {
    fail('TIMELINE_CONFLICT')
  }
}

async function advisoryLock(tx: Tx, captureSessionId: string): Promise<void> {
  await tx.$queryRaw<Array<{ locked: string | null }>>`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        CAST(${LOCK_DOMAIN} AS text) || ':' || CAST(${captureSessionId} AS text),
        0
      )
    )::text AS locked
  `
}

function hasRetryCode(error: unknown, depth = 0): boolean {
  if (depth > 4 || !error || typeof error !== 'object') return false
  for (const name of ['code', 'originalCode', 'sqlState']) {
    const value = Reflect.get(error, name)
    if (typeof value === 'string' && ['P2034', '40001', '40P01'].includes(value)) {
      return true
    }
  }
  for (const name of ['cause', 'driverAdapterError']) {
    if (hasRetryCode(Reflect.get(error, name), depth + 1)) return true
  }
  return false
}

function isRetryableTransactionError(error: unknown): boolean {
  return hasRetryCode(error)
}

async function findSegmentBySampleLocation(
  tx: Tx,
  location: IngestObjectLocation,
): Promise<SegmentWithArtifacts | null> {
  const sampleAsset = await tx.mediaAsset.findUnique({
    where: {
      bucket_objectKey: {
        bucket: location.bucket,
        objectKey: location.key,
      },
    },
    select: {
      dvrSampleIndexSegments: {
        include: artifactIncludes,
      },
    },
  })
  if (!sampleAsset) return null
  if (sampleAsset.dvrSampleIndexSegments.length !== 1) {
    fail('RESERVATION_CONFLICT')
  }
  return sampleAsset.dvrSampleIndexSegments[0]!
}

async function findReadyPredecessor(
  tx: Tx,
  dvrProgramId: string,
  beforeSequence?: bigint,
): Promise<SegmentWithArtifacts | null> {
  return tx.dvrSegment.findFirst({
    include: artifactIncludes,
    orderBy: { sequenceNumber: 'desc' },
    where: {
      dvrProgramId,
      readyAt: { not: null },
      ...(beforeSequence === undefined ? {} : { sequenceNumber: { lt: beforeSequence } }),
    },
  })
}

function plannerSegment(input: FinalizedSegmentReservationInput) {
  return {
    segmentIdentity: input.idempotencyKey,
    sourceIdentity: input.sourceIdentityHash,
    sourceOrder: input.sourceOrder,
    timeBase: input.timeBase,
    samples: input.samples,
  }
}

function planFrom(
  input: FinalizedSegmentReservationInput,
  currentHead: PersistedCaptureHead | null,
  config: CaptureEpochPlannerConfig,
): PlanNextCaptureSegmentResult {
  try {
    return planNextCaptureSegment({
      currentHead,
      newEpochId: input.newEpochId,
      segment: plannerSegment(input),
      sourceRestart: input.sourceRestart,
      timestampDiscontinuity: input.timestampDiscontinuity,
      ...(input.explicitGapBeforeUs === undefined
        ? {}
        : { explicitGapBeforeUs: input.explicitGapBeforeUs }),
      config,
    })
  } catch {
    return fail('TIMELINE_CONFLICT')
  }
}

function assertReference(
  reference: IngestReservationReference,
  segment: SegmentWithArtifacts,
): void {
  if (
    segment.id !== reference.dvrSegmentId ||
    segment.dvrProgramId !== reference.dvrProgramId ||
    segment.program.captureSessionId !== reference.captureSessionId ||
    segment.sampleIndexAssetId !== reference.sampleIndexAssetId ||
    !segment.sampleIndexAsset ||
    !sameLocation(segment.sampleIndexAsset, reference.sampleIndexLocation)
  ) {
    fail('RESERVATION_CONFLICT')
  }
}

async function readReservation(
  tx: Tx,
  reference: IngestReservationReference,
): Promise<SegmentWithArtifacts> {
  const segment = await findSegmentBySampleLocation(tx, reference.sampleIndexLocation)
  if (!segment) return fail('RESERVATION_CONFLICT')
  assertReference(reference, segment)
  return segment
}

function sampleIndexForExpectation(
  segment: SegmentWithArtifacts,
  document: SampleIndexDocument,
): SampleIndex {
  let index: SampleIndex
  try {
    index = parseSampleIndexDocument(document, {
      epochId: segment.captureEpoch.id,
      sourcePtsOrigin: segment.captureEpoch.sourcePtsOrigin,
      captureTimeOriginUs: segment.captureEpoch.captureTimeOriginUs,
      captureFrameOrigin: segment.captureEpoch.captureFrameOrigin,
      timeBase: {
        num: BigInt(segment.captureEpoch.sourceTimeBaseNum),
        den: BigInt(segment.captureEpoch.sourceTimeBaseDen),
      },
    })
  } catch {
    return fail('ARTIFACT_CONFLICT')
  }
  const first = index.samples[0]!
  const last = index.samples.at(-1)!
  if (
    segment.sourcePtsStart !== first.sourcePts ||
    segment.sourcePtsEnd !== last.sourcePts + last.durationPts ||
    segment.captureStartUs !== index.availableStartUs ||
    segment.captureEndUs !== index.availableEndUs ||
    segment.firstFrameIndex !== first.captureFrameIndex ||
    segment.frameCount !== BigInt(index.samples.length)
  ) {
    fail('ARTIFACT_CONFLICT')
  }
  return index
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class PrismaIngestRepository {
  readonly #client: PrismaClient
  readonly #plannerConfig: CaptureEpochPlannerConfig
  readonly #maxTransactionAttempts: number
  readonly #now: () => Date
  readonly #liveArchiveBackend: 'legacy' | 'media_extent'

  constructor(client: PrismaClient, options: PrismaIngestRepositoryOptions = {}) {
    const plannerConfig = {
      canonicalSessionOriginUs: options.plannerConfig?.canonicalSessionOriginUs ?? 0n,
      canonicalFrameOrigin: options.plannerConfig?.canonicalFrameOrigin ?? 0n,
      timestampToleranceUs: options.plannerConfig?.timestampToleranceUs ?? 250_000n,
    }
    if (
      plannerConfig.canonicalSessionOriginUs < 0n ||
      plannerConfig.canonicalFrameOrigin < 0n ||
      plannerConfig.timestampToleranceUs < 0n
    ) {
      fail('INVALID_INPUT')
    }
    const attempts = options.maxTransactionAttempts ?? 4
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      fail('INVALID_INPUT')
    }
    this.#client = client
    this.#plannerConfig = plannerConfig
    this.#maxTransactionAttempts = attempts
    this.#now = options.now ?? (() => new Date())
    this.#liveArchiveBackend = options.liveArchiveBackend ?? 'media_extent'
  }

  async #transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.#maxTransactionAttempts; attempt += 1) {
      try {
        return await this.#client.$transaction(operation, {
          isolationLevel: 'Serializable',
        })
      } catch (error) {
        if (error instanceof PrismaIngestRepositoryError) throw error
        if (isRetryableTransactionError(error)) {
          if (attempt === this.#maxTransactionAttempts) {
            fail('TRANSACTION_RETRY_EXHAUSTED')
          }
          continue
        }
        fail('DATABASE_FAILURE')
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED')
  }

  async #reserveExtentUploading(
    tx: Tx,
    input: FinalizedSegmentReservationInput,
    requestedArtifacts: ArtifactMap<IngestArtifactReservation>,
    session: { sourceKind: string },
  ): Promise<FinalizedSegmentReservation> {
    if (!input.extent) return fail('INVALID_INPUT')
    const programs = await tx.dvrProgram.findMany({
      orderBy: { createdAt: 'asc' },
      where: { captureSessionId: input.captureSessionId },
    })
    if (programs.length > 1) return fail('PROGRAM_CONFLICT')
    let program = programs[0]
    if (program && !sameProfile(program, input.programProfile)) return fail('PROGRAM_CONFLICT')
    if (program && !['STARTING', 'LIVE', 'STOPPING'].includes(program.status))
      return fail('PROGRAM_CONFLICT')
    if (!program) {
      program = await tx.dvrProgram.create({
        data: {
          captureSessionId: input.captureSessionId,
          fpsNum: input.programProfile.fpsNum,
          fpsDen: input.programProfile.fpsDen,
          timeBaseNum: input.programProfile.timeBaseNum,
          timeBaseDen: input.programProfile.timeBaseDen,
        },
      })
    }

    const replay = await tx.mediaExtent.findUnique({
      include: extentIncludes,
      where: { sourceJobId: input.extent.sourceJobId },
    })
    if (replay) {
      if (
        replay.captureSessionId !== input.captureSessionId ||
        replay.dvrProgramId !== program.id ||
        replay.localPath !== input.extent.localPath ||
        replay.finalizedAt?.getTime() !== input.extent.finalizedAt.getTime() ||
        replay.sequenceNumber === null ||
        replay.discontinuitySequence === null
      ) {
        return fail('RESERVATION_CONFLICT')
      }
      const pending = await tx.mediaExtent.findMany({
        select: { id: true },
        where: { dvrProgramId: program.id, status: { not: 'ARCHIVE_VERIFIED' } },
      })
      if (
        replay.status !== 'ARCHIVE_VERIFIED' &&
        (pending.length !== 1 || pending[0]!.id !== replay.id)
      ) {
        return fail('FIFO_BLOCKED')
      }
      const predecessor = await tx.mediaExtent.findFirst({
        include: extentIncludes,
        orderBy: { sequenceNumber: 'desc' },
        where: {
          dvrProgramId: program.id,
          sequenceNumber: { lt: replay.sequenceNumber },
          status: 'ARCHIVE_VERIFIED',
        },
      })
      const plan = planFrom(
        input,
        predecessor ? buildExtentHead(predecessor) : null,
        this.#plannerConfig,
      )
      assertExtentMatchesPlan(
        replay,
        plan,
        predecessor?.sequenceNumber === null || predecessor?.sequenceNumber === undefined
          ? 0n
          : predecessor.sequenceNumber + 1n,
        replay.status !== 'FINALIZED_LOCAL',
      )
      if (
        replay.bucket !== requestedArtifacts.media.location.bucket ||
        replay.objectKey !== requestedArtifacts.media.location.key ||
        (replay.initBucket !== null &&
          (replay.initBucket !== requestedArtifacts.init.location.bucket ||
            replay.initObjectKey !== requestedArtifacts.init.location.key)) ||
        (replay.sampleIndexBucket !== null &&
          (replay.sampleIndexBucket !== requestedArtifacts['sample-index'].location.bucket ||
            replay.sampleIndexObjectKey !== requestedArtifacts['sample-index'].location.key))
      ) {
        return fail('ARTIFACT_CONFLICT')
      }
      const epochId = replay.captureEpochId ?? plan.epoch.epochKey
      return {
        disposition: replay.status === 'ARCHIVE_VERIFIED' ? 'ALREADY_READY' : 'RESUMED',
        reference: {
          captureSessionId: input.captureSessionId,
          dvrProgramId: program.id,
          dvrSegmentId: replay.id,
          sampleIndexAssetId: replay.id,
          sampleIndexLocation: requestedArtifacts['sample-index'].location,
          mediaExtentId: replay.id,
          captureEpochId: epochId,
        },
        captureEpochId: epochId,
        sequenceNumber: replay.sequenceNumber,
        createdNewEpoch: plan.epoch.disposition === 'CREATE_NEXT',
        plan,
        sampleIndex: plan.segment.sampleIndex,
        artifacts: extentReservedArtifacts(replay, requestedArtifacts),
      }
    }

    if (
      (await tx.mediaExtent.count({
        where: { dvrProgramId: program.id, status: { not: 'ARCHIVE_VERIFIED' } },
      })) !== 0
    ) {
      return fail('FIFO_BLOCKED')
    }
    const locations = (['init', 'media', 'sample-index'] as const).map(
      kind => requestedArtifacts[kind].location,
    )
    const [occupiedAssets, occupiedExtents] = await Promise.all([
      tx.mediaAsset.count({
        where: {
          OR: locations.map(location => ({ bucket: location.bucket, objectKey: location.key })),
        },
      }),
      tx.mediaExtent.count({
        where: {
          OR: locations.flatMap(location => [
            { bucket: location.bucket, objectKey: location.key },
            { initBucket: location.bucket, initObjectKey: location.key },
            { sampleIndexBucket: location.bucket, sampleIndexObjectKey: location.key },
          ]),
        },
      }),
    ])
    if (occupiedAssets !== 0 || occupiedExtents !== 0) return fail('ARTIFACT_CONFLICT')

    const lastExtent = await tx.mediaExtent.findFirst({
      include: extentIncludes,
      orderBy: { sequenceNumber: 'desc' },
      where: { dvrProgramId: program.id, status: 'ARCHIVE_VERIFIED' },
    })
    const sequenceNumber =
      lastExtent?.sequenceNumber === null || !lastExtent ? 0n : lastExtent.sequenceNumber + 1n
    if (sequenceNumber < 0n || sequenceNumber > INT64_MAX) return fail('TIMELINE_CONFLICT')
    const currentHead = lastExtent ? buildExtentHead(lastExtent) : null
    const currentEpoch = await tx.captureEpoch.findFirst({
      orderBy: { sequenceIndex: 'desc' },
      where: { captureSessionId: input.captureSessionId },
    })
    const provisionalEpochMatchesHead = Boolean(
      currentHead &&
      currentEpoch?.discontinuityReason === OME_PROVISIONAL_EPOCH_REASON &&
      currentEpoch.sequenceIndex === currentHead.epochSequence + 1 &&
      currentEpoch.sourcePtsOrigin === 0n &&
      currentEpoch.captureTimeOriginUs === currentHead.lastCaptureEndUs &&
      currentEpoch.captureFrameOrigin === currentHead.lastCaptureFrameIndex + 1n &&
      currentEpoch.startedAtCaptureUs === currentHead.lastCaptureEndUs &&
      currentEpoch.endedAtCaptureUs === null,
    )
    if (
      (currentHead === null && currentEpoch !== null) ||
      (currentHead !== null &&
        currentEpoch?.id !== currentHead.epochId &&
        !provisionalEpochMatchesHead)
    ) {
      return fail('TIMELINE_CONFLICT')
    }
    const planningInput = provisionalEpochMatchesHead
      ? { ...input, newEpochId: currentEpoch!.id }
      : input
    const plan = planFrom(planningInput, currentHead, this.#plannerConfig)
    let epochId: string
    if (plan.epoch.disposition === 'CREATE_NEXT') {
      if (provisionalEpochMatchesHead) {
        if (!currentEpoch || currentEpoch.id !== plan.epoch.epochKey)
          return fail('TIMELINE_CONFLICT')
        await tx.captureEpoch.update({
          data: { discontinuityReason: persistedReason(plan.epoch.reasons) },
          where: { id: currentEpoch.id },
        })
        epochId = currentEpoch.id
      } else {
        if (await tx.captureEpoch.findUnique({ where: { id: input.newEpochId } }))
          return fail('RESERVATION_CONFLICT')
        const epoch = await tx.captureEpoch.create({
          data: {
            id: plan.epoch.epochKey,
            captureSessionId: input.captureSessionId,
            sequenceIndex: plan.epoch.epochSequence,
            sourceTimeBaseNum: Number(plan.epoch.timeBase.num),
            sourceTimeBaseDen: Number(plan.epoch.timeBase.den),
            sourcePtsOrigin: plan.epoch.sourcePtsOrigin,
            captureTimeOriginUs: plan.epoch.captureTimeOriginUs,
            captureFrameOrigin: plan.epoch.captureFrameOrigin,
            startedAtCaptureUs: plan.epoch.captureTimeOriginUs,
            discontinuityReason: persistedReason(plan.epoch.reasons),
          },
        })
        epochId = epoch.id
      }
    } else {
      if (!currentEpoch || currentEpoch.id !== plan.epoch.epochKey) return fail('TIMELINE_CONFLICT')
      epochId = currentEpoch.id
    }
    const created = await tx.mediaExtent.create({
      data: {
        captureSessionId: input.captureSessionId,
        dvrProgramId: program.id,
        sourceJobId: input.extent.sourceJobId,
        source: session.sourceKind,
        startUs: plan.segment.captureStartUs,
        endUs: plan.segment.captureEndUs,
        sequenceNumber,
        discontinuitySequence: plan.segment.discontinuitySequence,
        localPath: input.extent.localPath,
        finalizedAt: input.extent.finalizedAt,
        bucket: requestedArtifacts.media.location.bucket,
        objectKey: requestedArtifacts.media.location.key,
        status: 'FINALIZED_LOCAL',
      },
      include: extentIncludes,
    })
    return {
      disposition: 'RESERVED',
      reference: {
        captureSessionId: input.captureSessionId,
        dvrProgramId: program.id,
        dvrSegmentId: created.id,
        sampleIndexAssetId: created.id,
        sampleIndexLocation: requestedArtifacts['sample-index'].location,
        mediaExtentId: created.id,
        captureEpochId: epochId,
      },
      captureEpochId: epochId,
      sequenceNumber,
      createdNewEpoch: plan.epoch.disposition === 'CREATE_NEXT',
      plan,
      sampleIndex: plan.segment.sampleIndex,
      artifacts: extentReservedArtifacts(created, requestedArtifacts),
    }
  }

  async reserveUploading(
    input: FinalizedSegmentReservationInput,
  ): Promise<FinalizedSegmentReservation> {
    const requestedArtifacts = validateReservationInput(input)
    return this.#transaction(async tx => {
      await advisoryLock(tx, input.captureSessionId)
      const session = await tx.captureSession.findUnique({
        where: { id: input.captureSessionId },
      })
      if (!session) return fail('SESSION_NOT_FOUND')
      if (!['STARTING', 'LIVE', 'STOPPING'].includes(session.status)) {
        return fail('SESSION_TERMINAL')
      }
      if (
        this.#liveArchiveBackend === 'media_extent' &&
        isLiveCaptureSourceKind(session.sourceKind)
      ) {
        return this.#reserveExtentUploading(tx, input, requestedArtifacts, session)
      }

      const programs = await tx.dvrProgram.findMany({
        orderBy: { createdAt: 'asc' },
        where: { captureSessionId: input.captureSessionId },
      })
      if (programs.length > 1) return fail('PROGRAM_CONFLICT')
      let program = programs[0]
      if (program && !sameProfile(program, input.programProfile)) {
        return fail('PROGRAM_CONFLICT')
      }
      if (program && !['STARTING', 'LIVE', 'STOPPING'].includes(program.status)) {
        return fail('PROGRAM_CONFLICT')
      }
      if (!program) {
        program = await tx.dvrProgram.create({
          data: {
            captureSessionId: input.captureSessionId,
            fpsNum: input.programProfile.fpsNum,
            fpsDen: input.programProfile.fpsDen,
            timeBaseNum: input.programProfile.timeBaseNum,
            timeBaseDen: input.programProfile.timeBaseDen,
          },
        })
      }

      const replay = await findSegmentBySampleLocation(
        tx,
        requestedArtifacts['sample-index'].location,
      )
      if (replay) {
        if (
          replay.dvrProgramId !== program.id ||
          replay.program.captureSessionId !== input.captureSessionId
        ) {
          return fail('RESERVATION_CONFLICT')
        }
        assertArtifactRelationships(replay, requestedArtifacts)
        const unready = await tx.dvrSegment.findMany({
          select: { id: true },
          where: { dvrProgramId: program.id, readyAt: null },
        })
        if (replay.readyAt === null && (unready.length !== 1 || unready[0]!.id !== replay.id)) {
          return fail('FIFO_BLOCKED')
        }
        if (
          replay.readyAt === null &&
          (await tx.dvrSegment.count({
            where: {
              dvrProgramId: program.id,
              sequenceNumber: { gt: replay.sequenceNumber },
            },
          })) !== 0
        ) {
          return fail('FIFO_BLOCKED')
        }
        const predecessor = await findReadyPredecessor(tx, program.id, replay.sequenceNumber)
        const expectedSequence = predecessor ? predecessor.sequenceNumber + 1n : 0n
        const plan = planFrom(
          input,
          predecessor ? buildHead(predecessor) : null,
          this.#plannerConfig,
        )
        assertSegmentMatchesPlan(replay, plan, expectedSequence)
        const assets = segmentAssets(replay)
        const allReady =
          replay.readyAt !== null &&
          Object.values(assets).every(
            asset =>
              asset.state === 'READY' &&
              asset.readyAt !== null &&
              asset.byteLength !== null &&
              asset.byteLength > 0n &&
              asset.sha256 !== null &&
              SHA256.test(asset.sha256),
          )
        const allUploading =
          replay.readyAt === null &&
          Object.values(assets).every(
            asset => asset.state === 'UPLOADING' && asset.readyAt === null,
          )
        if (!allReady && !allUploading) return fail('RESERVATION_CONFLICT')
        return {
          disposition: allReady ? 'ALREADY_READY' : 'RESUMED',
          reference: makeReference(replay),
          captureEpochId: replay.captureEpochId,
          sequenceNumber: replay.sequenceNumber,
          createdNewEpoch: plan.epoch.disposition === 'CREATE_NEXT',
          plan,
          sampleIndex: plan.segment.sampleIndex,
          artifacts: reservedArtifacts(replay, requestedArtifacts),
        }
      }

      const occupiedLocations = await tx.mediaAsset.count({
        where: {
          OR: (['init', 'media', 'sample-index'] as const).map(kind => ({
            bucket: requestedArtifacts[kind].location.bucket,
            objectKey: requestedArtifacts[kind].location.key,
          })),
        },
      })
      if (occupiedLocations !== 0) return fail('ARTIFACT_CONFLICT')

      if (
        await tx.dvrSegment.count({
          where: { dvrProgramId: program.id, readyAt: null },
        })
      ) {
        return fail('FIFO_BLOCKED')
      }
      const lastSegment = await tx.dvrSegment.findFirst({
        include: artifactIncludes,
        orderBy: { sequenceNumber: 'desc' },
        where: { dvrProgramId: program.id },
      })
      if (lastSegment && (lastSegment.readyAt === null || lastSegment.isGap)) {
        return fail('TIMELINE_CONFLICT')
      }
      const sequenceNumber = lastSegment ? lastSegment.sequenceNumber + 1n : 0n
      if (sequenceNumber < 0n || sequenceNumber > INT64_MAX) {
        return fail('TIMELINE_CONFLICT')
      }
      const currentHead = lastSegment ? buildHead(lastSegment) : null
      const currentEpoch = await tx.captureEpoch.findFirst({
        orderBy: { sequenceIndex: 'desc' },
        where: { captureSessionId: input.captureSessionId },
      })
      const provisionalEpochMatchesHead = Boolean(
        currentHead &&
        currentEpoch?.discontinuityReason === OME_PROVISIONAL_EPOCH_REASON &&
        currentEpoch.sequenceIndex === currentHead.epochSequence + 1 &&
        currentEpoch.sourcePtsOrigin === 0n &&
        currentEpoch.captureTimeOriginUs === currentHead.lastCaptureEndUs &&
        currentEpoch.captureFrameOrigin === currentHead.lastCaptureFrameIndex + 1n &&
        currentEpoch.startedAtCaptureUs === currentHead.lastCaptureEndUs &&
        currentEpoch.endedAtCaptureUs === null,
      )
      if (
        (currentHead === null && currentEpoch !== null) ||
        (currentHead !== null &&
          currentEpoch?.id !== currentHead.epochId &&
          !provisionalEpochMatchesHead)
      ) {
        return fail('TIMELINE_CONFLICT')
      }
      const planningInput = provisionalEpochMatchesHead
        ? { ...input, newEpochId: currentEpoch!.id }
        : input
      const plan = planFrom(planningInput, currentHead, this.#plannerConfig)
      let epochId: string
      if (plan.epoch.disposition === 'CREATE_NEXT') {
        if (provisionalEpochMatchesHead) {
          if (
            !currentEpoch ||
            currentEpoch.id !== plan.epoch.epochKey ||
            currentEpoch.sequenceIndex !== plan.epoch.epochSequence ||
            currentEpoch.sourceTimeBaseNum !== Number(plan.epoch.timeBase.num) ||
            currentEpoch.sourceTimeBaseDen !== Number(plan.epoch.timeBase.den) ||
            currentEpoch.sourcePtsOrigin !== plan.epoch.sourcePtsOrigin ||
            currentEpoch.captureTimeOriginUs !== plan.epoch.captureTimeOriginUs ||
            currentEpoch.captureFrameOrigin !== plan.epoch.captureFrameOrigin
          ) {
            return fail('TIMELINE_CONFLICT')
          }
          await tx.captureEpoch.update({
            data: { discontinuityReason: persistedReason(plan.epoch.reasons) },
            where: { id: currentEpoch.id },
          })
          epochId = currentEpoch.id
        } else {
          if (await tx.captureEpoch.findUnique({ where: { id: input.newEpochId } })) {
            return fail('RESERVATION_CONFLICT')
          }
          const epoch = await tx.captureEpoch.create({
            data: {
              id: plan.epoch.epochKey,
              captureSessionId: input.captureSessionId,
              sequenceIndex: plan.epoch.epochSequence,
              sourceTimeBaseNum: Number(plan.epoch.timeBase.num),
              sourceTimeBaseDen: Number(plan.epoch.timeBase.den),
              sourcePtsOrigin: plan.epoch.sourcePtsOrigin,
              captureTimeOriginUs: plan.epoch.captureTimeOriginUs,
              captureFrameOrigin: plan.epoch.captureFrameOrigin,
              startedAtCaptureUs: plan.epoch.captureTimeOriginUs,
              discontinuityReason: persistedReason(plan.epoch.reasons),
            },
          })
          epochId = epoch.id
        }
      } else {
        if (!currentEpoch || currentEpoch.id !== plan.epoch.epochKey) {
          return fail('TIMELINE_CONFLICT')
        }
        epochId = currentEpoch.id
      }
      if (plan.segment.sampleIndex.epochId !== epochId) {
        return fail('TIMELINE_CONFLICT')
      }

      const createdAssets = {} as Record<IngestArtifactKind, { id: string }>
      for (const kind of ['init', 'media', 'sample-index'] as const) {
        const artifact = requestedArtifacts[kind]
        createdAssets[kind] = await tx.mediaAsset.create({
          data: {
            kind: dbKind(kind),
            bucket: artifact.location.bucket,
            objectKey: artifact.location.key,
            contentType: artifact.contentType,
            internalSchemaVersion: artifact.internalSchemaVersion,
            state: 'UPLOADING',
          },
          select: { id: true },
        })
      }
      const segment = await tx.dvrSegment.create({
        data: {
          dvrProgramId: program.id,
          captureEpochId: epochId,
          sequenceNumber,
          discontinuitySequence: plan.segment.discontinuitySequence,
          captureStartUs: plan.segment.captureStartUs,
          captureEndUs: plan.segment.captureEndUs,
          sourcePtsStart: plan.segment.sourcePtsStart,
          sourcePtsEnd: plan.segment.sourcePtsEndExclusive,
          firstFrameIndex: plan.segment.firstFrameIndex,
          frameCount: plan.segment.frameCount,
          durationUs: plan.segment.durationUs,
          isGap: false,
          initAssetId: createdAssets.init.id,
          mediaAssetId: createdAssets.media.id,
          sampleIndexAssetId: createdAssets['sample-index'].id,
        },
        include: artifactIncludes,
      })
      assertSegmentMatchesPlan(segment, plan, sequenceNumber)
      return {
        disposition: 'RESERVED',
        reference: makeReference(segment),
        captureEpochId: epochId,
        sequenceNumber,
        createdNewEpoch: plan.epoch.disposition === 'CREATE_NEXT',
        plan,
        sampleIndex: plan.segment.sampleIndex,
        artifacts: reservedArtifacts(segment, requestedArtifacts),
      }
    })
  }

  async #readExtentReservation(
    tx: Tx,
    reference: IngestReservationReference,
  ): Promise<ExtentWithEpoch> {
    if (!reference.mediaExtentId || !reference.captureEpochId) return fail('RESERVATION_CONFLICT')
    const extent = await tx.mediaExtent.findUnique({
      include: extentIncludes,
      where: { id: reference.mediaExtentId },
    })
    if (
      !extent ||
      extent.id !== reference.dvrSegmentId ||
      extent.id !== reference.sampleIndexAssetId ||
      extent.captureSessionId !== reference.captureSessionId ||
      extent.dvrProgramId !== reference.dvrProgramId
    ) {
      return fail('RESERVATION_CONFLICT')
    }
    return extent
  }

  async #recordExtentArtifactExpectations(
    tx: Tx,
    input: RecordArtifactExpectationsInput,
    expected: ArtifactMap<IngestArtifactExpectation>,
  ): Promise<void> {
    const extent = await this.#readExtentReservation(tx, input.reservation)
    const epoch = await tx.captureEpoch.findUnique({
      where: { id: input.reservation.captureEpochId! },
    })
    if (!epoch || epoch.captureSessionId !== input.reservation.captureSessionId)
      return fail('RESERVATION_CONFLICT')
    let index: SampleIndex
    try {
      index = parseSampleIndexDocument(input.sampleIndexDocument, {
        epochId: epoch.id,
        sourcePtsOrigin: epoch.sourcePtsOrigin,
        captureTimeOriginUs: epoch.captureTimeOriginUs,
        captureFrameOrigin: epoch.captureFrameOrigin,
        timeBase: {
          num: BigInt(epoch.sourceTimeBaseNum),
          den: BigInt(epoch.sourceTimeBaseDen),
        },
      })
    } catch {
      return fail('ARTIFACT_CONFLICT')
    }
    const first = index.samples[0]!
    const last = index.samples.at(-1)!
    if (
      extent.startUs !== index.availableStartUs ||
      extent.endUs !== index.availableEndUs ||
      expected.media.location.bucket !== extent.bucket ||
      expected.media.location.key !== extent.objectKey ||
      !sameLocation(
        {
          bucket: expected['sample-index'].location.bucket,
          objectKey: expected['sample-index'].location.key,
        },
        input.reservation.sampleIndexLocation,
      )
    ) {
      return fail('ARTIFACT_CONFLICT')
    }
    const canonicalDocument = serializeSampleIndex(index)
    const indexBytes = Buffer.from(JSON.stringify(canonicalDocument), 'utf8')
    if (
      expected['sample-index'].byteLength !== BigInt(indexBytes.byteLength) ||
      expected['sample-index'].sha256 !== sha256(indexBytes)
    ) {
      return fail('ARTIFACT_CONFLICT')
    }
    const projection = {
      captureEpochId: epoch.id,
      sourcePtsStart: first.sourcePts,
      sourcePtsEnd: last.sourcePts + last.durationPts,
      firstFrameIndex: first.captureFrameIndex,
      frameCount: BigInt(index.samples.length),
      sampleIndexBucket: expected['sample-index'].location.bucket,
      sampleIndexObjectKey: expected['sample-index'].location.key,
      sampleIndexSha256: expected['sample-index'].sha256,
      sampleIndexBytes: expected['sample-index'].byteLength,
      sampleIndexSchemaVersion: expected['sample-index'].internalSchemaVersion,
      mediaSha256: expected.media.sha256,
      mediaSchemaVersion: expected.media.internalSchemaVersion,
      initBucket: expected.init.location.bucket,
      initObjectKey: expected.init.location.key,
      initSha256: expected.init.sha256,
      initBytes: expected.init.byteLength,
      initSchemaVersion: expected.init.internalSchemaVersion,
      bytes: expected.media.byteLength,
    }
    const existingValues = [
      extent.captureEpochId,
      extent.sourcePtsStart,
      extent.sourcePtsEnd,
      extent.firstFrameIndex,
      extent.frameCount,
      extent.sampleIndexBucket,
      extent.sampleIndexObjectKey,
      extent.sampleIndexSha256,
      extent.sampleIndexBytes,
      extent.sampleIndexSchemaVersion,
      extent.mediaSha256,
      extent.mediaSchemaVersion,
      extent.initBucket,
      extent.initObjectKey,
      extent.initSha256,
      extent.initBytes,
      extent.initSchemaVersion,
      extent.bytes,
    ]
    const empty = existingValues.every(value => value === null)
    if (!empty) {
      for (const [key, value] of Object.entries(projection)) {
        if (Reflect.get(extent, key) !== value) return fail('ARTIFACT_CONFLICT')
      }
      return
    }
    if (extent.status !== 'FINALIZED_LOCAL') return fail('RESERVATION_CONFLICT')
    await tx.mediaExtent.update({
      data: { ...projection, catalogedAt: this.#now(), status: 'ARCHIVE_PENDING' },
      where: { id: extent.id },
    })
  }

  async recordArtifactExpectations(input: RecordArtifactExpectationsInput): Promise<void> {
    validateReference(input.reservation)
    const expected = artifactMap(input.artifacts, true)
    await this.#transaction(async tx => {
      await advisoryLock(tx, input.reservation.captureSessionId)
      if (input.reservation.mediaExtentId) {
        return this.#recordExtentArtifactExpectations(tx, input, expected)
      }
      const segment = await readReservation(tx, input.reservation)
      const reservationMetadata = expected as ArtifactMap<IngestArtifactReservation>
      assertArtifactRelationships(segment, reservationMetadata)
      const index = sampleIndexForExpectation(segment, input.sampleIndexDocument)
      const canonicalDocument = serializeSampleIndex(index)
      const indexBytes = Buffer.from(JSON.stringify(canonicalDocument), 'utf8')
      const indexExpectation = expected['sample-index']
      if (
        indexExpectation.byteLength !== BigInt(indexBytes.byteLength) ||
        indexExpectation.sha256 !== sha256(indexBytes)
      ) {
        return fail('ARTIFACT_CONFLICT')
      }
      const assets = segmentAssets(segment)
      const allReady =
        segment.readyAt !== null &&
        Object.values(assets).every(asset => asset.state === 'READY' && asset.readyAt !== null)
      const allUploading =
        segment.readyAt === null &&
        Object.values(assets).every(asset => asset.state === 'UPLOADING' && asset.readyAt === null)
      if (!allReady && !allUploading) return fail('ARTIFACT_CONFLICT')
      for (const kind of ['init', 'media', 'sample-index'] as const) {
        const asset = assets[kind]
        const expectation = expected[kind]
        if (asset.state === 'READY') {
          if (!sameExpectation(asset, expectation) || asset.readyAt === null) {
            return fail('ARTIFACT_CONFLICT')
          }
          continue
        }
        if (asset.state !== 'UPLOADING' || asset.readyAt !== null) {
          return fail('ARTIFACT_CONFLICT')
        }
        if (asset.byteLength !== null || asset.sha256 !== null) {
          if (!sameExpectation(asset, expectation)) {
            return fail('ARTIFACT_CONFLICT')
          }
          continue
        }
        await tx.mediaAsset.update({
          data: {
            byteLength: expectation.byteLength,
            sha256: expectation.sha256,
          },
          where: { id: asset.id },
        })
      }
    })
  }

  async #publishExtentReady(
    tx: Tx,
    input: PublishReadyInput,
    verified: ArtifactMap<IngestArtifactExpectation>,
  ): Promise<PublishReadyResult> {
    if (!input.extent) return fail('INVALID_INPUT')
    const extent = await this.#readExtentReservation(tx, input.reservation)
    if (
      extent.sourceJobId !== input.extent.sourceJobId ||
      extent.localPath !== input.extent.localPath ||
      extent.finalizedAt?.getTime() !== input.extent.finalizedAt.getTime() ||
      !extent.captureEpoch ||
      extent.captureEpochId !== input.reservation.captureEpochId ||
      extent.sequenceNumber === null ||
      extent.discontinuitySequence === null ||
      extent.sourcePtsStart === null ||
      extent.sourcePtsEnd === null ||
      extent.firstFrameIndex === null ||
      extent.frameCount === null
    ) {
      return fail('RESERVATION_CONFLICT')
    }
    const expectedProjection = {
      media: {
        bucket: extent.bucket,
        key: extent.objectKey,
        sha256: extent.mediaSha256,
        bytes: extent.bytes,
        schema: extent.mediaSchemaVersion,
      },
      init: {
        bucket: extent.initBucket,
        key: extent.initObjectKey,
        sha256: extent.initSha256,
        bytes: extent.initBytes,
        schema: extent.initSchemaVersion,
      },
      'sample-index': {
        bucket: extent.sampleIndexBucket,
        key: extent.sampleIndexObjectKey,
        sha256: extent.sampleIndexSha256,
        bytes: extent.sampleIndexBytes,
        schema: extent.sampleIndexSchemaVersion,
      },
    } as const
    for (const kind of ['init', 'media', 'sample-index'] as const) {
      const projection = expectedProjection[kind]
      const artifact = verified[kind]
      if (
        projection.bucket !== artifact.location.bucket ||
        projection.key !== artifact.location.key ||
        projection.sha256 !== artifact.sha256 ||
        projection.bytes !== artifact.byteLength ||
        projection.schema !== artifact.internalSchemaVersion
      ) {
        return fail('EXPECTATIONS_REQUIRED')
      }
    }
    const program = await tx.dvrProgram.findUnique({ where: { id: extent.dvrProgramId } })
    const session = await tx.captureSession.findUnique({
      select: {
        completionExpectedSegments: true,
        sourceDurationUs: true,
        startedAt: true,
        status: true,
      },
      where: { id: extent.captureSessionId },
    })
    if (!program || !session) return fail('SESSION_NOT_FOUND')
    if (extent.status === 'ARCHIVE_VERIFIED') {
      if (!extent.archiveVerifiedAt) return fail('RESERVATION_CONFLICT')
      return {
        disposition: 'ALREADY_READY',
        readyAt: extent.archiveVerifiedAt,
        playlistRevision: program.playlistRevision,
      }
    }
    if (extent.status !== 'ARCHIVE_PENDING') return fail('EXPECTATIONS_REQUIRED')
    if (
      (await tx.mediaExtent.count({
        where: {
          dvrProgramId: extent.dvrProgramId,
          id: { not: extent.id },
          OR: [
            { status: { not: 'ARCHIVE_VERIFIED' } },
            { sequenceNumber: { gt: extent.sequenceNumber } },
          ],
        },
      })) !== 0
    ) {
      return fail('FIFO_BLOCKED')
    }
    if (program.playlistRevision === INT64_MAX) return fail('REVISION_EXHAUSTED')
    if (!['STARTING', 'LIVE', 'STOPPING'].includes(session.status)) return fail('SESSION_TERMINAL')
    const firstExtent = await tx.mediaExtent.findFirst({
      orderBy: { sequenceNumber: 'asc' },
      select: { startUs: true },
      where: { dvrProgramId: extent.dvrProgramId },
    })
    if (!firstExtent || extent.endUs <= firstExtent.startUs) return fail('TIMELINE_CONFLICT')
    const predecessor = await tx.mediaExtent.findFirst({
      include: extentIncludes,
      orderBy: { sequenceNumber: 'desc' },
      where: {
        dvrProgramId: extent.dvrProgramId,
        sequenceNumber: { lt: extent.sequenceNumber },
        status: 'ARCHIVE_VERIFIED',
      },
    })
    const readyAt = this.#now()
    if (!(readyAt instanceof Date) || Number.isNaN(readyAt.getTime())) return fail('INVALID_INPUT')
    await tx.mediaExtent.update({
      data: {
        archiveVerifiedAt: readyAt,
        catalogedAt: extent.catalogedAt ?? readyAt,
        status: 'ARCHIVE_VERIFIED',
      },
      where: { id: extent.id },
    })
    await validateOmePresentationAnchor(tx, {
      captureSessionId: extent.captureSessionId,
      captureEpochId: extent.captureEpochId,
      captureTimeOriginUs: extent.captureEpoch.captureTimeOriginUs,
      extent: input.extent,
      readyAt,
    })
    if (
      predecessor?.captureEpochId &&
      predecessor.captureEpochId !== extent.captureEpochId &&
      predecessor.captureEpoch?.endedAtCaptureUs === null
    ) {
      await tx.captureEpoch.update({
        data: { endedAtCaptureUs: extent.startUs },
        where: { id: predecessor.captureEpochId },
      })
    }
    const updatedProgram = await tx.dvrProgram.update({
      data: {
        status: program.status === 'STARTING' ? 'LIVE' : program.status,
        liveEdgeUs: extent.endUs,
        durationUs: extent.endUs - firstExtent.startUs,
        playlistRevision: { increment: 1n },
      },
      where: { id: extent.dvrProgramId },
    })
    await tx.captureSession.update({
      data: {
        status: session.status === 'STARTING' ? 'LIVE' : session.status,
        health: 'HEALTHY',
        startedAt: session.startedAt ?? readyAt,
      },
      where: { id: extent.captureSessionId },
    })
    if (session.status === 'STOPPING' && session.completionExpectedSegments !== null) {
      const [readyExtents, pendingExtents] = await Promise.all([
        tx.mediaExtent.count({
          where: { dvrProgramId: extent.dvrProgramId, status: 'ARCHIVE_VERIFIED' },
        }),
        tx.mediaExtent.count({
          where: { dvrProgramId: extent.dvrProgramId, status: { not: 'ARCHIVE_VERIFIED' } },
        }),
      ])
      if (readyExtents >= session.completionExpectedSegments && pendingExtents === 0) {
        const endedAt = this.#now()
        await tx.dvrProgram.update({
          data: { status: 'FINISHED' },
          where: { id: extent.dvrProgramId },
        })
        await tx.captureEpoch.updateMany({
          data: { endedAtCaptureUs: extent.endUs },
          where: { captureSessionId: extent.captureSessionId, endedAtCaptureUs: null },
        })
        await tx.captureSession.update({
          data: {
            endedAt,
            health: 'OFFLINE',
            sourceDurationUs: session.sourceDurationUs ?? updatedProgram.durationUs,
            status: 'FINISHED',
          },
          where: { id: extent.captureSessionId },
        })
        await tx.outboxEvent.create({
          data: {
            aggregateId: extent.captureSessionId,
            aggregateType: 'CaptureSession',
            dedupeKey: `capture-source-completed:${extent.captureSessionId}`,
            eventType: 'capture.source_completed.v1',
            payload: {
              capture_session_id: extent.captureSessionId,
              ended_at: endedAt.toISOString(),
              final_capture_time_us: extent.endUs.toString(),
            },
          },
        })
      }
    }
    return { disposition: 'PUBLISHED', readyAt, playlistRevision: updatedProgram.playlistRevision }
  }

  async publishReady(input: PublishReadyInput): Promise<PublishReadyResult> {
    validateReference(input.reservation)
    if (input.extent) validateExtentPublication(input.extent)
    const verified = artifactMap(input.verifiedArtifacts, true)
    return this.#transaction(async tx => {
      await advisoryLock(tx, input.reservation.captureSessionId)
      if (input.reservation.mediaExtentId) {
        return this.#publishExtentReady(tx, input, verified)
      }
      const segment = await readReservation(tx, input.reservation)
      assertArtifactRelationships(segment, verified as ArtifactMap<IngestArtifactReservation>)
      const assets = segmentAssets(segment)
      for (const kind of ['init', 'media', 'sample-index'] as const) {
        if (!sameExpectation(assets[kind], verified[kind])) {
          return fail('EXPECTATIONS_REQUIRED')
        }
      }
      const session = await tx.captureSession.findUnique({
        select: {
          completionExpectedSegments: true,
          sourceDurationUs: true,
          sourceKind: true,
          startedAt: true,
          status: true,
        },
        where: { id: input.reservation.captureSessionId },
      })
      if (!session) return fail('SESSION_NOT_FOUND')
      const allReady =
        segment.readyAt !== null &&
        Object.values(assets).every(asset => asset.state === 'READY' && asset.readyAt !== null)
      if (allReady) {
        const timestamps = Object.values(assets).map(asset => asset.readyAt!.getTime())
        if (timestamps.some(value => value !== segment.readyAt!.getTime())) {
          return fail('RESERVATION_CONFLICT')
        }
        if (input.extent) {
          await catalogVerifiedExtent(tx, {
            captureSessionId: input.reservation.captureSessionId,
            captureEpochId: segment.captureEpochId,
            captureTimeOriginUs: segment.captureEpoch.captureTimeOriginUs,
            dvrProgramId: segment.dvrProgramId,
            dvrSegmentId: segment.id,
            sequenceNumber: segment.sequenceNumber,
            discontinuitySequence: segment.discontinuitySequence,
            sourcePtsStart: segment.sourcePtsStart,
            sourcePtsEnd: segment.sourcePtsEnd,
            firstFrameIndex: segment.firstFrameIndex,
            frameCount: segment.frameCount,
            source: session.sourceKind,
            startUs: segment.captureStartUs,
            endUs: segment.captureEndUs,
            extent: input.extent,
            init: verified.init,
            media: verified.media,
            sampleIndex: verified['sample-index'],
            readyAt: segment.readyAt!,
          })
        }
        return {
          disposition: 'ALREADY_READY',
          readyAt: segment.readyAt!,
          playlistRevision: segment.program.playlistRevision,
        }
      }
      if (
        segment.readyAt !== null ||
        Object.values(assets).some(asset => asset.state !== 'UPLOADING' || asset.readyAt !== null)
      ) {
        return fail('RESERVATION_CONFLICT')
      }
      if (
        (await tx.dvrSegment.count({
          where: {
            dvrProgramId: segment.dvrProgramId,
            id: { not: segment.id },
            OR: [{ readyAt: null }, { sequenceNumber: { gt: segment.sequenceNumber } }],
          },
        })) !== 0
      ) {
        return fail('FIFO_BLOCKED')
      }
      if (segment.program.playlistRevision === INT64_MAX) {
        return fail('REVISION_EXHAUSTED')
      }
      const firstSegment = await tx.dvrSegment.findFirst({
        orderBy: { sequenceNumber: 'asc' },
        select: { captureStartUs: true },
        where: { dvrProgramId: segment.dvrProgramId },
      })
      if (!firstSegment || segment.captureEndUs <= firstSegment.captureStartUs) {
        return fail('TIMELINE_CONFLICT')
      }
      if (segment.captureEpoch.endedAtCaptureUs !== null) {
        return fail('TIMELINE_CONFLICT')
      }
      if (!['STARTING', 'LIVE', 'STOPPING'].includes(session.status)) {
        return fail('SESSION_TERMINAL')
      }
      const predecessor = await findReadyPredecessor(
        tx,
        segment.dvrProgramId,
        segment.sequenceNumber,
      )
      if (predecessor && predecessor.captureEpochId !== segment.captureEpochId) {
        if (predecessor.captureEpoch.sequenceIndex + 1 !== segment.captureEpoch.sequenceIndex) {
          return fail('TIMELINE_CONFLICT')
        }
        if (
          predecessor.captureEpoch.endedAtCaptureUs !== null &&
          predecessor.captureEpoch.endedAtCaptureUs !== segment.captureStartUs
        ) {
          return fail('TIMELINE_CONFLICT')
        }
      }

      const readyAt = this.#now()
      if (!(readyAt instanceof Date) || Number.isNaN(readyAt.getTime())) {
        return fail('INVALID_INPUT')
      }
      for (const asset of Object.values(assets)) {
        await tx.mediaAsset.update({
          data: { state: 'READY', readyAt },
          where: { id: asset.id },
        })
      }
      await tx.dvrSegment.update({
        data: { readyAt },
        where: { id: segment.id },
      })
      if (input.extent) {
        await catalogVerifiedExtent(tx, {
          captureSessionId: input.reservation.captureSessionId,
          captureEpochId: segment.captureEpochId,
          captureTimeOriginUs: segment.captureEpoch.captureTimeOriginUs,
          dvrProgramId: segment.dvrProgramId,
          dvrSegmentId: segment.id,
          sequenceNumber: segment.sequenceNumber,
          discontinuitySequence: segment.discontinuitySequence,
          sourcePtsStart: segment.sourcePtsStart,
          sourcePtsEnd: segment.sourcePtsEnd,
          firstFrameIndex: segment.firstFrameIndex,
          frameCount: segment.frameCount,
          source: session.sourceKind,
          startUs: segment.captureStartUs,
          endUs: segment.captureEndUs,
          extent: input.extent,
          init: verified.init,
          media: verified.media,
          sampleIndex: verified['sample-index'],
          readyAt,
        })
      }
      if (
        predecessor &&
        predecessor.captureEpochId !== segment.captureEpochId &&
        predecessor.captureEpoch.endedAtCaptureUs === null
      ) {
        await tx.captureEpoch.update({
          data: { endedAtCaptureUs: segment.captureStartUs },
          where: { id: predecessor.captureEpochId },
        })
      }
      const program = await tx.dvrProgram.update({
        data: {
          status: segment.program.status === 'STARTING' ? 'LIVE' : segment.program.status,
          liveEdgeUs: segment.captureEndUs,
          durationUs: segment.captureEndUs - firstSegment.captureStartUs,
          playlistRevision: { increment: 1n },
        },
        where: { id: segment.dvrProgramId },
      })
      await tx.captureSession.update({
        data: {
          status: session.status === 'STARTING' ? 'LIVE' : session.status,
          health: 'HEALTHY',
          startedAt: session.startedAt ?? readyAt,
        },
        where: { id: input.reservation.captureSessionId },
      })
      if (session.status === 'STOPPING' && session.completionExpectedSegments !== null) {
        const [readySegments, pendingSegments] = await Promise.all([
          tx.dvrSegment.count({
            where: {
              dvrProgramId: segment.dvrProgramId,
              isGap: false,
              readyAt: { not: null },
            },
          }),
          tx.dvrSegment.count({
            where: { dvrProgramId: segment.dvrProgramId, readyAt: null },
          }),
        ])
        if (readySegments >= session.completionExpectedSegments && pendingSegments === 0) {
          const endedAt = this.#now()
          await tx.dvrProgram.update({
            data: { status: 'FINISHED' },
            where: { id: segment.dvrProgramId },
          })
          await tx.captureEpoch.updateMany({
            data: { endedAtCaptureUs: segment.captureEndUs },
            where: {
              captureSessionId: input.reservation.captureSessionId,
              endedAtCaptureUs: null,
            },
          })
          await tx.captureSession.update({
            data: {
              endedAt,
              health: 'OFFLINE',
              sourceDurationUs: session.sourceDurationUs ?? program.durationUs,
              status: 'FINISHED',
            },
            where: { id: input.reservation.captureSessionId },
          })
          await tx.outboxEvent.create({
            data: {
              aggregateId: input.reservation.captureSessionId,
              aggregateType: 'CaptureSession',
              dedupeKey: `capture-source-completed:${input.reservation.captureSessionId}`,
              eventType: 'capture.source_completed.v1',
              payload: {
                capture_session_id: input.reservation.captureSessionId,
                ended_at: endedAt.toISOString(),
                final_capture_time_us: segment.captureEndUs.toString(),
              },
            },
          })
        }
      }
      return {
        disposition: 'PUBLISHED',
        readyAt,
        playlistRevision: program.playlistRevision,
      }
    })
  }
}

export function createPrismaIngestRepository(
  client: PrismaClient,
  options: PrismaIngestRepositoryOptions = {},
) {
  return new PrismaIngestRepository(client, options)
}
