import {
  serializeSampleIndex,
  type IndexedSample,
  type SampleIndex,
} from './sample-index'

export type IndexedSegment = {
  segmentId: string
  index: SampleIndex
  discontinuity?: number
}

type SerializedAnchor = ReturnType<typeof serializeAnchor>

export type ResolveResult = {
  kind: 'frame_exact'
  epochId: string
  segmentId: string
  sample: SerializedAnchor
  snapDistanceUs: string
}

export type StepResult = {
  kind: 'frame_exact'
  epochId: string
  segmentId: string
  sample: SerializedAnchor
}

export type ResolveErrorCode =
  | 'WINDOW_BOUNDARY'
  | 'SAMPLE_NOT_FOUND'
  | 'CAPTURE_GAP'
  | 'INVALID_SEGMENT_SET'

export class ResolverError extends Error {
  constructor(
    public readonly code: ResolveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ResolverError'
  }
}

type IndexedLocation = {
  epochId: string
  segmentId: string
  sample: IndexedSample
}

type BoundaryFailureCode = 'INVALID_SEGMENT_SET' | 'SAMPLE_NOT_FOUND'

function serializeAnchor(sample: IndexedSample) {
  return {
    sourcePts: sample.sourcePts.toString(),
    captureTimeUs: sample.captureTimeUs.toString(),
    captureFrameIndex: sample.captureFrameIndex.toString(),
  }
}

function invalidSegmentSet(message: string): never {
  throw new ResolverError('INVALID_SEGMENT_SET', message)
}

function boundaryFailure(
  code: BoundaryFailureCode,
  message: string,
): never {
  throw new ResolverError(code, message)
}

function validateIndex(segment: IndexedSegment): void {
  try {
    serializeSampleIndex(segment.index)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown index error'
    invalidSegmentSet(
      `segment ${segment.segmentId} has an invalid sample index: ${detail}`,
    )
  }
}

function validateSegments(
  segments: readonly IndexedSegment[],
  windowStartUs: bigint,
  windowEndUs: bigint,
  unavailableBoundaryCode: BoundaryFailureCode,
): IndexedLocation[] {
  if (segments.length === 0) {
    invalidSegmentSet('at least one indexed segment is required')
  }
  if (windowStartUs >= windowEndUs) {
    invalidSegmentSet('playback window must be a non-empty half-open range')
  }

  const segmentIds = new Set<string>()
  const locations: IndexedLocation[] = []
  const sourcePts = new Set<bigint>()
  const captureTimes = new Set<bigint>()
  const captureFrames = new Set<bigint>()
  const first = segments[0]!
  const discontinuity = first.discontinuity ?? 0

  if (!Number.isInteger(discontinuity) || discontinuity < 0) {
    invalidSegmentSet('segment discontinuity must be a nonnegative integer')
  }

  let previousSegment: IndexedSegment | undefined
  let previousSample: IndexedSample | undefined

  for (const segment of segments) {
    if (!segment.segmentId.trim()) {
      invalidSegmentSet('segment id must be non-empty')
    }
    if (segmentIds.has(segment.segmentId)) {
      invalidSegmentSet(`duplicate segment id: ${segment.segmentId}`)
    }
    segmentIds.add(segment.segmentId)
    validateIndex(segment)

    const currentDiscontinuity = segment.discontinuity ?? 0
    if (!Number.isInteger(currentDiscontinuity) || currentDiscontinuity < 0) {
      invalidSegmentSet('segment discontinuity must be a nonnegative integer')
    }
    if (currentDiscontinuity !== discontinuity) {
      boundaryFailure(
        unavailableBoundaryCode,
        unavailableBoundaryCode === 'SAMPLE_NOT_FOUND'
          ? 'no adjacent sample across discontinuity'
          : 'indexed segments cross a discontinuity',
      )
    }
    if (segment.index.epochId !== first.index.epochId) {
      boundaryFailure(
        unavailableBoundaryCode,
        unavailableBoundaryCode === 'SAMPLE_NOT_FOUND'
          ? 'no adjacent sample across capture epoch'
          : 'indexed segments cross a capture epoch',
      )
    }
    if (
      segment.index.timeBase.num !== first.index.timeBase.num ||
      segment.index.timeBase.den !== first.index.timeBase.den
    ) {
      invalidSegmentSet('indexed segments must use one identical time base')
    }

    if (previousSegment) {
      if (
        segment.index.availableStartUs < previousSegment.index.availableEndUs
      ) {
        invalidSegmentSet('segment ranges overlap or are out of order')
      }
      if (
        segment.index.availableStartUs > previousSegment.index.availableEndUs
      ) {
        boundaryFailure(
          unavailableBoundaryCode,
          unavailableBoundaryCode === 'SAMPLE_NOT_FOUND'
            ? 'no adjacent sample across canonical gap'
            : 'indexed segments contain a canonical gap',
        )
      }
    }

    for (const sample of segment.index.samples) {
      if (
        sourcePts.has(sample.sourcePts) ||
        captureTimes.has(sample.captureTimeUs) ||
        captureFrames.has(sample.captureFrameIndex)
      ) {
        invalidSegmentSet('indexed segments contain a duplicate sample')
      }
      sourcePts.add(sample.sourcePts)
      captureTimes.add(sample.captureTimeUs)
      captureFrames.add(sample.captureFrameIndex)

      if (previousSample) {
        if (sample.captureFrameIndex !== previousSample.captureFrameIndex + 1n) {
          invalidSegmentSet(
            'sample frame indices must be contiguous across segments',
          )
        }
        if (sample.captureTimeUs <= previousSample.captureTimeUs) {
          invalidSegmentSet('sample capture times must strictly increase')
        }
        if (sample.sourcePts !== previousSample.sourcePts + previousSample.durationPts) {
          invalidSegmentSet(
            'sample source timing must be contiguous within one epoch',
          )
        }
      }

      locations.push({
        epochId: segment.index.epochId,
        segmentId: segment.segmentId,
        sample,
      })
      previousSample = sample
    }
    previousSegment = segment
  }

  const indexedStartUs = first.index.availableStartUs
  const indexedEndUs = segments.at(-1)!.index.availableEndUs
  if (windowStartUs < indexedStartUs || windowEndUs > indexedEndUs) {
    invalidSegmentSet('playback window must be contained in the indexed range')
  }

  return locations
}

