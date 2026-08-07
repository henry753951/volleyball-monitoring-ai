import {
  rescalePtsToUs,
  type IndexedSample,
  type Rational,
  type SampleIndex,
} from './sample-index'

/** One real source sample from a finalized fMP4 segment. */
export type SourceSampleTiming = {
  sourcePts: bigint
  durationPts: bigint
  keyframe: boolean
}

/**
 * Pure planner input. `segmentIdentity` is the stable replay identity, while
 * `sourceIdentity` identifies one recorder/source lifetime and changes on a
 * known restart. `sourceOrder` is an opaque monotonic bigint sequence.
 */
export type FinalizedIndexedSegment = {
  /** Stable idempotency identity for this finalized segment. */
  segmentIdentity: string
  /** Stable recorder/source lifetime identity; change it after a restart. */
  sourceIdentity: string
  /** Monotonic source discovery order, never converted to a JS number. */
  sourceOrder: bigint
  timeBase: Rational
  samples: readonly SourceSampleTiming[]
  /** Optional independent monotonic timestamp for the first source sample. */
  sourceStartTimeUs?: bigint
  /** Explicit restart signal when source identity cannot change. */
  sourceRestart?: boolean
  /** Explicit container/recorder discontinuity signal at this boundary. */
  timestampDiscontinuity?: boolean
  /** Known real unavailable interval before this segment. */
  explicitGapBeforeUs?: bigint
}

/** All tolerances and canonical origins are explicit and bigint-safe. */
export type CaptureEpochPlannerConfig = {
  canonicalSessionOriginUs: bigint
  canonicalFrameOrigin: bigint
  /** Tolerance for independent source timestamps and gap observations only. */
  timestampToleranceUs: bigint
}

/** Stable causes for opening a new capture epoch/discontinuity. */
export type DiscontinuityReason =
  | 'SESSION_START'
  | 'PTS_RESET'
  | 'TIMESTAMP_DISCONTINUITY'
  | 'SOURCE_RESTART'
  | 'SOURCE_IDENTITY_CHANGE'
  | 'TIME_BASE_CHANGE'
  | 'EXPLICIT_GAP'

/** One affine source-PTS to canonical-time mapping. */
export type PlannedCaptureEpoch = {
  epochKey: string
  epochSequence: number
  discontinuity: number
  sourceIdentity: string
  timeBase: Rational
  sourcePtsOrigin: bigint
  captureTimeOriginUs: bigint
  captureFrameOrigin: bigint
  reasons: readonly DiscontinuityReason[]
}

/** Canonicalized segment; `captureEndUs` is an exclusive presentation bound. */
export type PlannedCaptureSegment = {
  segmentIdentity: string
  sourceIdentity: string
  sourceOrder: bigint
  epochKey: string
  epochSequence: number
  discontinuity: number
  sourceStartPts: bigint
  sourceEndPtsExclusive: bigint
  captureStartUs: bigint
  captureEndUs: bigint
  sampleIndex: SampleIndex
}

/** A real unavailable half-open interval. No sample is created in this range. */
export type CaptureGapRange = {
  startUs: bigint
  endUs: bigint
  beforeSegmentIdentity: string
  afterSegmentIdentity: string
  discontinuity: number
  reasons: readonly DiscontinuityReason[]
}

export type PlannedAvailabilityRange = {
  startUs: bigint
  endUs: bigint
  discontinuity: number
  segmentIdentities: readonly string[]
}

/** Complete immutable result of one deterministic batch plan. */
export type CaptureEpochPlan = {
  canonicalSessionOriginUs: bigint
  canonicalFrameOrigin: bigint
  epochs: readonly PlannedCaptureEpoch[]
  segments: readonly PlannedCaptureSegment[]
  gaps: readonly CaptureGapRange[]
  availableRanges: readonly PlannedAvailabilityRange[]
  liveEdgeCaptureTimeUs: bigint
  nextCaptureFrameIndex: bigint
}

/** Fail-closed validation and ordering error codes. */
export type CaptureEpochPlannerErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_SEGMENT'
  | 'ORDER_CONFLICT'
  | 'DUPLICATE_CONFLICT'
  | 'GAP_CONFLICT'

export class CaptureEpochPlannerError extends Error {
  constructor(
    public readonly code: CaptureEpochPlannerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CaptureEpochPlannerError'
  }
}

type SegmentBounds = {
  firstPts: bigint
  lastPts: bigint
  endPtsExclusive: bigint
  durationUs: bigint
}

function sameTimeBase(left: Rational, right: Rational): boolean {
  return left.num === right.num && left.den === right.den
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

function validateIdentity(value: string, field: string): void {
  if (!value || value.includes('\0')) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      `${field} must be non-empty`,
    )
  }
}

