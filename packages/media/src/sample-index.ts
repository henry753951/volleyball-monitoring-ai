export type Rational = {
  num: bigint
  den: bigint
}

export type CaptureEpochOrigin = {
  epochId: string
  sourcePtsOrigin: bigint
  captureTimeOriginUs: bigint
  captureFrameOrigin: bigint
  timeBase: Rational
}

export type FfprobeFrame = {
  media_type: 'video' | string
  pts?: string
  pkt_duration?: string
  key_frame?: number
}

export type IndexedSample = {
  sourcePts: bigint
  durationPts: bigint
  captureTimeUs: bigint
  captureFrameIndex: bigint
  keyframe: boolean
}

export type SampleIndex = {
  epochId: string
  timeBase: Rational
  samples: readonly IndexedSample[]
  availableStartUs: bigint
  /** Exclusive canonical presentation end. */
  availableEndUs: bigint
}

export type SampleIndexSampleDocument = {
  sourcePts: string
  durationPts: string
  captureTimeUs: string
  captureFrameIndex: string
  keyframe: boolean
}

export type SampleIndexDocument = {
  schemaVersion: '1.0.0'
  epochId: string
  timeBase: {
    num: string
    den: string
  }
  samples: SampleIndexSampleDocument[]
}

export type AvailabilityRange = {
  segmentIds: string[]
  startUs: bigint
  endUs: bigint
  discontinuity: number
}

export type FfprobePayload = {
  streams?: readonly {
    codec_type?: string
    time_base?: string
  }[]
  frames?: readonly FfprobeFrame[]
}

export type SampleIndexErrorCode =
  | 'INVALID_TIME_BASE'
  | 'INVALID_FRAME'
  | 'INVALID_DOCUMENT'
  | 'INVALID_RANGE'
  | 'NON_MONOTONIC'
  | 'EMPTY_INDEX'

export class SampleIndexError extends Error {
  constructor(
    public readonly code: SampleIndexErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SampleIndexError'
  }
}

const SIGNED_DECIMAL = /^(?:0|-[1-9]\d*|[1-9]\d*)$/
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/
const POSITIVE_DECIMAL = /^[1-9]\d*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
): void {
  const keys = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      `${scope} has unknown or missing fields`,
    )
  }
}

function parseSignedDecimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      `${field} must be a canonical signed decimal string`,
    )
  }
  return BigInt(value)
}

function parseNonnegativeDecimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !NONNEGATIVE_DECIMAL.test(value)) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      `${field} must be a canonical nonnegative decimal string`,
    )
  }
  return BigInt(value)
}

function parsePositiveDecimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      `${field} must be a canonical positive decimal string`,
    )
  }
  return BigInt(value)
}

function validateEpochOrigin(origin: CaptureEpochOrigin): void {
  if (!origin.epochId.trim()) {
    throw new SampleIndexError('INVALID_FRAME', 'epoch id must be non-empty')
  }
  if (origin.timeBase.num <= 0n || origin.timeBase.den <= 0n) {
    throw new SampleIndexError(
      'INVALID_TIME_BASE',
      'time base must be positive',
    )
  }
  if (origin.captureTimeOriginUs < 0n || origin.captureFrameOrigin < 0n) {
    throw new SampleIndexError(
      'INVALID_FRAME',
      'canonical origins must be nonnegative',
    )
  }
}

function sameTimeBase(left: Rational, right: Rational): boolean {
  return left.num === right.num && left.den === right.den
}

