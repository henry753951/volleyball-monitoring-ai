import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealtimeReconnectScheduler, realtimeReconnectDelay } from './realtimeReconnect'

describe('realtime reconnect policy', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses capped exponential backoff with bounded jitter', () => {
    const options = { baseDelayMs: 500, maxDelayMs: 30_000, random: () => 0.5 }
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(attempt => realtimeReconnectDelay(attempt, options)))
      .toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  it('pauses while offline and resumes immediately on the online event', () => {
    vi.useFakeTimers()
    const reconnect = vi.fn()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const scheduler = createRealtimeReconnectScheduler(reconnect, { random: () => 0.5 })

    scheduler.schedule()
    vi.advanceTimersByTime(60_000)
    expect(reconnect).not.toHaveBeenCalled()

    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    expect(reconnect).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('cancels a pending retry while hidden and resumes when visible', () => {
    vi.useFakeTimers()
    const reconnect = vi.fn()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const scheduler = createRealtimeReconnectScheduler(reconnect, { random: () => 0.5 })

    scheduler.schedule()
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(60_000)
    expect(reconnect).not.toHaveBeenCalled()

    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reconnect).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })
})
