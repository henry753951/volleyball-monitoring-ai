export interface OverlayFrameTiming {
  capture_time_us: string[]
  capture_end_time_us: string
  clip_time_us: string[]
  clip_end_time_us: string
}

const PRESENTATION_ROUNDING_TOLERANCE_US = 2n

export function resolveFrameFromTimeline(
  targetTimeUs: string,
  frameTimesUs: readonly string[],
  endTimeUs: string,
): number {
  if (!frameTimesUs.length) return -1
  const target = BigInt(targetTimeUs)
  const end = BigInt(endTimeUs)
  const first = BigInt(frameTimesUs[0]!)
  if (target + PRESENTATION_ROUNDING_TOLERANCE_US < first || target >= end) return -1

  let low = 0
  let high = frameTimesUs.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (BigInt(frameTimesUs[middle]!) <= target) low = middle + 1
    else high = middle
  }
  if (low < frameTimesUs.length) {
    const next = BigInt(frameTimesUs[low]!)
    if (next - target <= PRESENTATION_ROUNDING_TOLERANCE_US) return low
  }
  return Math.max(0, low - 1)
}

export function resolveFrameFromRate(
  targetTimeUs: string,
  fps: { num: number; den: number },
  totalFrames: string,
): number {
  const target = BigInt(targetTimeUs)
  if (target < 0n || fps.num <= 0 || fps.den <= 0) return -1
  const denominator = 1_000_000n * BigInt(fps.den)
  const frame = (target * BigInt(fps.num) + denominator / 2n) / denominator
  const total = BigInt(totalFrames)
  return frame >= total || frame > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(frame)
}