/** Resolve one observation through a strict persisted sample index. */
export function resolveCanonicalTime(
  index: SampleIndex,
  segmentId: string,
  canonicalTimeUs: bigint,
  readyStartUs = index.availableStartUs,
  readyEndUs = index.availableEndUs,
): ResolveResult {
  return resolveCanonicalTimeAcrossSegments(
    [{ segmentId, index }],
    canonicalTimeUs,
    readyStartUs,
    readyEndUs,
  )
}

/**
 * Resolve globally across one bounded, contiguous epoch. A persisted sample is
 * exact frame identity even when the browser observation needs a nonzero snap.
 */
export function resolveCanonicalTimeAcrossSegments(
  segments: readonly IndexedSegment[],
  canonicalTimeUs: bigint,
  windowStartUs: bigint,
  windowEndUs: bigint,
): ResolveResult {
  const locations = validateSegments(
    segments,
    windowStartUs,
    windowEndUs,
    'INVALID_SEGMENT_SET',
  )
  if (canonicalTimeUs < windowStartUs || canonicalTimeUs >= windowEndUs) {
    throw new ResolverError(
      'CAPTURE_GAP',
      'target is outside ready contiguous range',
    )
  }

  let best: IndexedLocation | undefined
  let bestDistance: bigint | undefined
  for (const location of locations) {
    const captureTimeUs = location.sample.captureTimeUs
    if (captureTimeUs < windowStartUs || captureTimeUs >= windowEndUs) continue
    const distance =
      captureTimeUs >= canonicalTimeUs
        ? captureTimeUs - canonicalTimeUs
        : canonicalTimeUs - captureTimeUs
    if (
      bestDistance === undefined ||
      distance < bestDistance ||
      (distance === bestDistance &&
        captureTimeUs < best!.sample.captureTimeUs)
    ) {
      best = location
      bestDistance = distance
    }
  }

  if (!best || bestDistance === undefined) {
    throw new ResolverError('SAMPLE_NOT_FOUND', 'no sample in ready range')
  }
  return {
    kind: 'frame_exact',
    epochId: best.epochId,
    segmentId: best.segmentId,
    sample: serializeAnchor(best.sample),
    snapDistanceUs: bestDistance.toString(),
  }
}

export function frameStep(
  index: SampleIndex,
  segmentId: string,
  captureFrameIndex: bigint,
  direction: 'previous' | 'next',
  windowStartUs = index.availableStartUs,
  windowEndUs = index.availableEndUs,
): StepResult {
  return frameStepAcrossSegments(
    [{ segmentId, index }],
    captureFrameIndex,
    direction,
    windowStartUs,
    windowEndUs,
  )
}

export function frameStepAcrossSegments(
  segments: readonly IndexedSegment[],
  captureFrameIndex: bigint,
  direction: 'previous' | 'next',
  windowStartUs: bigint,
  windowEndUs: bigint,
): StepResult {
  const locations = validateSegments(
    segments,
    windowStartUs,
    windowEndUs,
    'SAMPLE_NOT_FOUND',
  )
  const currentIndex = locations.findIndex(
    ({ sample }) => sample.captureFrameIndex === captureFrameIndex,
  )
  if (currentIndex < 0) {
    throw new ResolverError('SAMPLE_NOT_FOUND', 'sample not found')
  }
  const current = locations[currentIndex]!
  if (
    current.sample.captureTimeUs < windowStartUs ||
    current.sample.captureTimeUs >= windowEndUs
  ) {
    throw new ResolverError(
      'SAMPLE_NOT_FOUND',
      'current sample is outside playback window',
    )
  }

  const targetIndex = currentIndex + (direction === 'next' ? 1 : -1)
  const target = locations[targetIndex]
  if (!target) {
    throw new ResolverError('SAMPLE_NOT_FOUND', 'no adjacent sample')
  }
  if (
    target.sample.captureTimeUs < windowStartUs ||
    target.sample.captureTimeUs >= windowEndUs
  ) {
    throw new ResolverError(
      'WINDOW_BOUNDARY',
      'adjacent sample outside playback window',
    )
  }
  return {
    kind: 'frame_exact',
    epochId: target.epochId,
    segmentId: target.segmentId,
    sample: serializeAnchor(target.sample),
  }
}
