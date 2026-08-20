import { describe, expect, it, vi } from 'vitest'
import { isInterruptedMediaPlay, requestMediaPause, requestMediaPlay } from './mediaPlaybackIntent'

function deferredMediaElement() {
  let paused = true
  let resolvePlay = () => undefined
  const play = vi.fn(
    () =>
      new Promise<void>(resolve => {
        resolvePlay = () => {
          paused = false
          resolve()
        }
      }),
  )
  const pause = vi.fn(() => {
    paused = true
  })
  const element = {
    ended: false,
    get paused() {
      return paused
    },
    pause,
    play,
  } as unknown as HTMLMediaElement
  return {
    element,
    pause,
    play,
    get resolvePlay() {
      return resolvePlay
    },
  }
}

describe('media playback intent', () => {
  it('waits for an in-flight play request before applying pause', async () => {
    const media = deferredMediaElement()
    const playing = requestMediaPlay(media.element)

    requestMediaPause(media.element)
    expect(media.pause).not.toHaveBeenCalled()

    media.resolvePlay()
    await playing
    await Promise.resolve()
    expect(media.pause).toHaveBeenCalledOnce()
  })

  it('coalesces repeated play requests for the same element', async () => {
    const media = deferredMediaElement()
    const first = requestMediaPlay(media.element)
    const second = requestMediaPlay(media.element)

    expect(media.play).toHaveBeenCalledOnce()
    media.resolvePlay()
    await Promise.all([first, second])
  })

  it('recognizes browser play interruption errors without hiding other failures', () => {
    expect(
      isInterruptedMediaPlay(
        new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'),
      ),
    ).toBe(true)
    expect(isInterruptedMediaPlay(new Error('decoder failed'))).toBe(false)
  })
})
