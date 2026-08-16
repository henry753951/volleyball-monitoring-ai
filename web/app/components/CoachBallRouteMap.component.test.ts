import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CoachBallRouteMap from './CoachBallRouteMap.vue'
import type { CoachPlayerActionEvent } from '~/utils/coachPlayerActions'

const events: CoachPlayerActionEvent[] = [
  {
    id: 'route-1',
    rallyId: 'rally-1',
    setNumber: 1,
    rallyOrdinal: 3,
    analysisRunId: 'run-1',
    trackId: 8,
    anchorTimeUs: '8400000',
    actionKey: 'spike',
    actionLabel: '殺球',
    actionConfidence: null,
    resultKey: 'point_scored',
    routeStart: { x: -0.06, y: 0.24 },
    routeEnd: { x: 1.04, y: 0.79 },
    outcome: 'won',
  },
]

describe('CoachBallRouteMap', () => {
  it('renders a directional route with distinct start and landing endpoints', () => {
    const wrapper = mount(CoachBallRouteMap, { props: { events, label: '殺球' } })

    expect(wrapper.findAll('.route-line')).toHaveLength(1)
    expect(wrapper.find('.route-line path').attributes('d')).toContain('Q')
    expect(Number(wrapper.find('.route-start').attributes('cx'))).toBeCloseTo(-10.8)
    expect(Number(wrapper.find('.route-end').attributes('cx'))).toBeCloseTo(187.2)
    expect(wrapper.text()).toContain('1 條完整球路 · 1 個落點')
  })

  it('switches to a landing heatmap without clamping out-of-court coordinates', async () => {
    const wrapper = mount(CoachBallRouteMap, { props: { events, label: '全部球種' } })

    await wrapper.get('button:nth-of-type(2)').trigger('click')

    expect(wrapper.findAll('.landing-heat')).toHaveLength(1)
    expect(Number(wrapper.find('.landing-point').attributes('cx'))).toBeGreaterThan(180)
    expect(wrapper.find('.route-map__canvas').attributes('data-mode')).toBe('landings')
  })
})
