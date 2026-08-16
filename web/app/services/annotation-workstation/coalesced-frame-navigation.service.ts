import { readonly, ref } from 'vue'

export type FrameNavigationDirection = 'previous' | 'next'

export interface CoalescedFrameNavigationOptions<T> {
  preview: (delta: number) => void
  step: (direction: FrameNavigationDirection, count: number) => Promise<T | null>
  apply: (value: T, direction: FrameNavigationDirection) => void
  ready?: () => boolean
  onError?: (cause: unknown) => void
  onSettled?: () => void
  settleMs?: number
  heldFlushMs?: number
  holdWatchdogMs?: number
  maxDelta?: number
  flushWhileHeld?: boolean
}

export function createCoalescedFrameNavigationService<T>(
  options: CoalescedFrameNavigationOptions<T>,
) {
  const running = ref(false)
  const pendingDelta = ref(0)
  const active = ref(false)
  const heldDirections = new Set<FrameNavigationDirection>()
  const settleMs = options.settleMs ?? 160
  const heldFlushMs = options.heldFlushMs ?? settleMs
  const holdWatchdogMs = options.holdWatchdogMs ?? 600
  const maxDelta = options.maxDelta ?? 120
  let generation = 0
  let latestResult: { value: T; direction: FrameNavigationDirection; generation: number } | null =
    null
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

  function finishSettled() {
    if (!settled()) return
    const result = latestResult
    latestResult = null
    if (result && result.generation === generation && !stopped)
      options.apply(result.value, result.direction)
    updateActive()
    options.onSettled?.()
  }

  function scheduleFlush(delay = settleMs, reset = true) {
    if (stopped || (heldDirections.size > 0 && !options.flushWhileHeld)) return
    if (settleTimer && !reset) return
    if (reset) clearSettleTimer()
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
      scheduleFlush(0)
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
    const nextDelta = Math.max(-maxDelta, Math.min(maxDelta, pendingDelta.value + delta))
    const acceptedDelta = nextDelta - pendingDelta.value
    pendingDelta.value = nextDelta
    updateActive()
    if (acceptedDelta !== 0) options.preview(acceptedDelta)
    if (input === 'keyboard') {
      heldDirections.add(direction)
      updateActive()
      armHoldWatchdog()
      if (options.flushWhileHeld) scheduleFlush(heldFlushMs, false)
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
    scheduleFlush(0)
  }

  async function flush(): Promise<void> {
    if (
      stopped ||
      running.value ||
      (heldDirections.size > 0 && !options.flushWhileHeld) ||
      (options.ready && !options.ready())
    )
      return
    const delta = pendingDelta.value
    if (delta === 0) {
      finishSettled()
      return
    }

    pendingDelta.value = 0
    running.value = true
    updateActive()
    const requestGeneration = generation
    const direction: FrameNavigationDirection = delta > 0 ? 'next' : 'previous'
    try {
      const value = await options.step(direction, Math.abs(delta))
      if (value && !stopped && requestGeneration === generation)
        latestResult = { value, direction, generation: requestGeneration }
    } catch (cause) {
      if (!stopped && requestGeneration === generation) options.onError?.(cause)
    } finally {
      running.value = false
      updateActive()
      if (
        !stopped &&
        pendingDelta.value !== 0 &&
        (heldDirections.size === 0 || options.flushWhileHeld)
      )
        scheduleFlush(heldDirections.size > 0 ? heldFlushMs : 0)
      else finishSettled()
    }
  }

  function cancel() {
    generation += 1
    latestResult = null
    pendingDelta.value = 0
    heldDirections.clear()
    updateActive()
    clearSettleTimer()
    clearHoldWatchdog()
    finishSettled()
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
