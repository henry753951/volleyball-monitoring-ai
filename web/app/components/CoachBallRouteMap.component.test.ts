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
    resultKey: 'success',
    routeStart: { x: -0.06, y: 0.24 },
    routeEnd: { x: 1.04, y: 0.79 },
    courtSide: 'left',
    outcome: 'won',
  },
]

describe('CoachBallRouteMap', () => {
  it('renders a directional route with distinct start and landing endpoints', () => {
    const wrapper = mount(CoachBallRouteMap, { props: { events, label: '殺球' } })

    expect(wrapper.findAll('.route-line')).toHaveLength(1)
    expect(wrapper.findAll('.route-path-base')).toHaveLength(0)
    expect(wrapper.find('.route-path-flow').attributes('marker-end')).toMatch(
      /^url\(#.+-route-arrow\)$/,
    )
    expect(Number(wrapper.find('.route-start').attributes('cx'))).toBeCloseTo(-10.8)
    expect(Number(wrapper.find('.route-end').attributes('cx'))).toBeCloseTo(187.2)
    expect(wrapper.text()).toContain('1 條完整球路 · 1 個落點')
  })

  it('labels the selected subject side separately from the opposing team side', () => {
    const wrapper = mount(CoachBallRouteMap, {
      props: {
        events,
        label: '殺球',
        sideLabels: {
          left: { teamShortName: 'IRI', scope: null },
          right: { teamShortName: 'PAK', scope: 'player' },
        },
      },
    })

    expect(wrapper.findAll('.court-side-name')).toHaveLength(2)
    expect(wrapper.text()).toContain('IRI')
    expect(wrapper.text()).toContain('PAK')
    expect(wrapper.findAll('.court-side-scope')).toHaveLength(1)
    expect(wrapper.text()).toContain('[選手方]')
    expect(wrapper.text()).not.toContain('[隊伍方]')
  })

  it('opens the short replay from the route without navigating away', async () => {
    const wrapper = mount(CoachBallRouteMap, { props: { events, label: '殺球' } })

    await wrapper.get('.route-path-flow').trigger('click')

    expect(wrapper.emitted('select')).toEqual([[events[0]]])
    expect(wrapper.get('.route-hit-target').attributes('role')).toBe('button')
    expect(wrapper.get('.route-hit-target').attributes('aria-label')).toContain('開啟短回放')
  })

  it('switches to a landing heatmap without clamping out-of-court coordinates', async () => {
    const wrapper = mount(CoachBallRouteMap, { props: { events, label: '全部球種' } })

    await wrapper.get('button:nth-of-type(2)').trigger('click')

    expect(wrapper.findAll('.landing-heat')).toHaveLength(1)
    expect(Number(wrapper.find('.landing-point').attributes('cx'))).toBeGreaterThan(180)
    expect(wrapper.find('.route-map__canvas').attributes('data-mode')).toBe('landings')
  })

  it('mirrors route and landing coordinates per event side', async () => {
    const wrapper = mount(CoachBallRouteMap, {
      props: {
        events: events.map(event => ({ ...event, courtSide: 'right' as const })),
        label: '殺球',
        selectedSide: 'left',
      },
    })

    expect(Number(wrapper.find('.route-start').attributes('cx'))).toBeCloseTo(190.8)
    expect(Number(wrapper.find('.route-end').attributes('cx'))).toBeCloseTo(-7.2)

    await wrapper.get('button:nth-of-type(2)').trigger('click')

    expect(Number(wrapper.find('.landing-point').attributes('cx'))).toBeCloseTo(-7.2)
  })
})
