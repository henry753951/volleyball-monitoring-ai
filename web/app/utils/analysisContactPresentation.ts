import type { ReplayContactEvent, ReplayPath } from '~/lib/coachDomain'

export interface AnalysisContactSemantic {
  courtSide: 'left' | 'right'
  teamLabel: string
  phase: 'pass' | 'set' | 'spike'
  typeLabel: '接球' | '舉球' | '攻擊'
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function analysisContactSemantic(
  event: ReplayContactEvent | undefined,
  teamLabels: Readonly<{ left: string; right: string }>,
): AnalysisContactSemantic | null {
  if (!event) return null
  const evidence = record(event.detection_evidence)
  const legacyLabel =
    typeof evidence?.group_activity_label === 'string' ? evidence.group_activity_label : null
  const match = legacyLabel?.match(/^([lr])_(pass|set|spike)$/)
  if (!match) return null
  const courtSide = match[1] === 'l' ? 'left' : 'right'
  const phase = match[2] as AnalysisContactSemantic['phase']
  return {
    courtSide,
    teamLabel: teamLabels[courtSide],
    phase,
    typeLabel: phase === 'pass' ? '接球' : phase === 'set' ? '舉球' : '攻擊',
  }
}

export function analysisPathLabel(
  path: ReplayPath | undefined,
  events: ReadonlyMap<string, ReplayContactEvent>,
  teamLabels: Readonly<{ left: string; right: string }>,
): string | null {
  if (!path || path.render_state !== 'complete') return null
  const start = analysisContactSemantic(events.get(path.start_key_point_id), teamLabels)
  const end = analysisContactSemantic(events.get(path.end_key_point_id), teamLabels)
  if (!start || !end) return null
  const route =
    start.courtSide === end.courtSide
      ? `${start.teamLabel} 隊內球路`
      : `${start.teamLabel} → ${end.teamLabel} 過網球路`
  return `${route}：${start.typeLabel} → ${end.typeLabel}`
}
