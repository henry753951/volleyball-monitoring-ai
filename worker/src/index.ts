import { validateWorkerRole } from './worker-role.js'

const role=process.env.WORKER_ROLE ?? 'media-indexer'
validateWorkerRole(role)
console.log(`worker scaffold role=${role}; implement pg-boss claim/lease in the corresponding module`)
