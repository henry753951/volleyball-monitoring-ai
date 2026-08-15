export interface RealtimeReconnectScheduler {
  connected(): void
  dispose(): void
  schedule(): void
}

interface RealtimeReconnectOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
}

export function browserAllowsRealtimeConnection() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

export function realtimeReconnectDelay(attempt: number, options: RealtimeReconnectOptions = {}) {
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const random = options.random ?? Math.random
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt))
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4
  return Math.min(maxDelayMs, Math.round(exponential * jitter))
}

export function createRealtimeReconnectScheduler(
  reconnect: () => void,
  options: RealtimeReconnectOptions = {},
): RealtimeReconnectScheduler {
  let attempt = 0
  let disposed = false
  let waitingForAvailability = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const handleAvailabilityChange = () => {
    if (disposed) return
    if (!browserAllowsRealtimeConnection()) {
      if (timer) {
        clearTimer()
        waitingForAvailability = true
      }
      return
    }
    if (!waitingForAvailability) return
    waitingForAvailability = false
    reconnect()
  }

  if (typeof window !== 'undefined') window.addEventListener('online', handleAvailabilityChange)
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', handleAvailabilityChange)

  return {
    connected() {
      attempt = 0
      waitingForAvailability = false
      clearTimer()
    },
    dispose() {
      disposed = true
      waitingForAvailability = false
      clearTimer()
      if (typeof window !== 'undefined')
        window.removeEventListener('online', handleAvailabilityChange)
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', handleAvailabilityChange)
    },
    schedule() {
      if (disposed || timer || waitingForAvailability) return
      if (!browserAllowsRealtimeConnection()) {
        waitingForAvailability = true
        return
      }
      const delay = realtimeReconnectDelay(attempt, options)
      attempt += 1
      timer = setTimeout(() => {
        timer = null
        if (!browserAllowsRealtimeConnection()) {
          waitingForAvailability = true
          return
        }
        reconnect()
      }, delay)
    },
  }
}