function validateSampleSequence(
  samples: readonly IndexedSample[],
  timeBase: Rational,
  origin?: CaptureEpochOrigin,
): void {
  if (samples.length === 0) {
    throw new SampleIndexError('EMPTY_INDEX', 'no samples')
  }

  let previous: IndexedSample | undefined
  for (const sample of samples) {
    if (typeof sample.keyframe !== 'boolean') {
      throw new SampleIndexError(
        'INVALID_FRAME',
        'sample keyframe must be boolean',
      )
    }
    if (sample.durationPts <= 0n) {
      throw new SampleIndexError(
        'INVALID_FRAME',
        'sample duration must be positive',
      )
    }
    if (sample.captureTimeUs < 0n || sample.captureFrameIndex < 0n) {
      throw new SampleIndexError(
        'INVALID_FRAME',
        'canonical sample values must be nonnegative',
      )
    }
    if (previous) {
      const expectedPts = previous.sourcePts + previous.durationPts
      if (sample.sourcePts !== expectedPts) {
        throw new SampleIndexError(
          'NON_MONOTONIC',
          sample.sourcePts < expectedPts
            ? 'sample timing overlaps'
            : 'sample timing has a hole',
        )
      }
      if (sample.captureFrameIndex !== previous.captureFrameIndex + 1n) {
        throw new SampleIndexError(
          'NON_MONOTONIC',
          'capture frame indices must be contiguous',
        )
      }
      if (sample.captureTimeUs <= previous.captureTimeUs) {
        throw new SampleIndexError(
          'NON_MONOTONIC',
          'capture times must increase',
        )
      }
    }
    if (origin) {
      const expectedCaptureTimeUs =
        origin.captureTimeOriginUs +
        rescalePtsToUs(
          sample.sourcePts - origin.sourcePtsOrigin,
          origin.timeBase,
        )
      if (sample.captureTimeUs !== expectedCaptureTimeUs) {
        throw new SampleIndexError(
          'INVALID_DOCUMENT',
          'capture time is inconsistent with the epoch origin',
        )
      }
      if (sample.captureFrameIndex < origin.captureFrameOrigin) {
        throw new SampleIndexError(
          'INVALID_DOCUMENT',
          'capture frame precedes the epoch origin',
        )
      }
    }
    previous = sample
  }

  const finalDurationUs = rescalePtsToUs(
    samples.at(-1)!.durationPts,
    timeBase,
  )
  if (finalDurationUs <= 0n) {
    throw new SampleIndexError(
      'INVALID_FRAME',
      'sample duration collapses at microsecond precision',
    )
  }
}

function epochRelativeEndUs(
  samples: readonly IndexedSample[],
  origin: Pick<
    CaptureEpochOrigin,
    'sourcePtsOrigin' | 'captureTimeOriginUs' | 'timeBase'
  >,
): bigint {
  const last = samples.at(-1)!
  return (
    origin.captureTimeOriginUs +
    rescalePtsToUs(
      last.sourcePts + last.durationPts - origin.sourcePtsOrigin,
      origin.timeBase,
    )
  )
}

function validateIndex(index: SampleIndex): void {
  if (!index.epochId.trim()) {
    throw new SampleIndexError('INVALID_FRAME', 'epoch id must be non-empty')
  }
  if (index.timeBase.num <= 0n || index.timeBase.den <= 0n) {
    throw new SampleIndexError(
      'INVALID_TIME_BASE',
      'time base must be positive',
    )
  }
  validateSampleSequence(index.samples, index.timeBase)
  if (index.availableStartUs !== index.samples[0]!.captureTimeUs) {
    throw new SampleIndexError(
      'INVALID_RANGE',
      'available start must equal the first sample time',
    )
  }
  if (index.availableEndUs <= index.samples.at(-1)!.captureTimeUs) {
    throw new SampleIndexError(
      'INVALID_RANGE',
      'available end must follow the last sample',
    )
  }
}

export function serializeSample(sample: IndexedSample): SampleIndexSampleDocument {
  return {
    sourcePts: sample.sourcePts.toString(),
    durationPts: sample.durationPts.toString(),
    captureTimeUs: sample.captureTimeUs.toString(),
    captureFrameIndex: sample.captureFrameIndex.toString(),
    keyframe: sample.keyframe,
  }
}

