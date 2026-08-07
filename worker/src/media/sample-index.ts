export type Rational = { num: bigint; den: bigint };

export type CaptureEpochOrigin = {
  epochId: string;
  sourcePtsOrigin: bigint;
  captureTimeOriginUs: bigint;
  captureFrameOrigin: bigint;
  timeBase: Rational;
};

export type FfprobeFrame = {
  media_type: 'video' | string;
  pts?: string;
  pkt_duration?: string;
  key_frame?: number;
};

export type IndexedSample = {
  sourcePts: bigint;
  durationPts: bigint;
  captureTimeUs: bigint;
  captureFrameIndex: bigint;
  keyframe: boolean;
};

export type SampleIndex = {
  version: string;
  epochId: string;
  timeBase: Rational;
  samples: readonly IndexedSample[];
  availableStartUs: bigint;
  availableEndUs: bigint;
};
export type AvailabilityRange = { segmentId: string; startUs: bigint; endUs: bigint; discontinuity: number };

export class SampleIndexError extends Error {
  constructor(public readonly code: 'INVALID_TIME_BASE' | 'INVALID_FRAME' | 'NON_MONOTONIC' | 'EMPTY_INDEX', message: string) { super(message); this.name = 'SampleIndexError'; }
}

function parseInt64(value: string | undefined, field: string): bigint {
  if (value === undefined || !/^-?\d+$/.test(value)) throw new SampleIndexError('INVALID_FRAME', `invalid ${field}`);
  return BigInt(value);
}

function roundNearestAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  const q = abs / denominator;
  const r = abs % denominator;
  return sign * (q + (r * 2n >= denominator ? 1n : 0n));
}

export function rescalePtsToUs(deltaPts: bigint, timeBase: Rational): bigint {
  return roundNearestAway(deltaPts * timeBase.num * 1_000_000n, timeBase.den);
}

export function buildSampleIndex(
  frames: readonly FfprobeFrame[],
  origin: CaptureEpochOrigin,
  version = '1',
): SampleIndex {
  if (origin.timeBase.num <= 0n || origin.timeBase.den <= 0n) throw new SampleIndexError('INVALID_TIME_BASE', 'time base must be positive');
  const samples: IndexedSample[] = [];
  let previousPts: bigint | undefined;
  let previousCapture: bigint | undefined;
  for (const frame of frames) {
    if (frame.media_type !== 'video') continue;
    const sourcePts = parseInt64(frame.pts, 'pts');
    const durationPts = parseInt64(frame.pkt_duration, 'pkt_duration');
    if (durationPts <= 0n) throw new SampleIndexError('INVALID_FRAME', 'pkt_duration must be positive');
    if (previousPts !== undefined && sourcePts <= previousPts) throw new SampleIndexError('NON_MONOTONIC', 'source PTS must increase');
    const captureTimeUs = origin.captureTimeOriginUs + rescalePtsToUs(sourcePts - origin.sourcePtsOrigin, origin.timeBase);
    if (previousCapture !== undefined && captureTimeUs <= previousCapture) throw new SampleIndexError('NON_MONOTONIC', 'capture time must increase');
    samples.push({ sourcePts, durationPts, captureTimeUs, captureFrameIndex: origin.captureFrameOrigin + BigInt(samples.length), keyframe: frame.key_frame === 1 });
    previousPts = sourcePts;
    previousCapture = captureTimeUs;
  }
  if (samples.length === 0) throw new SampleIndexError('EMPTY_INDEX', 'no video samples');
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return { version, epochId: origin.epochId, timeBase: origin.timeBase, samples, availableStartUs: first.captureTimeUs, availableEndUs: last.captureTimeUs };
}

export function serializeSample(sample: IndexedSample) {
  return { sourcePts: sample.sourcePts.toString(), durationPts: sample.durationPts.toString(), captureTimeUs: sample.captureTimeUs.toString(), captureFrameIndex: sample.captureFrameIndex.toString(), keyframe: sample.keyframe };
}

/** Preserve segment boundaries and gaps; ranges are never coalesced. */
export function buildAvailabilityRanges(indexes: readonly { segmentId: string; index: SampleIndex; discontinuity: number }[]): AvailabilityRange[] {
  return indexes.map(({ segmentId, index, discontinuity }) => ({ segmentId, startUs: index.availableStartUs, endUs: index.availableEndUs, discontinuity }));
}
