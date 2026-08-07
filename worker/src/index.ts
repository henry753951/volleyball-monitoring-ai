import { runWorkerLifecycle } from './lifecycle.js'
import { validateWorkerRole } from './worker-role.js'
import { createMediaIndexerComposition } from './composition.js'
import { createAiDispatcher } from './roles/ai-dispatcher.js'
import { createClipWorker } from './roles/clip-worker.js'

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
  } else if (validatedRole === 'clip-worker' || validatedRole === 'ai-dispatcher') {
    const { db } = await import('@volleyball-monitoring/db')
    const composition = validatedRole === 'clip-worker' ? createClipWorker(db) : createAiDispatcher(db)
    await runWorkerLifecycle({ role: validatedRole, signal: controller.signal, start: composition.start, stop: composition.stop })
  } else {
    await runWorkerLifecycle({ role: validatedRole, signal: controller.signal })
  }
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
