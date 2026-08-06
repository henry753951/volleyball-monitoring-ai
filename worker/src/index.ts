import { runWorkerLifecycle } from './lifecycle.js'
import { validateWorkerRole } from './worker-role.js'

const role = process.env.WORKER_ROLE ?? 'media-indexer'
const validatedRole = validateWorkerRole(role)
const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  await runWorkerLifecycle({ role: validatedRole, signal: controller.signal })
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
