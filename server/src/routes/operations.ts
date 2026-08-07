import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import type { FastifyPluginAsync } from 'fastify'

export interface MetricGroup {
  count: number
  labels: Record<string, string>
}

export interface OperationsSnapshot {
  generatedAt: string
  process: {
    heapUsedBytes: number
    residentBytes: number
    uptimeSeconds: number
  }
  database: {
    aiCallbacks: MetricGroup[]
    aiJobs: MetricGroup[]
    annotationOperations: { lastAt: string | null; total: number }
    annotationReceipts: MetricGroup[]
    captures: MetricGroup[]
    clipJobs: MetricGroup[]
    mediaAssets: MetricGroup[]
    outboxEvents: MetricGroup[]
    rallies: MetricGroup[]
  }
}

export type OperationsCollector = () => Promise<OperationsSnapshot>

const group = (count: number, labels: Record<string, string>): MetricGroup => ({ count, labels })

export async function collectOperationsSnapshot(database: typeof DatabaseClient): Promise<OperationsSnapshot> {
  const [rallies, clipJobs, aiJobs, captures, outboxEvents, callbacks, mediaAssets, annotationReceipts, annotationOperations] = await Promise.all([
    database.rally.groupBy({ by: ['annotationStatus', 'processingStatus'], _count: { _all: true } }),
    database.clipJob.groupBy({ by: ['status'], _count: { _all: true } }),
    database.aiJob.groupBy({ by: ['status'], _count: { _all: true } }),
    database.captureSession.groupBy({ by: ['status', 'health'], _count: { _all: true } }),
    database.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
    database.aiCallbackReceipt.groupBy({ by: ['kind'], _count: { _all: true } }),
    database.mediaAsset.groupBy({ by: ['kind', 'state'], _count: { _all: true } }),
    database.annotationCommandReceipt.groupBy({ by: ['accepted'], _count: { _all: true } }),
    database.annotationOperation.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
  ])
  const memory = process.memoryUsage()
  return {
    generatedAt: new Date().toISOString(),
    process: {
      heapUsedBytes: memory.heapUsed,
      residentBytes: memory.rss,
      uptimeSeconds: process.uptime(),
    },
    database: {
      rallies: rallies.map(row => group(row._count._all, { annotation_status: row.annotationStatus, processing_status: row.processingStatus })),
      clipJobs: clipJobs.map(row => group(row._count._all, { status: row.status })),
      aiJobs: aiJobs.map(row => group(row._count._all, { status: row.status })),
      captures: captures.map(row => group(row._count._all, { health: row.health, status: row.status })),
      outboxEvents: outboxEvents.map(row => group(row._count._all, { status: row.status })),
      aiCallbacks: callbacks.map(row => group(row._count._all, { kind: row.kind })),
      mediaAssets: mediaAssets.map(row => group(row._count._all, { kind: row.kind, state: row.state })),
      annotationReceipts: annotationReceipts.map(row => group(row._count._all, { accepted: String(row.accepted) })),
      annotationOperations: {
        lastAt: annotationOperations._max.createdAt?.toISOString() ?? null,
        total: annotationOperations._count._all,
      },
    },
  }
}

function escapeLabel(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}

function metricLine(name: string, value: number, labels: Record<string, string> = {}) {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
  const suffix = entries.length === 0
    ? ''
    : `{${entries.map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(',')}}`
  return `${name}${suffix} ${value}`
}

function groupedMetric(lines: string[], name: string, help: string, groups: MetricGroup[]) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
  for (const item of groups) lines.push(metricLine(name, item.count, item.labels))
}

export function renderPrometheusMetrics(snapshot: OperationsSnapshot) {
  const lines: string[] = []
  lines.push('# HELP vmai_process_resident_memory_bytes Resident process memory in bytes.', '# TYPE vmai_process_resident_memory_bytes gauge', metricLine('vmai_process_resident_memory_bytes', snapshot.process.residentBytes))
  lines.push('# HELP vmai_process_heap_used_bytes JavaScript heap used in bytes.', '# TYPE vmai_process_heap_used_bytes gauge', metricLine('vmai_process_heap_used_bytes', snapshot.process.heapUsedBytes))
  lines.push('# HELP vmai_process_uptime_seconds Server process uptime in seconds.', '# TYPE vmai_process_uptime_seconds gauge', metricLine('vmai_process_uptime_seconds', snapshot.process.uptimeSeconds))
  groupedMetric(lines, 'vmai_rallies_total', 'Persisted rallies grouped by annotation and processing state.', snapshot.database.rallies)
  groupedMetric(lines, 'vmai_clip_jobs_total', 'Clip jobs grouped by durable status.', snapshot.database.clipJobs)
  groupedMetric(lines, 'vmai_ai_jobs_total', 'AI jobs grouped by durable status.', snapshot.database.aiJobs)
  groupedMetric(lines, 'vmai_capture_sessions_total', 'Capture sessions grouped by lifecycle and source health.', snapshot.database.captures)
  groupedMetric(lines, 'vmai_outbox_events_total', 'Outbox events grouped by delivery status.', snapshot.database.outboxEvents)
  groupedMetric(lines, 'vmai_ai_callback_receipts_total', 'Accepted AI callback receipts grouped by kind.', snapshot.database.aiCallbacks)
  groupedMetric(lines, 'vmai_media_assets_total', 'Media assets grouped by immutable kind and lifecycle state.', snapshot.database.mediaAssets)
  groupedMetric(lines, 'vmai_annotation_command_receipts_total', 'Annotation command receipts grouped by acceptance.', snapshot.database.annotationReceipts)
  lines.push('# HELP vmai_annotation_operations_total Durable annotation audit operations.', '# TYPE vmai_annotation_operations_total gauge', metricLine('vmai_annotation_operations_total', snapshot.database.annotationOperations.total))
  if (snapshot.database.annotationOperations.lastAt) {
    lines.push('# HELP vmai_annotation_operation_last_timestamp_seconds Unix timestamp of the newest durable annotation operation.', '# TYPE vmai_annotation_operation_last_timestamp_seconds gauge', metricLine('vmai_annotation_operation_last_timestamp_seconds', Date.parse(snapshot.database.annotationOperations.lastAt) / 1000))
  }
  return `${lines.join('\n')}\n`
}

export function operationsRoutes(collect: OperationsCollector): FastifyPluginAsync {
  return async (app) => {
    app.get('/internal/metrics', async (_request, reply) => {
      const snapshot = await collect()
      return reply
        .header('cache-control', 'no-store')
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(renderPrometheusMetrics(snapshot))
    })
    app.get('/internal/audit/summary', async (_request, reply) => {
      const snapshot = await collect()
      return reply.header('cache-control', 'no-store').send(snapshot)
    })
  }
}
