import {
  parseFfprobePayload,
  rescalePtsToUs,
  type FfprobePayload,
  type IndexedSample,
  type Rational,
  type SampleIndex,
} from '@volleyball-monitoring/media/sample-index'

export interface ClipSourceSegment {
  id: string
  captureEpochId: string
  captureStartUs: bigint
  captureEndUs: bigint
  sourcePtsStart: bigint | null
  sourcePtsEnd: bigint | null
  firstFrameIndex: bigint | null
  frameCount: bigint
  index: SampleIndex
}

export interface ClipKeyPointAnchor {
  id: string
  captureEpochId: string
  sourcePts: bigint
  captureTimeUs: bigint
  captureFrameIndex: bigint
}

export interface SelectedClipSourceSample extends IndexedSample {
  captureEpochId: string
}

export interface SelectedClipRange {
  captureEpochId: string
  sourceTimeBase: Rational
  actualStartCaptureUs: bigint
  actualEndCaptureUs: bigint
  sourceStartFrame: bigint
  sourceEndFrameExclusive: bigint
  sourceStartOffsetUs: bigint
  durationUs: bigint
  sourceSamples: readonly SelectedClipSourceSample[]
  keyPointOrdinals: ReadonlyMap<string, number>
}

export interface OutputProbePayload extends FfprobePayload {
  streams?: readonly {
    codec_type?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    time_base?: string
    start_pts?: string
    duration_ts?: string
  }[]
}

export interface ProbedClipFrame {
  pts: bigint
  durationPts: bigint
}

export interface ProbedCanonicalClip {
  width: number
  height: number
  fps: { num: number; den: number }
  timeBase: { num: number; den: number }
  totalFrames: bigint
  durationUs: bigint
  hasAudio: boolean
  frames: readonly ProbedClipFrame[]
}

function sameTimeBase(left: Rational, right: Rational): boolean {
  return left.num === right.num && left.den === right.den
}

function sampleEndCaptureUs(sample: IndexedSample, timeBase: Rational): bigint {
  return sample.captureTimeUs + rescalePtsToUs(sample.durationPts, timeBase)
}

function validateSegmentMetadata(segment: ClipSourceSegment): void {
  const first = segment.index.samples[0]
  const last = segment.index.samples.at(-1)
  if (!first || !last) throw new Error(`sample index is empty for segment ${segment.id}`)
  if (
    segment.index.epochId !== segment.captureEpochId ||
    segment.captureStartUs !== segment.index.availableStartUs ||
    segment.captureEndUs !== segment.index.availableEndUs ||
    segment.sourcePtsStart !== first.sourcePts ||
    segment.sourcePtsEnd !== last.sourcePts + last.durationPts ||
    segment.firstFrameIndex !== first.captureFrameIndex ||
    segment.frameCount !== BigInt(segment.index.samples.length)
  ) {
    throw new Error(`sample index metadata does not match segment ${segment.id}`)
  }
}

/**
 * Selects an exact source-sample range. The result is expressed as frame
 * ordinals into the concatenated fMP4 input so FFmpeg never has to infer a
 * frame from an average FPS.
 */
