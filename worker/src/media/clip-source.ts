import type { PrismaClient } from '@volleyball-monitoring/db'

const SUPPORTED_SCHEMA_VERSION = '1.0.0'
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export type ClipSourceObject = {
  bucket: string
  objectKey: string
  byteLength: bigint | null
  sha256: string | null
}

export type ClipSource = {
  id: string
  captureEpochId: string
  captureStartUs: bigint
  captureEndUs: bigint
  sourcePtsStart: bigint | null
  sourcePtsEnd: bigint | null
  firstFrameIndex: bigint | null
  frameCount: bigint
  captureEpoch: {
    id: string
    sourcePtsOrigin: bigint
    captureTimeOriginUs: bigint
    captureFrameOrigin: bigint
    sourceTimeBaseNum: number
    sourceTimeBaseDen: number
  }
  initAsset: ClipSourceObject
  mediaAsset: ClipSourceObject
  sampleIndexAsset: ClipSourceObject
}

type ResolveClipSourcesInput = {
  dvrProgramId: string
  captureSessionId: string
  requestedStartCaptureUs: bigint
  requestedEndCaptureUs: bigint
  anchorCaptureTimeUs: bigint | null
}

function populated(value: string | null): value is string {
  return value !== null && value.trim().length > 0
}

function validObject(object: {
  bucket: string | null
  objectKey: string | null
  byteLength: bigint | null
  sha256: string | null
}): boolean {
  return (
    populated(object.bucket) &&
    populated(object.objectKey) &&
    object.byteLength !== null &&
    object.byteLength > 0n &&
    object.sha256 !== null &&
    SHA256_PATTERN.test(object.sha256)
  )
}

function assertContinuous(sources: ClipSource[]): void {
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index]!.captureStartUs !== sources[index - 1]!.captureEndUs) {
      throw new Error('canonical clip cannot cross a gap or discontinuity')
    }
  }
}

