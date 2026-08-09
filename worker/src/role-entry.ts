import { validateWorkerRole } from './worker-role.js'

const role = validateWorkerRole(process.argv[2] ?? '')
process.env.WORKER_ROLE = role
await import('./index.js')
