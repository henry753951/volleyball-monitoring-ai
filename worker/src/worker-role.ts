export const workerRoles = [
  'media-indexer',
  'workflow',
  'ai-dispatcher',
] as const

export type WorkerRole = (typeof workerRoles)[number]

export function validateWorkerRole(role: string): WorkerRole {
  if (!workerRoles.includes(role as WorkerRole)) {
    throw new Error(`Unsupported WORKER_ROLE: ${role}`)
  }
  return role as WorkerRole
}
