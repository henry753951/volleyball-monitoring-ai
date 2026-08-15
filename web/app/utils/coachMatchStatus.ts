import type { CaptureSession } from '~/lib/coreDomain'

export type CoachMatchStatusKind =
  | 'live'
  | 'processing'
  | 'ready'
  | 'planned'
  | 'finished'
  | 'failed'
  | 'archived'

export interface CoachMatchStatusPresentation {
  kind: CoachMatchStatusKind
  label: string
}

type StatusCapture = Pick<
  CaptureSession,
  'status' | 'health' | 'sourceKind' | 'startedAt' | 'endedAt'
>
type StatusMatch = { status: string; captureSessions?: readonly StatusCapture[] }

function captureTime(value: { startedAt: string | null; endedAt: string | null }) {
  return Date.parse(value.startedAt ?? value.endedAt ?? '') || 0
}

export function coachMatchStatus(match: StatusMatch): CoachMatchStatusPresentation {
  const captures = [...(match.captureSessions ?? [])].sort(
    (left, right) => captureTime(right) - captureTime(left),
  )
  const active = captures.find(capture => capture.status.toLowerCase() === 'live')
  if (active) {
    return active.health.toLowerCase() === 'healthy'
      ? { kind: 'live', label: '直播中' }
      : { kind: 'failed', label: '直播異常' }
  }

  if (captures.some(capture => capture.status.toLowerCase() === 'starting'))
    return { kind: 'processing', label: '連線中' }
  if (captures.some(capture => capture.status.toLowerCase() === 'stopping'))
    return { kind: 'processing', label: '結束處理中' }

  const matchStatus = match.status.toLowerCase()
  if (matchStatus === 'archived') return { kind: 'archived', label: '已封存' }
  if (matchStatus === 'finished') return { kind: 'finished', label: '已結束' }

  const latestFinished = captures.find(capture => capture.status.toLowerCase() === 'finished')
  if (latestFinished) {
    return latestFinished.sourceKind.toLowerCase().includes('live')
      ? { kind: 'finished', label: '直播已結束' }
      : { kind: 'ready', label: '影片已就緒' }
  }

  if (captures[0]?.status.toLowerCase() === 'failed') return { kind: 'failed', label: '影音失敗' }
  if (matchStatus === 'planned') return { kind: 'planned', label: '尚未開始' }
  return { kind: 'processing', label: '等待影音' }
}
