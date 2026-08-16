import type { StreamSnapshot } from './operationsMonitor'

export type MediaWorkTone = 'danger' | 'good' | 'neutral' | 'warning'

export interface MediaWorkStage {
  key:
    | 'queued'
    | 'preparing'
    | 'segmenting'
    | 'indexing'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'unknown'
  label: string
  detail: string
  tone: MediaWorkTone
}

const ACTIVE_WORK_STATUSES = new Set(['REQUESTED', 'RUNNING', 'DRAINING', 'STOP_REQUESTED'])

function decimalMicroseconds(value: string | null | undefined): number | null {
  if (!value) return null
  const result = Number(value) / 1_000_000
  return Number.isFinite(result) && result >= 0 ? result : null
}

function boundedPercent(numerator: number, denominator: number, completed: boolean) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  if (completed) return 100
  return Math.min(99.9, Math.max(0, (numerator / denominator) * 100))
}

export function mediaWorkStage(stream: StreamSnapshot): MediaWorkStage {
  const work = stream.sourceWork
  if (stream.status === 'FAILED' || work?.status === 'FAILED') {
    return {
      key: 'failed',
      label: '媒體處理失敗',
      detail: work?.lastErrorCode ? `錯誤代碼：${work.lastErrorCode}` : '請複製診斷資訊進行排查',
      tone: 'danger',
    }
  }
  if (stream.status === 'FINISHED' && work?.status === 'COMPLETED') {
    return {
      key: 'completed',
      label: '媒體與索引完成',
      detail: '來源、切片與可播放索引均已完成',
      tone: 'good',
    }
  }
  if (work?.status === 'REQUESTED') {
    return {
      key: 'queued',
      label: '等待媒體 Worker',
      detail: work.attempts ? `等待第 ${work.attempts + 1} 次嘗試` : '工作已建立，等待 Worker 領取',
      tone: 'neutral',
    }
  }
  if (work?.status === 'DRAINING') {
    return {
      key: 'indexing',
      label: '建立可播放索引',
      detail: '來源切片已完成，正在等待全部片段驗證與發布',
      tone: 'warning',
    }
  }
  if (work?.status === 'STOP_REQUESTED' || (stream.status === 'STOPPING' && !work)) {
    return {
      key: 'stopping',
      label: '正在停止並收尾',
      detail: '等待最後片段完成索引後關閉來源',
      tone: 'warning',
    }
  }
  if (work?.status === 'RUNNING') {
    if (work.resumeSegmentIndex > 0) {
      return {
        key: 'segmenting',
        label: '切片並送入索引',
        detail: `來源 Worker 已發布 ${work.resumeSegmentIndex} 個片段，索引器會逐一驗證`,
        tone: 'warning',
      }
    }
    return {
      key: 'preparing',
      label: stream.sourceKind === 'youtube_vod' ? '下載與準備影片' : '解析與連接來源',
      detail:
        stream.sourceKind === 'youtube_vod'
          ? '正在解析、下載或合併 YouTube 影音；第一個片段發布後會顯示切片進度'
          : '正在等待來源產生第一個可驗證片段',
      tone: 'warning',
    }
  }
  if (stream.program?.readySegmentCount) {
    return {
      key: 'indexing',
      label: '可播放片段建立中',
      detail: '已有片段可播放，但來源尚未宣告完成',
      tone: 'warning',
    }
  }
  return {
    key: 'unknown',
    label: '等待工作狀態',
    detail: '伺服器尚未收到媒體 Worker 的進度',
    tone: 'neutral',
  }
}

export function mediaPlayableProgress(stream: StreamSnapshot): number | null {
  const duration = decimalMicroseconds(stream.sourceDurationUs)
  const indexed = decimalMicroseconds(stream.program?.indexedDurationUs)
  if (duration === null || indexed === null) return null
  const completed = stream.status === 'FINISHED' && stream.sourceWork?.status === 'COMPLETED'
  return boundedPercent(indexed, duration, completed)
}

export function mediaPreparationProgress(stream: StreamSnapshot): number | null {
  const duration = decimalMicroseconds(stream.sourceDurationUs)
  const prepared = decimalMicroseconds(stream.sourceWork?.resumeCaptureTimeUs)
  if (duration === null || prepared === null) return null
  const completed = ['DRAINING', 'COMPLETED'].includes(stream.sourceWork?.status ?? '')
  return boundedPercent(prepared, duration, completed)
}

export function mediaAverageProcessingRate(stream: StreamSnapshot): {
  basis: 'indexed' | 'prepared'
  value: number
} | null {
  const indexed = decimalMicroseconds(stream.program?.indexedDurationUs) ?? 0
  const prepared = decimalMicroseconds(stream.sourceWork?.resumeCaptureTimeUs) ?? 0
  const processed = Math.max(indexed, prepared)
  const started = Date.parse(stream.startedAt ?? stream.sourceWork?.createdAt ?? '')
  const observed = Date.parse(
    stream.sourceWork?.lastHeartbeatAt ?? stream.sourceWork?.updatedAt ?? stream.updatedAt,
  )
  const elapsed = (observed - started) / 1_000
  if (!Number.isFinite(elapsed) || elapsed <= 0 || processed <= 0) return null
  return { basis: prepared > indexed ? 'prepared' : 'indexed', value: processed / elapsed }
}

export function mediaHeartbeat(
  stream: StreamSnapshot,
  generatedAt: string,
): { ageSeconds: number | null; label: string; stalled: boolean } {
  const status = stream.sourceWork?.status
  if (status && !ACTIVE_WORK_STATUSES.has(status)) {
    return {
      ageSeconds: null,
      label: status === 'COMPLETED' ? '工作已完成' : '工作已停止',
      stalled: false,
    }
  }
  const heartbeatAt = stream.sourceWork?.lastHeartbeatAt
  if (!heartbeatAt)
    return { ageSeconds: null, label: '尚未收到 heartbeat', stalled: status === 'RUNNING' }
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.parse(generatedAt) - Date.parse(heartbeatAt)) / 1_000),
  )
  if (!Number.isFinite(ageSeconds))
    return { ageSeconds: null, label: 'heartbeat 時間無效', stalled: true }
  return {
    ageSeconds,
    label: ageSeconds < 2 ? '剛剛收到 heartbeat' : `${ageSeconds} 秒前收到 heartbeat`,
    stalled: ageSeconds > 45,
  }
}

export function mediaDiagnostics(stream: StreamSnapshot, generatedAt: string) {
  const stage = mediaWorkStage(stream)
  const heartbeat = mediaHeartbeat(stream, generatedAt)
  const rate = mediaAverageProcessingRate(stream)
  return {
    generated_at: generatedAt,
    computed: {
      stage: stage.key,
      stage_label: stage.label,
      playable_progress_percent: mediaPlayableProgress(stream),
      preparation_progress_percent: mediaPreparationProgress(stream),
      average_processing_rate: rate?.value ?? null,
      rate_basis: rate?.basis ?? null,
      heartbeat_age_seconds: heartbeat.ageSeconds,
      heartbeat_stalled: heartbeat.stalled,
    },
    capture: {
      id: stream.captureSessionId,
      match_id: stream.matchId,
      source_kind: stream.sourceKind,
      source_duration_us: stream.sourceDurationUs,
      status: stream.status,
      health: stream.health,
      started_at: stream.startedAt,
      updated_at: stream.updatedAt,
      completion_expected_segments: stream.completionExpectedSegments,
      completion_requested_at: stream.completionRequestedAt,
      epoch_count: stream.epochCount,
    },
    source_work: stream.sourceWork,
    program: stream.program,
  }
}
