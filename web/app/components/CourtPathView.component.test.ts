import { ANALYSIS_PLAYER_FLAG, type AnalysisFrameChunk } from '@volleyball-monitoring/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CourtPathView from './CourtPathView.vue'
import type { ReplayContactEvent, ReplayPath } from '~/lib/coachDomain'

const paths: ReplayPath[] = [
  {
    id: 'path-1',
    sequence_index: 0,
    start_key_point_id: 'kp-1',
    end_key_point_id: 'kp-2',
    start_frame_index: '301',
    end_frame_index: '419',
    render_state: 'complete',
    is_terminal_segment: false,
    quality_flags: [],
    start_court_positions: [
      {
        track_id: 8,
        basis: 'player_footprint_proxy',
        court_pos: { x: -0.06, y: 0.24 },
        confidence: null,
      },
    ],
    end_court_positions: [
      {
        track_id: 3,
        basis: 'player_footprint_proxy',
        court_pos: { x: 0.72, y: 0.64 },
        confidence: null,
      },
    ],
  },
  {
    id: 'path-2',
    sequence_index: 1,
    start_key_point_id: 'kp-2',
    end_key_point_id: 'kp-3',
    start_frame_index: '419',
    end_frame_index: '480',
    render_state: 'complete',
    is_terminal_segment: true,
    quality_flags: [],
    start_court_positions: [
      {
        track_id: 3,
        basis: 'player_footprint_proxy',
        court_pos: { x: 0.72, y: 0.64 },
        confidence: null,
      },
    ],
    end_court_positions: [
      {
        track_id: null,
        basis: 'terminal_projection',
        court_pos: { x: 1.04, y: 0.79 },
        confidence: null,
      },
    ],
  },
]

const events: ReplayContactEvent[] = [
  {
    key_point_id: 'kp-1',
    sequence_index: 0,
    marker_kind: 'contact',
    is_terminal: false,
    anchor_frame_index: '301',
    resolved_frame_index: '301',
    anchor_time_us: '0',
    association_state: 'associated',
    ball_event: null,
    ball: { state: 'missing', frame_index: null, frame_pos: null },
    quality_flags: [],
    actors: [
      {
        track_id: 8,
        observation_frame_index: '301',
        association_confidence: 0.9,
        frame_bbox: null,
        frame_foot_pos: null,
        court_pos: { x: -0.06, y: 0.24 },
        action: null,
      },
    ],
    candidates: [],
    representative_court_positions: [],
  },
]

const chunk: AnalysisFrameChunk = {
  schemaVersion: 1,
  analysisId: 'analysis',
  analysisDataVersion: '1',
  chunkIndex: 0,
  startFrameIndex: 301n,
  frameCount: 1,
  frameOffsets: [0, 2],
  trackIds: [8, 12],
  frameBboxes: [
    { x1: 0, y1: 0, x2: 0, y2: 0 },
    { x1: 0, y1: 0, x2: 0, y2: 0 },
  ],
  frameFootPositions: [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ],
  courtPositions: [
    { x: -0.06, y: 0.24 },
    { x: 0.4, y: 0.8 },
  ],
  playerFlags: [ANALYSIS_PLAYER_FLAG.courtPosition, ANALYSIS_PLAYER_FLAG.courtPosition],
  playerConfidences: [-1, -1],
  actionLabelIds: [65535, 65535],
  actionConfidences: [-1, -1],
  ballFramePositions: [{ x: 0, y: 0 }],
  ballFlags: [0],
  ballConfidences: [-1],
  courtKeypointFrameOffsets: [0, 0],
  courtKeypointIds: [],
  courtKeypointPositions: [],
  courtKeypointConfidences: [],
}

describe('CourtPathView', () => {
  it('keeps a touch-sized hit target along every visible route', async () => {
    const wrapper = mount(CourtPathView, {
      props: {
        paths,
        events,
        activeFrame: 301,
      },
    })

    const curves = wrapper.findAll('.court-path__curve')
    const hitTargets = wrapper.findAll('.court-path__hit-target')
    expect(hitTargets).toHaveLength(curves.length)
    expect(hitTargets[0]!.attributes('d')).toBe(curves[0]!.attributes('d'))
    expect(wrapper.findAll('.court-team')[0]!.classes()).toContain('team-tone-red')
    expect(wrapper.findAll('.court-team')[1]!.classes()).toContain('team-tone-blue')

    await hitTargets[0]!.trigger('click')
    expect(wrapper.emitted('seek')?.[0]).toEqual(['301'])
  })

  it('moves the simulated ball from A to B using the active frame and switches on the next segment', async () => {
    const wrapper = mount(CourtPathView, {
      props: {
        paths,
        events,
        activeFrame: 301,
        playing: true,
        tracks: [
          { trackId: 8, courtSide: 'left', label: '王小明', jerseyNumber: '8', position: 'OH' },
          { trackId: 3, courtSide: 'right', label: '林大華', jerseyNumber: '3', position: 'MB' },
        ],
        fps: { num: 60, den: 1 },
      },
    })

    const startBall = wrapper.findAll('.flight-ball circle').at(-1)!
    expect(Number(startBall.attributes('cx'))).toBeCloseTo(24)
    expect(Number(startBall.attributes('cy'))).toBeCloseTo(212)
    expect(wrapper.text()).toContain('#8')
    expect(wrapper.find('marker').exists()).toBe(false)

    await wrapper.setProps({ activeFrame: 420 })

    const nextBall = wrapper.findAll('.flight-ball circle').at(-1)!
    expect(Number(nextBall.attributes('cx'))).toBeGreaterThanOrEqual(64)
    expect(wrapper.text()).toContain('2 / 2')
  })

  it('keeps non-hitters translucent and only reveals every nameplate in all-label mode', async () => {
    const wrapper = mount(CourtPathView, {
      props: {
        paths,
        events,
        activeFrame: 301,
        chunk,
        tracks: [
          { trackId: 8, courtSide: 'left', label: '王小明', jerseyNumber: '8', position: 'OH' },
          { trackId: 12, courtSide: 'right', label: null },
        ],
        playerLabelMode: 'hitters',
      },
    })

    expect(wrapper.findAll('.court-player')).toHaveLength(2)
    expect(wrapper.findAll('.court-player.hitter')).toHaveLength(1)
    expect(wrapper.findAll('.court-player.team-tone-blue')).toHaveLength(1)
    expect(wrapper.findAll('.court-player.team-tone-red')).toHaveLength(1)
    expect(wrapper.findAll('.court-nameplate')).toHaveLength(0)
    expect(wrapper.findAll('.court-endpoint-label')).toHaveLength(1)
    expect(wrapper.text()).toContain('#8')
    expect(wrapper.text()).not.toContain('#3')
    expect(wrapper.text()).not.toContain('ID 12')

    await wrapper.setProps({ playerLabelMode: 'all' })
    expect(wrapper.text()).toContain('T012')
    expect(wrapper.findAll('.court-endpoint-label')).toHaveLength(2)
  })

  it('keeps an explicit badge for mapped roster entries without a position', () => {
    const wrapper = mount(CourtPathView, {
      props: {
        paths,
        events,
        activeFrame: 301,
        tracks: [{ trackId: 8, label: '王小明', jerseyNumber: '8', position: 'UNSPECIFIED' }],
      },
    })

    expect(wrapper.text()).toContain('#8')
  })
})
