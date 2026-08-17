import type { BallEventRepair } from '@volleyball-monitoring/contracts'

const REPAIR_LABELS: ReadonlyArray<readonly [BallEventRepair['code'], string]> = [
  ['OUTSIDE_START_TOMBSTONED', '取消片段開始前的球點'],
  ['OUTSIDE_END_TOMBSTONED', '取消片段結束後的球點'],
  ['EVENT_KIND_NORMALIZED', '依球序調整球種'],
  ['EVENT_RESULT_CLEARED', '清除不相容結果'],
  ['SERVE_STYLE_DEFAULTED', '將發球方式預設為跳發'],
  ['SERVE_STYLE_CLEARED', '清除非發球球點的發球方式'],
  ['SERVE_SUCCESS_INFERRED', '因已出現第三球，補上未填寫的發球成功'],
  ['SECOND_POINT_RECEIVE_INFERRED', '因已出現第三球，將未編輯的第二球辨識為接發'],
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
