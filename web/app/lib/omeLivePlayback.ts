export type LiveMediaBackend = 'legacy' | 'ome_experiment'

export interface OmeLivePlaybackSource {
  backend: 'ome_llhls'
  captureSessionId: string
  manifestUrl: string
  presentationAnchors: OmeLivePresentationAnchor[]
}

export interface OmeLivePresentationAnchor {
  captureTimeOriginUs: string
  programDateTime: string
  sequenceIndex: number
}

export interface OmeLiveTimelineRange {
  startUs: string
  endUs: string
  discontinuity: number
}

export function captureTimeInTimelineRanges(
  captureTimeUs: string,
  ranges: readonly Pick<OmeLiveTimelineRange, 'startUs' | 'endUs'>[],
): boolean {
  const target = BigInt(captureTimeUs)
  return ranges.some(range => target >= BigInt(range.startUs) && target < BigInt(range.endUs))
}

export function projectOmeLiveTimelineRanges(
  durableRanges: readonly OmeLiveTimelineRange[],
  seekableRanges: readonly { startCaptureTimeUs: string; endCaptureTimeUs: string }[],
  observedCaptureTimeUs: string | null,
): OmeLiveTimelineRange[] {
  const ranges = [
    ...durableRanges,
    ...seekableRanges.map((range, index) => ({
      startUs: range.startCaptureTimeUs,
      endUs: range.endCaptureTimeUs,
      discontinuity: durableRanges.at(-1)?.discontinuity ?? index,
    })),
  ]
    .filter(range => BigInt(range.endUs) > BigInt(range.startUs))
    .sort((left, right) => {
      const delta = BigInt(left.startUs) - BigInt(right.startUs)
      return delta < 0n ? -1 : delta > 0n ? 1 : 0
    })
  const merged: OmeLiveTimelineRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (!previous || BigInt(range.startUs) > BigInt(previous.endUs)) {
      merged.push({ ...range })
      continue
    }
    if (BigInt(range.endUs) > BigInt(previous.endUs)) previous.endUs = range.endUs
  }
  if (observedCaptureTimeUs && merged.length) {
    const last = merged.at(-1)!
    if (BigInt(observedCaptureTimeUs) > BigInt(last.endUs)) last.endUs = observedCaptureTimeUs
  }
  return merged
}

export function liveMediaBackend(value: unknown): LiveMediaBackend {
  return value === 'ome' || value === 'ome_experiment' ? 'ome_experiment' : 'legacy'
}

export function omeLiveManifestUrl(baseUrl: string, ingestPath: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const encodedStream = ingestPath
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
  if (!normalizedBase || !encodedStream) throw new TypeError('OME live source path is incomplete')
  return `${normalizedBase}/app/${encodedStream}/master.m3u8`
}

export function omePresentationOriginFromPlayingDate(
  anchors: readonly OmeLivePresentationAnchor[],
  playingDate: Date | null,
  playerSeconds: number,
): string | null {
  const playingDateMs = playingDate?.getTime() ?? Number.NaN
  if (!Number.isFinite(playingDateMs) || !Number.isFinite(playerSeconds) || playerSeconds < 0)
    return null
  const anchor = omePresentationAnchorForPlayingDate(anchors, playingDate)
  if (!anchor) return null
  const anchorDateMs = Date.parse(anchor.programDateTime)
  const captureAtPlayingDateUs =
    BigInt(anchor.captureTimeOriginUs) + BigInt(Math.round((playingDateMs - anchorDateMs) * 1_000))
  return (captureAtPlayingDateUs - BigInt(Math.round(playerSeconds * 1_000_000))).toString()
}

export function omePresentationAnchorForPlayingDate(
  anchors: readonly OmeLivePresentationAnchor[],
  playingDate: Date | null,
): OmeLivePresentationAnchor | null {
  const playingDateMs = playingDate?.getTime() ?? Number.NaN
  if (!Number.isFinite(playingDateMs)) return null
  return (
    anchors
      .filter(candidate => Date.parse(candidate.programDateTime) <= playingDateMs)
      .sort(
        (left, right) =>
          Date.parse(right.programDateTime) - Date.parse(left.programDateTime) ||
          right.sequenceIndex - left.sequenceIndex,
      )[0] ?? null
  )
}

export function omePlayerSecondsForCaptureTime(
  captureTimeUs: string,
  presentationOriginCaptureUs: string,
): number {
  const deltaUs = BigInt(captureTimeUs) - BigInt(presentationOriginCaptureUs)
  const seconds = Number(deltaUs) / 1_000_000
  if (!Number.isFinite(seconds)) throw new RangeError('OME player time is outside the safe range')
  return seconds
}
