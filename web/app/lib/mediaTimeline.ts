import type { CaptureTimelineRange } from './mediaModel'

export function findAvailableRange(timeUs: bigint | string, ranges: readonly CaptureTimelineRange[]) {
  const t = BigInt(timeUs); return ranges.find(r => t >= BigInt(r.startUs) && t < BigInt(r.endUs)) ?? null
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

export const LIVE_EDGE_SAFETY_US = 2_000_000n

export function clampLiveEdgeTarget(
  targetCaptureTimeUs: string,
  ranges: readonly CaptureTimelineRange[],
  safetyUs = LIVE_EDGE_SAFETY_US,
): string {
  const range = ranges.at(-1)
  if (!range) return targetCaptureTimeUs
  const start = BigInt(range.startUs)
  const end = BigInt(range.endUs)
  const target = BigInt(targetCaptureTimeUs)
  if (end <= start || target < start) return targetCaptureTimeUs
  const safeEdge = end - start > safetyUs ? end - safetyUs : start
  return target >= safeEdge ? safeEdge.toString() : targetCaptureTimeUs
}

const LIVE_CAPTURE_SOURCE_KINDS = new Set(['live', 'rtmp', 'rtsp', 'srt', 'webrtc', 'whip', 'youtube_live', 'hls_live'])

export function isLiveCaptureSource(sourceKind?: string | null): boolean {
  if (!sourceKind) return false
  const normalized = sourceKind.trim().toLowerCase().replaceAll('-', '_')
  return LIVE_CAPTURE_SOURCE_KINDS.has(normalized) || normalized.endsWith('_live')
}

export type CapturePlaybackMode =
  | 'active_live'
  | 'complete_vod'
  | 'ended_live'
  | 'failed'
  | 'progressive_vod'
  | 'starting'
  | 'stopping'

export function capturePlaybackMode(input: {
  endedAt?: string | null
  sourceKind?: string | null
  status?: string | null
}): CapturePlaybackMode {
  const status = input.status?.trim().toUpperCase() ?? 'STARTING'
  const liveSource = isLiveCaptureSource(input.sourceKind)
  if (status === 'FAILED') return 'failed'
  if (status === 'STOPPING') return 'stopping'
  if (status === 'FINISHED' || input.endedAt) {
    return liveSource ? 'ended_live' : 'complete_vod'
  }
  if (status === 'STARTING') return 'starting'
  return liveSource ? 'active_live' : 'progressive_vod'
}
