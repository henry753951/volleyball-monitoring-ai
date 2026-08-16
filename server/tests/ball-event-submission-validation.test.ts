import { describe, expect, it } from 'vitest'
import {
  isSubmissionBallEventValid,
  unresolvedBallEventSubmissionMessage,
} from '../src/domain/annotation/ball-event-submission-validation.js'

describe('ball-event submission validation', () => {
  it('accepts generic RECEIVE after the second point', () => {
    const points = [
      { ballEvent: { kind: 'SERVE', result: 'SUCCESS' } },
      { ballEvent: { kind: 'RECEIVE', result: 'SUCCESS' } },
      { ballEvent: { kind: 'SPIKE', result: 'FAILURE' } },
      { ballEvent: { kind: 'RECEIVE', result: 'ERROR' } },
      { ballEvent: { kind: 'CONTACT', result: null } },
    ] as const

    expect(points.every((_, index) => isSubmissionBallEventValid(points, index))).toBe(true)
  })

  it('names every unresolved contextual receive and spike in Chinese', () => {
    const points = [
      { ballEvent: { kind: 'SERVE', result: 'SUCCESS' } },
      { ballEvent: { kind: 'RECEIVE', result: null } },
      { ballEvent: { kind: 'SPIKE', result: null } },
      { ballEvent: { kind: 'RECEIVE', result: null } },
      { ballEvent: { kind: 'CONTACT', result: null } },
      { ballEvent: { kind: 'RECEIVE', result: null } },
    ] as const

    expect(unresolvedBallEventSubmissionMessage(points)).toBe(
      '第 2 球「接發」尚未標記結果，請選擇成功、失敗或失分；' +
        '第 3 球「殺球」尚未標記結果，請選擇成功或失敗；' +
        '第 4 球「接殺」尚未標記結果，請選擇成功、失敗或失分；' +
        '第 6 球「接球」尚未標記結果，請選擇成功、失敗或失分',
    )
  })
})
