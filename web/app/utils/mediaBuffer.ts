export interface CanonicalMediaRange {
  startCaptureTimeUs: string
  endCaptureTimeUs: string
}

export function mediaTimeRangesToCaptureRanges(ranges: TimeRanges, presentationOriginCaptureUs: string): CanonicalMediaRange[] {
  const origin = BigInt(presentationOriginCaptureUs)
  return Array.from({ length: ranges.length }, (_, index) => ({
    startCaptureTimeUs: (origin + BigInt(Math.round(ranges.start(index) * 1_000_000))).toString(),
    endCaptureTimeUs: (origin + BigInt(Math.round(ranges.end(index) * 1_000_000))).toString(),
  })).filter(range => BigInt(range.endCaptureTimeUs) > BigInt(range.startCaptureTimeUs))
}

export function playbackWindowSecondsAhead(input: {
  currentTimeSeconds: number
  presentationOriginCaptureUs: string
  windowCaptureEndUs: string
}) {
  if (!Number.isFinite(input.currentTimeSeconds) || input.currentTimeSeconds < 0) return 0
  const observedCaptureUs = BigInt(input.presentationOriginCaptureUs)
    + BigInt(Math.round(input.currentTimeSeconds * 1_000_000))
  const aheadUs = BigInt(input.windowCaptureEndUs) - observedCaptureUs
  if (aheadUs <= 0n) return 0
  const wholeSeconds = aheadUs / 1_000_000n
  const remainderUs = aheadUs % 1_000_000n
  return Number(wholeSeconds) + Number(remainderUs) / 1_000_000
}
