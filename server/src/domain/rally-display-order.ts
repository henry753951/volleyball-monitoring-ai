export interface SegmentCaptureOrderSource {
  boundaries?: ReadonlyArray<{ captureTimeUs: bigint; kind: string }>
  keyPoints?: ReadonlyArray<{ captureTimeUs: bigint; markerKind: string }>
}

export interface RallyDisplayOrderCandidate {
  displaySetNumber: number
  id: string
  startCaptureTimeUs: bigint | null
}

export function segmentStartCaptureTimeUs(source: SegmentCaptureOrderSource): bigint | null {
  const startBoundary = source.boundaries?.find(boundary => boundary.kind.toUpperCase() === 'START')
  if (startBoundary) return startBoundary.captureTimeUs
  const legacyStart = source.keyPoints?.find(point => point.markerKind.toUpperCase() === 'SERVICE')
  if (legacyStart) return legacyStart.captureTimeUs
  return source.keyPoints?.reduce<bigint | null>((earliest, point) =>
    earliest === null || point.captureTimeUs < earliest ? point.captureTimeUs : earliest,
  null) ?? null
}

export function compareRallyCaptureOrder(
  left: RallyDisplayOrderCandidate,
  right: RallyDisplayOrderCandidate,
): number {
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs !== null && left.startCaptureTimeUs !== right.startCaptureTimeUs) {
    return left.startCaptureTimeUs < right.startCaptureTimeUs ? -1 : 1
  }
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs === null) return -1
  if (left.startCaptureTimeUs === null && right.startCaptureTimeUs !== null) return 1
  return left.id.localeCompare(right.id)
}

export function deriveRallyDisplayOrdinals(
  candidates: ReadonlyArray<RallyDisplayOrderCandidate>,
): Map<string, number> {
  const result = new Map<string, number>()
  const setNumbers = [...new Set(candidates.map(candidate => candidate.displaySetNumber))]
  for (const setNumber of setNumbers) {
    const ordered = candidates
      .filter(candidate => candidate.displaySetNumber === setNumber)
      .sort(compareRallyCaptureOrder)
    ordered.forEach((candidate, index) => result.set(candidate.id, index + 1))
  }
  return result
}
