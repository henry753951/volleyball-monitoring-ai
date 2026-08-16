import {
  isBallEventResultValid,
  receiveContextForPreviousEvent,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'

export interface SubmissionBallEventPoint {
  ballEvent: BallEventValue | null
}

export function isSubmissionBallEventValid(
  points: readonly SubmissionBallEventPoint[],
  index: number,
) {
  const event = points[index]?.ballEvent
  if (!event) return false
  if (index === 0 && event.kind !== 'SERVE') return false
  if (index === 1 && event.kind !== 'RECEIVE') return false
  if (index >= 2 && !['CONTACT', 'RECEIVE', 'SPIKE'].includes(event.kind)) return false
  return isBallEventResultValid(event.kind, event.result)
}

function eventName(points: readonly SubmissionBallEventPoint[], index: number) {
  const event = points[index]?.ballEvent
  if (!event) return '球點'
  if (event.kind === 'SERVE') return '發球'
  if (event.kind === 'SPIKE') return '殺球'
  if (event.kind !== 'RECEIVE') return 'HIT'
  const context = receiveContextForPreviousEvent(points[index - 1]?.ballEvent)
  if (context === 'SERVE_RECEIVE') return '接發'
  if (context === 'SPIKE_RECEIVE') return '接殺'
  return '接球'
}

function resultChoices(event: BallEventValue) {
  if (event.kind === 'SERVE') return '得分、成功或失誤'
  if (event.kind === 'RECEIVE') return '成功、失敗或失分'
  return '成功或失敗'
}

export function unresolvedBallEventSubmissionMessage(points: readonly SubmissionBallEventPoint[]) {
  const unresolved = points.flatMap((point, index) => {
    const event = point.ballEvent
    if (!event || event.kind === 'CONTACT' || event.result !== null) return []
    return [
      `第 ${index + 1} 球「${eventName(points, index)}」尚未標記結果，請選擇${resultChoices(event)}`,
    ]
  })
  return unresolved.length ? unresolved.join('；') : null
}
