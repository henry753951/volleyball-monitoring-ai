import { TextDecoder } from 'node:util'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  parseSampleIndexDocument,
  resolveCanonicalTimeAcrossSegments,
  type IndexedSegment,
  type SampleIndex,
} from '@volleyball-monitoring/media'
import {
  MEDIA_INTERNAL_SCHEMA_VERSION,
  validSha256,
  type MediaObjectReadRequest,
  type MediaObjectReader,
} from './playback-domain.js'

export const MAX_SAMPLE_INDEX_SEGMENT_IDS = 128

export type SampleIndexRepositoryErrorCode =
  | 'INVALID_REQUEST'
  | 'DATABASE_READ_FAILED'
  | 'SEGMENT_NOT_FOUND'
  | 'SEGMENT_NOT_READY'
  | 'INVALID_SEGMENT_METADATA'
  | 'SAMPLE_INDEX_ASSET_NOT_READY'
  | 'OBJECT_READ_FAILED'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'INVALID_DOCUMENT'
  | 'SEGMENT_INDEX_MISMATCH'
  | 'INVALID_SEGMENT_SET'

export class SampleIndexRepositoryError extends Error {
  constructor(
    public readonly code: SampleIndexRepositoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SampleIndexRepositoryError'
  }
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const JSON_CONTENT_TYPE = 'application/json'
const MAX_INT32 = 2_147_483_647

function repositoryFailure(code: SampleIndexRepositoryErrorCode, message: string): never {
  throw new SampleIndexRepositoryError(code, message)
}

function validateSegmentIds(segmentIds: readonly string[]): string[] {
  if (segmentIds.length === 0 || segmentIds.length > MAX_SAMPLE_INDEX_SEGMENT_IDS) {
    repositoryFailure('INVALID_REQUEST', 'Sample index segment request size is invalid')
  }

  const normalized: string[] = []
  const uniqueIds = new Set<string>()
  for (const segmentId of segmentIds) {
    if (!UUID.test(segmentId)) {
      repositoryFailure('INVALID_REQUEST', 'Sample index segment identity is invalid')
    }
    const normalizedId = segmentId.toLowerCase()
    if (uniqueIds.has(normalizedId)) {
      repositoryFailure('INVALID_REQUEST', 'Sample index segment identities must be unique')
    }
    uniqueIds.add(normalizedId)
    normalized.push(normalizedId)
  }
  return normalized
}

async function querySegments(database: PrismaClient, segmentIds: readonly string[]) {
  return database.dvrSegment.findMany({
    select: {
      captureEndUs: true,
      captureEpoch: {
        select: {
          captureFrameOrigin: true,
          captureSessionId: true,
          captureTimeOriginUs: true,
          endedAtCaptureUs: true,
          id: true,
          sequenceIndex: true,
          sourcePtsOrigin: true,
          sourceTimeBaseDen: true,
          sourceTimeBaseNum: true,
          startedAtCaptureUs: true,
        },
      },
      captureEpochId: true,
      captureStartUs: true,
      discontinuitySequence: true,
      durationUs: true,
      dvrProgramId: true,
      firstFrameIndex: true,
      frameCount: true,
      id: true,
      isGap: true,
      program: { select: { captureSessionId: true } },
      readyAt: true,
      sampleIndexAsset: {
        select: {
          bucket: true,
          byteLength: true,
          contentType: true,
          deletedAt: true,
          id: true,
          internalSchemaVersion: true,
          kind: true,
          objectKey: true,
          readyAt: true,
          sha256: true,
          state: true,
        },
      },
      sampleIndexAssetId: true,
      sequenceNumber: true,
      sourcePtsEnd: true,
      sourcePtsStart: true,
    },
    where: { id: { in: [...segmentIds] } },
  })
}

type SegmentRow = Awaited<ReturnType<typeof querySegments>>[number]

function orderedRows(rows: readonly SegmentRow[], segmentIds: readonly string[]): SegmentRow[] {
  const rowsById = new Map<string, SegmentRow>()
  for (const row of rows) {
    if (rowsById.has(row.id)) {
      repositoryFailure(
        'INVALID_SEGMENT_METADATA',
        'Persisted sample index segment metadata is duplicated',
      )
    }
    rowsById.set(row.id, row)
  }
  if (rowsById.size !== segmentIds.length) {
    repositoryFailure('SEGMENT_NOT_FOUND', 'A requested sample index segment was not found')
  }
  return segmentIds.map(segmentId => {
    const row = rowsById.get(segmentId)
    if (!row) {
      repositoryFailure('SEGMENT_NOT_FOUND', 'A requested sample index segment was not found')
    }
    return row
  })
}

function validateSegmentRow(row: SegmentRow): void {
  if (row.isGap || row.readyAt === null) {
    repositoryFailure('SEGMENT_NOT_READY', 'A requested sample index segment is not ready')
  }
  if (
    row.captureEpochId !== row.captureEpoch.id ||
    row.captureEpoch.captureSessionId !== row.program.captureSessionId ||
    row.captureEpoch.sourceTimeBaseNum <= 0 ||
    row.captureEpoch.sourceTimeBaseDen <= 0 ||
    !Number.isInteger(row.captureEpoch.sequenceIndex) ||
    row.captureEpoch.sequenceIndex < 0 ||
    row.captureEpoch.sequenceIndex > MAX_INT32 ||
    row.captureEpoch.startedAtCaptureUs !== row.captureEpoch.captureTimeOriginUs ||
    row.captureStartUs < row.captureEpoch.startedAtCaptureUs ||
    (row.captureEpoch.endedAtCaptureUs !== null &&
      (row.captureEpoch.endedAtCaptureUs <= row.captureEpoch.startedAtCaptureUs ||
        row.captureEndUs > row.captureEpoch.endedAtCaptureUs)) ||
    row.discontinuitySequence < 0 ||
    !Number.isSafeInteger(row.discontinuitySequence) ||
    row.captureStartUs < 0n ||
    row.captureEndUs <= row.captureStartUs ||
    row.durationUs <= 0n ||
    row.durationUs !== row.captureEndUs - row.captureStartUs ||
    row.frameCount <= 0n ||
    row.sourcePtsStart === null ||
    row.sourcePtsEnd === null ||
    row.firstFrameIndex === null
  ) {
    repositoryFailure(
      'INVALID_SEGMENT_METADATA',
      'Persisted sample index segment metadata is invalid',
    )
  }
}

function sampleIndexReadRequest(row: SegmentRow): MediaObjectReadRequest {
  const asset = row.sampleIndexAsset
  if (
    asset === null ||
    row.sampleIndexAssetId === null ||
    row.sampleIndexAssetId !== asset.id ||
    asset.state !== 'READY' ||
    asset.readyAt === null ||
    asset.deletedAt !== null ||
    asset.kind !== 'SAMPLE_INDEX' ||
    asset.contentType !== JSON_CONTENT_TYPE ||
    asset.internalSchemaVersion !== MEDIA_INTERNAL_SCHEMA_VERSION ||
    asset.byteLength === null ||
    asset.byteLength <= 0n ||
    !validSha256(asset.sha256) ||
    asset.bucket.length === 0 ||
    asset.bucket.trim() !== asset.bucket ||
    asset.objectKey.length === 0 ||
    asset.objectKey.trim() !== asset.objectKey
  ) {
    repositoryFailure('SAMPLE_INDEX_ASSET_NOT_READY', 'A sample index asset is not ready')
  }
  return {
    bucket: asset.bucket,
    expectedByteLength: asset.byteLength,
    expectedContentType: JSON_CONTENT_TYPE,
    expectedInternalSchemaVersion: MEDIA_INTERNAL_SCHEMA_VERSION,
    expectedKind: 'SAMPLE_INDEX',
    expectedSha256: asset.sha256,
    key: asset.objectKey,
  }
}

function decodeDocument(bytes: Uint8Array): unknown {
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    repositoryFailure('INVALID_UTF8', 'Sample index encoding is invalid')
  }
  try {
    return JSON.parse(json) as unknown
  } catch {
    repositoryFailure('INVALID_JSON', 'Sample index JSON is invalid')
  }
}

