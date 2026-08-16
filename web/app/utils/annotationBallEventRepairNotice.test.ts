import type { BallEventRepair } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import { ballEventRepairNotice, visibleBallEventRepairs } from './annotationBallEventRepairNotice'

function repair(
  code: BallEventRepair['code'],
  beforeEvent: BallEventRepair['before']['event'],
): BallEventRepair {
  return {
    code,
    key_point_id: code,
    action: 'update',
    before: { sequence_index: 1, event: beforeEvent },
    after: { sequence_index: 1, event: { kind: 'RECEIVE', result: null } },
  }
}

describe('ball-event repair notice', () => {
  it('does not announce ordinary default initialization as an automatic correction', () => {
    const repairs = [repair('EVENT_KIND_NORMALIZED', null)]
    expect(visibleBallEventRepairs(repairs)).toEqual([])
    expect(ballEventRepairNotice(repairs)).toBeNull()
  })

  it('still summarizes real user-visible corrections', () => {
    const repairs = [
      repair('EVENT_KIND_NORMALIZED', { kind: 'SPIKE', result: 'SUCCESS' }),
      repair('EVENT_RESULT_CLEARED', { kind: 'RECEIVE', result: 'FAILURE' }),
    ]
    expect(ballEventRepairNotice(repairs)).toBe('依球序調整球種 1 個；清除不相容結果 1 個')
  })
})
