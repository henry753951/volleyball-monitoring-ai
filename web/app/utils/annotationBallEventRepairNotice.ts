import type { BallEventRepair } from '@volleyball-monitoring/contracts'

const REPAIR_LABELS: ReadonlyArray<readonly [BallEventRepair['code'], string]> = [
  ['OUTSIDE_START_TOMBSTONED', '取消片段開始前的球點'],
  ['OUTSIDE_END_TOMBSTONED', '取消片段結束後的球點'],
  ['EVENT_KIND_NORMALIZED', '依球序調整球種'],
  ['EVENT_RESULT_CLEARED', '清除不相容結果'],
  ['SERVE_SUCCESS_INFERRED', '依後續球點確認發球成功'],
  ['RECEIVE_POINT_LOST_DOWNGRADED', '將仍有後續球的接球失分改為失敗'],
  ['SPIKE_SUCCESS_DOWNGRADED', '將非最後一球的殺球得分改為失敗'],
  ['SEQUENCE_REINDEXED', '重新排列球點順序'],
]

export function visibleBallEventRepairs(repairs: readonly BallEventRepair[]) {
  return repairs.filter(
    repair => !(repair.code === 'EVENT_KIND_NORMALIZED' && repair.before.event === null),
  )
}

export function ballEventRepairNotice(repairs: readonly BallEventRepair[]) {
  const visible = visibleBallEventRepairs(repairs)
  if (!visible.length) return null
  const counts = new Map<BallEventRepair['code'], number>()
  for (const repair of visible) counts.set(repair.code, (counts.get(repair.code) ?? 0) + 1)
  return REPAIR_LABELS.flatMap(([code, label]) => {
    const count = counts.get(code) ?? 0
    return count ? [`${label} ${count} 個`] : []
  }).join('；')
}
