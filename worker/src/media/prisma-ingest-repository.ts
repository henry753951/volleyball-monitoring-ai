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
  timeBase: Rational
  samples: IncrementalFinalizedIndexedSegment['samples']
  sourceRestart: boolean
  timestampDiscontinuity: boolean
  explicitGapBeforeUs?: bigint
  artifacts: readonly IngestArtifactReservation[]
}

export type IngestReservationReference = {
  captureSessionId: string
  dvrProgramId: string
  dvrSegmentId: string
  sampleIndexAssetId: string
  sampleIndexLocation: IngestObjectLocation
}

export type ReservedArtifact = IngestArtifactReservation & {
  id: string
  state: 'UPLOADING' | 'READY'
  readyAt: Date | null
}

export type IngestReservationDisposition =
  | 'RESERVED'
  | 'RESUMED'
  | 'ALREADY_READY'

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
    location.key.split('/').some((part) => !part || part === '.' || part === '..')
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
    input.timeBase.den > BigInt(INT32_MAX) ||
    input.timeBase.num !== BigInt(input.programProfile.timeBaseNum) ||
    input.timeBase.den !== BigInt(input.programProfile.timeBaseDen)
  ) {
    fail('INVALID_INPUT')
  }
  if (
    typeof input.sourceRestart !== 'boolean' ||
    typeof input.timestampDiscontinuity !== 'boolean'
  ) {
    fail('INVALID_INPUT')
  }
  return artifactMap(input.artifacts, false)
}

function validateReference(reference: IngestReservationReference): void {
  requireUuid(reference.captureSessionId)
  requireUuid(reference.dvrProgramId)
  requireUuid(reference.dvrSegmentId)
  requireUuid(reference.sampleIndexAssetId)
  validateObjectLocation(reference.sampleIndexLocation)
}