/** Serialize the strict internal v1 document without changing its stored shape. */
export function serializeSampleIndex(index: SampleIndex): SampleIndexDocument {
  validateIndex(index)
  return {
    schemaVersion: '1.0.0',
    epochId: index.epochId,
    timeBase: {
      num: index.timeBase.num.toString(),
      den: index.timeBase.den.toString(),
    },
    samples: index.samples.map(serializeSample),
  }
}

/**
 * Parse and materialize a strict v1 document. The epoch origin is required
 * because it is intentionally stored in CaptureEpoch rather than duplicated
 * in every sample-index artifact.
 */
export function parseSampleIndexDocument(
  input: unknown,
  origin: CaptureEpochOrigin,
): SampleIndex {
  validateEpochOrigin(origin)
  if (!isRecord(input)) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      'sample index document must be an object',
    )
  }
  requireExactKeys(
    input,
    ['schemaVersion', 'epochId', 'timeBase', 'samples'],
    'sample index document',
  )
  if (input.schemaVersion !== '1.0.0') {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      'unsupported sample index schema version',
    )
  }
  if (typeof input.epochId !== 'string' || !input.epochId.trim()) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      'epochId must be a non-empty string',
    )
  }
  if (input.epochId !== origin.epochId) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      'document epoch does not match the epoch origin',
    )
  }
  if (!isRecord(input.timeBase)) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      'timeBase must be an object',
    )
  }
  requireExactKeys(input.timeBase, ['num', 'den'], 'timeBase')
  const timeBase = {
    num: parsePositiveDecimal(input.timeBase.num, 'timeBase.num'),
    den: parsePositiveDecimal(input.timeBase.den, 'timeBase.den'),
  }
  if (!sameTimeBase(timeBase, origin.timeBase)) {
    throw new SampleIndexError(
      'INVALID_DOCUMENT',
      'document time base does not match the epoch origin',
    )
  }
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    throw new SampleIndexError(
      'EMPTY_INDEX',
      'samples must be a non-empty array',
    )
  }

  const samples: IndexedSample[] = input.samples.map((value, index) => {
    if (!isRecord(value)) {
      throw new SampleIndexError(
        'INVALID_DOCUMENT',
        `samples[${index}] must be an object`,
      )
    }
    requireExactKeys(
      value,
      [
        'sourcePts',
        'durationPts',
        'captureTimeUs',
        'captureFrameIndex',
        'keyframe',
      ],
      `samples[${index}]`,
    )
    if (typeof value.keyframe !== 'boolean') {
      throw new SampleIndexError(
        'INVALID_DOCUMENT',
        `samples[${index}].keyframe must be boolean`,
      )
    }
    return {
      sourcePts: parseSignedDecimal(
        value.sourcePts,
        `samples[${index}].sourcePts`,
      ),
      durationPts: parsePositiveDecimal(
        value.durationPts,
        `samples[${index}].durationPts`,
      ),
      captureTimeUs: parseNonnegativeDecimal(
        value.captureTimeUs,
        `samples[${index}].captureTimeUs`,
      ),
      captureFrameIndex: parseNonnegativeDecimal(
        value.captureFrameIndex,
        `samples[${index}].captureFrameIndex`,
      ),
      keyframe: value.keyframe,
    }
  })

  validateSampleSequence(samples, timeBase, origin)
  const index: SampleIndex = {
    epochId: input.epochId,
    timeBase,
    samples,
    availableStartUs: samples[0]!.captureTimeUs,
    availableEndUs: epochRelativeEndUs(samples, origin),
  }
  validateIndex(index)
  return index
}

function parseFfprobeInteger(
  value: string | undefined,
  field: string,
): bigint {
  if (value === undefined || !SIGNED_DECIMAL.test(value)) {
    throw new SampleIndexError('INVALID_FRAME', `invalid ${field}`)
  }
  return BigInt(value)
}

export function parseTimeBase(value: string | undefined): Rational {
  if (!value) {
    throw new SampleIndexError('INVALID_TIME_BASE', 'invalid time base')
  }
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value)
  if (!match) {
    throw new SampleIndexError('INVALID_TIME_BASE', 'invalid time base')
  }
  return {
    num: BigInt(match[1]!),
    den: BigInt(match[2]!),
  }
}

