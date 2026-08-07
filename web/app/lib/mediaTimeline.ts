import type { CaptureTimelineRange } from './mediaModel'

export function findAvailableRange(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]) {
  const t = BigInt(timeUs); return ranges.find(r => t >= BigInt(r.start_us) && t <= BigInt(r.end_us)) ?? null
}
export function isCaptureGap(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]): boolean {
  return ranges.length > 0 && !findAvailableRange(timeUs, ranges)
}
export function canSeekCaptureTime(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]): boolean {
  return Boolean(findAvailableRange(timeUs, ranges))
}
export function availableBounds(ranges: readonly CaptureTimelineRange[]) {
  if (!ranges.length) return null
  return { start_us: ranges.reduce((a, r) => BigInt(a.start_us) < BigInt(r.start_us) ? a : r).start_us, end_us: ranges.reduce((a, r) => BigInt(a.end_us) > BigInt(r.end_us) ? a : r).end_us }
}
