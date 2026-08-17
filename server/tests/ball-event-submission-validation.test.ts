import { describe, expect, it } from 'vitest'
import {
  isSubmissionBallEventValid,
  unresolvedBallEventSubmissionMessage,
} from '../src/domain/annotation/ball-event-submission-validation.js'

describe('ball-event submission validation', () => {
  it('accepts manual CONTACT or RECEIVE at the second point', () => {
    const points = [
      { ballEvent: { kind: 'SERVE', result: 'SUCCESS' } },
      { ballEvent: { kind: 'RECEIVE', result: 'SUCCESS' } },
      { ballEvent: { kind: 'SPIKE', result: 'FAILURE' } },
      { ballEvent: { kind: 'RECEIVE', result: 'FAILURE' } },
      { ballEvent: { kind: 'CONTACT', result: null } },
    ] as const

    expect(points.every((_, index) => isSubmissionBallEventValid(points, index))).toBe(true)
  })

  it('names every optional unresolved contextual result in Chinese', () => {
    const points = [
      { ballEvent: { kind: 'SERVE', result: 'SUCCESS' } },
      { ballEvent: { kind: 'RECEIVE', result: null } },
      { ballEvent: { kind: 'SPIKE', result: null } },
      { ballEvent: { kind: 'RECEIVE', result: null } },
      { ballEvent: { kind: 'CONTACT', result: null } },
      { ballEvent: { kind: 'RECEIVE', result: null } },
    ] as const

    expect(unresolvedBallEventSubmissionMessage(points)).toBe(
      '第 2 球「接發」尚未標記成功或失敗；' +
        '第 3 球「殺球」尚未標記成功或失敗；' +
        '第 4 球「接殺」尚未標記成功或失敗；' +
        '第 6 球「接球」尚未標記成功或失敗',
    )
  })
})