export function selectCanonicalClipRange(
  segments: readonly ClipSourceSegment[],
  requestedStartCaptureUs: bigint,
  requestedEndCaptureUs: bigint,
  keyPoints: readonly ClipKeyPointAnchor[],
): SelectedClipRange {
  if (segments.length === 0) throw new Error('canonical clip has no source segments')
  if (requestedStartCaptureUs < 0n || requestedEndCaptureUs <= requestedStartCaptureUs) {
    throw new Error('requested canonical clip range is invalid')
  }

  const allSamples: SelectedClipSourceSample[] = []
  const epochId = segments[0]!.captureEpochId
  const timeBase = segments[0]!.index.timeBase
  let previous: SelectedClipSourceSample | undefined
  let previousEndCaptureUs: bigint | undefined
  const epochTimingOrigins = new Map<string, { sourcePts: bigint; captureTimeUs: bigint }>()

  for (const segment of segments) {
    validateSegmentMetadata(segment)
    if (!sameTimeBase(segment.index.timeBase, timeBase)) {
      throw new Error('canonical clip cannot cross a time-base change')
    }
    if (previousEndCaptureUs !== undefined && segment.captureStartUs !== previousEndCaptureUs) {
      throw new Error('canonical clip cannot cross a gap')
    }
    const segmentFirstSample = segment.index.samples[0]!
    if (!epochTimingOrigins.has(segment.captureEpochId)) {
      epochTimingOrigins.set(segment.captureEpochId, {
        sourcePts: segmentFirstSample.sourcePts,
        captureTimeUs: segmentFirstSample.captureTimeUs,
      })
    }
    const epochTimingOrigin = epochTimingOrigins.get(segment.captureEpochId)!
    for (const sample of segment.index.samples) {
      const expectedCaptureTimeUs =
        epochTimingOrigin.captureTimeUs +
        rescalePtsToUs(sample.sourcePts - epochTimingOrigin.sourcePts, timeBase)
      if (previous) {
        if (
          (segment.captureEpochId === previous.captureEpochId &&
            sample.sourcePts !== previous.sourcePts + previous.durationPts) ||
          sample.captureFrameIndex !== previous.captureFrameIndex + 1n
        ) {
          throw new Error('canonical sample sequence is not contiguous')
        }
      }
      // Compute from cumulative epoch-relative PTS once. Summing individually
      // rounded frame durations would create a false 1 µs discontinuity at
      // rates such as 60000/1001, even though the PTS identity is exact.
      if (sample.captureTimeUs !== expectedCaptureTimeUs) {
        throw new Error('canonical sample capture time does not match source PTS')
      }
      const selectedSample = { ...sample, captureEpochId: segment.captureEpochId }
      allSamples.push(selectedSample)
      previous = selectedSample
    }
    previousEndCaptureUs = segment.captureEndUs
  }

  const firstOrdinal = allSamples.findIndex(
    sample => sampleEndCaptureUs(sample, timeBase) > requestedStartCaptureUs,
  )
  // A rally END boundary is an observed source frame, not the gap after it.
  // Keep the sample whose start is exactly the requested end so zero post-roll
  // clips can still map that immutable boundary without approximating timing.
  let endOrdinalExclusive = allSamples.findIndex(
    sample => sample.captureTimeUs > requestedEndCaptureUs,
  )
  if (endOrdinalExclusive < 0) endOrdinalExclusive = allSamples.length
  if (firstOrdinal < 0 || endOrdinalExclusive <= firstOrdinal) {
    throw new Error('requested DVR range does not contain a complete source sample')
  }

  const sourceSamples = allSamples.slice(firstOrdinal, endOrdinalExclusive)
  const first = sourceSamples[0]!
  const last = sourceSamples.at(-1)!
  const keyPointOrdinals = new Map<string, number>()
  for (const point of keyPoints) {
    const ordinal = sourceSamples.findIndex(
      sample =>
        point.captureEpochId === sample.captureEpochId &&
        point.sourcePts === sample.sourcePts &&
        point.captureTimeUs === sample.captureTimeUs &&
        point.captureFrameIndex === sample.captureFrameIndex,
    )
    if (ordinal < 0) throw new Error(`immutable key point ${point.id} has no exact source sample`)
    keyPointOrdinals.set(point.id, ordinal)
  }

  return {
    captureEpochId: epochId,
    sourceTimeBase: timeBase,
    actualStartCaptureUs: first.captureTimeUs,
    actualEndCaptureUs: sampleEndCaptureUs(last, timeBase),
    sourceStartFrame: BigInt(firstOrdinal),
    sourceEndFrameExclusive: BigInt(endOrdinalExclusive),
    sourceStartOffsetUs: first.captureTimeUs - segments[0]!.captureStartUs,
    durationUs: sampleEndCaptureUs(last, timeBase) - first.captureTimeUs,
    sourceSamples,
    keyPointOrdinals,
  }
}

