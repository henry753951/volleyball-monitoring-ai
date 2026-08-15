import { readonly, ref } from 'vue'

export type FrameNavigationDirection = 'previous' | 'next'

export interface CoalescedFrameNavigationOptions<T> {
  preview: (delta: number) => void
  step: (direction: FrameNavigationDirection, count: number) => Promise<T | null>
  apply: (value: T, direction: FrameNavigationDirection) => void
  onError?: (cause: unknown) => void
  onSettled?: () => void
  settleMs?: number
  holdWatchdogMs?: number
  maxDelta?: number
}

export function useCoalescedFrameNavigation<T>(options: CoalescedFrameNavigationOptions<T>) {
  const running = ref(false)
  const pendingDelta = ref(0)
  const active = ref(false)
  const heldDirections = new Set<FrameNavigationDirection>()
  const settleMs = options.settleMs ?? 160
  const holdWatchdogMs = options.holdWatchdogMs ?? 600
  const maxDelta = options.maxDelta ?? 120
  let generation = 0
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let holdWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function clearSettleTimer() {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  }

  function clearHoldWatchdog() {
    if (holdWatchdogTimer) clearTimeout(holdWatchdogTimer)
    holdWatchdogTimer = null
  }

  function settled() {
    return !running.value && pendingDelta.value === 0 && heldDirections.size === 0
  }

  function updateActive() {
    active.value = running.value || pendingDelta.value !== 0 || heldDirections.size > 0
  }

  function notifySettled() {
    if (settled()) options.onSettled?.()
  }

  function scheduleFlush(delay = settleMs) {
    if (stopped || heldDirections.size > 0) return
    clearSettleTimer()
    settleTimer = setTimeout(() => {
      settleTimer = null
      void flush()
    }, delay)
  }

  function armHoldWatchdog() {
    clearHoldWatchdog()
    holdWatchdogTimer = setTimeout(() => {
      holdWatchdogTimer = null
      heldDirections.clear()
      updateActive()
      scheduleFlush()
    }, holdWatchdogMs)
  }

  function enqueue(
    direction: FrameNavigationDirection,
    count = 1,
    input: 'keyboard' | 'button' = 'button',
  ) {
    if (stopped) return
    const boundedCount = Math.max(1, Math.trunc(count))
    const delta = direction === 'next' ? boundedCount : -boundedCount
    generation += 1
    pendingDelta.value = Math.max(-maxDelta, Math.min(maxDelta, pendingDelta.value + delta))
    updateActive()
    options.preview(delta)
    clearSettleTimer()
    if (input === 'keyboard') {
      heldDirections.add(direction)
      updateActive()
      armHoldWatchdog()
      return
    }
    scheduleFlush()
  }

  function release(direction: FrameNavigationDirection) {
    if (stopped) return
    heldDirections.delete(direction)
    updateActive()
    if (heldDirections.size > 0) return
    clearHoldWatchdog()
    scheduleFlush()
  }

  async function flush(): Promise<void> {
    if (stopped || running.value || heldDirections.size > 0) return
    const delta = pendingDelta.value
    if (delta === 0) {
      notifySettled()
      return
    }

    pendingDelta.value = 0
    running.value = true
    updateActive()
    const requestGeneration = generation
    const direction: FrameNavigationDirection = delta > 0 ? 'next' : 'previous'
    try {
      const value = await options.step(direction, Math.abs(delta))
      if (
        value &&
        !stopped &&
        requestGeneration === generation &&
        pendingDelta.value === 0 &&
        heldDirections.size === 0
      ) {
        options.apply(value, direction)
      }
    } catch (cause) {
      if (!stopped && requestGeneration === generation) options.onError?.(cause)
    } finally {
      running.value = false
      updateActive()
      if (!stopped && pendingDelta.value !== 0 && heldDirections.size === 0) scheduleFlush(0)
      else notifySettled()
    }
  }

  function cancel() {
    generation += 1
    pendingDelta.value = 0
    heldDirections.clear()
    updateActive()
    clearSettleTimer()
    clearHoldWatchdog()
    notifySettled()
  }

  function stop() {
    cancel()
    stopped = true
  }

  return {
    running: readonly(running),
    pendingDelta: readonly(pendingDelta),
    active: readonly(active),
    enqueue,
    release,
    flush,
    cancel,
    stop,
  }
}
