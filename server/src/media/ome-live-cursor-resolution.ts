import { randomUUID } from 'node:crypto'
import {
  parseResolvedMediaAnchor,
  type OmeLivePlaybackCursor,
  type ResolvedMediaAnchor,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import {
  resolveCanonicalTimeAcrossSegments,
  type IndexedSegment,
} from '@volleyball-monitoring/media'
import type { CursorMediaIdentity } from './cursor-resolution.js'
import type { CursorSampleIndexLoader } from './cursor-resolution.js'
import { MediaHttpError } from './playback-domain.js'

export const OME_PROVISIONAL_EPOCH_REASON = 'OME_RECORDING_EXTENT_PROVISIONAL'
const MEDIA_INGEST_LOCK_DOMAIN = 'volleyball-media-ingest-v1'

function roundNearestAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new TypeError('denominator must be positive')
  const sign = numerator < 0n ? -1n : 1n
  const absolute = numerator < 0n ? -numerator : numerator
  const quotient = absolute / denominator
  const remainder = absolute % denominator
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n))
}

export function resolveOmeEpochTime(input: {
  captureFrameOrigin: bigint
  captureTimeOriginUs: bigint
  fpsDen: number
  fpsNum: number
  sourcePtsOrigin: bigint
  sourceTimeBaseDen: number
  sourceTimeBaseNum: number
  targetCaptureTimeUs: bigint
}) {
  const deltaUs = input.targetCaptureTimeUs - input.captureTimeOriginUs
  if (deltaUs < 0n) throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor predates OME epoch')
  const frameDelta = roundNearestAway(
    deltaUs * BigInt(input.fpsNum),
    1_000_000n * BigInt(input.fpsDen),
  )
  const sourcePtsDelta = roundNearestAway(
    frameDelta * BigInt(input.fpsDen) * BigInt(input.sourceTimeBaseDen),
    BigInt(input.fpsNum) * BigInt(input.sourceTimeBaseNum),
  )
  const sourcePts = input.sourcePtsOrigin + sourcePtsDelta
  const captureTimeUs =
    input.captureTimeOriginUs +
    roundNearestAway(
      sourcePtsDelta * BigInt(input.sourceTimeBaseNum) * 1_000_000n,
      BigInt(input.sourceTimeBaseDen),
    )
  return {
    captureFrameIndex: input.captureFrameOrigin + frameDelta,
    captureTimeUs,
    snapDistanceUs:
      captureTimeUs >= input.targetCaptureTimeUs
        ? captureTimeUs - input.targetCaptureTimeUs
        : input.targetCaptureTimeUs - captureTimeUs,
    sourcePts,
  }
}

