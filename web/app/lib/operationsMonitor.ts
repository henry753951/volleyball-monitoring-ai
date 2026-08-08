export type CheckStatus = 'ok' | 'failed'

export interface MetricGroup {
  count: number
  labels: Record<string, string>
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
  status: 'online' | 'stale' | 'offline'
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

export interface OperationsDashboardSnapshot {
  readiness: {
    status: 'ready' | 'unavailable'
    checks: Record<string, CheckStatus>
  }
  operations: {
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
    aiWork: AiWorkSnapshot[]
    streams: StreamSnapshot[]
  }
}

export function visibleStreamsForMatches(
  streams: readonly StreamSnapshot[],
  matchIds: ReadonlySet<string>,
): StreamSnapshot[] {
  return streams.filter(stream => matchIds.has(stream.matchId))
}

export async function fetchOperationsSnapshot(
  basePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OperationsDashboardSnapshot> {
  const response = await fetchImpl(`${basePath.replace(/\/$/, '')}/operations/summary`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('目前帳號沒有系統監控權限')
    throw new Error(`監控資料讀取失敗（${response.status}）`)
  }
  return await response.json() as OperationsDashboardSnapshot
}
