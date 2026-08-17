import { describe, expect, it } from 'vitest'
import {
  decideBallEventShortcut,
  normalizeBallEventKeyPoints,
  receiveContextForPreviousEvent,
  resultForBallEventChoice,
  type BallEventValue,
} from '../src/ball-event.js'

const point = (
  id: string,
  time: number,
  sequence: number,
  event: BallEventValue | null = null,
) => ({
  key_point_id: id,
  capture_time_us: String(time),
  capture_frame_index: String(time),
  sequence_index: sequence,
  event,
})

describe('normalizeBallEventKeyPoints', () => {
  it('orders every source and defaults only the first point to a jump serve', () => {
    const result = normalizeBallEventKeyPoints({
      points: [point('manual', 30, 0), point('automatic', 10, 1), point('copied', 20, 2)],
    })

    expect(result.points.map(entry => [entry.key_point_id, entry.event])).toEqual([
      ['automatic', { kind: 'SERVE', result: null, serve_style: 'JUMP' }],
      ['copied', { kind: 'CONTACT', result: null, serve_style: null }],
      ['manual', { kind: 'CONTACT', result: null, serve_style: null }],
    ])
  })

  it('preserves a manually classified second-point receive without deciding its result', () => {
    const result = normalizeBallEventKeyPoints({
      points: [
        point('serve', 10, 0, { kind: 'SERVE', result: null }),
        point('receive', 20, 1, { kind: 'RECEIVE', result: null }),
        point('third', 30, 2),
      ],
    })
    expect(result.points[1]?.event).toEqual({
      kind: 'RECEIVE',
      result: null,
      serve_style: null,
    })
    expect(result.points[0]?.event.result).toBeNull()
  })

  it('prevents a spike on either of the first two points', () => {
    const result = normalizeBallEventKeyPoints({
      points: [
        point('first', 10, 0, { kind: 'SPIKE', result: 'SUCCESS' }),
        point('second', 20, 1, { kind: 'SPIKE', result: 'FAILURE' }),
      ],
    })
    expect(result.points.map(entry => entry.event.kind)).toEqual(['SERVE', 'CONTACT'])
    expect(result.points.map(entry => entry.event.result)).toEqual([null, null])
  })

  it('tombstones points after an earlier Z end boundary', () => {
    const result = normalizeBallEventKeyPoints({
      boundaries: [
        { kind: 'start', capture_time_us: '5', capture_frame_index: '5' },
        { kind: 'end', capture_time_us: '25', capture_frame_index: '25' },
      ],
      points: [point('p1', 10, 0), point('p2', 20, 1), point('p3', 30, 2)],
    })
    expect(result.tombstoned_key_point_ids).toEqual(['p3'])
    expect(result.repairs).toContainEqual(
      expect.objectContaining({ code: 'OUTSIDE_END_TOMBSTONED', key_point_id: 'p3' }),
    )
  })
})

describe('human result choices', () => {
  it('maps the generic success/failure buttons without changing the event kind', () => {
    expect(resultForBallEventChoice('SERVE', 'SUCCESS')).toBe('SUCCESS')
    expect(resultForBallEventChoice('SERVE', 'FAILURE')).toBe('FAILURE')
    expect(resultForBallEventChoice('RECEIVE', 'FAILURE')).toBe('FAILURE')
    expect(resultForBallEventChoice('SPIKE', 'FAILURE')).toBe('FAILURE')
    expect(resultForBallEventChoice('CONTACT', 'SUCCESS')).toBeNull()
  })
})

describe('decideBallEventShortcut', () => {
  const points = [point('p1', 10, 0), point('p2', 20, 1), point('p3', 30, 2)]

  it('keeps C unavailable on the first two points', () => {
    expect(
      decideBallEventShortcut({ shortcut: 'C', points, selected_key_point_id: 'p1' }),
    ).toMatchObject({ allowed: false, reason: 'SPIKE_REQUIRES_THIRD_POINT' })
    expect(
      decideBallEventShortcut({ shortcut: 'C', points, selected_key_point_id: 'p3' }),
    ).toMatchObject({ allowed: true, ordinal: 3, event: { kind: 'SPIKE', result: null } })
  })

  it('creates a spike only when the candidate would be the third point or later', () => {
    expect(
      decideBallEventShortcut({
        shortcut: 'C',
        points: points.slice(0, 2),
        candidate_anchor: { capture_time_us: '30', capture_frame_index: '30' },
      }),
    ).toMatchObject({ allowed: true, mode: 'create', ordinal: 3, event: { kind: 'SPIKE' } })
  })
})

describe('receiveContextForPreviousEvent', () => {
  it('derives serve receive, spike receive, and ordinary receive without changing storage', () => {
    expect(receiveContextForPreviousEvent({ kind: 'SERVE', result: 'SUCCESS' })).toBe(
      'SERVE_RECEIVE',
    )
    expect(receiveContextForPreviousEvent({ kind: 'SPIKE', result: 'FAILURE' })).toBe(
      'SPIKE_RECEIVE',
    )
    expect(receiveContextForPreviousEvent({ kind: 'CONTACT', result: null })).toBe('RECEIVE')
  })
})
