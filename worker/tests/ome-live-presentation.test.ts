import { describe, expect, it } from 'vitest'
import {
  omeMasterPlaylistUrl,
  parseOmePresentationObservation,
  parseOmeVideoPlaylistUrl,
} from '../src/media/ome-live-presentation.js'

describe('OME live presentation metadata', () => {
  it('builds an encoded master playlist URL', () => {
    expect(omeMasterPlaylistUrl('http://ome.test:3333/', 'live/source one')).toBe(
      'http://ome.test:3333/app/live/source%20one/master.m3u8',
    )
  })

  it('selects the video rendition instead of the alternate audio playlist', () => {
    const masterUrl = 'http://ome.test:3333/app/live/master.m3u8'
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,URI="/app/live/chunklist_1_audio_10_llhls.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000
/app/live/chunklist_0_video_10_llhls.m3u8
`
    expect(parseOmeVideoPlaylistUrl(master, masterUrl)).toBe(
      'http://ome.test:3333/app/live/chunklist_0_video_10_llhls.m3u8',
    )
  })

  it('parses the stable stream instance and first program date time', () => {
    const playlistUrl =
      'http://ome.test:3333/app/live/chunklist_0_video_5494374788645664965_llhls.m3u8'
    const observation = parseOmePresentationObservation(
      `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PROGRAM-DATE-TIME:2026-08-18T07:01:16.338+00:00
#EXTINF:2.000000,
seg_0_0_video_5494374788645664965_llhls.m4s
`,
      playlistUrl,
    )
    expect(observation).toEqual({
      firstMediaSequence: 0n,
      playlistUrl,
      programDateTime: new Date('2026-08-18T07:01:16.338Z'),
      streamInstanceId: '5494374788645664965',
    })
  })
})