function parseDocument(row: SegmentRow, document: unknown): SampleIndex {
  try {
    return parseSampleIndexDocument(document, {
      captureFrameOrigin: row.captureEpoch.captureFrameOrigin,
      captureTimeOriginUs: row.captureEpoch.captureTimeOriginUs,
      epochId: row.captureEpoch.id,
      sourcePtsOrigin: row.captureEpoch.sourcePtsOrigin,
      timeBase: {
        den: BigInt(row.captureEpoch.sourceTimeBaseDen),
        num: BigInt(row.captureEpoch.sourceTimeBaseNum),
      },
    })
  } catch {
    repositoryFailure('INVALID_DOCUMENT', 'Sample index document is invalid')
  }
}

function validateIndexAgainstSegment(row: SegmentRow, index: SampleIndex): void {
  const first = index.samples[0]!
  const last = index.samples.at(-1)!
  if (
    index.availableStartUs !== row.captureStartUs ||
    index.availableEndUs !== row.captureEndUs ||
    index.availableEndUs - index.availableStartUs !== row.durationUs ||
    BigInt(index.samples.length) !== row.frameCount ||
    first.captureFrameIndex !== row.firstFrameIndex ||
    first.sourcePts !== row.sourcePtsStart ||
    last.sourcePts + last.durationPts !== row.sourcePtsEnd
  ) {
    repositoryFailure(
      'SEGMENT_INDEX_MISMATCH',
      'Sample index does not match persisted segment metadata',
    )
  }
}

