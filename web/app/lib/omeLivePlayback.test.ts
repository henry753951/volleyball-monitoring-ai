import { describe, expect, it } from 'vitest'
import {
  liveMediaBackend,
  omeLiveManifestUrl,
  omePlayerSecondsForCaptureTime,
  omePresentationOriginCaptureUs,
} from './omeLivePlayback'

describe('OME live playback configuration', () => {
  it('keeps legacy as the fail-closed default', () => {
    expect(liveMediaBackend(undefined)).toBe('legacy')
    expect(liveMediaBackend('unknown')).toBe('legacy')
    expect(liveMediaBackend('ome')).toBe('ome_experiment')
  })

  it('builds the configured OME playlist and encodes each stream path segment', () => {
    expect(omeLiveManifestUrl('/ome/', 'youtube-live/source one')).toBe(
      '/ome/app/youtube-live/source%20one/master.m3u8',
    )
  })

  it('projects capture time from the current OME seekable edge', () => {
    const origin = omePresentationOriginCaptureUs('90000000', 30)
    expect(origin).toBe('60000000')
    expect(omePlayerSecondsForCaptureTime('75000000', origin!)).toBe(15)
  })
})
