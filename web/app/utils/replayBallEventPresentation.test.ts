import { describe, expect, it } from 'vitest'
import type { ReplayContactEvent } from '~/lib/coachDomain'
import { replayBallEventKindKey, replayBallEventLabel } from './replayBallEventPresentation'

function event(
  sequence_index: number,
  kind: NonNullable<ReplayContactEvent['ball_event']>['kind'],
  result: NonNullable<ReplayContactEvent['ball_event']>['result'] = null,
) {
  return {
    key_point_id: String(sequence_index),
    sequence_index,
    ball_event: { ordinal: sequence_index + 1, kind, result },
  } as ReplayContactEvent
}

describe('replay ball-event presentation', () => {
  it('derives receive categories from the immediately preceding ball event', () => {
    const events = [
      event(0, 'serve', 'success'),
      event(1, 'receive', 'success'),
      event(2, 'spike', 'failure'),
      event(3, 'receive', 'error'),
      event(4, 'contact'),
      event(5, 'receive', 'success'),
    ]

    expect(replayBallEventKindKey(events, events[1]!)).toBe('serve_receive')
    expect(replayBallEventKindKey(events, events[3]!)).toBe('spike_receive')
    expect(replayBallEventKindKey(events, events[5]!)).toBe('receive')
    expect(replayBallEventLabel(events, events[3]!)).toBe('HIT · 失敗')
    expect(replayBallEventLabel(events, events[4]!)).toBe('HIT')
  })
})
