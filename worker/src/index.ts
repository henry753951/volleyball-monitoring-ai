const roles=['media-indexer','playback-packager','clip-worker','ai-dispatcher','analysis-ingest','outbox-publisher'] as const
const role=process.env.WORKER_ROLE ?? 'media-indexer'
if(!roles.includes(role as typeof roles[number]))throw new Error(`Unsupported WORKER_ROLE: ${role}`)
console.log(`worker scaffold role=${role}; implement pg-boss claim/lease in the corresponding module`)
