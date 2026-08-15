import { describe, expect, it, vi } from 'vitest'
import { createFrameNavigationGestureRouter } from './frameNavigationGestureRouter'

describe('createFrameNavigationGestureRouter', () => {
  it('keeps the keydown owner stable until keyup', () => {
    const playerRelease = vi.fn()
    const keyPointRelease = vi.fn()
    const router = createFrameNavigationGestureRouter({
      player: { release: playerRelease },
      'key-point': { release: keyPointRelease },
    })

    expect(router.claim('next', 'key-point')).toBe('key-point')
    expect(router.claim('next', 'player')).toBe('key-point')
    router.release('next')

    expect(keyPointRelease).toHaveBeenCalledWith('next')
    expect(playerRelease).not.toHaveBeenCalled()
  })

  it('releases every queue when a keyup arrives without a known owner', () => {
    const playerRelease = vi.fn()
    const keyPointRelease = vi.fn()
    const router = createFrameNavigationGestureRouter({
      player: { release: playerRelease },
      'key-point': { release: keyPointRelease },
    })

    router.release('previous')

    expect(playerRelease).toHaveBeenCalledWith('previous')
    expect(keyPointRelease).toHaveBeenCalledWith('previous')
  })

  it('releases claimed gestures immediately when the window loses focus', () => {
    const playerRelease = vi.fn()
    const keyPointRelease = vi.fn()
    const router = createFrameNavigationGestureRouter({
      player: { release: playerRelease },
      'key-point': { release: keyPointRelease },
    })

    router.claim('previous', 'player')
    router.claim('next', 'key-point')
    router.releaseAll()

    expect(playerRelease).toHaveBeenCalledWith('previous')
    expect(keyPointRelease).toHaveBeenCalledWith('next')
    expect(router.ownerOf('previous')).toBeNull()
    expect(router.ownerOf('next')).toBeNull()
  })
})
