import { describe, expect, it } from 'vitest'
import { ballEventKindLabel, ballEventLabel } from './annotationBallEventPresentation'

describe('annotation ball-event presentation', () => {
  it('derives receive labels from the immediately preceding persisted event', () => {
    const receive = { kind: 'RECEIVE', result: 'SUCCESS' } as const
    expect(ballEventLabel(receive, { previousEvent: { kind: 'SERVE', result: 'SUCCESS' } })).toBe(
      '接發 · 成功',
    )
    expect(ballEventLabel(receive, { previousEvent: { kind: 'SPIKE', result: 'FAILURE' } })).toBe(
      '接殺 · 成功',
    )
    expect(ballEventLabel(receive, { previousEvent: { kind: 'CONTACT', result: null } })).toBe(
      '接球 · 成功',
    )
  })

  it('uses the same explicit failure result for every typed ball event', () => {
    expect(ballEventLabel({ kind: 'RECEIVE', result: 'FAILURE' })).toBe('接球 · 失敗')
    expect(ballEventLabel({ kind: 'SERVE', result: 'FAILURE' })).toBe('發球 · 失敗')
    expect(ballEventKindLabel({ kind: 'RECEIVE', result: null })).toBe('接球')
  })
})
