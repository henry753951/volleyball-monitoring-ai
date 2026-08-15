import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCoalescedFrameNavigation } from './useCoalescedFrameNavigation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useCoalescedFrameNavigation', () => {
  it('coalesces rapid taps into one authoritative request', async () => {
    vi.useFakeTimers()
    const step = vi.fn().mockResolvedValue('anchor')
    const apply = vi.fn()
    const navigation = useCoalescedFrameNavigation({
      preview: vi.fn(),
      step,
      apply,
      settleMs: 120,
    })

    navigation.enqueue('next')
    await vi.advanceTimersByTimeAsync(60)
    navigation.enqueue('next')
    await vi.advanceTimersByTimeAsync(60)
    navigation.enqueue('next', 5)
    await vi.advanceTimersByTimeAsync(120)

    expect(step).toHaveBeenCalledTimes(1)
    expect(step).toHaveBeenCalledWith('next', 7)
    expect(apply).toHaveBeenCalledWith('anchor', 'next')
    navigation.stop()
  })

  it('flushes bounded authoritative batches while a keyboard direction remains held', async () => {
    vi.useFakeTimers()
    const step = vi.fn().mockResolvedValue('anchor')
    const apply = vi.fn()
    const navigation = useCoalescedFrameNavigation({
      preview: vi.fn(),
      step,
      apply,
      settleMs: 100,
      heldFlushMs: 100,
      holdWatchdogMs: 500,
      flushWhileHeld: true,
    })

    navigation.enqueue('next', 1, 'keyboard')
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(60)
      navigation.enqueue('next', 1, 'keyboard')
    }

    expect(step).toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()

    navigation.release('next')
    await vi.runAllTimersAsync()
    const requested = step.mock.calls.reduce((total, [, count]) => total + count, 0)
    expect(requested).toBe(5)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('anchor', 'next')
    navigation.stop()
  })

  it('applies only the final response after newer local input', async () => {
    vi.useFakeTimers()
    const first = deferred<string | null>()
    const step = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('new')
    const apply = vi.fn()
    const navigation = useCoalescedFrameNavigation({
      preview: vi.fn(),
      step,
      apply,
      settleMs: 50,
    })

    navigation.enqueue('next')
    await vi.advanceTimersByTimeAsync(50)
    navigation.enqueue('next', 5)
    first.resolve('old')
    await first.promise
    await vi.runAllTimersAsync()

    expect(step).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('new', 'next')
    navigation.stop()
  })

  it('previews only the delta accepted by the bounded queue', async () => {
    vi.useFakeTimers()
    const preview = vi.fn()
    const step = vi.fn().mockResolvedValue('anchor')
    const navigation = useCoalescedFrameNavigation({
      preview,
      step,
      apply: vi.fn(),
      settleMs: 100,
      maxDelta: 120,
    })

    for (let index = 0; index < 140; index += 1) navigation.enqueue('next')
    await vi.advanceTimersByTimeAsync(100)

    expect(step).toHaveBeenCalledWith('next', 120)
    expect(preview.mock.calls.reduce((total, [delta]) => total + delta, 0)).toBe(120)
    navigation.stop()
  })

  it('retains transient input until authoritative stepping is ready', async () => {
    vi.useFakeTimers()
    let ready = false
    const step = vi.fn().mockResolvedValue('anchor')
    const apply = vi.fn()
    const navigation = useCoalescedFrameNavigation({
      preview: vi.fn(),
      step,
      apply,
      ready: () => ready,
      settleMs: 50,
    })

    navigation.enqueue('next')
    await vi.advanceTimersByTimeAsync(50)
    expect(step).not.toHaveBeenCalled()
    expect(navigation.pendingDelta.value).toBe(1)

    ready = true
    await navigation.flush()
    expect(step).toHaveBeenCalledWith('next', 1)
    expect(apply).toHaveBeenCalledWith('anchor', 'next')
    navigation.stop()
  })

  it('discards an in-flight response after cancellation', async () => {
    vi.useFakeTimers()
    const request = deferred<string | null>()
    const apply = vi.fn()
    const navigation = useCoalescedFrameNavigation({
      preview: vi.fn(),
      step: vi.fn().mockReturnValue(request.promise),
      apply,
      settleMs: 20,
    })

    navigation.enqueue('next')
    await vi.advanceTimersByTimeAsync(20)
    navigation.cancel()
    request.resolve('stale')
    await request.promise

    expect(apply).not.toHaveBeenCalled()
    navigation.stop()
  })

  it('cancels opposite input without issuing a zero-delta request', async () => {
    vi.useFakeTimers()
    const step = vi.fn().mockResolvedValue('anchor')
    const navigation = useCoalescedFrameNavigation({
      preview: vi.fn(),
      step,
      apply: vi.fn(),
      settleMs: 80,
    })

    navigation.enqueue('next', 5)
    navigation.enqueue('previous', 5)
    await vi.advanceTimersByTimeAsync(80)

    expect(step).not.toHaveBeenCalled()
    navigation.stop()
  })
})
