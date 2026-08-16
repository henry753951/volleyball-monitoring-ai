import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AnalysisReviewAction } from '@volleyball-monitoring/contracts'
import { createWorkstationActionManager } from './workstation-action.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'
import { createAnalysisRevisionService } from './analysis-revision.service'

function setup() {
  const runId = ref<string | null>('run-1')
  const overlayActive = ref(true)
  const currentFrame = ref(120)
  const dirtyCount = ref(0)
  const pending = ref(false)
  const status = ref<'editing' | 'ready' | 'approved'>('editing')
  const dependenciesPending = ref(false)
  const hasBallOverride = ref(false)
  const hasBBoxOverride = ref(false)
  const hasActorOverride = ref(false)
  const hasActionOverride = ref(false)
  const hits = ref([
    { keyPointId: 'hit-1', frameIndex: 100, anchorSource: 'ai' as const },
    { keyPointId: 'hit-2', frameIndex: 120, anchorSource: 'ai' as const },
    { keyPointId: 'hit-3', frameIndex: 140, anchorSource: 'human' as const },
  ])
  const review = {
    dirtyCount,
    pending,
    status,
    contactEdits: ref(new Map()),
    setBallPosition: vi.fn(),
    markBallMissing: vi.fn(),
    clearBallOverride: vi.fn(),
    setPlayerBBox: vi.fn(),
    clearPlayerBBoxOverride: vi.fn(),
    setAction: vi.fn<(frameIndex: number, trackId: number, action: AnalysisReviewAction) => void>(),
    clearActionOverride: vi.fn(),
    setContactActor: vi.fn(),
    clearContactActorOverride: vi.fn(),
    setContactTime: vi.fn(),
    clearContactTimeOverride: vi.fn(),
    addContact: vi.fn(() => 'manual-hit'),
    deleteContact: vi.fn(),
    restoreContact: vi.fn(),
    applyChanges: vi.fn(async () => undefined),
    discardChanges: vi.fn(async () => undefined),
    recalculate: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
  }
  const feedback = createWorkstationFeedbackService()
  const notifications: Array<{ title: string; description?: string }> = []
  feedback.subscribe(message => notifications.push(message))
  const manager = createWorkstationActionManager({ feedback })
  const refreshCoach = vi.fn(async () => undefined)
  const refreshOverlay = vi.fn(async () => undefined)
  const seekFrame = vi.fn()
  const service = createAnalysisRevisionService({
    manager,
    review,
    feedback,
    selectedAnalysisRunId: () => runId.value,
    overlayActive: () => overlayActive.value,
    currentFrame,
    hits: () => hits.value,
    resolveHitFrame: keyPointId =>
      hits.value.find(hit => hit.keyPointId === keyPointId)?.frameIndex ?? null,
    seekFrame,
    refreshCoach,
    refreshOverlay,
    dependenciesPending: () => dependenciesPending.value,
    hasBallOverride: () => hasBallOverride.value,
    hasBBoxOverride: () => hasBBoxOverride.value,
    hasActorOverride: () => hasActorOverride.value,
    hasActionOverride: () => hasActionOverride.value,
  })
  return {
    service,
    manager,
    review,
    notifications,
    runId,
    overlayActive,
    dirtyCount,
    status,
    dependenciesPending,
    hasBallOverride,
    hasBBoxOverride,
    hasActorOverride,
    hasActionOverride,
    refreshCoach,
    refreshOverlay,
    seekFrame,
  }
}

describe('createAnalysisRevisionService', () => {
  it('keeps entry availability and user feedback in the shared action manager', async () => {
    const context = setup()
    context.runId.value = null

    const result = await context.manager.execute('analysis.enter-revision')

    expect(result.status).toBe('blocked')
    expect(context.service.revisionMode.value).toBe(false)
    expect(context.notifications.at(-1)?.description).toContain('請先選取')
  })

  it('preserves hit order when changing an AI contact time', () => {
    const context = setup()
    context.service.enter()

    context.service.adjustHitTime('hit-2', -21)
    expect(context.review.setContactTime).not.toHaveBeenCalled()
    expect(context.notifications.at(-1)?.title).toContain('前後事件之間')

    context.service.adjustHitTime('hit-2', 1)
    expect(context.review.setContactTime).toHaveBeenCalledWith('hit-2', 121)
    expect(context.seekFrame).toHaveBeenCalledWith(121)
  })

  it('centralizes dirty, dependency and approval locks', () => {
    const context = setup()
    context.service.enter()

    expect(context.manager.state('analysis.apply').value.enabled).toBe(false)
    context.dirtyCount.value = 1
    expect(context.manager.state('analysis.apply').value.enabled).toBe(true)
    expect(context.manager.state('analysis.recalculate').value.enabled).toBe(false)
    context.dirtyCount.value = 0
    context.dependenciesPending.value = true
    expect(context.manager.state('analysis.recalculate').value.reason).toContain('正在更新')
    context.dependenciesPending.value = false
    expect(context.manager.state('analysis.approve').value.enabled).toBe(false)
    context.status.value = 'ready'
    expect(context.manager.state('analysis.approve').value.enabled).toBe(true)
  })

  it('applies staged changes and refreshes derived views without rerunning model work', async () => {
    const context = setup()
    context.service.enter()
    context.dirtyCount.value = 1

    const result = await context.manager.execute('analysis.apply')

    expect(result.status).toBe('executed')
    expect(context.review.applyChanges).toHaveBeenCalledOnce()
    expect(context.refreshCoach).toHaveBeenCalledOnce()
    expect(context.refreshOverlay).toHaveBeenCalledOnce()
    expect(context.notifications.at(-1)?.description).toContain('既有逐幀分析')
  })

  it('uses the same contextual availability for toolbox actions', () => {
    const context = setup()
    context.service.enter()
    context.service.panelPage.value = 'ball'

    expect(context.manager.state('analysis.clear-ball-override').value.enabled).toBe(false)
    context.hasBallOverride.value = true
    expect(context.manager.state('analysis.clear-ball-override').value.enabled).toBe(true)

    context.service.panelPage.value = 'players'
    context.service.selectTrack(8, 'standing')
    expect(context.manager.state('analysis.clear-bbox-override').value.enabled).toBe(false)
    context.hasBBoxOverride.value = true
    expect(context.manager.state('analysis.clear-bbox-override').value.enabled).toBe(true)
  })
})
