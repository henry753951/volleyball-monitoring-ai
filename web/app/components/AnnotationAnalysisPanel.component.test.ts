import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import type { WorkstationActionId } from '~/services/annotation-workstation/workstation-action.service'
import AnnotationAnalysisPanel from './AnnotationAnalysisPanel.vue'

const hits = [
  {
    keyPointId: 'hit-1',
    sequenceIndex: 0,
    frameIndex: 189,
    actorTrackId: 5,
    actorLabel: 'Track 5',
    actorSource: 'auto' as const,
    ballLabel: 'AI 球點',
    anchorSource: 'ai' as const,
    anchorConfidence: 0.86,
    timeAdjusted: false,
  },
  {
    keyPointId: 'hit-2',
    sequenceIndex: 1,
    frameIndex: 249,
    actorTrackId: null,
    actorLabel: '沒人打',
    actorSource: 'none' as const,
    ballLabel: '人工球點',
    anchorSource: 'human' as const,
    anchorConfidence: null,
    timeAdjusted: false,
  },
]

const baseProps = {
  frameIndex: 179,
  ballOverride: null,
  ballPosition: null,
  selectedTrackAction: null,
  hasActionOverride: false,
  hasBboxOverride: false,
  hits,
  removedHits: [],
}

function mountPanel(
  options: {
    page?: 'root' | 'hits' | 'ball' | 'players'
    revisionMode?: boolean
    props?: Record<string, unknown>
  } = {},
) {
  const page = ref(options.page ?? 'root')
  const revisionMode = ref(options.revisionMode ?? true)
  const selectedTrackId = ref<number | null>(null)
  const selectedHitId = ref<string | null>('hit-1')
  const execute = vi.fn().mockResolvedValue({ status: 'executed', value: undefined })
  const service = {
    analysis: {
      revision: {
        panelPage: page,
        analysisRunId: ref('analysis-1'),
        selectedTrackId,
        selectedHitId,
        revisionMode,
        dependenciesPending: ref(false),
      },
      review: {
        pending: ref(false),
        connection: ref('ready'),
        dirtyCount: ref(0),
        status: ref('editing'),
      },
    },
    actions: {
      execute,
      state: (id: WorkstationActionId) =>
        computed(() => ({
          id,
          group: 'analysis',
          label: id,
          shortcut: null,
          visible: true,
          enabled: true,
          pending: false,
          reason: null,
        })),
    },
  }
  const wrapper = mount(AnnotationAnalysisPanel, {
    props: { ...baseProps, ...options.props },
    global: { provide: { [annotationWorkstationServiceKey as symbol]: service } },
  })
  return { wrapper, execute, page, revisionMode }
}

describe('AnnotationAnalysisPanel', () => {
  it('uses a root menu to enter a focused editing page', async () => {
    const { wrapper, page } = mountPanel()

    await wrapper.get('button.analysis-menu__item').trigger('click')

    expect(page.value).toBe('hits')
  })

  it('keeps the hit page list-only and delegates edits to the player toolbox', async () => {
    const { wrapper, execute } = mountPanel({ page: 'hits' })

    expect(wrapper.find('.hit-actions').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('點畫面指派')
    expect(wrapper.text()).not.toContain('恢復自動')

    await wrapper.findAll('.hit-main')[1]!.trigger('click')
    expect(execute).toHaveBeenCalledWith('analysis.select-contact', 'hit-2')
  })

  it('offers frame-safe nudging for an AI-detected hit', async () => {
    const { wrapper, execute } = mountPanel({ page: 'hits' })

    expect(wrapper.text()).toContain('AI 擊球建議 86%')
    await wrapper.get('button[title="往後一格"]').trigger('click')
    expect(execute).toHaveBeenCalledWith('analysis.adjust-contact-time', {
      keyPointId: 'hit-1',
      deltaFrames: 1,
    })
  })

  it('restores a removed hit from the staged review', async () => {
    const { wrapper, execute } = mountPanel({
      page: 'hits',
      props: {
        removedHits: [{ keyPointId: 'hit-3', frameIndex: 320, label: 'AI 擊球建議' }],
      },
    })

    expect(wrapper.text()).toContain('已移除')
    await wrapper.get('.removed-hits button').trigger('click')
    expect(execute).toHaveBeenCalledWith('analysis.restore-contact', 'hit-3')
  })

  it('shows state only on the ball page without duplicating editing buttons', () => {
    const { wrapper } = mountPanel({
      page: 'ball',
      props: {
        ballOverride: 'position',
        ballPosition: { x: 640, y: 360 },
      },
    })

    expect(wrapper.text()).toContain('人工位置')
    expect(wrapper.text()).toContain('X 640.0 · Y 360.0')
    expect(wrapper.find('button[aria-label="返回分析功能"]').exists()).toBe(true)
    expect(wrapper.findAll('button')).toHaveLength(6)
  })

  it('keeps analyzed clips read-only until revision mode is entered', async () => {
    const { wrapper, execute } = mountPanel({ page: 'hits', revisionMode: false })

    expect(wrapper.text()).toContain('唯讀')
    expect(wrapper.find('.add-hit').exists()).toBe(false)
    expect(wrapper.find('.hit-time-editor').exists()).toBe(false)
    expect(wrapper.find('.delete-hit').exists()).toBe(false)

    await wrapper.get('.enter-revision').trigger('click')
    expect(execute).toHaveBeenCalledWith('analysis.enter-revision', undefined)
  })
})
