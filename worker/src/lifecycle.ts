import type { WorkerRole } from './worker-role.js'

export interface WorkerLifecycleOptions {
  role: WorkerRole
  signal: AbortSignal
  log?: (message: string) => void
  idleIntervalMs?: number
  start?: () => Promise<void>
  stop?: () => Promise<void>
}

/** Keep a configured worker alive until its host requests shutdown. */
export async function runWorkerLifecycle({
  role,
  signal,
  log = console.log,
  idleIntervalMs = 60_000,
  start,
  stop: stopRuntime,
}: WorkerLifecycleOptions): Promise<void> {
  if (signal.aborted) return
  if (start) await start()
  log(`worker ready role=${role}${start ? '; durable runtime active' : '; scaffold role'}`)

  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => undefined, idleIntervalMs)
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      clearInterval(timer)
      signal.removeEventListener('abort', stop)
      if (stopRuntime) {
        void stopRuntime().then(resolve, reject)
      } else resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}
