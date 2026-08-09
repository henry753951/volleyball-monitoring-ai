import { runWorkerLifecycle } from './lifecycle.js'
import { validateWorkerRole } from './worker-role.js'
import { createMediaComposition } from './composition.js'
import { createWorkflowComposition } from './workflow-composition.js'
import { startWorkerHealthServer } from './runtime-health.js'

const role = process.env.WORKER_ROLE ?? 'media'
const validatedRole = validateWorkerRole(role)
const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  if (validatedRole === 'media') {
    const composition = await createMediaComposition()
    let health: Awaited<ReturnType<typeof startWorkerHealthServer>> | undefined
    await runWorkerLifecycle({
      role: validatedRole,
      signal: controller.signal,
      start: async () => {
        await composition.start()
        health = await startWorkerHealthServer({
          role: validatedRole,
          port: Number(process.env.WORKER_HEALTH_PORT ?? 4101),
          snapshot: () => composition.healthSnapshot(),
        })
      },
      stop: async () => {
        await health?.stop()
        await composition.stop()
      },
    })
  } else if (validatedRole === 'workflow') {
    const { db } = await import('@volleyball-monitoring/db')
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is required for durable workers')
    const composition = createWorkflowComposition(db, connectionString)
    let health: Awaited<ReturnType<typeof startWorkerHealthServer>> | undefined
    await runWorkerLifecycle({
      role: validatedRole,
      signal: controller.signal,
      start: async () => {
        await composition.start()
        health = await startWorkerHealthServer({
          role: validatedRole,
          port: Number(process.env.WORKER_HEALTH_PORT ?? 4102),
          snapshot: () => composition.healthSnapshot(),
        })
      },
      stop: async () => {
        await health?.stop()
        await composition.stop()
      },
    })
  } else {
    const unsupported: never = validatedRole
    throw new Error(`Worker role has no runtime composition: ${unsupported}`)
  }
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
