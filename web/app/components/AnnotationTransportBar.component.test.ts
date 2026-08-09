import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnnotationTransportBar from './AnnotationTransportBar.vue'

const baseProps = {
  playing: false,
  playerReady: true,
  frameReady: true,
  frameMovePending: false,
  timecode: '00:00:01:00',
  liveActive: false,
  liveAvailable: false,
  contextTitle: '第 1 局 · 回合 1',
  contextHits: 2,
  contextDuration: '3000000',
  contextState: '分析完成',
  correctionActive: false,
  submittedSelected: true,
  navigable: true,
  selectedPoint: true,
  editable: true,
  editReady: true,
  deleteEnabled: true,
  muted: false,
  timelineScale: 0.1,
  shortcuts: {
    play: 'Space',
    previousFrame: 'ArrowLeft',
    nextFrame: 'ArrowRight',
    previousPoint: 'A',
    nextPoint: 'D',
  },
}

describe('AnnotationTransportBar', () => {
  it('keeps correction cancellation available when ordinary editing is blocked', async () => {
    const wrapper = mount(AnnotationTransportBar, {
      props: { ...baseProps, correctionActive: true, editReady: false },
    })
    const cancel = wrapper.get('[aria-label="取消修正片段"]')
    expect(cancel.attributes('disabled')).toBeUndefined()
    await cancel.trigger('click')
    expect(wrapper.emitted('cancelCorrection')).toHaveLength(1)
  })

  it('shows a stable timeline scale beside mute and resets it on click', async () => {
    const wrapper = mount(AnnotationTransportBar, {
      props: { ...baseProps, timelineScale: 0.01 },
    })
    const scale = wrapper.get('[aria-label^="時間軸倍率"]')
    expect(scale.text()).toBe('0.01×')
    await scale.trigger('click')
    expect(wrapper.emitted('resetTimelineZoom')).toHaveLength(1)
  })
})
