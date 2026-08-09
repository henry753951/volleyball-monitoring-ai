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
  latencyMs: number | null
  lastPingAt: string | null
  lastPongAt: string | null
  status: 'online' | 'stale' | 'offline'
  canDelete: boolean
}

export interface AiWorkerAccessSnapshot {
  name: 'volleyball-analysis-engine'
  authMode: 'managed' | 'environment' | 'unconfigured'
  workerCount: number
  onlineWorkerCount: number
  activeJobCount: number
  tokens: AiWorkerTokenSnapshot[]
}

export interface AiWorkerTokenSnapshot {
  id: string
  name: string
  tokenPrefix: string
  enabled: boolean
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DeleteAiWorkerReceipt {
  schema_version: '1.0.0'
  deleted_worker: { id: string; instance_key: string }
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

const ACTIVE_AI_WORK_STATUSES = new Set(['QUEUED', 'RUNNING'])

export function activeAiWorkForDashboard(items: readonly AiWorkSnapshot[]) {
  return items.filter(item => ACTIVE_AI_WORK_STATUSES.has(item.status.toUpperCase()))
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

export interface HostStorageSnapshot {
  available: boolean
  freeBytes: string
  path: string
  totalBytes: string
  usedBytes: string
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
    aiWorkerAccess: AiWorkerAccessSnapshot
    aiWork: AiWorkSnapshot[]
    hostStorage: HostStorageSnapshot
    matchMedia: MatchMediaSnapshot[]
    streams: StreamSnapshot[]
  }
}

async function operationsWrite<T>(
  basePath: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${basePath.replace(/\/$/, '')}${path}`, {
    ...init,
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (response.status === 401) throw new Error('無法確認操作身分，請重新整理後再試')
    if (response.status === 403) throw new Error('目前無法管理 Worker Token')
    throw new Error(payload?.error || `AI Worker 設定更新失敗（${response.status}）`)
  }
  return await response.json() as T
}

export function createAiWorkerToken(basePath: string, name: string, fetchImpl: typeof fetch = fetch) {
  return operationsWrite<{ schema_version: '1.0.0'; access_token: { id: string; name: string; tokenPrefix: string }; token: string }>(
    basePath, '/operations/ai-worker-tokens', { body: JSON.stringify({ name }), method: 'POST' }, fetchImpl,
  )
}

export function rotateAiWorkerToken(basePath: string, tokenId: string, fetchImpl: typeof fetch = fetch) {
  return operationsWrite<{ schema_version: '1.0.0'; token_id: string; token: string }>(
    basePath, `/operations/ai-worker-tokens/${encodeURIComponent(tokenId)}/rotate`, { body: '{}', method: 'POST' }, fetchImpl,
  )
}

export function setAiWorkerTokenEnabled(basePath: string, tokenId: string, enabled: boolean, fetchImpl: typeof fetch = fetch) {
  return operationsWrite<{ schema_version: '1.0.0'; token_id: string; enabled: boolean }>(
    basePath, `/operations/ai-worker-tokens/${encodeURIComponent(tokenId)}`, { body: JSON.stringify({ enabled }), method: 'PATCH' }, fetchImpl,
  )
}

export function deleteAiWorkerToken(basePath: string, tokenId: string, fetchImpl: typeof fetch = fetch) {
  return operationsWrite<{ schema_version: '1.0.0'; deleted_token: { id: string } }>(
    basePath, `/operations/ai-worker-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }, fetchImpl,
  )
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

export async function deleteAiWorker(
  basePath: string,
  workerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeleteAiWorkerReceipt> {
  const response = await fetchImpl(`${basePath.replace(/\/$/, '')}/operations/ai-workers/${encodeURIComponent(workerId)}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    method: 'DELETE',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string } | null
    if (payload?.code === 'AI_WORKER_ONLINE') throw new Error('Worker 已恢復連線，無法刪除')
    if (payload?.code === 'AI_WORKER_HAS_ACTIVE_JOBS') throw new Error('Worker 仍持有進行中的工作，無法刪除')
    if (payload?.code === 'AI_WORKER_NOT_FOUND') throw new Error('Worker 紀錄已不存在')
    if (response.status === 401 || response.status === 403) throw new Error('目前帳號沒有移除 AI Worker 的權限')
    throw new Error(`AI Worker 刪除失敗（${response.status}）`)
  }
  return await response.json() as DeleteAiWorkerReceipt
}
