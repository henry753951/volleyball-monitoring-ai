import type { CaptureTimelineRange } from './mediaModel'
export interface TimelineViewport {
  captureSessionId: string
  startCaptureTimeUs: string
  endCaptureTimeUs: string
  scale: number
}
export const MIN_MANUAL_TIMELINE_SPAN_US = 5_000_000n
export const TIMELINE_SCALE_BASE_SPAN_US = 300_000_000n
export const MIN_TIMELINE_SCALE = 0.01
export const DEFAULT_TIMELINE_SCALE = 0.1
export const MAX_TIMELINE_SCALE = 60
export function timelineBounds(ranges: readonly CaptureTimelineRange[]) { if (!ranges.length) return null; return { startUs: ranges[0]!.startUs, endUs: ranges[ranges.length - 1]!.endUs } }
export function timelineZoomLimit(bounds: { startUs: string; endUs: string }, minimumVisibleSpanUs = MIN_MANUAL_TIMELINE_SPAN_US) {
  const fullSpan = BigInt(bounds.endUs) - BigInt(bounds.startUs)
  if (fullSpan <= minimumVisibleSpanUs || minimumVisibleSpanUs <= 0n) return 1
  return Number(fullSpan) / Number(minimumVisibleSpanUs)
}
export function clampTimelineScale(scale: number) {
  if (!Number.isFinite(scale)) return DEFAULT_TIMELINE_SCALE
  return Math.max(MIN_TIMELINE_SCALE, Math.min(MAX_TIMELINE_SCALE, scale))
}
export function timelineScaleForSpan(visibleSpanUs: bigint) {
  if (visibleSpanUs <= 0n) return DEFAULT_TIMELINE_SCALE
  return clampTimelineScale(Number(TIMELINE_SCALE_BASE_SPAN_US) / Number(visibleSpanUs))
}
export function timelineScaleForZoom(bounds: { startUs: string; endUs: string }, zoom: number) {
  const fullSpan = BigInt(bounds.endUs) - BigInt(bounds.startUs)
  if (fullSpan <= 0n) return DEFAULT_TIMELINE_SCALE
  const normalizedZoom = Math.max(1, Number.isFinite(zoom) ? zoom : 1)
  return timelineScaleForSpan(BigInt(Math.max(1, Math.round(Number(fullSpan) / normalizedZoom))))
}
export function timelineZoomForScale(bounds: { startUs: string; endUs: string }, scale: number) {
  const fullSpan = BigInt(bounds.endUs) - BigInt(bounds.startUs)
  if (fullSpan <= 1n) return 1
  const requestedSpan = BigInt(Math.max(1, Math.round(Number(TIMELINE_SCALE_BASE_SPAN_US) / clampTimelineScale(scale))))
  const visibleSpan = requestedSpan > fullSpan ? fullSpan : requestedSpan < MIN_MANUAL_TIMELINE_SPAN_US ? MIN_MANUAL_TIMELINE_SPAN_US : requestedSpan
  return Math.max(1, Number(fullSpan) / Number(visibleSpan))
}
export function timelineViewForScale(
  bounds: { startUs: string; endUs: string },
  scale: number,
  anchorCaptureTimeUs = bounds.endUs,
) {
  const fullStart = BigInt(bounds.startUs)
  const fullEnd = BigInt(bounds.endUs)
  const fullSpan = fullEnd - fullStart
  const zoom = timelineZoomForScale(bounds, scale)
  const visibleSpan = BigInt(Math.max(1, Math.round(Number(fullSpan) / zoom)))
  const availablePan = fullSpan - visibleSpan
  const rawAnchor = BigInt(anchorCaptureTimeUs)
  const anchor = rawAnchor < fullStart ? fullStart : rawAnchor > fullEnd ? fullEnd : rawAnchor
  const desiredStart = anchor - visibleSpan / 2n - fullStart
  const relativeStart = desiredStart < 0n ? 0n : desiredStart > availablePan ? availablePan : desiredStart
  const viewStart = fullStart + relativeStart
  return {
    zoom,
    pan: availablePan > 0n ? Number(relativeStart * 1_000_000n / availablePan) / 1_000_000 : 0,
    startUs: viewStart.toString(),
    endUs: (viewStart + visibleSpan).toString(),
  }
}
export function timelineViewForRange(
  bounds: { startUs: string; endUs: string },
  range: { startUs: string; endUs: string },
) {
  const fullStart = BigInt(bounds.startUs)
  const fullEnd = BigInt(bounds.endUs)
  const fullSpan = fullEnd - fullStart
  if (fullSpan <= 1n) return { zoom: 1, pan: 0, startUs: bounds.startUs, endUs: bounds.endUs }

  const requestedStart = BigInt(range.startUs)
  const requestedEnd = BigInt(range.endUs)
  const requestedSpan = requestedEnd > requestedStart ? requestedEnd - requestedStart : 1n
  const visibleSpan = requestedSpan < fullSpan ? requestedSpan : fullSpan
  const availablePan = fullSpan - visibleSpan
  const latestStart = fullEnd - visibleSpan
  const viewStart = requestedStart < fullStart
    ? fullStart
    : requestedStart > latestStart
      ? latestStart
      : requestedStart

  return {
    zoom: visibleSpan < fullSpan ? Number(fullSpan) / Number(visibleSpan) : 1,
    pan: availablePan > 0n ? Number(viewStart - fullStart) / Number(availablePan) : 0,
    startUs: viewStart.toString(),
    endUs: (viewStart + visibleSpan).toString(),
  }
}
export function formatTimelineScale(scale: number) {
  const value = clampTimelineScale(scale)
  if (value >= 1) return `${Number(value.toFixed(1))}×`
  if (value >= 0.1) return `${value.toFixed(1)}×`
  return `${value.toFixed(2)}×`
}
export function focusedTimelineView(
  bounds: { startUs: string; endUs: string },
  range: { startCaptureTimeUs: string; endCaptureTimeUs: string },
) {
  const fullStart = BigInt(bounds.startUs)
  const fullEnd = BigInt(bounds.endUs)
  const fullSpan = fullEnd - fullStart
  if (fullSpan <= 1n) return { zoom: 1, pan: 0, startUs: bounds.startUs, endUs: bounds.endUs }

  const rawStart = BigInt(range.startCaptureTimeUs)
  const rawEnd = BigInt(range.endCaptureTimeUs)
  const rangeStart = rawStart < fullStart ? fullStart : rawStart > fullEnd ? fullEnd : rawStart
  const rangeEnd = rawEnd > fullEnd ? fullEnd : rawEnd < rangeStart ? rangeStart : rawEnd
  const rangeSpan = rangeEnd > rangeStart ? rangeEnd - rangeStart : 1n
  // 80% segment width leaves 10% breathing room on either side. Never focus
  // closer than the fixed five-second/60x ceiling, so tiny clips stay legible.
  const paddedSpan = (rangeSpan * 5n + 3n) / 4n
  const desiredSpan = (paddedSpan < MIN_MANUAL_TIMELINE_SPAN_US ? MIN_MANUAL_TIMELINE_SPAN_US : paddedSpan) > fullSpan
    ? fullSpan
    : paddedSpan < MIN_MANUAL_TIMELINE_SPAN_US ? MIN_MANUAL_TIMELINE_SPAN_US : paddedSpan
  const availablePan = fullSpan - desiredSpan
  const centeredStart = (rangeStart + rangeEnd - desiredSpan) / 2n
  const relativeStart = centeredStart < fullStart
    ? 0n
    : centeredStart - fullStart > availablePan
      ? availablePan
      : centeredStart - fullStart
  const viewStart = fullStart + relativeStart
  return {
    zoom: Number(fullSpan) / Number(desiredSpan),
    pan: availablePan > 0n ? Number(relativeStart * 1_000_000n / availablePan) / 1_000_000 : 0,
    startUs: viewStart.toString(),
    endUs: (viewStart + desiredSpan).toString(),
  }
}
export function capturePercentBps(target: string, bounds: { startUs: string; endUs: string }) { const span = BigInt(bounds.endUs) - BigInt(bounds.startUs); if (span <= 0n) return 0; const delta = BigInt(target) - BigInt(bounds.startUs); const raw = Number((delta * 10000n) / span); return Math.max(0, Math.min(10000, raw)) }
export function formatRelativeUs(valueUs: bigint) { const ms = valueUs / 1000n; const h = ms / 3600000n; const m = (ms % 3600000n) / 60000n; const s = (ms % 60000n) / 1000n; const milli = ms % 1000n; return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${milli.toString().padStart(3, '0')}` }
export function formatTimelinePosition(targetUs?: string | null, originUs?: string | null) {
  if (targetUs == null || originUs == null) return '00:00.000'
  const relativeUs = BigInt(targetUs) - BigInt(originUs)
  const milliseconds = (relativeUs > 0n ? relativeUs : 0n) / 1_000n
  const minutes = milliseconds / 60_000n
  const seconds = (milliseconds % 60_000n) / 1_000n
  const milli = milliseconds % 1_000n
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milli.toString().padStart(3, '0')}`
}
export function rulerTicks(bounds: { startUs: string; endUs: string } | null, originUs = bounds?.startUs) { if (!bounds || originUs === undefined) return []; const start = BigInt(bounds.startUs); const origin = BigInt(originUs); const span = BigInt(bounds.endUs) - start; return Array.from({ length: 9 }, (_, index) => { const value = start + (span * BigInt(index)) / 8n; return { value: value.toString(), label: formatRelativeUs(value - origin), percentBps: index * 1250 } }) }
export function pointerTarget(clientX: number, rect: { left: number; width: number }, bounds: { startUs: string; endUs: string }) { if (rect.width <= 0) return bounds.startUs; const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)); return (BigInt(bounds.startUs) + ((BigInt(bounds.endUs) - BigInt(bounds.startUs)) * BigInt(Math.round(ratio * 1000000))) / 1000000n).toString() }
export function readyAt(target: string, ranges: readonly CaptureTimelineRange[]) { return ranges.some(range => BigInt(target) >= BigInt(range.startUs) && BigInt(target) < BigInt(range.endUs)) }
export function gapRanges(ranges: readonly CaptureTimelineRange[]) { const sorted = [...ranges].sort((a, b) => BigInt(a.startUs) < BigInt(b.startUs) ? -1 : BigInt(a.startUs) > BigInt(b.startUs) ? 1 : 0); const gaps: CaptureTimelineRange[] = []; for (let i = 1; i < sorted.length; i++) { const prev = sorted[i - 1]!, next = sorted[i]!; if (BigInt(next.startUs) > BigInt(prev.endUs)) gaps.push({ startUs: prev.endUs, endUs: next.startUs, discontinuity: next.discontinuity }); else if (next.discontinuity !== prev.discontinuity) gaps.push({ startUs: next.startUs, endUs: next.startUs, discontinuity: next.discontinuity }) } return gaps }
export function segmentAtCaptureTime<T extends { id: string; startCaptureTimeUs: string; endCaptureTimeUs: string }>(captureTimeUs: string | null | undefined, segments: readonly T[]) {
  if (!captureTimeUs) return null
  const cursor = BigInt(captureTimeUs)
  return segments.find(segment => cursor >= BigInt(segment.startCaptureTimeUs) && cursor <= BigInt(segment.endCaptureTimeUs)) ?? null
}
export function resolveSegmentSelection(pinnedSegmentId: string | null | undefined, cursorSegmentId: string | null | undefined) {
  return pinnedSegmentId ?? cursorSegmentId ?? null
}
export function paddedClipRange(captureTimesUs: readonly string[], preRollUs: bigint, postRollUs: bigint) {
  if (!captureTimesUs.length) return null
  const ordered = captureTimesUs.map(BigInt).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const requestedStart = ordered[0]! - preRollUs
  return {
    startCaptureTimeUs: (requestedStart < 0n ? 0n : requestedStart).toString(),
    endCaptureTimeUs: (ordered.at(-1)! + postRollUs).toString(),
  }
}
export function clipRangeOverlaps<T extends { id: string; startCaptureTimeUs: string; endCaptureTimeUs: string }>(range: { startCaptureTimeUs: string; endCaptureTimeUs: string }, candidates: readonly T[], excludedId?: string | null) {
  const start = BigInt(range.startCaptureTimeUs)
  const end = BigInt(range.endCaptureTimeUs)
  return candidates.some(candidate => candidate.id !== excludedId && start < BigInt(candidate.endCaptureTimeUs) && end > BigInt(candidate.startCaptureTimeUs))
}
export function selectNonOverlappingRanges<T extends { id: string; startCaptureTimeUs: string; endCaptureTimeUs: string }>(ranges: readonly T[], activeRange?: { startCaptureTimeUs: string; endCaptureTimeUs: string } | null, preferredId?: string | null) {
  const activeStart = activeRange ? BigInt(activeRange.startCaptureTimeUs) : null
  const activeEnd = activeRange ? BigInt(activeRange.endCaptureTimeUs) : null
  const accepted: T[] = []
  const candidates = [...ranges].sort((left, right) => {
    const difference = BigInt(left.startCaptureTimeUs) - BigInt(right.startCaptureTimeUs)
    return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
  })
  for (const candidate of candidates) {
    const start = BigInt(candidate.startCaptureTimeUs)
    const end = BigInt(candidate.endCaptureTimeUs)
    if (activeStart !== null && activeEnd !== null && start < activeEnd && end > activeStart) continue
    const overlapIndex = accepted.findIndex(existing => start < BigInt(existing.endCaptureTimeUs) && end > BigInt(existing.startCaptureTimeUs))
    if (overlapIndex < 0) accepted.push(candidate)
    else if (candidate.id === preferredId) accepted.splice(overlapIndex, 1, candidate)
  }
  return accepted
}
