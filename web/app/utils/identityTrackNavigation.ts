export interface IdentityTrackFrameTiming {
  clipStartCaptureTimeUs: string
  frameIndex: string
  fps: { num: number; den: number }
}

export function captureTimeForIdentityTrackFrame(input: IdentityTrackFrameTiming) {
  if (!Number.isSafeInteger(input.fps.num) || !Number.isSafeInteger(input.fps.den)) return null
  if (input.fps.num <= 0 || input.fps.den <= 0) return null

  try {
    const clipStart = BigInt(input.clipStartCaptureTimeUs)
    const frame = BigInt(input.frameIndex)
    if (clipStart < 0n || frame < 0n) return null
    return (
      clipStart +
      (frame * 1_000_000n * BigInt(input.fps.den)) / BigInt(input.fps.num)
    ).toString()
  } catch {
    return null
  }
}
