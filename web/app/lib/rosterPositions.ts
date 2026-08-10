import type { RosterPosition } from './coreDomain'

export const ROSTER_POSITION_OPTIONS = [
  { value: 'UNSPECIFIED', code: '—', label: '未設定' },
  { value: 'OH', code: 'OH', label: '主攻' },
  { value: 'MB', code: 'MB', label: '副攻' },
  { value: 'OPP', code: 'OPP', label: '舉對（接應）' },
  { value: 'S', code: 'S', label: '舉球員' },
  { value: 'L', code: 'L', label: '自由球員' },
  { value: 'DS', code: 'DS', label: '防守專家' },
] as const satisfies ReadonlyArray<{ value: RosterPosition; code: string; label: string }>

export const ROSTER_POSITION_SELECT_OPTIONS = ROSTER_POSITION_OPTIONS.map(option => ({
  value: option.value,
  label: `${option.code} · ${option.label}`,
}))

export function rosterPositionLabel(value: RosterPosition) {
  const option = ROSTER_POSITION_OPTIONS.find(item => item.value === value)
  return option ? `${option.code} · ${option.label}` : value
}
