import { runWorkerLifecycle } from './lifecycle.js'
import { validateWorkerRole } from './worker-role.js'
import { createMediaIndexerComposition } from './composition.js'
import { createAiDispatcher } from './roles/ai-dispatcher.js'
import { createWorkflowComposition } from './workflow-composition.js'

const role = process.env.WORKER_ROLE ?? 'media-indexer'
const validatedRole = validateWorkerRole(role)
const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  if (validatedRole === 'media-indexer') {
    const composition = await createMediaIndexerComposition()
    await runWorkerLifecycle({ role: validatedRole, signal: controller.signal, start: composition.start, stop: composition.stop })
  } else if (validatedRole === 'workflow' || validatedRole === 'ai-dispatcher') {
    const { db } = await import('@volleyball-monitoring/db')
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is required for durable workers')
    const composition = validatedRole === 'workflow'
      ? createWorkflowComposition(db, connectionString)
      : createAiDispatcher(db)
    await runWorkerLifecycle({ role: validatedRole, signal: controller.signal, start: composition.start, stop: composition.stop })
  } else {
    const unsupported: never = validatedRole
    throw new Error(`Worker role has no runtime composition: ${unsupported}`)
  }
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
