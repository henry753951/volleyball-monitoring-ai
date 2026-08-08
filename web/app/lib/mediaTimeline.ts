import type { CaptureTimelineRange } from './mediaModel'

export function findAvailableRange(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]) {
  const t = BigInt(timeUs); return ranges.find(r => t >= BigInt(r.startUs) && t <= BigInt(r.endUs)) ?? null
}
export function isCaptureGap(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]): boolean {
  return ranges.length > 0 && !findAvailableRange(timeUs, ranges)
}
export function canSeekCaptureTime(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]): boolean {
  return Boolean(findAvailableRange(timeUs, ranges))
}
export function availableBounds(ranges: readonly CaptureTimelineRange[]) {
  if (!ranges.length) return null
  return { startUs: ranges.reduce((a, r) => BigInt(a.startUs) < BigInt(r.startUs) ? a : r).startUs, endUs: ranges.reduce((a, r) => BigInt(a.endUs) > BigInt(r.endUs) ? a : r).endUs }
}

const LIVE_CAPTURE_SOURCE_KINDS = new Set(['live', 'rtmp', 'rtsp', 'srt', 'webrtc', 'whip', 'youtube_live', 'hls_live'])

export function isLiveCaptureSource(sourceKind?: string | null): boolean {
  if (!sourceKind) return false
  const normalized = sourceKind.trim().toLowerCase().replaceAll('-', '_')
  return LIVE_CAPTURE_SOURCE_KINDS.has(normalized) || normalized.endsWith('_live')
}
