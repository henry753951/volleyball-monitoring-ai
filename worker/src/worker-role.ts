export const workerRoles = [
  'media-indexer',
  'playback-packager',
  'clip-worker',
  'ai-dispatcher',
  'analysis-ingest',
  'outbox-publisher',
] as const

export type WorkerRole = (typeof workerRoles)[number]

export function validateWorkerRole(role: string): WorkerRole {
  if (!workerRoles.includes(role as WorkerRole)) {
    throw new Error(`Unsupported WORKER_ROLE: ${role}`)
  }
  return role as WorkerRole
}
