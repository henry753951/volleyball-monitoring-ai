export type PollingLifecycleSnapshot = {
  active: boolean
  failedCount: number
  lastErrorAt: string | null
  lastErrorName: string | null
  lastHeartbeatAt: string | null
  lastSuccessAt: string | null
  processedCount: number
}

export type PollingLifecycle = {
  start(): Promise<void>
  stop(): Promise<void>
  runtimeSnapshot?(): PollingLifecycleSnapshot
}

export function createPollingLifecycle(
  runOnce: (signal: AbortSignal) => Promise<boolean>,
  options: { idleMs?: number; onError?: (error: unknown) => void; disconnect?: () => Promise<void> } = {},
): PollingLifecycle {
  const controller = new AbortController()
  let running: Promise<void> | null = null
  const idleMs = options.idleMs ?? 1_000
  const snapshot: PollingLifecycleSnapshot = {
    active: false,
    failedCount: 0,
    lastErrorAt: null,
    lastErrorName: null,
    lastHeartbeatAt: null,
    lastSuccessAt: null,
    processedCount: 0,
  }

  const wait = (milliseconds: number) => new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    controller.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve() }, { once: true })
  })

  return {
    async start() {
      if (running) throw new Error('polling lifecycle already started')
      running = (async () => {
        while (!controller.signal.aborted) {
          try {
            snapshot.active = true
            snapshot.lastHeartbeatAt = new Date().toISOString()
            const processed = await runOnce(controller.signal)
            snapshot.lastSuccessAt = new Date().toISOString()
            if (processed) snapshot.processedCount += 1
            if (!processed) await wait(idleMs)
          }
          catch (error) {
            snapshot.failedCount += 1
            snapshot.lastErrorAt = new Date().toISOString()
            snapshot.lastErrorName = error instanceof Error ? error.name : 'UnknownError'
            options.onError?.(error)
            if (!controller.signal.aborted) await wait(idleMs)
          }
          finally {
            snapshot.active = false
          }
        }
      })()
    },
    async stop() {
      controller.abort()
      await running
      await options.disconnect?.()
    },
    runtimeSnapshot: () => ({ ...snapshot }),
  }
}
