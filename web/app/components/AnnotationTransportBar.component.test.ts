import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AnnotationTransportBar from './AnnotationTransportBar.vue'

vi.mock('motion-v', async () => {
  const { defineComponent, h } = await import('vue')
  const passthrough = (name: string) => defineComponent({
    name,
    inheritAttrs: true,
    setup(_, { attrs, slots }) {
      return () => h('div', attrs, slots.default?.())
    },
  })
  return { AnimatePresence: passthrough('AnimatePresence'), Motion: passthrough('Motion') }
})

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
  clipSelected: false,
  draftSelected: false,
  submitEnabled: false,
  navigable: true,
  selectedPoint: true,
  editable: true,
  editReady: true,
  pointDeleteEnabled: true,
  muted: false,
  timelineScale: 0.1,
  shortcuts: {
    play: 'Space',
    previousFrame: 'ArrowLeft',
    nextFrame: 'ArrowRight',
    previousPoint: 'Shift+ArrowLeft',
    nextPoint: 'Shift+ArrowRight',
  },
}

describe('AnnotationTransportBar', () => {
  it('reveals clip actions only after a clip is selected', async () => {
    const wrapper = mount(AnnotationTransportBar, { props: baseProps })

    expect(wrapper.find('[aria-label="片段工具"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="刪除所選片段"]').exists()).toBe(false)

    await wrapper.setProps({ clipSelected: true })

    expect(wrapper.find('[aria-label="片段工具"]').exists()).toBe(true)
    await wrapper.find('[aria-label="刪除所選片段"]').trigger('click')
    expect(wrapper.emitted('deleteClip')).toHaveLength(1)
  })

  it('keeps key-point deletion separate from clip deletion', async () => {
    const wrapper = mount(AnnotationTransportBar, { props: baseProps })

    await wrapper.find('[aria-label="刪除所選擊球點"]').trigger('click')

    expect(wrapper.emitted('deletePoint')).toHaveLength(1)
    expect(wrapper.emitted('deleteClip')).toBeUndefined()
  })

  it('keeps correction cancellation available for the selected correction when editing is blocked', async () => {
    const wrapper = mount(AnnotationTransportBar, { props: { ...baseProps, clipSelected: true, correctionActive: true, editReady: false } })
    const cancel = wrapper.get('[aria-label="取消修正片段"]')
    expect(cancel.attributes('disabled')).toBeUndefined()
    await cancel.trigger('click')
    expect(wrapper.emitted('cancelCorrection')).toHaveLength(1)
  })

  it('keeps deletion available for every selected clip even when annotation editing is blocked', async () => {
    const wrapper = mount(AnnotationTransportBar, { props: { ...baseProps, clipSelected: true, editReady: false } })
    const remove = wrapper.get('[aria-label="刪除所選片段"]')
    expect(remove.attributes('disabled')).toBeUndefined()
    await remove.trigger('click')
    expect(wrapper.emitted('deleteClip')).toHaveLength(1)
  })

  it('hides correction actions when its clip is not selected', () => {
    const wrapper = mount(AnnotationTransportBar, { props: { ...baseProps, correctionActive: true } })
    expect(wrapper.find('[aria-label="片段工具"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="取消修正片段"]').exists()).toBe(false)
  })

  it('provides a physical submit action for every selected draft', async () => {
    const wrapper = mount(AnnotationTransportBar, { props: { ...baseProps, clipSelected: true, draftSelected: true, submitEnabled: true, submittedSelected: false } })
    await wrapper.get('[aria-label="送出片段"]').trigger('click')
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('places submit before and apart from destructive correction actions', () => {
    const wrapper = mount(AnnotationTransportBar, { props: {
      ...baseProps,
      clipSelected: true,
      correctionActive: true,
      draftSelected: true,
      submitEnabled: true,
      submittedSelected: false,
    } })
    const labels = wrapper.get('[aria-label="片段工具"]').findAll('button').map(button => button.attributes('aria-label'))

    expect(labels).toEqual(['送出片段', '取消修正片段', '下載片段', '刪除所選片段'])
    expect(wrapper.find('.action-separator').exists()).toBe(true)
  })

  it('uses correction-draft language without implementation terminology', () => {
    const wrapper = mount(AnnotationTransportBar, { props: { ...baseProps, clipSelected: true } })
    expect(wrapper.get('[aria-label="建立修正版草稿"]').text()).toContain('建立修正版草稿')
    expect(wrapper.text()).not.toContain('immutable')
  })

  it('shows a stable timeline scale beside mute and resets it on click', async () => {
    const wrapper = mount(AnnotationTransportBar, { props: { ...baseProps, timelineScale: 0.01 } })
    const scale = wrapper.get('[aria-label^="時間軸倍率"]')
    expect(scale.text()).toBe('0.01×')
    await scale.trigger('click')
    expect(wrapper.emitted('resetTimelineZoom')).toHaveLength(1)
  })
})
