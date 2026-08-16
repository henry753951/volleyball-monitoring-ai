import type {
  CoachMatchAnalytics,
  CoachRallyReplay,
  ReplayActor,
  ReplayContactEvent,
  ReplayCourtPosition,
} from '~/lib/coachDomain'

export type CoachActionOutcome = 'won' | 'lost' | 'unknown'

export interface CoachPlayerActionEvent {
  id: string
  rallyId: string
  setNumber: number
  rallyOrdinal: number
  analysisRunId: string
  trackId: number
  anchorTimeUs: string
  actionKey: string
  actionLabel: string
  actionConfidence: number | null
  resultKey: NonNullable<ReplayContactEvent['ball_event']>['result']
  routeStart: { x: number; y: number } | null
  routeEnd: { x: number; y: number } | null
  outcome: CoachActionOutcome
}

const ACTION_TRANSLATIONS: Record<string, string> = {
  attack: '殺球',
  attacking: '殺球',
  spike: '殺球',
  spiking: '殺球',
  reception: '接發',
  receive: '接發',
  receiving: '接發',
  serve_receive: '接發',
  dig: '接球',
  digging: '接球',
  defense: '接球',
  defensive: '接球',
  set: '舉球',
  setting: '舉球',
  serve: '發球',
  serving: '發球',
  block: '攔網',
  blocking: '攔網',
  standing: '站立',
  contact: '擊球',
}

const ACTION_COLORS = [
  '#007aff',
  '#ff3b30',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#00a6a6',
  '#d05a91',
] as const
const KNOWN_ACTION_COLORS: Record<string, string> = {
  attack: '#ff3b30',
  attacking: '#ff3b30',
  spike: '#ff3b30',
  spiking: '#ff3b30',
  reception: '#007aff',
  receive: '#007aff',
  receiving: '#007aff',
  serve_receive: '#007aff',
  dig: '#00a6a6',
  digging: '#00a6a6',
  defense: '#00a6a6',
  defensive: '#00a6a6',
  set: '#af52de',
  setting: '#af52de',
  serve: '#ff9500',
  serving: '#ff9500',
  block: '#d05a91',
  blocking: '#d05a91',
  standing: '#8e8e93',
  contact: '#69b7ff',
}

function actionRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function actionName(value: unknown) {
  if (typeof value === 'string') return value.trim() || null
  const record = actionRecord(value)
  return typeof record?.label === 'string' && record.label.trim() ? record.label.trim() : null
}

export function actionConfidence(value: unknown) {
  const confidence = actionRecord(value)?.confidence
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null
}

export function actionKey(value: unknown) {
  return (
    actionName(value)
      ?.toLocaleLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || 'unknown'
  )
}

export function actionDisplayLabel(value: unknown) {
  const name = actionName(value)
  if (!name) return '未分類'
  return ACTION_TRANSLATIONS[actionKey(name)] ?? name
}

export function actionColor(key: string) {
  if (KNOWN_ACTION_COLORS[key]) return KNOWN_ACTION_COLORS[key]
  let hash = 0
  for (const character of key) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return ACTION_COLORS[Math.abs(hash) % ACTION_COLORS.length]!
}

export function replayStartSeconds(anchorTimeUs: string, leadSeconds = 3) {
  if (!/^\d+$/.test(anchorTimeUs) || !Number.isFinite(leadSeconds) || leadSeconds < 0) return 0
  const leadUs = BigInt(Math.round(leadSeconds * 1_000_000))
  const startUs = BigInt(anchorTimeUs) > leadUs ? BigInt(anchorTimeUs) - leadUs : 0n
  return Number(startUs) / 1_000_000
}

export function replayEventUrl(
  matchId: string,
  event: Pick<CoachPlayerActionEvent, 'rallyId' | 'anchorTimeUs'>,
) {
  return `/matches/${matchId}/replay/${event.rallyId}?event_us=${event.anchorTimeUs}`
}

function actorForTrack(actors: ReplayActor[], trackId: number) {
  return actors.find(actor => actor.track_id === trackId) ?? null
}

function routePosition(positions: ReplayCourtPosition[], actorTrackId: number) {
  return (
    positions.find(position => position.track_id === null) ??
    positions.find(position => position.track_id === actorTrackId) ??
    positions[0] ??
    null
  )
}

export function collectCoachActionEvents(
  tracks: CoachMatchAnalytics['tracks'],
  replays: ReadonlyMap<string, CoachRallyReplay | null>,
) {
  const records = new Map<string, CoachPlayerActionEvent>()
  for (const track of tracks) {
    const replay = replays.get(track.rally_id)
    if (!replay?.analysis) continue
    for (const event of replay.analysis.contact_events) {
      const semantic = event.ball_event
      if (!semantic) continue
      const actorTrackId = semantic.actor?.track_id ?? event.actors[0]?.track_id ?? null
      if (actorTrackId !== track.track_id) continue
      const actor = actorForTrack(event.actors, track.track_id)
      const path = replay.analysis.paths.find(
        item => item.start_key_point_id === event.key_point_id,
      )
      const routeStart = path ? routePosition(path.start_court_positions, track.track_id) : null
      const routeEnd = path ? routePosition(path.end_court_positions, track.track_id) : null
      const semanticOutcome =
        semantic.result === 'point_scored' || semantic.result === 'success'
          ? 'won'
          : semantic.result === 'error' ||
              semantic.result === 'point_lost' ||
              semantic.result === 'failure'
            ? 'lost'
            : null
      const id = `${track.analysis_run_id}:${event.key_point_id}:${track.track_id}`
      records.set(id, {
        id,
        rallyId: track.rally_id,
        setNumber: track.set_number,
        rallyOrdinal: track.rally_ordinal,
        analysisRunId: track.analysis_run_id,
        trackId: track.track_id,
        anchorTimeUs: event.anchor_time_us,
        actionKey: semantic.kind,
        actionLabel: ACTION_TRANSLATIONS[semantic.kind] ?? semantic.kind,
        actionConfidence: null,
        resultKey: semantic.result,
        routeStart: routeStart?.court_pos ?? actor?.court_pos ?? null,
        routeEnd: routeEnd?.court_pos ?? null,
        outcome: semanticOutcome ?? 'unknown',
      })
    }
  }
  return [...records.values()].sort(
    (left, right) =>
      left.setNumber - right.setNumber ||
      left.rallyOrdinal - right.rallyOrdinal ||
      Number(BigInt(left.anchorTimeUs) - BigInt(right.anchorTimeUs)),
  )
}

export function actionOutcomeRate(events: CoachPlayerActionEvent[]) {
  const resolved = events.filter(event => event.outcome !== 'unknown')
  const won = resolved.filter(event => event.outcome === 'won').length
  return {
    won,
    resolved: resolved.length,
    unknown: events.length - resolved.length,
    rate: resolved.length ? won / resolved.length : null,
  }
}

export function formatActionTime(anchorTimeUs: string) {
  if (!/^\d+$/.test(anchorTimeUs)) return '0:00.0'
  const tenths = Number(BigInt(anchorTimeUs) / 100_000n)
  const seconds = Math.floor(tenths / 10)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`
}
