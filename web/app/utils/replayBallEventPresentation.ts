import type { ReplayContactEvent } from '~/lib/coachDomain'

export type ReplayBallEventKindKey =
  | 'serve'
  | 'serve_receive'
  | 'spike_receive'
  | 'receive'
  | 'contact'
  | 'spike'

function semanticKind(event: ReplayContactEvent) {
  return (
    event.ball_event?.kind ??
    (event.sequence_index === 0 ? 'serve' : event.sequence_index === 1 ? 'receive' : 'contact')
  )
}

export function previousReplayBallEvent(
  events: readonly ReplayContactEvent[],
  event: ReplayContactEvent,
) {
  return events.reduce<ReplayContactEvent | null>((previous, candidate) => {
    if (candidate.sequence_index >= event.sequence_index) return previous
    if (!previous || candidate.sequence_index > previous.sequence_index) return candidate
    return previous
  }, null)
}

export function replayBallEventKindKey(
  events: readonly ReplayContactEvent[],
  event: ReplayContactEvent,
): ReplayBallEventKindKey {
  const kind = semanticKind(event)
  if (kind !== 'receive') return kind
  const previousKind = semanticKind(previousReplayBallEvent(events, event) ?? event)
  if (previousKind === 'serve') return 'serve_receive'
  if (previousKind === 'spike') return 'spike_receive'
  return 'receive'
}

export function replayBallEventKindLabel(
  events: readonly ReplayContactEvent[],
  event: ReplayContactEvent,
) {
  const kind = replayBallEventKindKey(events, event)
  if (kind === 'serve') return '發球'
  if (kind === 'serve_receive') return '接發'
  if (kind === 'spike') return '殺球'
  return 'HIT'
}

export function replayBallEventLabel(
  events: readonly ReplayContactEvent[],
  event: ReplayContactEvent,
) {
  const label = replayBallEventKindLabel(events, event)
  const result = event.ball_event?.result
  const resultLabel = result === 'success' ? '成功' : result === 'failure' ? '失敗' : null
  return resultLabel ? `${label} · ${resultLabel}` : label
}
