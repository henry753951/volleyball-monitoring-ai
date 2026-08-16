import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCoachAnalytics } from './useCoachAnalytics'

const analyticsRequest = vi.hoisted(() => vi.fn())

vi.mock('~/lib/coachDomain', () => ({
  createCoachDomainClient: () => ({ analytics: analyticsRequest }),
}))
vi.mock('~/lib/coreDomain', () => ({ createGraphQLTransport: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  analyticsRequest.mockReset()
})

describe('useCoachAnalytics refresh visibility', () => {
  it('keeps interval polling silent while manual refresh remains observable', async () => {
    vi.useFakeTimers()
    analyticsRequest.mockResolvedValue({ teams: [], players: [], tracks: [] })

    let state!: ReturnType<typeof useCoachAnalytics>
    const wrapper = mount(
      defineComponent({
        setup() {
          state = useCoachAnalytics(ref('match-1'), { refreshIntervalMs: 100 })
          return () => h('div')
        },
      }),
    )

    await flushPromises()
    expect(state.pending.value).toBe(false)
    expect(state.refreshing.value).toBe(false)

    const background = deferred<unknown>()
    analyticsRequest.mockReturnValueOnce(background.promise)
    await vi.advanceTimersByTimeAsync(100)

    expect(analyticsRequest).toHaveBeenCalledTimes(2)
    expect(state.refreshing.value).toBe(false)

    background.resolve({ teams: [], players: [], tracks: [] })
    await flushPromises()

    const manual = deferred<unknown>()
    analyticsRequest.mockReturnValueOnce(manual.promise)
    const refresh = state.refresh()

    expect(state.refreshing.value).toBe(true)
    manual.resolve({ teams: [], players: [], tracks: [] })
    await refresh
    expect(state.refreshing.value).toBe(false)

    wrapper.unmount()
  })

  it('does not drop a manual refresh requested during a background refresh', async () => {
    const first = deferred<unknown>()
    analyticsRequest
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ teams: [{ id: 'latest' }], players: [], tracks: [] })

    let state!: ReturnType<typeof useCoachAnalytics>
    const wrapper = mount(
      defineComponent({
        setup() {
          state = useCoachAnalytics(ref('match-1'), { refreshIntervalMs: 0 })
          return () => h('div')
        },
      }),
    )

    const coalesced = state.refresh()
    expect(state.refreshing.value).toBe(true)
    first.resolve({ teams: [{ id: 'stale' }], players: [], tracks: [] })
    await coalesced
    await flushPromises()

    expect(analyticsRequest).toHaveBeenCalledTimes(2)
    expect(state.data.value?.teams).toEqual([{ id: 'latest' }])
    expect(state.refreshing.value).toBe(false)
    wrapper.unmount()
  })
})
