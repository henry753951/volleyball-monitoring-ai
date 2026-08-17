import type { db as DatabaseClient } from '@volleyball-monitoring/db'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { ReadinessResult } from '../health/readiness.js'
import type { HostStorageProbe, HostStorageSnapshot } from '../operations/host-storage.js'
import type { DeploymentProbe, DeploymentSnapshot } from '../operations/kubernetes-deployments.js'
import {
  AiWorkerAccessError,
  getAiWorkerAccess,
  type AiWorkerAccessSnapshot,
} from '../services/ai-worker-access.js'

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
  aiWorkers: AiWorkerSnapshot[]
  aiWorkerAccess: AiWorkerAccessSnapshot
  aiWork: AiWorkSnapshot[]
  deployment: DeploymentSnapshot
  hostStorage: HostStorageSnapshot
  objectStorage: HostStorageSnapshot
  matchMedia: MatchMediaSnapshot[]
  streams: StreamSnapshot[]
}

export interface MatchMediaSnapshot {
  matchId: string
  captureCount: number
  activeCaptureCount: number
  failedCaptureCount: number
  segmentCount: number
  readySegmentCount: number
  gapSegmentCount: number
  indexedDurationUs: string
  storedBytes: string
}

export interface AiWorkerSnapshot {
  id: string
  instanceKey: string
  providerBuildId: string
  sdkVersion: string
  maxConcurrency: number
  activeJobs: number
  utilization: number
  connectedAt: string
  lastSeenAt: string
  disconnectedAt: string | null
  latencyMs: number | null
  lastPingAt: string | null
  lastPongAt: string | null
  status: 'online' | 'stale' | 'offline'
  canDelete: boolean
  accelerator: string | null
  modelVersion: string | null
  modelSha256: string | null
  deploymentStatus: 'degraded' | 'progressing' | 'ready' | 'unknown'
}

export interface AiWorkSnapshot {
  id: string
  matchId: string
  matchTitle: string
  rallyId: string
  status: string
  progress: number | null
  stage: string | null
  workerInstanceKey: string | null
  createdAt: string
  updatedAt: string
}

