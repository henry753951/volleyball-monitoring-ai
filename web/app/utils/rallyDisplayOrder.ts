interface SegmentCaptureSource {
  boundaries?: ReadonlyArray<{ capture_time_us: string; kind: string }>
  key_points: ReadonlyArray<{ capture_time_us: string; marker_kind: string }>
}

export function segmentStartCaptureTimeUs(source: SegmentCaptureSource): bigint | null {
  const startBoundary = source.boundaries?.find(boundary => boundary.kind === 'start')
  if (startBoundary) return BigInt(startBoundary.capture_time_us)
  const legacyStart = source.key_points.find(point => point.marker_kind === 'service')
  if (legacyStart) return BigInt(legacyStart.capture_time_us)
  return source.key_points.reduce<bigint | null>((earliest, point) => {
    const captureTimeUs = BigInt(point.capture_time_us)
    return earliest === null || captureTimeUs < earliest ? captureTimeUs : earliest
  }, null)
}
