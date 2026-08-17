import { describe, expect, it } from 'vitest'
import { coachEventReplayMediaUrl, coachEventReplayWindow } from './coachEventReplay'

describe('coachEventReplay', () => {
  it('creates a bounded five-second event window', () => {
    expect(coachEventReplayWindow('8400000', '12000000')).toEqual({
      eventSeconds: 8.4,
      startSeconds: 5.4,
      endSeconds: 10.4,
    })
  })

  it('clips the short replay at the media boundaries', () => {
    expect(coachEventReplayWindow('1500000', '3000000')).toEqual({
      eventSeconds: 1.5,
      startSeconds: 0,
      endSeconds: 3,
    })
  })

  it('adds a media fragment without retaining an older fragment', () => {
    expect(
      coachEventReplayMediaUrl('/media/rally.mp4#t=0,20', {
        startSeconds: 5.4,
        endSeconds: 10.4,
      }),
    ).toBe('/media/rally.mp4#t=5.400,10.400')
  })
})
