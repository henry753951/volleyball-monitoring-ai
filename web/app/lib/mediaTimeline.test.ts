import { describe, expect, it } from 'vitest'
import { availableBounds, canSeekCaptureTime, capturePlaybackMode, findAvailableRange, isCaptureGap, isLiveCaptureSource } from './mediaTimeline'
const ranges = [{ startUs: '9007199254740993', endUs: '9007199254741993', discontinuity: 0 }, { startUs: '9007199254742993', endUs: '9007199254743993', discontinuity: 1 }]
describe('timeline gaps', () => {
  it('finds ranges without Number coercion', () => { expect(findAvailableRange('9007199254740993', ranges)?.discontinuity).toBe(0); expect(isCaptureGap('9007199254742493', ranges)).toBe(true); expect(canSeekCaptureTime('9007199254742993', ranges)).toBe(true) })
  it('returns exact bounds', () => { expect(availableBounds(ranges)).toEqual({ startUs: '9007199254740993', endUs: '9007199254743993' }) })
})

describe('capture source behavior', () => {
  it('only exposes live-edge controls for genuinely live sources', () => {
    expect(isLiveCaptureSource('rtmp')).toBe(true)
    expect(isLiveCaptureSource('youtube-live')).toBe(true)
    expect(isLiveCaptureSource('local_mp4')).toBe(false)
    expect(isLiveCaptureSource('youtube_vod')).toBe(false)
  })
  it('separates source brand from active and terminal playback modes', () => {
    expect(capturePlaybackMode({ sourceKind: 'youtube_live', status: 'LIVE' })).toBe('active_live')
    expect(capturePlaybackMode({ sourceKind: 'youtube_live', status: 'FINISHED' })).toBe('ended_live')
    expect(capturePlaybackMode({ sourceKind: 'youtube_vod', status: 'LIVE' })).toBe('progressive_vod')
    expect(capturePlaybackMode({ sourceKind: 'local_mp4', status: 'FINISHED' })).toBe('complete_vod')
  })
})