export function parseFfprobePayload(payload: FfprobePayload): {
  frames: FfprobeFrame[]
  timeBase: Rational
} {
  const streams = (payload.streams ?? []).filter(
    (stream) => stream.codec_type === 'video',
  )
  if (streams.length !== 1) {
    throw new SampleIndexError(
      'INVALID_FRAME',
      'expected exactly one video stream',
    )
  }
  const timeBase = parseTimeBase(streams[0]!.time_base)
  const frames = [...(payload.frames ?? [])]
  if (frames.length === 0) {
    throw new SampleIndexError('EMPTY_INDEX', 'no frames')
  }
  return { frames, timeBase }
}

function roundNearestAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive')
  const sign = numerator < 0n ? -1n : 1n
  const absoluteValue = numerator < 0n ? -numerator : numerator
  const quotient = absoluteValue / denominator
  const remainder = absoluteValue % denominator
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n))
}

export function rescalePtsToUs(
  deltaPts: bigint,
  timeBase: Rational,
): bigint {
  if (timeBase.num <= 0n || timeBase.den <= 0n) {
    throw new SampleIndexError(
      'INVALID_TIME_BASE',
      'time base must be positive',
    )
  }
  return roundNearestAway(
    deltaPts * timeBase.num * 1_000_000n,
    timeBase.den,
  )
}

/** Build one strict index from an epoch-relative ffprobe sample table. */
export function buildSampleIndex(
  frames: readonly FfprobeFrame[],
  origin: CaptureEpochOrigin,
): SampleIndex {
  validateEpochOrigin(origin)
  const samples: IndexedSample[] = []
  let previousEndPts: bigint | undefined
  let frameIndex = origin.captureFrameOrigin

  for (const frame of frames) {
    if (frame.media_type !== 'video') continue
    const sourcePts = parseFfprobeInteger(frame.pts, 'pts')
    const durationPts = parseFfprobeInteger(frame.pkt_duration, 'pkt_duration')
    if (durationPts <= 0n) {
      throw new SampleIndexError(
        'INVALID_FRAME',
        'pkt_duration must be positive',
      )
    }
    if (
      frame.key_frame !== undefined &&
      frame.key_frame !== 0 &&
      frame.key_frame !== 1
    ) {
      throw new SampleIndexError(
        'INVALID_FRAME',
        'key_frame must be 0 or 1',
      )
    }
    if (previousEndPts !== undefined && sourcePts !== previousEndPts) {
      throw new SampleIndexError(
        'NON_MONOTONIC',
        sourcePts < previousEndPts
          ? 'sample timing overlaps'
          : 'sample timing has a hole',
      )
    }
    samples.push({
      sourcePts,
      durationPts,
      captureTimeUs:
        origin.captureTimeOriginUs +
        rescalePtsToUs(
          sourcePts - origin.sourcePtsOrigin,
          origin.timeBase,
        ),
      captureFrameIndex: frameIndex,
      keyframe: frame.key_frame === 1,
    })
    previousEndPts = sourcePts + durationPts
    frameIndex += 1n
  }

  if (samples.length === 0) {
    throw new SampleIndexError('EMPTY_INDEX', 'no video samples')
  }
  validateSampleSequence(samples, origin.timeBase, origin)
  const index: SampleIndex = {
    epochId: origin.epochId,
    timeBase: origin.timeBase,
    samples,
    availableStartUs: samples[0]!.captureTimeUs,
    availableEndUs: epochRelativeEndUs(samples, origin),
  }
  validateIndex(index)
  return index
}

/**
 * Coalesce only exact touching ranges in one discontinuity. Input order,
 * identities, ranges, epoch boundaries, and canonical frame order fail closed.
 */