export interface StreamSnapshot {
  captureSessionId: string
  matchId: string
  matchTitle: string
  sourceKind: string
  sourceLabel: string | null
  sourceDurationUs: string | null
  status: string
  health: string
  startedAt: string | null
  updatedAt: string
  completionExpectedSegments: number | null
  completionRequestedAt: string | null
  epochCount: number
  sourceWork: {
    id: string
    status: string
    attempts: number
    availableAt: string
    leaseExpiresAt: string | null
    lastHeartbeatAt: string | null
    lastErrorCode: string | null
    resumeSegmentIndex: number
    resumeCaptureTimeUs: string
    createdAt: string
    updatedAt: string
  } | null
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
export type AiWorkerDeleteResult =
  | { deleted: true; id: string; instanceKey: string }
  | { deleted: false; reason: 'active_jobs' | 'not_found' | 'online' }
export type AiWorkerDeleter = (
  workerId: string,
  identity: OperationsIdentity,
) => Promise<AiWorkerDeleteResult>
export type AiWorkerTokenCreator = (
  name: string,
  identity: OperationsIdentity,
) => Promise<{ accessToken: { id: string; name: string; tokenPrefix: string }; token: string }>
export type AiWorkerTokenRotator = (
  tokenId: string,
  identity: OperationsIdentity,
) => Promise<{ tokenId: string; token: string }>
export type AiWorkerTokenStateUpdater = (
  tokenId: string,
  enabled: boolean,
  identity: OperationsIdentity,
) => Promise<{ tokenId: string; enabled: boolean }>
export type AiWorkerTokenDeleter = (
  tokenId: string,
  identity: OperationsIdentity,
) => Promise<{ tokenId: string }>

const group = (count: number, labels: Record<string, string>): MetricGroup => ({ count, labels })
const AI_WORKER_STALE_MS = 30_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function deleteInactiveAiWorker(
  database: typeof DatabaseClient,
  workerId: string,
  now = new Date(),
): Promise<AiWorkerDeleteResult> {
  const staleBefore = new Date(now.getTime() - AI_WORKER_STALE_MS)
  const candidate = await database.aiProviderInstance.findUnique({
    where: { id: workerId },
    select: { disconnectedAt: true, instanceKey: true, lastSeenAt: true },
  })
  if (!candidate) return { deleted: false, reason: 'not_found' }
  if (!candidate.disconnectedAt && candidate.lastSeenAt >= staleBefore) {
    return { deleted: false, reason: 'online' }
  }

  const deleted = await database.aiProviderInstance.deleteMany({
    where: {
      id: workerId,
      OR: [{ disconnectedAt: { not: null } }, { lastSeenAt: { lt: staleBefore } }],
      jobs: { none: { status: { in: ['QUEUED', 'RUNNING'] } } },
      providerJobs: { none: { status: { in: ['QUEUED', 'RUNNING'] } } },
    },
  })
  if (deleted.count === 1) {
    return { deleted: true, id: workerId, instanceKey: candidate.instanceKey }
  }

  const current = await database.aiProviderInstance.findUnique({
    where: { id: workerId },
    select: { disconnectedAt: true, lastSeenAt: true },
  })
  if (!current) return { deleted: false, reason: 'not_found' }
  if (!current.disconnectedAt && current.lastSeenAt >= staleBefore) {
    return { deleted: false, reason: 'online' }
  }
  return { deleted: false, reason: 'active_jobs' }
}

export async function collectOperationsSnapshot(
  database: typeof DatabaseClient,
  identity?: OperationsIdentity,
  hostStorageProbe?: HostStorageProbe,
  objectStorageProbe?: HostStorageProbe,
  deploymentProbe?: DeploymentProbe,
): Promise<OperationsSnapshot> {
  const deploymentPromise =
    deploymentProbe?.() ??
    Promise.resolve({
      available: false,
      components: [],
      namespace: null,
      overallStatus: 'unknown' as const,
      source: 'unavailable' as const,
    })
  const [
    rallies,
    clipJobs,
    aiJobs,
    captures,
    outboxEvents,
    callbacks,
    mediaAssets,
    annotationReceipts,
    annotationOperations,
    captureSessions,
    providerInstances,
    recentAiWork,
    activeAiJobs,
    activeProviderJobs,
    aiWorkerAccess,
  ] = await Promise.all([
    database.rally.groupBy({
      by: ['annotationStatus', 'processingStatus'],
      _count: { _all: true },
    }),
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
        ? {
            where: {
              match: {
                members: { some: { userId: identity.userId } },
              },
            },
          }
        : {}),
      select: {
        id: true,
        matchId: true,
        sourceKind: true,
        sourceLabel: true,
        sourceDurationUs: true,
        status: true,
        health: true,
        startedAt: true,
        updatedAt: true,
        completionExpectedSegments: true,
        completionRequestedAt: true,
        match: { select: { title: true } },
        _count: { select: { epochs: true } },
        sourceWork: {
          select: {
            id: true,
            status: true,
            attempts: true,
            availableAt: true,
            leaseExpiresAt: true,
            lastHeartbeatAt: true,
            lastErrorCode: true,
            resumeSegmentIndex: true,
            resumeCaptureTimeUs: true,
            createdAt: true,
            updatedAt: true,
          },
        },
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
    }),
    database.aiProviderInstance.findMany({
      orderBy: [{ disconnectedAt: 'asc' }, { lastSeenAt: 'desc' }],
      take: 32,
    }),
    database.aiJob.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 32,
      select: {
        id: true,
        status: true,
        progress: true,
        stage: true,
        createdAt: true,
        updatedAt: true,
        providerInstance: { select: { instanceKey: true } },
        submission: {
          select: {
            rally: {
              select: {
                id: true,
                match: { select: { id: true, title: true } },
              },
            },
          },
        },
      },
    }),
    database.aiJob.groupBy({
      by: ['providerInstanceId'],
      where: {
        providerInstanceId: { not: null },
        deliveryId: { not: null },
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      _count: { _all: true },
    }),
    database.providerJob.groupBy({
      by: ['providerInstanceId'],
      where: {
        providerInstanceId: { not: null },
        deliveryId: { not: null },
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      _count: { _all: true },
    }),
    getAiWorkerAccess(database),
  ])
  const programIds = captureSessions.flatMap(capture => capture.programs.map(program => program.id))
  const [segmentTotals, readySegments, gapSegments] =
    programIds.length === 0
      ? ([[], [], []] as const)
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
  const [mediaByteRows, hostStorage, objectStorage, deployment] = await Promise.all([
    database.$queryRaw<Array<{ matchId: string; storedBytes: bigint }>>`
      WITH asset_match AS (
        SELECT DISTINCT cs."matchId", ds."initAssetId" AS "assetId" FROM "DvrSegment" ds JOIN "DvrProgram" dp ON dp.id = ds."dvrProgramId" JOIN "CaptureSession" cs ON cs.id = dp."captureSessionId"
        UNION SELECT DISTINCT cs."matchId", ds."mediaAssetId" FROM "DvrSegment" ds JOIN "DvrProgram" dp ON dp.id = ds."dvrProgramId" JOIN "CaptureSession" cs ON cs.id = dp."captureSessionId"
        UNION SELECT DISTINCT cs."matchId", ds."sampleIndexAssetId" FROM "DvrSegment" ds JOIN "DvrProgram" dp ON dp.id = ds."dvrProgramId" JOIN "CaptureSession" cs ON cs.id = dp."captureSessionId"
        UNION SELECT DISTINCT r."matchId", cj."clipAssetId" FROM "ClipJob" cj JOIN "RallySubmission" rs ON rs.id = cj."submissionId" JOIN "Rally" r ON r.id = rs."rallyId"
        UNION SELECT DISTINCT r."matchId", cj."timingManifestAssetId" FROM "ClipJob" cj JOIN "RallySubmission" rs ON rs.id = cj."submissionId" JOIN "Rally" r ON r.id = rs."rallyId"
        UNION SELECT DISTINCT r."matchId", ar."rawAnalysisDataAssetId" FROM "AnalysisRun" ar JOIN "RallySubmission" rs ON rs.id = ar."submissionId" JOIN "Rally" r ON r.id = rs."rallyId"
        UNION SELECT DISTINCT r."matchId", aa."assetId" FROM "AnalysisArtifact" aa JOIN "AnalysisRun" ar ON ar.id = aa."analysisRunId" JOIN "RallySubmission" rs ON rs.id = ar."submissionId" JOIN "Rally" r ON r.id = rs."rallyId"
        UNION SELECT DISTINCT r."matchId", oc."assetId" FROM "AnalysisFrameChunk" oc JOIN "AnalysisRun" ar ON ar.id = oc."analysisRunId" JOIN "RallySubmission" rs ON rs.id = ar."submissionId" JOIN "Rally" r ON r.id = rs."rallyId"
      )
      SELECT am."matchId", COALESCE(SUM(ma."byteLength"), 0)::bigint AS "storedBytes"
      FROM asset_match am JOIN "MediaAsset" ma ON ma.id = am."assetId"
      WHERE am."assetId" IS NOT NULL GROUP BY am."matchId"
    `,
    hostStorageProbe?.() ??
      Promise.resolve({
        available: false,
        freeBytes: '0',
        managedBytes: '0',
        path: '',
        totalBytes: '0',
        usedBytes: '0',
      }),
    objectStorageProbe?.() ??
      Promise.resolve({
        available: false,
        freeBytes: '0',
        managedBytes: '0',
        path: '',
        totalBytes: '0',
        usedBytes: '0',
      }),
    deploymentPromise,
  ])
  const totalsByProgram = new Map(segmentTotals.map(item => [item.dvrProgramId, item]))
  const readyByProgram = new Map(readySegments.map(item => [item.dvrProgramId, item._count._all]))
  const gapsByProgram = new Map(gapSegments.map(item => [item.dvrProgramId, item._count._all]))
  const activeJobsByWorker = new Map<string | null, number>()
  for (const item of [...activeAiJobs, ...activeProviderJobs]) {
    activeJobsByWorker.set(
      item.providerInstanceId,
      (activeJobsByWorker.get(item.providerInstanceId) ?? 0) + item._count._all,
    )
  }
  const visibleMatchIds = new Set(captureSessions.map(capture => capture.matchId))
  const visibleMediaByteRows = mediaByteRows.filter(row => visibleMatchIds.has(row.matchId))
  const bytesByMatch = new Map(visibleMediaByteRows.map(row => [row.matchId, row.storedBytes]))
  objectStorage.managedBytes = visibleMediaByteRows
    .reduce((total, row) => total + row.storedBytes, 0n)
    .toString()
  const matchMedia = new Map<string, MatchMediaSnapshot>()
  for (const capture of captureSessions) {
    const program = capture.programs[0]
    const totals = program ? totalsByProgram.get(program.id) : undefined
    const current = matchMedia.get(capture.matchId) ?? {
      activeCaptureCount: 0,
      captureCount: 0,
      failedCaptureCount: 0,
      gapSegmentCount: 0,
      indexedDurationUs: '0',
      matchId: capture.matchId,
      readySegmentCount: 0,
      segmentCount: 0,
      storedBytes: (bytesByMatch.get(capture.matchId) ?? 0n).toString(),
    }
    current.captureCount += 1
    if (['STARTING', 'LIVE', 'STOPPING'].includes(capture.status)) current.activeCaptureCount += 1
    if (capture.status === 'FAILED') current.failedCaptureCount += 1
    current.segmentCount += totals?._count._all ?? 0
    current.readySegmentCount += program ? (readyByProgram.get(program.id) ?? 0) : 0
    current.gapSegmentCount += program ? (gapsByProgram.get(program.id) ?? 0) : 0
    current.indexedDurationUs = (
      BigInt(current.indexedDurationUs) + (totals?._sum.durationUs ?? 0n)
    ).toString()
    matchMedia.set(capture.matchId, current)
  }
  const workerStaleBefore = Date.now() - AI_WORKER_STALE_MS
  const memory = process.memoryUsage()
  const aiDeployment = deployment.components.find(
    component => component.component === 'analysis-worker',
  )
  return {
    generatedAt: new Date().toISOString(),
    process: {
      heapUsedBytes: memory.heapUsed,
      residentBytes: memory.rss,
      uptimeSeconds: process.uptime(),
    },
    database: {
      rallies: rallies.map(row =>
        group(row._count._all, {
          annotation_status: row.annotationStatus,
          processing_status: row.processingStatus,
        }),
      ),
      clipJobs: clipJobs.map(row => group(row._count._all, { status: row.status })),
      aiJobs: aiJobs.map(row => group(row._count._all, { status: row.status })),
      captures: captures.map(row =>
        group(row._count._all, { health: row.health, status: row.status }),
      ),
      outboxEvents: outboxEvents.map(row => group(row._count._all, { status: row.status })),
      aiCallbacks: callbacks.map(row => group(row._count._all, { kind: row.kind })),
      mediaAssets: mediaAssets.map(row =>
        group(row._count._all, { kind: row.kind, state: row.state }),
      ),
      annotationReceipts: annotationReceipts.map(row =>
        group(row._count._all, { accepted: String(row.accepted) }),
      ),
      annotationOperations: {
        lastAt: annotationOperations._max.createdAt?.toISOString() ?? null,
        total: annotationOperations._count._all,
      },
    },
    aiWorkers: providerInstances.map(instance => {
      const activeJobs = activeJobsByWorker.get(instance.id) ?? 0
      const status = instance.disconnectedAt
        ? ('offline' as const)
        : instance.lastSeenAt.getTime() < workerStaleBefore
          ? ('stale' as const)
          : ('online' as const)
      return {
        id: instance.id,
        instanceKey: instance.instanceKey,
        providerBuildId: instance.providerBuildId,
        sdkVersion: instance.sdkVersion,
        maxConcurrency: instance.maxConcurrency,
        activeJobs,
        utilization: instance.maxConcurrency > 0 ? activeJobs / instance.maxConcurrency : 0,
        connectedAt: instance.connectedAt.toISOString(),
        lastSeenAt: instance.lastSeenAt.toISOString(),
        disconnectedAt: instance.disconnectedAt?.toISOString() ?? null,
        latencyMs: instance.latencyMs,
        lastPingAt: instance.lastPingAt?.toISOString() ?? null,
        lastPongAt: instance.lastPongAt?.toISOString() ?? null,
        status,
        canDelete: status !== 'online' && activeJobs === 0,
        accelerator: aiDeployment?.accelerator ?? null,
        modelVersion: aiDeployment?.modelVersion ?? null,
        modelSha256: aiDeployment?.modelSha256 ?? null,
        deploymentStatus: aiDeployment?.status ?? 'unknown',
      }
    }),
    aiWorkerAccess,
    aiWork: recentAiWork.map(job => ({
      id: job.id,
      matchId: job.submission.rally.match.id,
      matchTitle: job.submission.rally.match.title,
      rallyId: job.submission.rally.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      workerInstanceKey: job.providerInstance?.instanceKey ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    })),
    deployment,
    hostStorage,
    objectStorage,
    matchMedia: [...matchMedia.values()],
    streams: captureSessions.map(capture => {
      const program = capture.programs[0]
      const totals = program ? totalsByProgram.get(program.id) : undefined
      return {
        captureSessionId: capture.id,
        matchId: capture.matchId,
        matchTitle: capture.match.title,
        sourceKind: capture.sourceKind,
        sourceLabel: capture.sourceLabel,
        sourceDurationUs: capture.sourceDurationUs?.toString() ?? null,
        status: capture.status,
        health: capture.health,
        startedAt: capture.startedAt?.toISOString() ?? null,
        updatedAt: capture.updatedAt.toISOString(),
        completionExpectedSegments: capture.completionExpectedSegments,
        completionRequestedAt: capture.completionRequestedAt?.toISOString() ?? null,
        epochCount: capture._count.epochs,
        sourceWork: capture.sourceWork
          ? {
              id: capture.sourceWork.id,
              status: capture.sourceWork.status,
              attempts: capture.sourceWork.attempts,
              availableAt: capture.sourceWork.availableAt.toISOString(),
              leaseExpiresAt: capture.sourceWork.leaseExpiresAt?.toISOString() ?? null,
              lastHeartbeatAt: capture.sourceWork.lastHeartbeatAt?.toISOString() ?? null,
              lastErrorCode: capture.sourceWork.lastErrorCode,
              resumeSegmentIndex: capture.sourceWork.resumeSegmentIndex,
              resumeCaptureTimeUs: capture.sourceWork.resumeCaptureTimeUs.toString(),
              createdAt: capture.sourceWork.createdAt.toISOString(),
              updatedAt: capture.sourceWork.updatedAt.toISOString(),
            }
          : null,
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
  const suffix =
    entries.length === 0
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
  lines.push(
    '# HELP vmai_process_resident_memory_bytes Resident process memory in bytes.',
    '# TYPE vmai_process_resident_memory_bytes gauge',
    metricLine('vmai_process_resident_memory_bytes', snapshot.process.residentBytes),
  )
  lines.push(
    '# HELP vmai_process_heap_used_bytes JavaScript heap used in bytes.',
    '# TYPE vmai_process_heap_used_bytes gauge',
    metricLine('vmai_process_heap_used_bytes', snapshot.process.heapUsedBytes),
  )
  lines.push(
    '# HELP vmai_process_uptime_seconds Server process uptime in seconds.',
    '# TYPE vmai_process_uptime_seconds gauge',
    metricLine('vmai_process_uptime_seconds', snapshot.process.uptimeSeconds),
  )
  if (snapshot.hostStorage.available) {
    lines.push(
      '# HELP vmai_host_storage_free_bytes Available bytes on the server temporary media volume.',
      '# TYPE vmai_host_storage_free_bytes gauge',
      metricLine('vmai_host_storage_free_bytes', Number(snapshot.hostStorage.freeBytes)),
    )
    lines.push(
      '# HELP vmai_host_storage_used_bytes Used bytes on the server temporary media volume.',
      '# TYPE vmai_host_storage_used_bytes gauge',
      metricLine('vmai_host_storage_used_bytes', Number(snapshot.hostStorage.usedBytes)),
    )
    lines.push(
      '# HELP vmai_host_storage_total_bytes Total bytes on the server temporary media volume.',
      '# TYPE vmai_host_storage_total_bytes gauge',
      metricLine('vmai_host_storage_total_bytes', Number(snapshot.hostStorage.totalBytes)),
    )
    lines.push(
      '# HELP vmai_host_storage_managed_bytes Bytes managed under the configured server temporary directory.',
      '# TYPE vmai_host_storage_managed_bytes gauge',
      metricLine('vmai_host_storage_managed_bytes', Number(snapshot.hostStorage.managedBytes)),
    )
  }
  if (snapshot.objectStorage.available) {
    lines.push(
      '# HELP vmai_object_storage_free_bytes Available usable bytes in object storage.',
      '# TYPE vmai_object_storage_free_bytes gauge',
      metricLine('vmai_object_storage_free_bytes', Number(snapshot.objectStorage.freeBytes)),
    )
    lines.push(
      '# HELP vmai_object_storage_used_bytes Used usable bytes in object storage.',
      '# TYPE vmai_object_storage_used_bytes gauge',
      metricLine('vmai_object_storage_used_bytes', Number(snapshot.objectStorage.usedBytes)),
    )
    lines.push(
      '# HELP vmai_object_storage_total_bytes Total usable bytes in object storage.',
      '# TYPE vmai_object_storage_total_bytes gauge',
      metricLine('vmai_object_storage_total_bytes', Number(snapshot.objectStorage.totalBytes)),
    )
    lines.push(
      '# HELP vmai_object_storage_managed_bytes Object bytes referenced by matches visible to the operator.',
      '# TYPE vmai_object_storage_managed_bytes gauge',
      metricLine('vmai_object_storage_managed_bytes', Number(snapshot.objectStorage.managedBytes)),
    )
  }
  groupedMetric(
    lines,
    'vmai_rallies_total',
    'Persisted rallies grouped by annotation and processing state.',
    snapshot.database.rallies,
  )
  groupedMetric(
    lines,
    'vmai_clip_jobs_total',
    'Clip jobs grouped by durable status.',
    snapshot.database.clipJobs,
  )
  groupedMetric(
    lines,
    'vmai_ai_jobs_total',
    'AI jobs grouped by durable status.',
    snapshot.database.aiJobs,
  )
  groupedMetric(
    lines,
    'vmai_capture_sessions_total',
    'Capture sessions grouped by lifecycle and source health.',
    snapshot.database.captures,
  )
  groupedMetric(
    lines,
    'vmai_outbox_events_total',
    'Outbox events grouped by delivery status.',
    snapshot.database.outboxEvents,
  )
  groupedMetric(
    lines,
    'vmai_ai_callback_receipts_total',
    'Accepted AI callback receipts grouped by kind.',
    snapshot.database.aiCallbacks,
  )
  groupedMetric(
    lines,
    'vmai_media_assets_total',
    'Media assets grouped by immutable kind and lifecycle state.',
    snapshot.database.mediaAssets,
  )
  groupedMetric(
    lines,
    'vmai_annotation_command_receipts_total',
    'Annotation command receipts grouped by acceptance.',
    snapshot.database.annotationReceipts,
  )
  lines.push(
    '# HELP vmai_ai_provider_worker_online AI provider worker liveness (1 online, 0 otherwise).',
    '# TYPE vmai_ai_provider_worker_online gauge',
  )
  lines.push(
    '# HELP vmai_ai_provider_worker_active_jobs Active deliveries owned by an AI provider worker.',
    '# TYPE vmai_ai_provider_worker_active_jobs gauge',
  )
  lines.push(
    '# HELP vmai_ai_provider_worker_capacity Configured maximum concurrency for an AI provider worker.',
    '# TYPE vmai_ai_provider_worker_capacity gauge',
  )
  for (const worker of snapshot.aiWorkers) {
    const labels = { instance: worker.instanceKey, build: worker.providerBuildId }
    lines.push(
      metricLine('vmai_ai_provider_worker_online', worker.status === 'online' ? 1 : 0, labels),
    )
    lines.push(metricLine('vmai_ai_provider_worker_active_jobs', worker.activeJobs, labels))
    lines.push(metricLine('vmai_ai_provider_worker_capacity', worker.maxConcurrency, labels))
  }
  lines.push(
    '# HELP vmai_annotation_operations_total Durable annotation audit operations.',
    '# TYPE vmai_annotation_operations_total gauge',
    metricLine('vmai_annotation_operations_total', snapshot.database.annotationOperations.total),
  )
  if (snapshot.database.annotationOperations.lastAt) {
    lines.push(
      '# HELP vmai_annotation_operation_last_timestamp_seconds Unix timestamp of the newest durable annotation operation.',
      '# TYPE vmai_annotation_operation_last_timestamp_seconds gauge',
      metricLine(
        'vmai_annotation_operation_last_timestamp_seconds',
        Date.parse(snapshot.database.annotationOperations.lastAt) / 1000,
      ),
    )
  }
  return `${lines.join('\n')}\n`
}

export function operationsRoutes(
  collect: OperationsCollector,
  options: {
    authenticate?: OperationsAuthorizer
    collectReadiness?: () => Promise<ReadinessResult>
    deleteAiWorker?: AiWorkerDeleter
    createAiWorkerToken?: AiWorkerTokenCreator
    deleteAiWorkerToken?: AiWorkerTokenDeleter
    rotateAiWorkerToken?: AiWorkerTokenRotator
    updateAiWorkerTokenState?: AiWorkerTokenStateUpdater
  } = {},
): FastifyPluginAsync {
  return async app => {
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
      if (!options.authenticate || !options.collectReadiness)
        return reply.status(404).send({ error: 'Not found' })
      let identity: OperationsIdentity | null
      try {
        identity = await options.authenticate(request)
      } catch {
        return reply.status(401).send({ error: 'Authentication required' })
      }
      if (!identity) return reply.status(401).send({ error: 'Authentication required' })
      if (identity.role !== 'ADMIN' && identity.role !== 'OPERATOR') {
        return reply.status(403).send({ error: 'Operations access required' })
      }
      const [operations, readiness] = await Promise.all([
        collect(identity),
        options.collectReadiness(),
      ])
      const payload: OperationsDashboardSnapshot = { operations, readiness }
      return reply.header('cache-control', 'no-store').send(payload)
    })
    app.delete<{ Params: { workerId: string } }>(
      '/api/v1/operations/ai-workers/:workerId',
      async (request, reply) => {
        if (!options.authenticate || !options.deleteAiWorker)
          return reply.status(404).send({ error: 'Not found' })
        let identity: OperationsIdentity | null
        try {
          identity = await options.authenticate(request)
        } catch {
          return reply.status(401).send({ error: 'Authentication required' })
        }
        if (!identity) return reply.status(401).send({ error: 'Authentication required' })
        if (identity.role !== 'ADMIN' && identity.role !== 'OPERATOR') {
          return reply.status(403).send({ error: 'Operations access required' })
        }
        if (!UUID_PATTERN.test(request.params.workerId)) {
          return reply
            .status(400)
            .send({ code: 'INVALID_AI_WORKER_ID', error: 'Invalid AI worker id' })
        }

        const result = await options.deleteAiWorker(request.params.workerId, identity)
        if (!result.deleted) {
          if (result.reason === 'not_found') {
            return reply
              .status(404)
              .send({ code: 'AI_WORKER_NOT_FOUND', error: 'AI worker not found' })
          }
          if (result.reason === 'online') {
            return reply
              .status(409)
              .send({ code: 'AI_WORKER_ONLINE', error: 'AI worker is online' })
          }
          return reply
            .status(409)
            .send({ code: 'AI_WORKER_HAS_ACTIVE_JOBS', error: 'AI worker still owns active jobs' })
        }
        return reply.header('cache-control', 'no-store').send({
          schema_version: '1.0.0',
          deleted_worker: { id: result.id, instance_key: result.instanceKey },
        })
      },
    )
    app.post<{ Body: { name?: string } }>(
      '/api/v1/operations/ai-worker-tokens',
      async (request, reply) => {
        if (!options.authenticate || !options.createAiWorkerToken)
          return reply.status(404).send({ error: 'Not found' })
        const identity = await options.authenticate(request).catch(() => null)
        if (!identity) return reply.status(401).send({ error: 'Authentication required' })
        try {
          const result = await options.createAiWorkerToken(request.body?.name ?? '', identity)
          return reply.status(201).header('cache-control', 'no-store').send({
            schema_version: '1.0.0',
            access_token: result.accessToken,
            token: result.token,
          })
        } catch (error) {
          if (error instanceof AiWorkerAccessError) {
            return reply
              .status(error.code === 'NAME_CONFLICT' ? 409 : 400)
              .send({ code: error.code, error: error.message })
          }
          throw error
        }
      },
    )
    app.post<{ Params: { tokenId: string } }>(
      '/api/v1/operations/ai-worker-tokens/:tokenId/rotate',
      async (request, reply) => {
        if (!options.authenticate || !options.rotateAiWorkerToken)
          return reply.status(404).send({ error: 'Not found' })
        const identity = await options.authenticate(request).catch(() => null)
        if (!identity) return reply.status(401).send({ error: 'Authentication required' })
        if (!UUID_PATTERN.test(request.params.tokenId))
          return reply
            .status(400)
            .send({ code: 'INVALID_AI_WORKER_TOKEN_ID', error: 'Invalid AI worker token id' })
        try {
          const result = await options.rotateAiWorkerToken(request.params.tokenId, identity)
          return reply
            .header('cache-control', 'no-store')
            .send({ schema_version: '1.0.0', token_id: result.tokenId, token: result.token })
        } catch (error) {
          if (error instanceof AiWorkerAccessError && error.code === 'NOT_FOUND')
            return reply.status(404).send({ code: error.code, error: error.message })
          throw error
        }
      },
    )
    app.patch<{ Body: { enabled?: boolean }; Params: { tokenId: string } }>(
      '/api/v1/operations/ai-worker-tokens/:tokenId',
      async (request, reply) => {
        if (!options.authenticate || !options.updateAiWorkerTokenState)
          return reply.status(404).send({ error: 'Not found' })
        const identity = await options.authenticate(request).catch(() => null)
        if (!identity) return reply.status(401).send({ error: 'Authentication required' })
        if (
          !UUID_PATTERN.test(request.params.tokenId) ||
          typeof request.body?.enabled !== 'boolean'
        )
          return reply.status(400).send({
            code: 'INVALID_AI_WORKER_TOKEN_UPDATE',
            error: 'Invalid AI worker token update',
          })
        try {
          const result = await options.updateAiWorkerTokenState(
            request.params.tokenId,
            request.body.enabled,
            identity,
          )
          return reply
            .header('cache-control', 'no-store')
            .send({ schema_version: '1.0.0', token_id: result.tokenId, enabled: result.enabled })
        } catch (error) {
          if (error instanceof AiWorkerAccessError && error.code === 'NOT_FOUND')
            return reply.status(404).send({ code: error.code, error: error.message })
          throw error
        }
      },
    )
    app.delete<{ Params: { tokenId: string } }>(
      '/api/v1/operations/ai-worker-tokens/:tokenId',
      async (request, reply) => {
        if (!options.authenticate || !options.deleteAiWorkerToken)
          return reply.status(404).send({ error: 'Not found' })
        const identity = await options.authenticate(request).catch(() => null)
        if (!identity) return reply.status(401).send({ error: 'Authentication required' })
        if (!UUID_PATTERN.test(request.params.tokenId))
          return reply
            .status(400)
            .send({ code: 'INVALID_AI_WORKER_TOKEN_ID', error: 'Invalid AI worker token id' })
        try {
          const result = await options.deleteAiWorkerToken(request.params.tokenId, identity)
          return reply.header('cache-control', 'no-store').send({
            schema_version: '1.0.0',
            deleted_token: { id: result.tokenId },
          })
        } catch (error) {
          if (error instanceof AiWorkerAccessError && error.code === 'NOT_FOUND')
            return reply.status(404).send({ code: error.code, error: error.message })
          throw error
        }
      },
    )
  }
}
