import type { WorkerRole } from './worker-role.js'

export interface WorkerLifecycleOptions {
  role: WorkerRole
  signal: AbortSignal
  log?: (message: string) => void
  idleIntervalMs?: number
}

/** Keep a configured worker alive until its host requests shutdown. */
export async function runWorkerLifecycle({
  role,
  signal,
  log = console.log,
  idleIntervalMs = 60_000,
}: WorkerLifecycleOptions): Promise<void> {
  if (signal.aborted) return
  log(`worker ready role=${role}; scaffold is idle until pg-boss claim/lease is implemented`)

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => undefined, idleIntervalMs)
    const stop = () => {
      clearInterval(timer)
      signal.removeEventListener('abort', stop)
      resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}