async function ensureOmeProvisionalEpoch(database: PrismaClient, captureSessionId: string) {
  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(CAST(${MEDIA_INGEST_LOCK_DOMAIN} AS text) || ':' || CAST(${captureSessionId} AS text), 0))::text AS lock`
    const latestSegment = await tx.dvrSegment.findFirst({
      include: { captureEpoch: true, program: true },
      orderBy: [{ captureEndUs: 'desc' }, { sequenceNumber: 'desc' }],
      where: {
        program: { captureSessionId },
        readyAt: { not: null },
      },
    })
    if (!latestSegment || latestSegment.firstFrameIndex === null)
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME epoch profile is unavailable')
    const latestEpoch = await tx.captureEpoch.findFirst({
      orderBy: { sequenceIndex: 'desc' },
      where: { captureSessionId },
    })
    if (
      latestEpoch?.discontinuityReason === OME_PROVISIONAL_EPOCH_REASON &&
      latestEpoch.captureTimeOriginUs === latestSegment.captureEndUs &&
      latestEpoch.captureFrameOrigin === latestSegment.firstFrameIndex + latestSegment.frameCount
    )
      return latestEpoch
    if (latestEpoch?.id !== latestSegment.captureEpochId)
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME provisional epoch is inconsistent')
    return tx.captureEpoch.create({
      data: {
        id: randomUUID(),
        captureSessionId,
        sequenceIndex: latestEpoch.sequenceIndex + 1,
        sourceTimeBaseNum: latestEpoch.sourceTimeBaseNum,
        sourceTimeBaseDen: latestEpoch.sourceTimeBaseDen,
        sourcePtsOrigin: 0n,
        captureTimeOriginUs: latestSegment.captureEndUs,
        captureFrameOrigin: latestSegment.firstFrameIndex + latestSegment.frameCount,
        startedAtCaptureUs: latestSegment.captureEndUs,
        discontinuityReason: OME_PROVISIONAL_EPOCH_REASON,
      },
    })
  })
}

export async function resolveOmeLivePlaybackCursor(
  cursor: OmeLivePlaybackCursor,
  identity: CursorMediaIdentity,
  database: PrismaClient,
  sampleIndexes?: CursorSampleIndexLoader,
  now = new Date(),
): Promise<ResolvedMediaAnchor> {
  if (cursor.cursor_status !== 'ready')
    throw new MediaHttpError(422, 'CURSOR_NOT_READY', 'Playback cursor is not ready')
  const observedProgramDate = new Date(cursor.program_date_time)
  if (
    Number.isNaN(observedProgramDate.getTime()) ||
    observedProgramDate.getTime() > now.getTime() + 10_000
  )
    throw new MediaHttpError(422, 'CURSOR_NOT_READY', 'OME presentation date is invalid')

  const anchor = await database.livePresentationAnchor.findFirst({
    include: { captureEpoch: true },
    where: {
      captureSessionId: cursor.capture_session_id,
      sequenceIndex: cursor.presentation_anchor_sequence,
      validatedAt: { not: null },
      captureTimeOriginUs: { not: null },
      ...(identity.role === UserRole.ADMIN
        ? {}
        : { captureSession: { match: { members: { some: { userId: identity.id } } } } }),
    },
  })
  if (!anchor?.captureEpoch || anchor.captureTimeOriginUs === null)
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME presentation anchor is not validated')
  if (observedProgramDate < anchor.programDateTime)
    throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor predates OME presentation')
  const nextAnchor = await database.livePresentationAnchor.findFirst({
    orderBy: { sequenceIndex: 'asc' },
    select: { programDateTime: true, streamInstanceId: true, validatedAt: true },
    where: {
      captureSessionId: anchor.captureSessionId,
      sequenceIndex: { gt: anchor.sequenceIndex },
    },
  })
  if (
    nextAnchor &&
    observedProgramDate >= nextAnchor.programDateTime &&
    (nextAnchor.streamInstanceId !== anchor.streamInstanceId || nextAnchor.validatedAt !== null)
  )
    throw new MediaHttpError(409, 'MAPPING_STALE', 'OME presentation generation is stale')

  const targetCaptureTimeUs =
    anchor.captureTimeOriginUs +
    BigInt((observedProgramDate.getTime() - anchor.programDateTime.getTime()) * 1_000)

  const coveringExtents = await database.mediaExtent.findMany({
    include: { captureEpoch: true, dvrProgram: true },
    take: 2,
    where: {
      archiveVerifiedAt: { not: null },
      captureEpochId: { not: null },
      captureSessionId: anchor.captureSessionId,
      endUs: { gt: targetCaptureTimeUs },
      firstFrameIndex: { not: null },
      frameCount: { not: null },
      sampleIndexBucket: { not: null },
      sampleIndexBytes: { not: null },
      sampleIndexObjectKey: { not: null },
      sampleIndexSchemaVersion: { not: null },
      sampleIndexSha256: { not: null },
      sourcePtsEnd: { not: null },
      sourcePtsStart: { not: null },
      startUs: { lte: targetCaptureTimeUs },
      status: 'ARCHIVE_VERIFIED',
    },
  })
  if (coveringExtents.length > 1)
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME extent mapping is ambiguous')
  const coveringExtent = coveringExtents[0]
  if (coveringExtent && coveringExtent.captureEpoch && sampleIndexes?.loadOrderedExtents) {
    let indexed: readonly IndexedSegment[]
    try {
      indexed = await sampleIndexes.loadOrderedExtents([coveringExtent.id])
    } catch {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME extent sample index is unavailable')
    }
    if (indexed.length !== 1 || indexed[0]?.segmentId !== coveringExtent.id)
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME extent sample index mapping is invalid')
    let exact: ReturnType<typeof resolveCanonicalTimeAcrossSegments>
    try {
      exact = resolveCanonicalTimeAcrossSegments(
        indexed,
        targetCaptureTimeUs,
        coveringExtent.startUs,
        coveringExtent.endUs,
      )
    } catch {
      throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor is outside available OME media')
    }
    const timeBase = indexed[0]!.index.timeBase
    if (
      timeBase.num <= 0n ||
      timeBase.den <= 0n ||
      timeBase.num > BigInt(Number.MAX_SAFE_INTEGER) ||
      timeBase.den > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME sample time base is invalid')
    return parseResolvedMediaAnchor({
      schema_version: '1.0.0',
      playback_window_id: anchor.id,
      capture_session_id: anchor.captureSessionId,
      capture_epoch_id: exact.epochId,
      dvr_segment_id: null,
      source_pts: exact.sample.sourcePts,
      source_time_base: { den: Number(timeBase.den), num: Number(timeBase.num) },
      capture_time_us: exact.sample.captureTimeUs,
      capture_frame_index: exact.sample.captureFrameIndex,
      resolved_player_media_time_us: cursor.player_media_time_us,
      mapping_version: anchor.sequenceIndex + 1,
      snap_distance_us: exact.snapDistanceUs,
      timing_precision: exact.kind,
    })
  }

  // FILE recording creates a new CaptureEpoch for every physical extent because
  // OME resets each file's PTS to zero. The presentation anchor validates the
  // wall-clock -> canonical capture mapping, but it must not pin all later
  // positions to the one extent that happened to validate it.
  const coveringSegment = await database.dvrSegment.findFirst({
    include: { captureEpoch: true, program: true },
    where: {
      program: { captureSessionId: anchor.captureSessionId },
      captureStartUs: { lte: targetCaptureTimeUs },
      captureEndUs: { gt: targetCaptureTimeUs },
      readyAt: { not: null },
    },
  })
  const profileSegment =
    coveringSegment ??
    (await database.dvrSegment.findFirst({
      include: { captureEpoch: true, program: true },
      orderBy: [{ captureEndUs: 'desc' }, { sequenceNumber: 'desc' }],
      where: {
        program: { captureSessionId: anchor.captureSessionId },
        captureStartUs: { lte: targetCaptureTimeUs },
        readyAt: { not: null },
      },
    }))
  if (!profileSegment)
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME epoch profile is unavailable')

  if (coveringSegment && sampleIndexes) {
    let indexed: readonly IndexedSegment[]
    try {
      indexed = await sampleIndexes.loadOrderedSegments([coveringSegment.id])
    } catch {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME sample index is unavailable')
    }
    if (indexed.length !== 1 || indexed[0]?.segmentId !== coveringSegment.id)
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME sample index mapping is invalid')
    let exact: ReturnType<typeof resolveCanonicalTimeAcrossSegments>
    try {
      exact = resolveCanonicalTimeAcrossSegments(
        indexed,
        targetCaptureTimeUs,
        coveringSegment.captureStartUs,
        coveringSegment.captureEndUs,
      )
    } catch {
      throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor is outside available OME media')
    }
    const timeBase = indexed[0]!.index.timeBase
    if (
      timeBase.num <= 0n ||
      timeBase.den <= 0n ||
      timeBase.num > BigInt(Number.MAX_SAFE_INTEGER) ||
      timeBase.den > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'OME sample time base is invalid')
    return parseResolvedMediaAnchor({
      schema_version: '1.0.0',
      playback_window_id: anchor.id,
      capture_session_id: anchor.captureSessionId,
      capture_epoch_id: exact.epochId,
      dvr_segment_id: exact.segmentId,
      source_pts: exact.sample.sourcePts,
      source_time_base: { den: Number(timeBase.den), num: Number(timeBase.num) },
      capture_time_us: exact.sample.captureTimeUs,
      capture_frame_index: exact.sample.captureFrameIndex,
      resolved_player_media_time_us: cursor.player_media_time_us,
      mapping_version: anchor.sequenceIndex + 1,
      snap_distance_us: exact.snapDistanceUs,
      timing_precision: exact.kind,
    })
  }

  const profileEpoch =
    !coveringSegment && targetCaptureTimeUs >= profileSegment.captureEndUs
      ? await ensureOmeProvisionalEpoch(database, anchor.captureSessionId)
      : profileSegment.captureEpoch
  const resolved = resolveOmeEpochTime({
    captureFrameOrigin: profileEpoch.captureFrameOrigin,
    captureTimeOriginUs: profileEpoch.captureTimeOriginUs,
    fpsDen: profileSegment.program.fpsDen,
    fpsNum: profileSegment.program.fpsNum,
    sourcePtsOrigin: profileEpoch.sourcePtsOrigin,
    sourceTimeBaseDen: profileEpoch.sourceTimeBaseDen,
    sourceTimeBaseNum: profileEpoch.sourceTimeBaseNum,
    targetCaptureTimeUs,
  })
  return parseResolvedMediaAnchor({
    schema_version: '1.0.0',
    playback_window_id: anchor.id,
    capture_session_id: anchor.captureSessionId,
    capture_epoch_id: profileEpoch.id,
    dvr_segment_id: null,
    source_pts: resolved.sourcePts.toString(),
    source_time_base: {
      den: profileEpoch.sourceTimeBaseDen,
      num: profileEpoch.sourceTimeBaseNum,
    },
    capture_time_us: resolved.captureTimeUs.toString(),
    capture_frame_index: resolved.captureFrameIndex.toString(),
    resolved_player_media_time_us: cursor.player_media_time_us,
    mapping_version: anchor.sequenceIndex + 1,
    snap_distance_us: resolved.snapDistanceUs.toString(),
    timing_precision: 'estimated',
  })
}
