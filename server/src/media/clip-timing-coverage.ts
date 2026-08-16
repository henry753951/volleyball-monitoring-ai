import type { MediaObjectReader } from './playback-domain.js'

const DECIMAL = /^(0|[1-9]\d*)$/
const SIGNED_DECIMAL = /^-?(0|[1-9]\d*)$/

export class ClipTimingManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClipTimingManifestError'
  }
}

export interface TimingManifestAssetReference {
  bucket: string
  objectKey: string
  contentType: string
  byteLength: bigint | null
  sha256: string | null
  internalSchemaVersion: string | null
}

export interface CaptureCoverage {
  startUs: bigint
  endUs: bigint
}

export function timingManifestIdentity(
  clipJobId: string,
  idempotencyKey: string,
  objectKey: string,
): string {
  return (
    /\/([0-9a-f-]{36})\.timing\.json$/i.exec(objectKey)?.[1] ??
    /:reuse:([0-9a-f-]{36})$/i.exec(idempotencyKey)?.[1] ??
    clipJobId
  )
}

export interface ClipFrameTimeline {
  captureEpochId: string[]
  captureFrameIndex: bigint[]
  captureTimeUs: bigint[]
  captureEndUs: bigint
  clipPts: bigint[]
  clipTimeUs: bigint[]
  clipEndUs: bigint
  sourcePts: bigint[]
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClipTimingManifestError('timing manifest must be an object')
  }
  return value as Record<string, unknown>
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new ClipTimingManifestError(`${field} must be a decimal string`)
  }
  return BigInt(value)
}

function signedDecimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) {
    throw new ClipTimingManifestError(`${field} must be a signed decimal string`)
  }
  return BigInt(value)
}

export function resolveClipFrameTimeline(
  input: unknown,
  expectedClipJobId: string,
): ClipFrameTimeline {
  const manifest = record(input)
  if (
    !['1.1.0', '2.0.0'].includes(String(manifest.schema_version)) ||
    manifest.clip_job_id !== expectedClipJobId
  ) {
    throw new ClipTimingManifestError('timing manifest identity is invalid')
  }
  const actualStartUs = decimal(manifest.actual_start_capture_us, 'actual_start_capture_us')
  const actualEndUs = decimal(manifest.actual_end_capture_us, 'actual_end_capture_us')
  const video = record(manifest.video)
  const clipEndUs = decimal(video.duration_us, 'video.duration_us')
  if (actualEndUs <= actualStartUs) {
    throw new ClipTimingManifestError('timing manifest range is empty')
  }
  if (clipEndUs <= 0n) {
    throw new ClipTimingManifestError('timing manifest clip range is empty')
  }
  if (!Array.isArray(manifest.frame_map) || manifest.frame_map.length === 0) {
    throw new ClipTimingManifestError('frame_map must be non-empty')
  }

  const captureTimes: bigint[] = []
  const captureEpochIds: string[] = []
  const captureFrameIndexes: bigint[] = []
  const clipPtsValues: bigint[] = []
  const clipTimes: bigint[] = []
  const sourcePtsValues: bigint[] = []
  for (const [index, value] of manifest.frame_map.entries()) {
    const frame = record(value)
    if (typeof frame.capture_epoch_id !== 'string' || frame.capture_epoch_id.length === 0) {
      throw new ClipTimingManifestError(
        `frame_map[${index}].capture_epoch_id must be a non-empty string`,
      )
    }
    const captureFrameIndex = decimal(
      frame.capture_frame_index,
      `frame_map[${index}].capture_frame_index`,
    )
    const sourcePts = signedDecimal(frame.source_pts, `frame_map[${index}].source_pts`)
    const clipPts = decimal(frame.clip_pts, `frame_map[${index}].clip_pts`)
    const clipFrameIndex = decimal(frame.clip_frame_index, `frame_map[${index}].clip_frame_index`)
    const captureTimeUs = decimal(frame.capture_time_us, `frame_map[${index}].capture_time_us`)
    const clipTimeUs = decimal(frame.clip_time_us, `frame_map[${index}].clip_time_us`)
    if (clipFrameIndex !== BigInt(index)) {
      throw new ClipTimingManifestError('frame_map indices must be contiguous')
    }
    if (
      captureTimeUs < actualStartUs ||
      captureTimeUs >= actualEndUs ||
      (captureTimes.length > 0 && captureTimeUs <= captureTimes.at(-1)!)
    ) {
      throw new ClipTimingManifestError('frame_map capture times are invalid')
    }
    if (
      clipTimeUs < 0n ||
      clipTimeUs >= clipEndUs ||
      (clipTimes.length > 0 && clipTimeUs <= clipTimes.at(-1)!) ||
      (index === 0 && clipTimeUs !== 0n)
    ) {
      throw new ClipTimingManifestError('frame_map clip times are invalid')
    }
    captureEpochIds.push(frame.capture_epoch_id)
    captureFrameIndexes.push(captureFrameIndex)
    captureTimes.push(captureTimeUs)
    clipPtsValues.push(clipPts)
    clipTimes.push(clipTimeUs)
    sourcePtsValues.push(sourcePts)
  }

  return {
    captureEpochId: captureEpochIds,
    captureFrameIndex: captureFrameIndexes,
    captureTimeUs: captureTimes,
    captureEndUs: actualEndUs,
    clipPts: clipPtsValues,
    clipTimeUs: clipTimes,
    clipEndUs,
    sourcePts: sourcePtsValues,
  }
}

