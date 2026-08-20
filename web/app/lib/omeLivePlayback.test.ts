import { describe, expect, it } from 'vitest'
import {
  captureTimeInTimelineRanges,
  liveMediaBackend,
  omeLiveManifestUrl,
  omePlayerSecondsForCaptureTime,
  omePresentationOriginFromPlayingDate,
  projectOmeLiveTimelineRanges,
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

  it('projects capture time from a durable presentation anchor and hls.js playing date', () => {
    const origin = omePresentationOriginFromPlayingDate(
      [
        {
          captureTimeOriginUs: '90000000',
          programDateTime: '2026-08-18T07:10:13.252Z',
          sequenceIndex: 1,
        },
      ],
      new Date('2026-08-18T07:10:28.252Z'),
      30,
    )
    expect(origin).toBe('75000000')
    expect(omePlayerSecondsForCaptureTime('90000000', origin!)).toBe(15)
  })

  it('uses the newest validated generation before the current presentation date', () => {
    const origin = omePresentationOriginFromPlayingDate(
      [
        {
          captureTimeOriginUs: '1000000',
          programDateTime: '2026-08-18T07:10:00.000Z',
          sequenceIndex: 1,
        },
        {
          captureTimeOriginUs: '61000000',
          programDateTime: '2026-08-18T07:11:00.000Z',
          sequenceIndex: 2,
        },
      ],
      new Date('2026-08-18T07:11:10.000Z'),
      10,
    )
    expect(origin).toBe('61000000')
  })

  it('fails closed until the current presentation has a validated anchor', () => {
    expect(
      omePresentationOriginFromPlayingDate(
        [
          {
            captureTimeOriginUs: '61000000',
            programDateTime: '2026-08-18T07:11:00.000Z',
            sequenceIndex: 2,
          },
        ],
        new Date('2026-08-18T07:10:59.000Z'),
        5,
      ),
    ).toBeNull()
  })

  it('extends the visible timeline continuously from OME seekable media and cursor progress', () => {
    expect(
      projectOmeLiveTimelineRanges(
        [{ startUs: '1000000', endUs: '60000000', discontinuity: 0 }],
        [{ startCaptureTimeUs: '59000000', endCaptureTimeUs: '119500000' }],
        '120000000',
      ),
    ).toEqual([{ startUs: '1000000', endUs: '120000000', discontinuity: 0 }])
  })

  it('distinguishes a finalized archive position from an unavailable gap', () => {
    const ranges = [
      { startUs: '1000000', endUs: '60000000' },
      { startUs: '90000000', endUs: '120000000' },
    ]
    expect(captureTimeInTimelineRanges('59999999', ranges)).toBe(true)
    expect(captureTimeInTimelineRanges('60000000', ranges)).toBe(false)
    expect(captureTimeInTimelineRanges('90000000', ranges)).toBe(true)
  })
})
