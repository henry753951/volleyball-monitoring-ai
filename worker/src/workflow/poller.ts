export type PollingLifecycle = { start(): Promise<void>; stop(): Promise<void> }

export function createPollingLifecycle(
  runOnce: (signal: AbortSignal) => Promise<boolean>,
  options: { idleMs?: number; onError?: (error: unknown) => void; disconnect?: () => Promise<void> } = {},
): PollingLifecycle {
  const controller = new AbortController()
  let running: Promise<void> | null = null
  const idleMs = options.idleMs ?? 1_000

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
            const processed = await runOnce(controller.signal)
            if (!processed) await wait(idleMs)
          }
          catch (error) {
            options.onError?.(error)
            if (!controller.signal.aborted) await wait(idleMs)
          }
        }
      })()
    },
    async stop() {
      controller.abort()
      await running
      await options.disconnect?.()
    },
  }
}
