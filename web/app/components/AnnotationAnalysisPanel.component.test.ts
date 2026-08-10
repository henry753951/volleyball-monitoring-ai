import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnnotationAnalysisPanel from './AnnotationAnalysisPanel.vue'

const hits = [
  { keyPointId: 'hit-1', sequenceIndex: 0, frameIndex: 189, actorTrackId: 5, actorLabel: 'Track 5', actorSource: 'auto' as const, ballLabel: 'AI 球點' },
  { keyPointId: 'hit-2', sequenceIndex: 1, frameIndex: 249, actorTrackId: null, actorLabel: '沒人打', actorSource: 'none' as const, ballLabel: '人工球點' },
]

const baseProps = {
  analysisRunId: 'analysis-1',
  page: 'root' as const,
  frameIndex: 179,
  ballOverride: null,
  ballPosition: null,
  selectedTrackId: null,
  selectedTrackAction: null,
  selectedHitId: 'hit-1',
  hasActionOverride: false,
  hasBboxOverride: false,
  hits,
  saving: false,
  connection: 'ready' as const,
}

describe('AnnotationAnalysisPanel', () => {
  it('uses a root menu to enter a focused editing page', async () => {
    const wrapper = mount(AnnotationAnalysisPanel, { props: baseProps })

    await wrapper.get('button.analysis-menu__item').trigger('click')

    expect(wrapper.emitted('update:page')).toEqual([['hits']])
  })

  it('keeps the hit page list-only and delegates edits to the player toolbox', async () => {
    const wrapper = mount(AnnotationAnalysisPanel, { props: { ...baseProps, page: 'hits' } })

    expect(wrapper.find('.hit-actions').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('點畫面指派')
    expect(wrapper.text()).not.toContain('恢復自動')

    await wrapper.findAll('.hit-main')[1]!.trigger('click')
    expect(wrapper.emitted('selectHit')).toEqual([['hit-2']])
  })

  it('shows state only on the ball page without duplicating editing buttons', () => {
    const wrapper = mount(AnnotationAnalysisPanel, { props: { ...baseProps, page: 'ball', ballOverride: 'position', ballPosition: { x: 640, y: 360 } } })

    expect(wrapper.text()).toContain('人工位置')
    expect(wrapper.text()).toContain('X 640.0 · Y 360.0')
    expect(wrapper.find('button[aria-label="返回分析功能"]').exists()).toBe(true)
    expect(wrapper.findAll('button')).toHaveLength(1)
  })
})
