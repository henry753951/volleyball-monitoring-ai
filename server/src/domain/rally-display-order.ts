export interface SegmentCaptureOrderSource {
  boundaries?: ReadonlyArray<{ captureTimeUs: bigint; kind: string }>
  keyPoints?: ReadonlyArray<{ captureTimeUs: bigint; markerKind: string }>
}

export function segmentStartCaptureTimeUs(source: SegmentCaptureOrderSource): bigint | null {
  const startBoundary = source.boundaries?.find(boundary => boundary.kind.toUpperCase() === 'START')
  if (startBoundary) return startBoundary.captureTimeUs
  const legacyStart = source.keyPoints?.find(point => point.markerKind.toUpperCase() === 'SERVICE')
  if (legacyStart) return legacyStart.captureTimeUs
  return (
    source.keyPoints?.reduce<bigint | null>(
      (earliest, point) =>
        earliest === null || point.captureTimeUs < earliest ? point.captureTimeUs : earliest,
      null,
    ) ?? null
  )
}
