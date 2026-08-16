export type BufferedMediaElement = Pick<HTMLMediaElement, 'buffered' | 'currentTime'>

export interface CanonicalMediaRange {
  startCaptureTimeUs: string
  endCaptureTimeUs: string
}

export function mediaTimeRangeContains(
  ranges: Pick<TimeRanges, 'length' | 'start' | 'end'>,
  targetSeconds: number,
  toleranceSeconds = 0.001,
) {
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) return false
  const tolerance = Math.max(0, toleranceSeconds)
  for (let index = 0; index < ranges.length; index += 1) {
    const start = ranges.start(index)
    const end = ranges.end(index)
    if (targetSeconds >= start - tolerance && targetSeconds < end + tolerance) return true
  }
  return false
}

export function mediaTimeRangesToCaptureRanges(
  ranges: TimeRanges,
  presentationOriginCaptureUs: string,
): CanonicalMediaRange[] {
  const origin = BigInt(presentationOriginCaptureUs)
  return Array.from({ length: ranges.length }, (_, index) => ({
    startCaptureTimeUs: (origin + BigInt(Math.round(ranges.start(index) * 1_000_000))).toString(),
    endCaptureTimeUs: (origin + BigInt(Math.round(ranges.end(index) * 1_000_000))).toString(),
  })).filter(range => BigInt(range.endCaptureTimeUs) > BigInt(range.startCaptureTimeUs))
}

export function bufferedSecondsAhead(element: BufferedMediaElement) {
  for (let index = 0; index < element.buffered.length; index += 1) {
    const start = element.buffered.start(index)
    const end = element.buffered.end(index)
    if (element.currentTime >= start - 0.05 && element.currentTime <= end + 0.05) {
      return Math.max(0, end - element.currentTime)
    }
  }
  // Presentation duration describes the descriptor, not bytes already held by
  // MSE. A cursor in an unbuffered hole must stay visible as buffer starvation.
  return 0
}

export function playbackWindowSecondsAhead(input: {
  currentTimeSeconds: number
  presentationOriginCaptureUs: string
  windowCaptureEndUs: string
}) {
  if (!Number.isFinite(input.currentTimeSeconds) || input.currentTimeSeconds < 0) return 0
  const observedCaptureUs =
    BigInt(input.presentationOriginCaptureUs) +
    BigInt(Math.round(input.currentTimeSeconds * 1_000_000))
  const aheadUs = BigInt(input.windowCaptureEndUs) - observedCaptureUs
  if (aheadUs <= 0n) return 0
  const wholeSeconds = aheadUs / 1_000_000n
  const remainderUs = aheadUs % 1_000_000n
  return Number(wholeSeconds) + Number(remainderUs) / 1_000_000
}
