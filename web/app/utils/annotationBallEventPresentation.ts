import {
  receiveContextForPreviousEvent,
  type BallEventKind,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'

export type BallEventTone = 'serve' | 'receive' | 'hit' | 'spike' | 'ground'

const KIND_LABELS: Record<BallEventKind, string> = {
  SERVE: '發球',
  RECEIVE: '接球',
  CONTACT: 'HIT',
  SPIKE: '殺球',
}

export const BALL_EVENT_TONE_COLORS: Record<BallEventTone, string> = {
  serve: '#f5b84b',
  receive: '#35c6a4',
  hit: '#62a9ff',
  spike: '#f06f8f',
  ground: '#e8edf2',
}

export function ballEventTone(
  event: BallEventValue | null | undefined,
  options: { isTerminal?: boolean; markerKind?: string | null } = {},
): BallEventTone {
  if (options.isTerminal) return 'ground'
  if (event?.kind === 'SERVE' || options.markerKind === 'service') return 'serve'
  if (event?.kind === 'RECEIVE') return 'receive'
  if (event?.kind === 'SPIKE') return 'spike'
  return 'hit'
}

export function ballEventKindLabel(
  event: BallEventValue | null | undefined,
  options: {
    isTerminal?: boolean
    markerKind?: string | null
    previousEvent?: BallEventValue | null
  } = {},
) {
  if (options.isTerminal) return '落地'
  if (event?.kind === 'RECEIVE') {
    const context = receiveContextForPreviousEvent(options.previousEvent)
    if (context === 'SERVE_RECEIVE') return '接發'
    if (context === 'SPIKE_RECEIVE') return '接殺'
  }
  if (event) return KIND_LABELS[event.kind]
  return options.markerKind === 'service' ? '發球' : 'HIT'
}

export function ballEventResultLabel(event: BallEventValue | null | undefined) {
  if (!event?.result) return null
  if (event.result === 'SUCCESS') return '成功'
  return '失敗'
}

export function ballEventLabel(
  event: BallEventValue | null | undefined,
  options: {
    isTerminal?: boolean
    markerKind?: string | null
    previousEvent?: BallEventValue | null
  } = {},
) {
  const kind = ballEventKindLabel(event, options)
  const result = ballEventResultLabel(event)
  return result ? `${kind} · ${result}` : kind
}