function segmentBounds(segment: FinalizedIndexedSegment): SegmentBounds {
  validateIdentity(segment.segmentIdentity, 'segmentIdentity')
  validateIdentity(segment.sourceIdentity, 'sourceIdentity')
  if (segment.sourceOrder < 0n) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      'sourceOrder must be non-negative',
    )
  }
  if (segment.timeBase.num <= 0n || segment.timeBase.den <= 0n) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      'time base must be positive',
    )
  }
  if (segment.samples.length === 0) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      'segment must contain samples',
    )
  }
  if (
    segment.explicitGapBeforeUs !== undefined &&
    segment.explicitGapBeforeUs <= 0n
  ) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      'explicit gap must be positive',
    )
  }

  let previousEndPts: bigint | undefined
  let previousCaptureOffsetUs: bigint | undefined
  const firstPts = segment.samples[0]!.sourcePts
  for (const sample of segment.samples) {
    if (sample.durationPts <= 0n) {
      throw new CaptureEpochPlannerError(
        'INVALID_SEGMENT',
        'sample duration must be positive',
      )
    }
    if (previousEndPts !== undefined && sample.sourcePts !== previousEndPts) {
      throw new CaptureEpochPlannerError(
        'INVALID_SEGMENT',
        'sample table must be contiguous within a segment',
      )
    }
    const captureOffsetUs = rescalePtsToUs(
      sample.sourcePts - firstPts,
      segment.timeBase,
    )
    if (
      previousCaptureOffsetUs !== undefined &&
      captureOffsetUs <= previousCaptureOffsetUs
    ) {
      throw new CaptureEpochPlannerError(
        'INVALID_SEGMENT',
        'sample times collapse at microsecond precision',
      )
    }
    previousCaptureOffsetUs = captureOffsetUs
    previousEndPts = sample.sourcePts + sample.durationPts
  }

  const lastPts = segment.samples.at(-1)!.sourcePts
  const endPtsExclusive = previousEndPts!
  const durationUs = rescalePtsToUs(
    endPtsExclusive - firstPts,
    segment.timeBase,
  )
  if (durationUs <= 0n) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      'segment duration collapses at microsecond precision',
    )
  }
  return { firstPts, lastPts, endPtsExclusive, durationUs }
}

function sameSegment(
  left: FinalizedIndexedSegment,
  right: FinalizedIndexedSegment,
): boolean {
  if (
    left.segmentIdentity !== right.segmentIdentity ||
    left.sourceIdentity !== right.sourceIdentity ||
    left.sourceOrder !== right.sourceOrder ||
    !sameTimeBase(left.timeBase, right.timeBase) ||
    left.sourceStartTimeUs !== right.sourceStartTimeUs ||
    left.sourceRestart !== right.sourceRestart ||
    left.timestampDiscontinuity !== right.timestampDiscontinuity ||
    left.explicitGapBeforeUs !== right.explicitGapBeforeUs ||
    left.samples.length !== right.samples.length
  ) {
    return false
  }
  return left.samples.every((sample, index) => {
    const other = right.samples[index]
    return (
      other !== undefined &&
      sample.sourcePts === other.sourcePts &&
      sample.durationPts === other.durationPts &&
      sample.keyframe === other.keyframe
    )
  })
}

function epochKey(sequence: number): string {
  return `capture-epoch-${sequence}`
}

function addReason(
  reasons: DiscontinuityReason[],
  reason: DiscontinuityReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason)
}

function reconcileGapCandidates(
  candidates: readonly bigint[],
  toleranceUs: bigint,
): bigint {
  if (candidates.length === 0) return 0n
  const authoritative = candidates[0]!
  for (const candidate of candidates.slice(1)) {
    if (absolute(candidate - authoritative) > toleranceUs) {
      throw new CaptureEpochPlannerError(
        'GAP_CONFLICT',
        'independent gap observations conflict',
      )
    }
  }
  return authoritative
}

function buildSampleIndex(
  segment: FinalizedIndexedSegment,
  bounds: SegmentBounds,
  epoch: PlannedCaptureEpoch,
  frameOrigin: bigint,
): SampleIndex {
  const samples: IndexedSample[] = []
  let frameIndex = frameOrigin
  for (const sample of segment.samples) {
    samples.push({
      sourcePts: sample.sourcePts,
      durationPts: sample.durationPts,
      captureTimeUs:
        epoch.captureTimeOriginUs +
        rescalePtsToUs(
          sample.sourcePts - epoch.sourcePtsOrigin,
          epoch.timeBase,
        ),
      captureFrameIndex: frameIndex,
      keyframe: sample.keyframe,
    })
    frameIndex += 1n
  }
  const availableEndUs =
    epoch.captureTimeOriginUs +
    rescalePtsToUs(
      bounds.endPtsExclusive - epoch.sourcePtsOrigin,
      epoch.timeBase,
    )
  return {
    version: '1',
    epochId: epoch.epochKey,
    timeBase: epoch.timeBase,
    samples,
    availableStartUs: samples[0]!.captureTimeUs,
    availableEndUs,
  }
}