export async function resolveClipSources(
  database: PrismaClient,
  input: ResolveClipSourcesInput,
): Promise<ClipSource[]> {
  const where = {
    dvrProgramId: input.dvrProgramId,
    startUs: { lt: input.requestedEndCaptureUs },
    endUs: { gt: input.requestedStartCaptureUs },
  }
  const [extentCandidates, legacyCandidates] = await Promise.all([
    database.mediaExtent.findMany({
      where: { ...where, status: 'ARCHIVE_VERIFIED' },
      orderBy: [{ sequenceNumber: 'asc' }, { id: 'asc' }],
      include: { captureEpoch: true },
    }),
    database.dvrSegment.findMany({
      where: {
        dvrProgramId: input.dvrProgramId,
        isGap: false,
        readyAt: { not: null },
        captureStartUs: { lt: input.requestedEndCaptureUs },
        captureEndUs: { gt: input.requestedStartCaptureUs },
      },
      orderBy: { sequenceNumber: 'asc' },
      include: {
        initAsset: true,
        mediaAsset: true,
        sampleIndexAsset: true,
        captureEpoch: true,
      },
    }),
  ])

  const legacyAnchors =
    input.anchorCaptureTimeUs === null
      ? []
      : legacyCandidates.filter(
          segment =>
            input.anchorCaptureTimeUs! >= segment.captureStartUs &&
            input.anchorCaptureTimeUs! < segment.captureEndUs,
        )
  if (legacyAnchors.length > 1) throw new Error('canonical clip anchor is ambiguous')
  const legacyAnchor = legacyAnchors[0] ?? null
  const legacyRun = legacyAnchor
    ? legacyCandidates.filter(
        segment => segment.discontinuitySequence === legacyAnchor.discontinuitySequence,
      )
    : []
  const legacyReady =
    legacyRun.length > 0 &&
    legacyRun.every(
      segment =>
        segment.initAsset !== null &&
        segment.mediaAsset !== null &&
        segment.sampleIndexAsset !== null,
    )
  const legacySources: ClipSource[] = legacyReady
    ? legacyRun.map(segment => ({
        ...segment,
        initAsset: segment.initAsset!,
        mediaAsset: segment.mediaAsset!,
        sampleIndexAsset: segment.sampleIndexAsset!,
      }))
    : []

  if (extentCandidates.length === 0) {
    if (!legacySources.length) throw new Error('requested DVR range is not ready')
    assertContinuous(legacySources)
    return legacySources
  }

  const projectionFields = (extent: (typeof extentCandidates)[number]) =>
    [
      extent.captureEpochId,
      extent.sequenceNumber,
      extent.discontinuitySequence,
      extent.sourcePtsStart,
      extent.sourcePtsEnd,
      extent.firstFrameIndex,
      extent.frameCount,
      extent.mediaSha256,
      extent.mediaSchemaVersion,
      extent.initBucket,
      extent.initObjectKey,
      extent.initSha256,
      extent.initBytes,
      extent.initSchemaVersion,
      extent.sampleIndexBucket,
      extent.sampleIndexObjectKey,
      extent.sampleIndexSha256,
      extent.sampleIndexBytes,
      extent.sampleIndexSchemaVersion,
    ] as const
  const states = extentCandidates.map(extent => {
    const fields = projectionFields(extent)
    if (fields.every(value => value === null)) return 'EMPTY' as const
    if (fields.every(value => value !== null)) return 'COMPLETE' as const
    return 'PARTIAL' as const
  })
  if (states.includes('PARTIAL')) {
    throw new Error('media extent projection is partially populated')
  }
  if (states.includes('EMPTY')) {
    if (!legacySources.length) throw new Error('requested DVR range is not ready')
    assertContinuous(legacySources)
    return legacySources
  }

  for (const extent of extentCandidates) {
    if (
      extent.archiveVerifiedAt === null ||
      extent.captureEpoch === null ||
      extent.captureEpochId === null ||
      extent.captureSessionId !== input.captureSessionId ||
      extent.captureEpoch.captureSessionId !== extent.captureSessionId ||
      extent.sequenceNumber === null ||
      extent.sequenceNumber < 0n ||
      extent.discontinuitySequence === null ||
      extent.discontinuitySequence < 0 ||
      extent.startUs < 0n ||
      extent.endUs <= extent.startUs ||
      extent.sourcePtsStart === null ||
      extent.sourcePtsEnd === null ||
      extent.sourcePtsEnd <= extent.sourcePtsStart ||
      extent.firstFrameIndex === null ||
      extent.firstFrameIndex < 0n ||
      extent.frameCount === null ||
      extent.frameCount <= 0n ||
      extent.mediaSchemaVersion !== SUPPORTED_SCHEMA_VERSION ||
      extent.initSchemaVersion !== SUPPORTED_SCHEMA_VERSION ||
      extent.sampleIndexSchemaVersion !== SUPPORTED_SCHEMA_VERSION ||
      !validObject({
        bucket: extent.bucket,
        objectKey: extent.objectKey,
        byteLength: extent.bytes,
        sha256: extent.mediaSha256,
      }) ||
      !validObject({
        bucket: extent.initBucket,
        objectKey: extent.initObjectKey,
        byteLength: extent.initBytes,
        sha256: extent.initSha256,
      }) ||
      !validObject({
        bucket: extent.sampleIndexBucket,
        objectKey: extent.sampleIndexObjectKey,
        byteLength: extent.sampleIndexBytes,
        sha256: extent.sampleIndexSha256,
      })
    ) {
      throw new Error('media extent projection is invalid')
    }
  }

  const anchorExtents =
    input.anchorCaptureTimeUs === null
      ? []
      : extentCandidates.filter(
          extent =>
            input.anchorCaptureTimeUs! >= extent.startUs &&
            input.anchorCaptureTimeUs! < extent.endUs,
        )
  if (anchorExtents.length > 1) throw new Error('canonical clip anchor is ambiguous')
  const anchorExtent = anchorExtents[0] ?? null
  if (!anchorExtent) {
    if (!legacySources.length) throw new Error('requested DVR range is not ready')
    assertContinuous(legacySources)
    return legacySources
  }
  const extentRun = extentCandidates.filter(
    extent => extent.discontinuitySequence === anchorExtent.discontinuitySequence,
  )
  for (let index = 1; index < extentRun.length; index += 1) {
    if (
      extentRun[index]!.sequenceNumber !== extentRun[index - 1]!.sequenceNumber! + 1n ||
      extentRun[index]!.startUs !== extentRun[index - 1]!.endUs
    ) {
      throw new Error('canonical clip cannot cross a gap or discontinuity')
    }
  }

  const extentSources: ClipSource[] = extentRun.map(extent => ({
    id: extent.id,
    captureEpochId: extent.captureEpochId!,
    captureStartUs: extent.startUs,
    captureEndUs: extent.endUs,
    sourcePtsStart: extent.sourcePtsStart,
    sourcePtsEnd: extent.sourcePtsEnd,
    firstFrameIndex: extent.firstFrameIndex,
    frameCount: extent.frameCount!,
    captureEpoch: extent.captureEpoch!,
    initAsset: {
      bucket: extent.initBucket!,
      objectKey: extent.initObjectKey!,
      byteLength: extent.initBytes!,
      sha256: extent.initSha256!,
    },
    mediaAsset: {
      bucket: extent.bucket!,
      objectKey: extent.objectKey!,
      byteLength: extent.bytes!,
      sha256: extent.mediaSha256!,
    },
    sampleIndexAsset: {
      bucket: extent.sampleIndexBucket!,
      objectKey: extent.sampleIndexObjectKey!,
      byteLength: extent.sampleIndexBytes!,
      sha256: extent.sampleIndexSha256!,
    },
  }))

  if (legacySources.length) {
    const parity =
      legacyRun.length === extentRun.length &&
      legacyRun.every((segment, index) => {
        const extent = extentRun[index]!
        return (
          extent.dvrSegmentId === segment.id &&
          extent.sequenceNumber === segment.sequenceNumber &&
          extent.discontinuitySequence === segment.discontinuitySequence &&
          extent.captureEpochId === segment.captureEpochId &&
          extent.startUs === segment.captureStartUs &&
          extent.endUs === segment.captureEndUs &&
          extent.sourcePtsStart === segment.sourcePtsStart &&
          extent.sourcePtsEnd === segment.sourcePtsEnd &&
          extent.firstFrameIndex === segment.firstFrameIndex &&
          extent.frameCount === segment.frameCount &&
          extent.initBucket === segment.initAsset!.bucket &&
          extent.initObjectKey === segment.initAsset!.objectKey &&
          extent.initBytes === segment.initAsset!.byteLength &&
          extent.initSha256 === segment.initAsset!.sha256 &&
          extent.initSchemaVersion === segment.initAsset!.internalSchemaVersion &&
          extent.bucket === segment.mediaAsset!.bucket &&
          extent.objectKey === segment.mediaAsset!.objectKey &&
          extent.bytes === segment.mediaAsset!.byteLength &&
          extent.mediaSha256 === segment.mediaAsset!.sha256 &&
          extent.mediaSchemaVersion === segment.mediaAsset!.internalSchemaVersion &&
          extent.sampleIndexBucket === segment.sampleIndexAsset!.bucket &&
          extent.sampleIndexObjectKey === segment.sampleIndexAsset!.objectKey &&
          extent.sampleIndexBytes === segment.sampleIndexAsset!.byteLength &&
          extent.sampleIndexSha256 === segment.sampleIndexAsset!.sha256 &&
          extent.sampleIndexSchemaVersion === segment.sampleIndexAsset!.internalSchemaVersion
        )
      })
    const selected = parity ? extentSources : legacySources
    assertContinuous(selected)
    return selected
  }

  if (
    extentRun.length === 0 ||
    extentRun[0]!.startUs > input.requestedStartCaptureUs ||
    extentRun.at(-1)!.endUs < input.requestedEndCaptureUs
  ) {
    throw new Error('requested DVR range is not ready')
  }
  assertContinuous(extentSources)
  return extentSources
}
