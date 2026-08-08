import type { MediaObjectReader } from './playback-domain.js'

const DECIMAL = /^(0|[1-9]\d*)$/

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

export function resolveClipTimingCoverage(
  input: unknown,
  expectedClipJobId: string,
  firstFrame: bigint | null,
  lastFrame: bigint | null,
): CaptureCoverage {
  const manifest = record(input)
  if (
    manifest.schema_version !== '1.1.0'
    || manifest.clip_job_id !== expectedClipJobId
  ) {
    throw new ClipTimingManifestError('timing manifest identity is invalid')
  }
  const actualStartUs = decimal(
    manifest.actual_start_capture_us,
    'actual_start_capture_us',
  )
  const actualEndUs = decimal(
    manifest.actual_end_capture_us,
    'actual_end_capture_us',
  )
  if (actualEndUs <= actualStartUs) {
    throw new ClipTimingManifestError('timing manifest range is empty')
  }
  if (!Array.isArray(manifest.frame_map) || manifest.frame_map.length === 0) {
    throw new ClipTimingManifestError('frame_map must be non-empty')
  }

  const captureTimes: bigint[] = []
  for (const [index, value] of manifest.frame_map.entries()) {
    const frame = record(value)
    const clipFrameIndex = decimal(
      frame.clip_frame_index,
      `frame_map[${index}].clip_frame_index`,
    )
    const captureTimeUs = decimal(
      frame.capture_time_us,
      `frame_map[${index}].capture_time_us`,
    )
    if (clipFrameIndex !== BigInt(index)) {
      throw new ClipTimingManifestError('frame_map indices must be contiguous')
    }
    if (
      captureTimeUs < actualStartUs
      || captureTimeUs >= actualEndUs
      || (captureTimes.length > 0 && captureTimeUs <= captureTimes.at(-1)!)
    ) {
      throw new ClipTimingManifestError('frame_map capture times are invalid')
    }
    captureTimes.push(captureTimeUs)
  }

  if (firstFrame === null && lastFrame === null) {
    return { startUs: actualStartUs, endUs: actualEndUs }
  }
  if (
    firstFrame === null
    || lastFrame === null
    || firstFrame < 0n
    || lastFrame < firstFrame
    || lastFrame >= BigInt(captureTimes.length)
    || lastFrame > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ClipTimingManifestError('analysis frame coverage is invalid')
  }
  const firstIndex = Number(firstFrame)
  const lastIndex = Number(lastFrame)
  return {
    startUs: captureTimes[firstIndex]!,
    endUs: lastIndex + 1 < captureTimes.length
      ? captureTimes[lastIndex + 1]!
      : actualEndUs,
  }
}

export async function readClipTimingCoverage(
  reader: MediaObjectReader,
  asset: TimingManifestAssetReference,
  clipJobId: string,
  firstFrame: bigint | null,
  lastFrame: bigint | null,
): Promise<CaptureCoverage> {
  if (
    asset.byteLength === null
    || asset.sha256 === null
    || asset.internalSchemaVersion !== '1.1.0'
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
  let manifest: unknown
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ClipTimingManifestError('timing manifest JSON is invalid')
  }
  return resolveClipTimingCoverage(
    manifest,
    clipJobId,
    firstFrame,
    lastFrame,
  )
}