function nextEpochSequence(current: number): number {
  if (current === 2_147_483_647) {
    throw new CaptureEpochPlannerError(
      'INVALID_CONFIG',
      'discontinuity sequence exhausted',
    )
  }
  return current + 1
}

/**
 * Plans a deterministic canonical timeline from already-finalized sample
 * tables. Inputs must arrive in source order. Exact duplicate replays are
 * ignored; conflicting identities or order reuse fail closed.
 */
export function planCaptureEpochs(
  input: readonly FinalizedIndexedSegment[],
  config: CaptureEpochPlannerConfig,
): CaptureEpochPlan {
  if (config.canonicalFrameOrigin < 0n || config.timestampToleranceUs < 0n) {
    throw new CaptureEpochPlannerError(
      'INVALID_CONFIG',
      'frame origin and timestamp tolerance must be non-negative',
    )
  }
  if (input.length === 0) {
    throw new CaptureEpochPlannerError(
      'INVALID_SEGMENT',
      'at least one segment is required',
    )
  }

  const seenByIdentity = new Map<string, FinalizedIndexedSegment>()
  const seenByOrder = new Map<bigint, string>()
  const unique: Array<{
    segment: FinalizedIndexedSegment
    bounds: SegmentBounds
  }> = []
  let lastOrder: bigint | undefined

  for (const segment of input) {
    const bounds = segmentBounds(segment)
    const replay = seenByIdentity.get(segment.segmentIdentity)
    if (replay) {
      if (!sameSegment(replay, segment)) {
        throw new CaptureEpochPlannerError(
          'DUPLICATE_CONFLICT',
          `segment ${segment.segmentIdentity} replay conflicts`,
        )
      }
      continue
    }
    const orderIdentity = seenByOrder.get(segment.sourceOrder)
    if (orderIdentity !== undefined) {
      throw new CaptureEpochPlannerError(
        'ORDER_CONFLICT',
        `source order already belongs to ${orderIdentity}`,
      )
    }
    if (lastOrder !== undefined && segment.sourceOrder <= lastOrder) {
      throw new CaptureEpochPlannerError(
        'ORDER_CONFLICT',
        'segments must arrive in strictly increasing source order',
      )
    }
    seenByIdentity.set(segment.segmentIdentity, segment)
    seenByOrder.set(segment.sourceOrder, segment.segmentIdentity)
    unique.push({ segment, bounds })
    lastOrder = segment.sourceOrder
  }

  const epochs: PlannedCaptureEpoch[] = []
  const segments: PlannedCaptureSegment[] = []
  const gaps: CaptureGapRange[] = []
  const availableRanges: Array<{
    startUs: bigint
    endUs: bigint
    discontinuity: number
    segmentIdentities: string[]
  }> = []
  let nextFrameIndex = config.canonicalFrameOrigin

  for (const [index, entry] of unique.entries()) {
    const { segment, bounds } = entry
    const previousEntry = unique[index - 1]
    const previousPlan = segments[index - 1]
    let epoch: PlannedCaptureEpoch

    if (!previousEntry || !previousPlan) {
      if (segment.explicitGapBeforeUs !== undefined) {
        throw new CaptureEpochPlannerError(
          'INVALID_SEGMENT',
          'first segment cannot declare a preceding gap',
        )
      }
      epoch = {
        epochKey: epochKey(0),
        epochSequence: 0,
        discontinuity: 0,
        sourceIdentity: segment.sourceIdentity,
        timeBase: segment.timeBase,
        sourcePtsOrigin: bounds.firstPts,
        captureTimeOriginUs: config.canonicalSessionOriginUs,
        captureFrameOrigin: nextFrameIndex,
        reasons: ['SESSION_START'],
      }
      epochs.push(epoch)
    } else {
      const reasons: DiscontinuityReason[] = []
      const gapCandidates: bigint[] = []
      const previous = previousEntry.segment
      const previousBounds = previousEntry.bounds
      const previousEpoch = epochs[epochs.length - 1]!

      if (segment.sourceRestart) addReason(reasons, 'SOURCE_RESTART')
      if (segment.timestampDiscontinuity) {
        addReason(reasons, 'TIMESTAMP_DISCONTINUITY')
      }
      if (segment.sourceIdentity !== previous.sourceIdentity) {
        addReason(reasons, 'SOURCE_IDENTITY_CHANGE')
      }
      if (!sameTimeBase(segment.timeBase, previous.timeBase)) {
        addReason(reasons, 'TIME_BASE_CHANGE')
      }
      if (segment.explicitGapBeforeUs !== undefined) {
        addReason(reasons, 'EXPLICIT_GAP')
        gapCandidates.push(segment.explicitGapBeforeUs)
      }

      if (
        segment.sourceIdentity === previous.sourceIdentity &&
        sameTimeBase(segment.timeBase, previous.timeBase)
      ) {
        const ptsDelta = bounds.firstPts - previousBounds.endPtsExclusive
        if (ptsDelta < 0n) {
          addReason(
            reasons,
            bounds.firstPts <= previousBounds.lastPts
              ? 'PTS_RESET'
              : 'TIMESTAMP_DISCONTINUITY',
          )
        } else if (ptsDelta > 0n) {
          addReason(reasons, 'TIMESTAMP_DISCONTINUITY')
          const ptsGapUs = rescalePtsToUs(ptsDelta, segment.timeBase)
          if (ptsGapUs > 0n) gapCandidates.push(ptsGapUs)
        }
      }

      if (
        previous.sourceStartTimeUs !== undefined &&
        segment.sourceStartTimeUs !== undefined
      ) {
        const expectedSourceStartUs =
          previous.sourceStartTimeUs + previousBounds.durationUs
        const timestampDriftUs =
          segment.sourceStartTimeUs - expectedSourceStartUs
        if (absolute(timestampDriftUs) > config.timestampToleranceUs) {
          addReason(reasons, 'TIMESTAMP_DISCONTINUITY')
          if (timestampDriftUs > 0n) gapCandidates.push(timestampDriftUs)
        }
      }

      if (reasons.length === 0) {
        epoch = previousEpoch
      } else {
        const sequence = nextEpochSequence(previousEpoch.epochSequence)
        const gapUs = reconcileGapCandidates(
          gapCandidates,
          config.timestampToleranceUs,
        )
        const captureOriginUs = previousPlan.captureEndUs + gapUs
        epoch = {
          epochKey: epochKey(sequence),
          epochSequence: sequence,
          discontinuity: sequence,
          sourceIdentity: segment.sourceIdentity,
          timeBase: segment.timeBase,
          sourcePtsOrigin: bounds.firstPts,
          captureTimeOriginUs: captureOriginUs,
          captureFrameOrigin: nextFrameIndex,
          reasons,
        }
        epochs.push(epoch)
        if (gapUs > 0n) {
          gaps.push({
            startUs: previousPlan.captureEndUs,
            endUs: captureOriginUs,
            beforeSegmentIdentity: previousPlan.segmentIdentity,
            afterSegmentIdentity: segment.segmentIdentity,
            discontinuity: sequence,
            reasons,
          })
        }
      }
    }

    const sampleIndex = buildSampleIndex(segment, bounds, epoch, nextFrameIndex)
    const firstSample = sampleIndex.samples[0]!
    if (
      previousPlan &&
      (firstSample.captureTimeUs < previousPlan.captureEndUs ||
        firstSample.captureFrameIndex <=
          previousPlan.sampleIndex.samples.at(-1)!.captureFrameIndex)
    ) {
      throw new CaptureEpochPlannerError(
        'ORDER_CONFLICT',
        'canonical segment order is not monotonic',
      )
    }
    const planned: PlannedCaptureSegment = {
      segmentIdentity: segment.segmentIdentity,
      sourceIdentity: segment.sourceIdentity,
      sourceOrder: segment.sourceOrder,
      epochKey: epoch.epochKey,
      epochSequence: epoch.epochSequence,
      discontinuity: epoch.discontinuity,
      sourceStartPts: bounds.firstPts,
      sourceEndPtsExclusive: bounds.endPtsExclusive,
      captureStartUs: sampleIndex.availableStartUs,
      captureEndUs: sampleIndex.availableEndUs,
      sampleIndex,
    }
    segments.push(planned)

    const previousRange = availableRanges.at(-1)
    if (
      previousRange &&
      previousRange.discontinuity === planned.discontinuity &&
      previousRange.endUs === planned.captureStartUs
    ) {
      previousRange.endUs = planned.captureEndUs
      previousRange.segmentIdentities.push(planned.segmentIdentity)
    } else {
      availableRanges.push({
        startUs: planned.captureStartUs,
        endUs: planned.captureEndUs,
        discontinuity: planned.discontinuity,
        segmentIdentities: [planned.segmentIdentity],
      })
    }

    nextFrameIndex = sampleIndex.samples.at(-1)!.captureFrameIndex + 1n
  }

  return {
    canonicalSessionOriginUs: config.canonicalSessionOriginUs,
    canonicalFrameOrigin: config.canonicalFrameOrigin,
    epochs,
    segments,
    gaps,
    availableRanges,
    liveEdgeCaptureTimeUs: segments.at(-1)!.captureEndUs,
    nextCaptureFrameIndex: nextFrameIndex,
  }
}
