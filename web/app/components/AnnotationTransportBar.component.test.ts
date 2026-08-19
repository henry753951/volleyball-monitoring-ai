import { computed } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import type { WorkstationActionId } from '~/services/annotation-workstation/workstation-action.service'
import AnnotationTransportBar from './AnnotationTransportBar.vue'

vi.mock('motion-v', async () => {
  const { defineComponent, h } = await import('vue')
  const passthrough = (name: string) =>
    defineComponent({
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
  muted: false,
  timelineScale: 0.1,
  cursorAvailable: true,
  shortcuts: {
    play: 'Space',
    previousFrame: 'ArrowLeft',
    nextFrame: 'ArrowRight',
    previousPoint: 'Shift+ArrowLeft',
    nextPoint: 'Shift+ArrowRight',
    previousSegment: 'Shift+A',
    nextSegment: 'Shift+D',
  },
}

function mountBar(
  options: {
    props?: Record<string, unknown>
    disabled?: Partial<Record<WorkstationActionId, string>>
    pending?: WorkstationActionId[]
  } = {},
) {
  const execute = vi.fn().mockResolvedValue({ status: 'executed', value: undefined })
  const pending = new Set(options.pending ?? [])
  const service = {
    actions: {
      execute,
      state: (id: WorkstationActionId) =>
        computed(() => ({
          id,
          group: 'media',
          label: id,
          shortcut: null,
          visible: true,
          enabled: !options.disabled?.[id] && !pending.has(id),
          pending: pending.has(id),
          reason: options.disabled?.[id] ?? null,
        })),
    },
  }
  const wrapper = mount(AnnotationTransportBar, {
    props: { ...baseProps, ...options.props },
    global: { provide: { [annotationWorkstationServiceKey as symbol]: service } },
  })
  return { wrapper, execute }
}

describe('AnnotationTransportBar', () => {
  it('reveals clip actions only after a clip is selected', async () => {
    const { wrapper, execute } = mountBar()
    expect(wrapper.find('[aria-label="片段工具"]').exists()).toBe(false)
    await wrapper.setProps({ clipSelected: true })
    await wrapper.find('[aria-label="刪除片段內容"]').trigger('click')
    expect(execute).toHaveBeenCalledWith('segment.delete-processing')
  })

  it('keeps key-point deletion separate from clip deletion', async () => {
    const { wrapper, execute } = mountBar()
    await wrapper.find('[aria-label="刪除所選擊球點"]').trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.delete')
    expect(execute).not.toHaveBeenCalledWith('segment.delete-processing')
  })

  it('puts physical previous and next segment buttons in the context status bar', async () => {
    const { wrapper, execute } = mountBar()

    await wrapper.get('[aria-label="上一個片段"]').trigger('click')
    await wrapper.get('[aria-label="下一個片段"]').trigger('click')

    expect(execute).toHaveBeenNthCalledWith(1, 'media.segment-previous')
    expect(execute).toHaveBeenNthCalledWith(2, 'media.segment-next')
    expect(wrapper.get('[aria-label="片段導覽"]').element.parentElement?.className).toContain(
      'transport-context',
    )
  })

  it('keeps correction cancellation available for the selected correction', async () => {
    const { wrapper, execute } = mountBar({
      props: { clipSelected: true, correctionActive: true },
    })
    await wrapper.get('[aria-label="取消修正片段"]').trigger('click')
    expect(execute).toHaveBeenCalledWith('correction.cancel')
  })

  it('provides a physical submit action for every selected draft', async () => {
    const { wrapper, execute } = mountBar({
      props: { clipSelected: true, draftSelected: true, submittedSelected: false },
    })
    await wrapper.get('[aria-label="送出片段"]').trigger('click')
    expect(execute).toHaveBeenCalledWith('submission.submit')
  })

  it('shows an explicit loading state while a correction draft is being created', () => {
    const { wrapper } = mountBar({
      props: { clipSelected: true },
      pending: ['correction.create'],
    })
    expect(wrapper.get('[aria-label="正在建立修正版草稿"]').text()).toContain('建立修正版中')
    expect(wrapper.find('[aria-label="建立修正版草稿"]').exists()).toBe(false)
  })

  it('shows a durable waiting state while submit awaits acknowledgement', () => {
    const { wrapper } = mountBar({
      props: {
        clipSelected: true,
        draftSelected: true,
        submittedSelected: true,
        submissionPending: true,
      },
    })
    expect(wrapper.get('[aria-label="等待伺服器確認送出"]').text()).toContain('等待確認')
    expect(wrapper.find('[aria-label="送出片段"]').exists()).toBe(false)
  })

  it('uses the action manager for timeline zoom and playback speed', async () => {
    const { wrapper, execute } = mountBar({ props: { timelineScale: 0.01, playbackRate: 1.25 } })
    const scale = wrapper.get('[aria-label^="時間軸倍率"]')
    expect(scale.text()).toBe('0.01×')
    await scale.trigger('click')
    await wrapper.get('[aria-label="播放速度"]').trigger('click')
    await wrapper.get('[role="menuitemradio"][aria-checked="false"]').trigger('click')
    expect(execute).toHaveBeenCalledWith('timeline.reset-zoom')
    expect(execute).toHaveBeenCalledWith('media.set-rate', 0.5)
  })

  it('renders the action-manager reason for disabled downloads', async () => {
    const { wrapper } = mountBar({
      props: { clipSelected: true },
      disabled: { 'clip.download': '片段尚未完成剪切' },
    })
    expect(wrapper.get('[aria-label="下載片段"]').attributes('disabled')).toBeDefined()
  })

  it('emits a cursor-focus request when the PTS indicator is clicked', async () => {
    const { wrapper } = mountBar()
    await wrapper.get('[aria-label="回到目前 PTS 游標並置中時間軸"]').trigger('click')
    expect(wrapper.emitted('focus-cursor')).toHaveLength(1)
  })
})