export function buildAvailabilityRanges(
  indexes: readonly {
    segmentId: string
    index: SampleIndex
    discontinuity: number
  }[],
): AvailabilityRange[] {
  const ranges: AvailabilityRange[] = []
  const segmentIds = new Set<string>()
  let previous:
    | {
        segmentId: string
        index: SampleIndex
        discontinuity: number
      }
    | undefined

  for (const entry of indexes) {
    if (!entry.segmentId.trim()) {
      throw new SampleIndexError(
        'INVALID_RANGE',
        'segment id must be non-empty',
      )
    }
    if (segmentIds.has(entry.segmentId)) {
      throw new SampleIndexError('INVALID_RANGE', 'duplicate segment id')
    }
    segmentIds.add(entry.segmentId)
    if (
      !Number.isInteger(entry.discontinuity) ||
      entry.discontinuity < 0 ||
      entry.discontinuity > 2_147_483_647
    ) {
      throw new SampleIndexError(
        'INVALID_RANGE',
        'invalid discontinuity sequence',
      )
    }
    validateIndex(entry.index)

    if (!previous) {
      if (entry.discontinuity !== 0) {
        throw new SampleIndexError(
          'INVALID_RANGE',
          'first discontinuity must be zero',
        )
      }
    } else {
      const previousLast = previous.index.samples.at(-1)!
      const nextFirst = entry.index.samples[0]!
      if (
        entry.discontinuity < previous.discontinuity ||
        entry.discontinuity > previous.discontinuity + 1
      ) {
        throw new SampleIndexError(
          'INVALID_RANGE',
          'discontinuity sequence regressed or skipped',
        )
      }
      if (entry.index.availableStartUs < previous.index.availableEndUs) {
        const exactDuplicateMapping =
          entry.index.availableStartUs === previous.index.availableStartUs &&
          entry.index.availableEndUs === previous.index.availableEndUs &&
          entry.index.epochId === previous.index.epochId
        throw new SampleIndexError(
          'INVALID_RANGE',
          exactDuplicateMapping
            ? 'duplicate segment mapping'
            : 'segment ranges overlap or are out of order',
        )
      }
      if (nextFirst.captureFrameIndex !== previousLast.captureFrameIndex + 1n) {
        throw new SampleIndexError(
          'INVALID_RANGE',
          'segment frame indices must be contiguous',
        )
      }

      const sameDiscontinuity =
        entry.discontinuity === previous.discontinuity
      const exactTouch =
        entry.index.availableStartUs === previous.index.availableEndUs
      if (sameDiscontinuity) {
        if (!exactTouch) {
          throw new SampleIndexError(
            'INVALID_RANGE',
            'a canonical gap requires a new discontinuity',
          )
        }
        if (
          entry.index.epochId !== previous.index.epochId ||
          !sameTimeBase(entry.index.timeBase, previous.index.timeBase)
        ) {
          throw new SampleIndexError(
            'INVALID_RANGE',
            'one discontinuity cannot span capture epochs',
          )
        }
        if (
          nextFirst.sourcePts !==
          previousLast.sourcePts + previousLast.durationPts
        ) {
          throw new SampleIndexError(
            'INVALID_RANGE',
            'same-epoch segment source timing must be contiguous',
          )
        }
      } else if (entry.index.epochId === previous.index.epochId) {
        throw new SampleIndexError(
          'INVALID_RANGE',
          'a new discontinuity requires a new capture epoch',
        )
      }
    }

    const currentRange = ranges.at(-1)
    if (
      currentRange &&
      previous &&
      entry.discontinuity === previous.discontinuity &&
      entry.index.availableStartUs === previous.index.availableEndUs
    ) {
      currentRange.endUs = entry.index.availableEndUs
      currentRange.segmentIds.push(entry.segmentId)
    } else {
      ranges.push({
        segmentIds: [entry.segmentId],
        startUs: entry.index.availableStartUs,
        endUs: entry.index.availableEndUs,
        discontinuity: entry.discontinuity,
      })
    }
    previous = entry
  }

  return ranges
}
