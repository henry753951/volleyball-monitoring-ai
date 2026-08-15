const MIN_FRAME_DURATION_US = 1_000n
const MAX_FRAME_DURATION_US = 250_000n

export function estimateFrameDurationSeconds(
  fromCaptureTimeUs: string,
  toCaptureTimeUs: string,
  frameCount: number,
): number | null {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 120) return null
  try {
    const from = BigInt(fromCaptureTimeUs)
    const to = BigInt(toCaptureTimeUs)
    const delta = from >= to ? from - to : to - from
    const count = BigInt(frameCount)
    if (delta < MIN_FRAME_DURATION_US * count || delta > MAX_FRAME_DURATION_US * count) {
      return null
    }
    const seconds = Number(delta) / frameCount / 1_000_000
    return Number.isFinite(seconds) ? seconds : null
  } catch {
    return null
  }
}
