import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { ReadinessResult } from '../health/readiness.js'

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
  streams: StreamSnapshot[]
}

export interface StreamSnapshot {
  captureSessionId: string
  matchId: string
  matchTitle: string
  sourceKind: string
  sourceLabel: string | null
  status: string
  health: string
  startedAt: string | null
  updatedAt: string
  epochCount: number
  program: {
    id: string
    status: string
    playlistRevision: string
    liveEdgeUs: string
    durationUs: string
    fps: { numerator: number; denominator: number }
    timeBase: { numerator: number; denominator: number }
    segmentCount: number
    readySegmentCount: number
    gapSegmentCount: number
    frameCount: string
    indexedDurationUs: string
  } | null
}

export interface OperationsDashboardSnapshot {
  readiness: ReadinessResult
  operations: OperationsSnapshot
}

export interface OperationsIdentity {
  role: string
  userId: string
}

export type OperationsCollector = (identity?: OperationsIdentity) => Promise<OperationsSnapshot>
export type OperationsAuthorizer = (request: FastifyRequest) => Promise<OperationsIdentity | null>

const group = (count: number, labels: Record<string, string>): MetricGroup => ({ count, labels })

export async function collectOperationsSnapshot(
  database: typeof DatabaseClient,
  identity?: OperationsIdentity,
): Promise<OperationsSnapshot> {
  const [rallies, clipJobs, aiJobs, captures, outboxEvents, callbacks, mediaAssets, annotationReceipts, annotationOperations, captureSessions] = await Promise.all([
    database.rally.groupBy({ by: ['annotationStatus', 'processingStatus'], _count: { _all: true } }),
    database.clipJob.groupBy({ by: ['status'], _count: { _all: true } }),
    database.aiJob.groupBy({ by: ['status'], _count: { _all: true } }),
    database.captureSession.groupBy({ by: ['status', 'health'], _count: { _all: true } }),
    database.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
    database.aiCallbackReceipt.groupBy({ by: ['kind'], _count: { _all: true } }),
    database.mediaAsset.groupBy({ by: ['kind', 'state'], _count: { _all: true } }),
    database.annotationCommandReceipt.groupBy({ by: ['accepted'], _count: { _all: true } }),
    database.annotationOperation.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    database.captureSession.findMany({
      orderBy: { updatedAt: 'desc' },
      ...(identity && identity.role !== 'ADMIN'
        ? { where: {
            match: {
              members: { some: { userId: identity.userId } },
            },
          } }
        : {}),
      select: {
        id: true,
        matchId: true,
        sourceKind: true,
        sourceLabel: true,
        status: true,
        health: true,
        startedAt: true,
        updatedAt: true,
        match: { select: { title: true } },
        _count: { select: { epochs: true } },
        programs: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            playlistRevision: true,
            liveEdgeUs: true,
            durationUs: true,
            fpsNum: true,
            fpsDen: true,
            timeBaseNum: true,
            timeBaseDen: true,
          },
        },
      },
      take: 24,
    }),
  ])
  const programIds = captureSessions.flatMap(capture => capture.programs.map(program => program.id))
  const [segmentTotals, readySegments, gapSegments] = programIds.length === 0
    ? [[], [], []] as const
    : await Promise.all([
        database.dvrSegment.groupBy({
          by: ['dvrProgramId'],
          where: { dvrProgramId: { in: programIds } },
          _count: { _all: true },
          _sum: { durationUs: true, frameCount: true },
        }),
        database.dvrSegment.groupBy({
          by: ['dvrProgramId'],
          where: { dvrProgramId: { in: programIds }, readyAt: { not: null } },
          _count: { _all: true },
        }),
        database.dvrSegment.groupBy({
          by: ['dvrProgramId'],
          where: { dvrProgramId: { in: programIds }, isGap: true },
          _count: { _all: true },
        }),
      ])
  const totalsByProgram = new Map(segmentTotals.map(item => [item.dvrProgramId, item]))
  const readyByProgram = new Map(readySegments.map(item => [item.dvrProgramId, item._count._all]))
  const gapsByProgram = new Map(gapSegments.map(item => [item.dvrProgramId, item._count._all]))
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
    streams: captureSessions.map((capture) => {
      const program = capture.programs[0]
      const totals = program ? totalsByProgram.get(program.id) : undefined
      return {
        captureSessionId: capture.id,
        matchId: capture.matchId,
        matchTitle: capture.match.title,
        sourceKind: capture.sourceKind,
        sourceLabel: capture.sourceLabel,
        status: capture.status,
        health: capture.health,
        startedAt: capture.startedAt?.toISOString() ?? null,
        updatedAt: capture.updatedAt.toISOString(),
        epochCount: capture._count.epochs,
        program: program
          ? {
              id: program.id,
              status: program.status,
              playlistRevision: program.playlistRevision.toString(),
              liveEdgeUs: program.liveEdgeUs.toString(),
              durationUs: program.durationUs.toString(),
              fps: { numerator: program.fpsNum, denominator: program.fpsDen },
              timeBase: { numerator: program.timeBaseNum, denominator: program.timeBaseDen },
              segmentCount: totals?._count._all ?? 0,
              readySegmentCount: readyByProgram.get(program.id) ?? 0,
              gapSegmentCount: gapsByProgram.get(program.id) ?? 0,
              frameCount: (totals?._sum.frameCount ?? 0n).toString(),
              indexedDurationUs: (totals?._sum.durationUs ?? 0n).toString(),
            }
          : null,
      }
    }),
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

export function operationsRoutes(
  collect: OperationsCollector,
  options: {
    authenticate?: OperationsAuthorizer
    collectReadiness?: () => Promise<ReadinessResult>
  } = {},
): FastifyPluginAsync {
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
    app.get('/api/v1/operations/summary', async (request, reply) => {
      if (!options.authenticate || !options.collectReadiness) return reply.status(404).send({ error: 'Not found' })
      let identity: OperationsIdentity | null = null
      try {
        identity = await options.authenticate(request)
      }
      catch {
        return reply.status(401).send({ error: 'Authentication required' })
      }
      if (!identity) return reply.status(401).send({ error: 'Authentication required' })
      if (identity.role !== 'ADMIN' && identity.role !== 'OPERATOR') {
        return reply.status(403).send({ error: 'Operations access required' })
      }
      const [operations, readiness] = await Promise.all([collect(identity), options.collectReadiness()])
      const payload: OperationsDashboardSnapshot = { operations, readiness }
      return reply.header('cache-control', 'no-store').send(payload)
    })
  }
}
