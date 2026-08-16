import { describe, expect, it } from 'vitest'
import { decideBallEventShortcut, normalizeBallEventKeyPoints } from '../src/ball-event.js'

const point = (
  id: string,
  time: number,
  sequence: number,
  event: { kind: 'SERVE' | 'RECEIVE' | 'CONTACT' | 'SPIKE'; result: any } | null = null,
) => ({
  key_point_id: id,
  capture_time_us: String(time),
  capture_frame_index: String(time),
  sequence_index: sequence,
  event,
})

describe('normalizeBallEventKeyPoints', () => {
  it('uses every valid keypoint source in canonical time order', () => {
    const result = normalizeBallEventKeyPoints({
      points: [point('manual', 30, 0), point('automatic', 10, 1), point('copied', 20, 2)],
    })

    expect(result.points.map(entry => [entry.key_point_id, entry.event.kind])).toEqual([
      ['automatic', 'SERVE'],
      ['copied', 'RECEIVE'],
      ['manual', 'CONTACT'],
    ])
    expect(result.points.map(entry => entry.sequence_index)).toEqual([0, 1, 2])
  })

  it('tombstones points after an earlier Z end boundary and reports each repair', () => {
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

  it('clears incompatible results when insertion changes the ordinal', () => {
    const result = normalizeBallEventKeyPoints({
      points: [
        point('new-first', 5, 3),
        point('old-first', 10, 0, { kind: 'SERVE', result: 'SUCCESS' }),
        point('old-receive', 20, 1, { kind: 'RECEIVE', result: 'SUCCESS' }),
      ],
    })

    expect(result.points.map(entry => entry.event)).toEqual([
      { kind: 'SERVE', result: 'SUCCESS' },
      { kind: 'RECEIVE', result: null },
      { kind: 'CONTACT', result: null },
    ])
  })

  it('repairs direct-point results without overriding an explicit spike decision', () => {
    const result = normalizeBallEventKeyPoints({
      points: [
        point('serve', 10, 0, { kind: 'SERVE', result: 'POINT_SCORED' }),
        point('receive', 20, 1, { kind: 'RECEIVE', result: 'POINT_LOST' }),
        point('spike', 30, 2, { kind: 'SPIKE', result: 'SUCCESS' }),
        point('later', 40, 3),
      ],
    })

    expect(result.points.map(entry => entry.event.result)).toEqual([
      'SUCCESS',
      'ERROR',
      'SUCCESS',
      null,
    ])
    expect(result.repairs.map(repair => repair.code)).toEqual(
      expect.arrayContaining(['SERVE_SUCCESS_INFERRED', 'RECEIVE_POINT_LOST_DOWNGRADED']),
    )
    expect(result.repairs.map(repair => repair.code)).not.toContain('SPIKE_SUCCESS_DOWNGRADED')
  })
})

describe('decideBallEventShortcut', () => {
  const points = [point('p1', 10, 0), point('p2', 20, 1), point('p3', 30, 2)]

  it('changes a selected second point with V or B', () => {
    expect(
      decideBallEventShortcut({ shortcut: 'V', points, selected_key_point_id: 'p2' }),
    ).toMatchObject({ allowed: true, mode: 'update', ordinal: 2, event: { result: 'SUCCESS' } })
    expect(
      decideBallEventShortcut({ shortcut: 'B', points, selected_key_point_id: 'p2' }),
    ).toMatchObject({ allowed: true, mode: 'update', ordinal: 2, event: { result: 'ERROR' } })
  })

  it('rejects C on the first two points and V/B outside the second point', () => {
    expect(
      decideBallEventShortcut({ shortcut: 'C', points, selected_key_point_id: 'p1' }),
    ).toMatchObject({ allowed: false, reason: 'SPIKE_REQUIRES_THIRD_POINT' })
    expect(
      decideBallEventShortcut({ shortcut: 'V', points, selected_key_point_id: 'p3' }),
    ).toMatchObject({ allowed: false, reason: 'RECEIVE_REQUIRES_SECOND_POINT' })
  })

  it('creates a typed point only when its cursor ordinal is legal', () => {
    expect(
      decideBallEventShortcut({
        shortcut: 'C',
        points: points.slice(0, 2),
        candidate_anchor: { capture_time_us: '30', capture_frame_index: '30' },
      }),
    ).toMatchObject({ allowed: true, mode: 'create', ordinal: 3, event: { kind: 'SPIKE' } })
    expect(
      decideBallEventShortcut({
        shortcut: 'B',
        points: points.slice(0, 1),
        candidate_anchor: { capture_time_us: '20', capture_frame_index: '20' },
      }),
    ).toMatchObject({ allowed: true, mode: 'create', ordinal: 2 })
  })
})
