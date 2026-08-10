import { OVERLAY_PLAYER_FLAG, type BrowserOverlayChunk } from '@volleyball-monitoring/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CourtPathView from './CourtPathView.vue'
import type { ReplayPath } from '~/lib/coachDomain'

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
    start_court_positions: [{ track_id: 8, basis: 'player_footprint_proxy', court_pos: { x: -.06, y: .24 }, confidence: null }],
    end_court_positions: [{ track_id: 3, basis: 'player_footprint_proxy', court_pos: { x: .72, y: .64 }, confidence: null }],
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
    start_court_positions: [{ track_id: 3, basis: 'player_footprint_proxy', court_pos: { x: .72, y: .64 }, confidence: null }],
    end_court_positions: [{ track_id: null, basis: 'terminal_projection', court_pos: { x: 1.04, y: .79 }, confidence: null }],
  },
]

const chunk: BrowserOverlayChunk = {
  schemaVersion: 1,
  analysisId: 'analysis',
  overlayVersion: '1',
  chunkIndex: 0,
  startFrameIndex: 301n,
  frameCount: 1,
  frameOffsets: [0, 2],
  trackIds: [8, 12],
  frameBboxes: [{ x1: 0, y1: 0, x2: 0, y2: 0 }, { x1: 0, y1: 0, x2: 0, y2: 0 }],
  frameFootPositions: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
  courtPositions: [{ x: -.06, y: .24 }, { x: .4, y: .8 }],
  playerFlags: [OVERLAY_PLAYER_FLAG.courtPosition, OVERLAY_PLAYER_FLAG.courtPosition],
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
  it('moves the simulated ball from A to B using the active frame and switches on the next segment', async () => {
    const wrapper = mount(CourtPathView, {
      props: {
        paths,
        activeFrame: 301,
        playing: true,
        tracks: [{ trackId: 8, label: '王小明' }, { trackId: 3, label: null }],
        fps: { num: 60, den: 1 },
      },
    })

    const startBall = wrapper.findAll('.flight-ball circle').at(-1)!
    expect(Number(startBall.attributes('cx'))).toBeCloseTo(24)
    expect(Number(startBall.attributes('cy'))).toBeCloseTo(212)
    expect(wrapper.text()).toContain('王小明')
    expect(wrapper.text()).toContain('ID 3')
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
        activeFrame: 301,
        chunk,
        tracks: [{ trackId: 8, label: '王小明' }, { trackId: 12, label: null }],
        playerLabelMode: 'hitters',
      },
    })

    expect(wrapper.findAll('.court-player')).toHaveLength(2)
    expect(wrapper.findAll('.court-player.hitter')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('ID 12')

    await wrapper.setProps({ playerLabelMode: 'all' })
    expect(wrapper.text()).toContain('ID 12')
  })
})
