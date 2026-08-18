export type LiveMediaBackend = 'legacy' | 'ome_experiment'

export interface OmeLivePlaybackSource {
  backend: 'ome_llhls'
  captureSessionId: string
  liveEdgeCaptureTimeUs: string | null
  manifestUrl: string
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

export function omePresentationOriginCaptureUs(
  liveEdgeCaptureTimeUs: string | null,
  seekableEndSeconds: number,
): string | null {
  if (!liveEdgeCaptureTimeUs || !Number.isFinite(seekableEndSeconds) || seekableEndSeconds < 0)
    return null
  return (
    BigInt(liveEdgeCaptureTimeUs) - BigInt(Math.round(seekableEndSeconds * 1_000_000))
  ).toString()
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