function validateOrderedMetadata(rows: readonly SegmentRow[]): void {
  const first = rows[0]!
  const assetIds = new Set<string>()
  let previous: SegmentRow | undefined
  for (const row of rows) {
    validateSegmentRow(row)
    if (
      row.dvrProgramId !== first.dvrProgramId ||
      row.discontinuitySequence !== first.discontinuitySequence
    ) {
      repositoryFailure('INVALID_SEGMENT_SET', 'Sample index segments cross a media boundary')
    }
    if (row.sampleIndexAssetId !== null) {
      if (assetIds.has(row.sampleIndexAssetId)) {
        repositoryFailure(
          'INVALID_SEGMENT_METADATA',
          'Persisted sample index asset relation is duplicated',
        )
      }
      assetIds.add(row.sampleIndexAssetId)
    }
    if (
      previous &&
      (row.sequenceNumber <= previous.sequenceNumber ||
        row.captureStartUs !== previous.captureEndUs ||
        (row.captureEpochId === previous.captureEpochId
          ? row.captureEpoch.sequenceIndex !== previous.captureEpoch.sequenceIndex
          : row.captureEpoch.sequenceIndex !== previous.captureEpoch.sequenceIndex + 1))
    ) {
      repositoryFailure(
        'INVALID_SEGMENT_SET',
        'Sample index segments are not an ordered contiguous set',
      )
    }
    previous = row
  }
}

function validateResolvedSegmentSet(segments: readonly IndexedSegment[]): void {
  try {
    resolveCanonicalTimeAcrossSegments(
      segments,
      segments[0]!.index.availableStartUs,
      segments[0]!.index.availableStartUs,
      segments.at(-1)!.index.availableEndUs,
    )
  } catch {
    repositoryFailure('INVALID_SEGMENT_SET', 'Sample indexes are not one contiguous resolver set')
  }
}

export class SampleIndexRepository {
  constructor(
    private readonly database: PrismaClient,
    private readonly objectReader: MediaObjectReader,
  ) {}

  async loadOrderedSegments(segmentIds: readonly string[]): Promise<readonly IndexedSegment[]> {
    const normalizedIds = validateSegmentIds(segmentIds)
    let rows: Awaited<ReturnType<typeof querySegments>>
    try {
      rows = await querySegments(this.database, normalizedIds)
    } catch {
      repositoryFailure('DATABASE_READ_FAILED', 'Sample index metadata could not be read')
    }
    const ordered = orderedRows(rows, normalizedIds)
    validateOrderedMetadata(ordered)

    const segments: IndexedSegment[] = []
    for (const row of ordered) {
      const readRequest = sampleIndexReadRequest(row)
      let bytes: Uint8Array
      try {
        bytes = await this.objectReader(readRequest)
      } catch {
        repositoryFailure('OBJECT_READ_FAILED', 'Sample index object could not be read')
      }
      const index = parseDocument(row, decodeDocument(bytes))
      validateIndexAgainstSegment(row, index)
      segments.push({
        discontinuity: row.discontinuitySequence,
        index,
        segmentId: row.id,
      })
    }

    validateResolvedSegmentSet(segments)
    return segments
  }
}

export function createSampleIndexRepository(
  database: PrismaClient,
  objectReader: MediaObjectReader,
): SampleIndexRepository {
  return new SampleIndexRepository(database, objectReader)
}