export function resolveClipTimingCoverage(
  input: unknown,
  expectedClipJobId: string,
  firstFrame: bigint | null,
  lastFrame: bigint | null,
): CaptureCoverage {
  const timeline = resolveClipFrameTimeline(input, expectedClipJobId)
  const captureTimes = timeline.captureTimeUs
  const actualStartUs = captureTimes[0]!
  const actualEndUs = timeline.captureEndUs

  if (firstFrame === null && lastFrame === null) {
    return { startUs: actualStartUs, endUs: actualEndUs }
  }
  if (
    firstFrame === null ||
    lastFrame === null ||
    firstFrame < 0n ||
    lastFrame < firstFrame ||
    lastFrame >= BigInt(captureTimes.length) ||
    lastFrame > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ClipTimingManifestError('analysis frame coverage is invalid')
  }
  const firstIndex = Number(firstFrame)
  const lastIndex = Number(lastFrame)
  return {
    startUs: captureTimes[firstIndex]!,
    endUs: lastIndex + 1 < captureTimes.length ? captureTimes[lastIndex + 1]! : actualEndUs,
  }
}

async function readTimingManifest(
  reader: MediaObjectReader,
  asset: TimingManifestAssetReference,
): Promise<unknown> {
  if (
    asset.byteLength === null ||
    asset.sha256 === null ||
    asset.internalSchemaVersion === null ||
    !['1.1.0', '2.0.0'].includes(asset.internalSchemaVersion)
  ) {
    throw new ClipTimingManifestError('timing manifest asset is incomplete')
  }
  const bytes = await reader({
    bucket: asset.bucket,
    key: asset.objectKey,
    expectedByteLength: asset.byteLength,
    expectedSha256: asset.sha256,
    expectedContentType: asset.contentType,
    expectedInternalSchemaVersion: asset.internalSchemaVersion,
    expectedKind: 'TIMING_MANIFEST',
  })
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ClipTimingManifestError('timing manifest JSON is invalid')
  }
}

export async function readClipFrameTimeline(
  reader: MediaObjectReader,
  asset: TimingManifestAssetReference,
  clipJobId: string,
): Promise<ClipFrameTimeline> {
  return resolveClipFrameTimeline(await readTimingManifest(reader, asset), clipJobId)
}

export async function readClipTimingCoverage(
  reader: MediaObjectReader,
  asset: TimingManifestAssetReference,
  clipJobId: string,
  firstFrame: bigint | null,
  lastFrame: bigint | null,
): Promise<CaptureCoverage> {
  return resolveClipTimingCoverage(
    await readTimingManifest(reader, asset),
    clipJobId,
    firstFrame,
    lastFrame,
  )
}
