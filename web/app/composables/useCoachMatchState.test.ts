import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCoachMatchState } from './useCoachMatchState'

const matchStateRequest = vi.hoisted(() => vi.fn())

vi.mock('~/lib/coachDomain', () => ({
  createCoachDomainClient: () => ({ matchState: matchStateRequest }),
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
  matchStateRequest.mockReset()
})

describe('useCoachMatchState refresh coalescing', () => {
  it('fully coalesces ordinary refreshes behind an active request', async () => {
    const first = deferred<unknown>()
    matchStateRequest.mockReturnValueOnce(first.promise)

    let state!: ReturnType<typeof useCoachMatchState>
    const wrapper = mount(
      defineComponent({
        setup() {
          state = useCoachMatchState(ref('match-1'), {
            refreshIntervalMs: 0,
            profile: 'annotation',
          })
          return () => h('div')
        },
      }),
    )

    expect(matchStateRequest).toHaveBeenCalledTimes(1)
    expect(matchStateRequest).toHaveBeenCalledWith('match-1', 'annotation')
    const coalesced = state.refresh()
    first.resolve({ match: { id: 'stale' } })
    await coalesced
    await flushPromises()

    expect(matchStateRequest).toHaveBeenCalledTimes(1)
    expect(state.data.value).toEqual({ match: { id: 'stale' } })
    expect(state.refreshing.value).toBe(false)
    wrapper.unmount()
  })

  it('runs one trailing refresh when a structural invalidation arrives in flight', async () => {
    vi.useFakeTimers()
    const first = deferred<unknown>()
    matchStateRequest
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ match: { id: 'new' } })

    let state!: ReturnType<typeof useCoachMatchState>
    const wrapper = mount(
      defineComponent({
        setup() {
          state = useCoachMatchState(ref('match-1'), {
            refreshIntervalMs: 0,
            profile: 'annotation',
          })
          return () => h('div')
        },
      }),
    )

    window.dispatchEvent(
      new CustomEvent('vollyai:match-state-invalidated', {
        detail: { match_id: 'match-1' },
      }),
    )
    await vi.advanceTimersByTimeAsync(40)
    first.resolve({ match: { id: 'stale' } })
    await flushPromises()

    expect(matchStateRequest).toHaveBeenCalledTimes(2)
    expect(state.data.value).toEqual({ match: { id: 'new' } })
    expect(state.refreshing.value).toBe(false)
    wrapper.unmount()
    vi.useRealTimers()
  })
})