function sameProfile(
  program: Pick<
    Prisma.DvrProgramModel,
    'fpsNum' | 'fpsDen' | 'timeBaseNum' | 'timeBaseDen'
  >,
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
    (['init', 'media', 'sample-index'] as const).map((kind) => [
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
    if (
      typeof value === 'string' &&
      ['P2034', '40001', '40P01'].includes(value)
    ) {
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
      ...(beforeSequence === undefined
        ? {}
        : { sequenceNumber: { lt: beforeSequence } }),
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
  const segment = await findSegmentBySampleLocation(
    tx,
    reference.sampleIndexLocation,
  )
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

  constructor(client: PrismaClient, options: PrismaIngestRepositoryOptions = {}) {
    const plannerConfig = {
      canonicalSessionOriginUs:
        options.plannerConfig?.canonicalSessionOriginUs ?? 0n,
      canonicalFrameOrigin: options.plannerConfig?.canonicalFrameOrigin ?? 0n,
      timestampToleranceUs:
        options.plannerConfig?.timestampToleranceUs ?? 250_000n,
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

  async reserveUploading(
    input: FinalizedSegmentReservationInput,
  ): Promise<FinalizedSegmentReservation> {
    const requestedArtifacts = validateReservationInput(input)
    return this.#transaction(async (tx) => {
      await advisoryLock(tx, input.captureSessionId)
      const session = await tx.captureSession.findUnique({
        where: { id: input.captureSessionId },
      })
      if (!session) return fail('SESSION_NOT_FOUND')
      if (!['STARTING', 'LIVE', 'STOPPING'].includes(session.status)) {
        return fail('SESSION_TERMINAL')
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
        if (
          replay.readyAt === null &&
          (unready.length !== 1 || unready[0]!.id !== replay.id)
        ) {
          return fail('FIFO_BLOCKED')
        }
        if (
          replay.readyAt === null &&
          await tx.dvrSegment.count({
            where: {
              dvrProgramId: program.id,
              sequenceNumber: { gt: replay.sequenceNumber },
            },
          }) !== 0
        ) {
          return fail('FIFO_BLOCKED')
        }
        const predecessor = await findReadyPredecessor(
          tx,
          program.id,
          replay.sequenceNumber,
        )
        const expectedSequence = predecessor
          ? predecessor.sequenceNumber + 1n
          : 0n
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
            (asset) =>
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
            (asset) => asset.state === 'UPLOADING' && asset.readyAt === null,
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
          OR: (['init', 'media', 'sample-index'] as const).map((kind) => ({
            bucket: requestedArtifacts[kind].location.bucket,
            objectKey: requestedArtifacts[kind].location.key,
          })),
        },
      })
      if (occupiedLocations !== 0) return fail('ARTIFACT_CONFLICT')

      if (await tx.dvrSegment.count({
        where: { dvrProgramId: program.id, readyAt: null },
      })) {
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
      const sequenceNumber = lastSegment
        ? lastSegment.sequenceNumber + 1n
        : 0n
      if (sequenceNumber < 0n || sequenceNumber > INT64_MAX) {
        return fail('TIMELINE_CONFLICT')
      }
      const currentHead = lastSegment ? buildHead(lastSegment) : null
      const currentEpoch = await tx.captureEpoch.findFirst({
        orderBy: { sequenceIndex: 'desc' },
        where: { captureSessionId: input.captureSessionId },
      })
      if (
        (currentHead === null && currentEpoch !== null) ||
        (currentHead !== null && currentEpoch?.id !== currentHead.epochId)
      ) {
        return fail('TIMELINE_CONFLICT')
      }
      const plan = planFrom(input, currentHead, this.#plannerConfig)
      let epochId: string
      if (plan.epoch.disposition === 'CREATE_NEXT') {
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

  async recordArtifactExpectations(
    input: RecordArtifactExpectationsInput,
  ): Promise<void> {
    validateReference(input.reservation)
    const expected = artifactMap(input.artifacts, true)
    await this.#transaction(async (tx) => {
      await advisoryLock(tx, input.reservation.captureSessionId)
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
        Object.values(assets).every(
          (asset) => asset.state === 'READY' && asset.readyAt !== null,
        )
      const allUploading =
        segment.readyAt === null &&
        Object.values(assets).every(
          (asset) => asset.state === 'UPLOADING' && asset.readyAt === null,
        )
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

  async publishReady(input: PublishReadyInput): Promise<PublishReadyResult> {
    validateReference(input.reservation)
    const verified = artifactMap(input.verifiedArtifacts, true)
    return this.#transaction(async (tx) => {
      await advisoryLock(tx, input.reservation.captureSessionId)
      const segment = await readReservation(tx, input.reservation)
      assertArtifactRelationships(
        segment,
        verified as ArtifactMap<IngestArtifactReservation>,
      )
      const assets = segmentAssets(segment)
      for (const kind of ['init', 'media', 'sample-index'] as const) {
        if (!sameExpectation(assets[kind], verified[kind])) {
          return fail('EXPECTATIONS_REQUIRED')
        }
      }
      const allReady =
        segment.readyAt !== null &&
        Object.values(assets).every(
          (asset) => asset.state === 'READY' && asset.readyAt !== null,
        )
      if (allReady) {
        const timestamps = Object.values(assets).map((asset) => asset.readyAt!.getTime())
        if (timestamps.some((value) => value !== segment.readyAt!.getTime())) {
          return fail('RESERVATION_CONFLICT')
        }
        return {
          disposition: 'ALREADY_READY',
          readyAt: segment.readyAt!,
          playlistRevision: segment.program.playlistRevision,
        }
      }
      if (
        segment.readyAt !== null ||
        Object.values(assets).some(
          (asset) => asset.state !== 'UPLOADING' || asset.readyAt !== null,
        )
      ) {
        return fail('RESERVATION_CONFLICT')
      }
      if (
        await tx.dvrSegment.count({
          where: {
            dvrProgramId: segment.dvrProgramId,
            id: { not: segment.id },
            OR: [
              { readyAt: null },
              { sequenceNumber: { gt: segment.sequenceNumber } },
            ],
          },
        }) !== 0
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
      const session = await tx.captureSession.findUnique({
        select: { startedAt: true, status: true },
        where: { id: input.reservation.captureSessionId },
      })
      if (!session) return fail('SESSION_NOT_FOUND')
      if (!['STARTING', 'LIVE', 'STOPPING'].includes(session.status)) {
        return fail('SESSION_TERMINAL')
      }
      const predecessor = await findReadyPredecessor(
        tx,
        segment.dvrProgramId,
        segment.sequenceNumber,
      )
      if (predecessor && predecessor.captureEpochId !== segment.captureEpochId) {
        if (
          predecessor.captureEpoch.sequenceIndex + 1 !==
          segment.captureEpoch.sequenceIndex
        ) {
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
          status: segment.program.status === 'STARTING'
            ? 'LIVE'
            : segment.program.status,
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
