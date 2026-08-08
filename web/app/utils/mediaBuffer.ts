export type BufferedMediaElement = Pick<HTMLMediaElement, 'buffered' | 'currentTime'>

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

export function bufferedSecondsAhead(element: BufferedMediaElement) {
  for (let index = 0; index < element.buffered.length; index += 1) {
    const start = element.buffered.start(index)
    const end = element.buffered.end(index)
    if (element.currentTime >= start - 0.05 && element.currentTime <= end + 0.05) {
      return Math.max(0, end - element.currentTime)
    }
  }
  // `duration` describes the presentation timeline, not bytes currently held by
  // MSE. Returning duration here suppresses prefetch while the cursor is in an
  // unbuffered hole (or before the first fragment has arrived).
  return 0
}