export function buildCanonicalClipFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  selection: Pick<
    SelectedClipRange,
    'sourceStartFrame' | 'sourceEndFrameExclusive' | 'sourceStartOffsetUs' | 'durationUs'
  >,
  sourceKind: 'file' | 'concat' = 'file',
): string[] {
  const seconds = (value: bigint) => {
    if (value < 0n || value > 3_600_000_000n)
      throw new Error('clip timing is outside the bounded profile')
    return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`
  }
  return [
    '-y',
    '-v',
    'error',
    ...(sourceKind === 'concat' ? ['-f', 'concat', '-safe', '0'] : []),
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    `trim=start_frame=${selection.sourceStartFrame}:end_frame=${selection.sourceEndFrameExclusive},setpts=PTS-STARTPTS`,
    '-af',
    `atrim=start=${seconds(selection.sourceStartOffsetUs)}:duration=${seconds(selection.durationUs)},asetpts=PTS-STARTPTS`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'passthrough',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    outputPath,
  ]
}

function parseDisplayRate(value: string | undefined, fallback: { fpsNum: number; fpsDen: number }) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
  if (!match) return { num: fallback.fpsNum, den: fallback.fpsDen }
  const num = Number(match[1])
  const den = Number(match[2])
  return Number.isInteger(num) && num > 0 && Number.isInteger(den) && den > 0
    ? { num, den }
    : { num: fallback.fpsNum, den: fallback.fpsDen }
}

/** Parses every actual output frame and rejects any count/timing ambiguity. */
export function parseCanonicalClipProbe(
  payload: OutputProbePayload,
  expectedFrameCount: number,
  fallback: { fpsNum: number; fpsDen: number },
): ProbedCanonicalClip {
  const videoStreams = (payload.streams ?? []).filter(stream => stream.codec_type === 'video')
  if (videoStreams.length !== 1 || !videoStreams[0]!.width || !videoStreams[0]!.height) {
    throw new Error('canonical clip must contain exactly one valid video stream')
  }
  const parsed = parseFfprobePayload({
    ...payload,
    frames: (payload.frames ?? []).filter(frame => frame.media_type === 'video'),
  })
  if (parsed.frames.length !== expectedFrameCount) {
    throw new Error(
      `canonical clip frame count mismatch: expected ${expectedFrameCount}, received ${parsed.frames.length}`,
    )
  }
  const framePts = parsed.frames.map((frame, index) => {
    try {
      if (frame.pts === undefined) throw new Error('missing')
      return BigInt(frame.pts)
    } catch {
      throw new Error(`canonical output frame ${index} has invalid PTS`)
    }
  })
  const frames = parsed.frames.map((frame, index) => {
    const pts = framePts[index]!
    const nextPts = framePts[index + 1]
    let packetDuration: bigint | undefined
    if (frame.pkt_duration !== undefined) {
      try {
        packetDuration = BigInt(frame.pkt_duration)
      } catch {
        throw new Error(`canonical output frame ${index} has invalid duration`)
      }
    }
    const durationPts =
      nextPts === undefined
        ? (packetDuration ??
          (parsed.streamEndPtsExclusive === undefined ? 0n : parsed.streamEndPtsExclusive - pts))
        : nextPts - pts
    if (durationPts <= 0n) throw new Error(`canonical output frame ${index} has invalid timing`)
    if (
      nextPts === undefined &&
      packetDuration !== undefined &&
      parsed.streamEndPtsExclusive !== undefined &&
      pts + packetDuration !== parsed.streamEndPtsExclusive
    ) {
      throw new Error('canonical output tail duration conflicts with stream duration')
    }
    return { pts, durationPts }
  })
  const firstPts = frames[0]!.pts
  const last = frames.at(-1)!
  if (firstPts < 0n) throw new Error('canonical clip starts with a negative PTS')
  const durationUs = rescalePtsToUs(last.pts + last.durationPts - firstPts, parsed.timeBase)
  if (durationUs <= 0n) throw new Error('canonical clip duration is invalid')
  const stream = videoStreams[0]!
  return {
    width: stream.width!,
    height: stream.height!,
    fps: parseDisplayRate(stream.avg_frame_rate, fallback),
    timeBase: { num: Number(parsed.timeBase.num), den: Number(parsed.timeBase.den) },
    totalFrames: BigInt(frames.length),
    durationUs,
    hasAudio: (payload.streams ?? []).some(item => item.codec_type === 'audio'),
    frames,
  }
}

export function mapClipKeyPoint(
  keyPointId: string,
  ordinal: number,
  video: ProbedCanonicalClip,
): { clipPts: bigint; clipTimeUs: bigint; clipFrameIndex: bigint } {
  const frame = video.frames[ordinal]
  const first = video.frames[0]
  if (!frame || !first)
    throw new Error(`canonical output frame is missing for key point ${keyPointId}`)
  const timeBase = { num: BigInt(video.timeBase.num), den: BigInt(video.timeBase.den) }
  return {
    clipPts: frame.pts,
    clipTimeUs: rescalePtsToUs(frame.pts - first.pts, timeBase),
    clipFrameIndex: BigInt(ordinal),
  }
}
