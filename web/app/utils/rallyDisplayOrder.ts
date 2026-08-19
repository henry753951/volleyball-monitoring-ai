import type { CoachDraft, CoachRally } from '~/lib/coachDomain'

interface SegmentCaptureSource {
  boundaries?: ReadonlyArray<{ capture_time_us: string; kind: string }>
  key_points: ReadonlyArray<{ capture_time_us: string; marker_kind: string }>
}

interface DisplayOrderCandidate {
  id: string
  setNumber: number
  startCaptureTimeUs: bigint | null
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

function compareCaptureOrder(left: DisplayOrderCandidate, right: DisplayOrderCandidate): number {
  if (
    left.startCaptureTimeUs !== null &&
    right.startCaptureTimeUs !== null &&
    left.startCaptureTimeUs !== right.startCaptureTimeUs
  ) {
    return left.startCaptureTimeUs < right.startCaptureTimeUs ? -1 : 1
  }
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs === null) return -1
  if (left.startCaptureTimeUs === null && right.startCaptureTimeUs !== null) return 1
  return left.id.localeCompare(right.id)
}

export function deriveCoachDisplayOrdinals(
  drafts: ReadonlyArray<CoachDraft>,
  rallies: ReadonlyArray<CoachRally>,
  displaySetNumberFor: (rawSetNumber: number) => number = rawSetNumber => rawSetNumber,
): Map<string, number> {
  const byId = new Map<string, DisplayOrderCandidate>()
  for (const rally of rallies) {
    byId.set(rally.id, {
      id: rally.id,
      setNumber: rally.display_set_number,
      startCaptureTimeUs: segmentStartCaptureTimeUs(rally.submission),
    })
  }
  // An editable correction is the current geometry for this rally. It should
  // replace, rather than duplicate, the immutable submitted view.
  for (const draft of drafts) {
    byId.set(draft.id, {
      id: draft.id,
      setNumber: draft.display_set_number,
      startCaptureTimeUs: segmentStartCaptureTimeUs(draft),
    })
  }
  const result = new Map<string, number>()
  const candidates = [...byId.values()]
  for (const setNumber of new Set(
    candidates.map(candidate => displaySetNumberFor(candidate.setNumber)),
  )) {
    candidates
      .filter(candidate => displaySetNumberFor(candidate.setNumber) === setNumber)
      .sort(compareCaptureOrder)
      .forEach((candidate, index) => result.set(candidate.id, index + 1))
  }
  return result
}
