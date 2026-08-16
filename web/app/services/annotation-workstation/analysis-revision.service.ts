import type {
  AnalysisFrameBBox,
  AnalysisReviewAction,
  AnalysisReviewState,
} from '@volleyball-monitoring/contracts'
import { computed, readonly, ref, watch, type Ref } from 'vue'
import type { WorkstationActionManager } from './workstation-action.service'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

export interface AnalysisRevisionHit {
  keyPointId: string
  frameIndex: number
  anchorSource: 'human' | 'ai' | 'manual'
}

export interface AnalysisReviewPort {
  dirtyCount: { readonly value: number }
  pending: { readonly value: boolean }
  status: { readonly value: 'editing' | 'ready' | 'approved' }
  contactEdits: {
    readonly value: ReadonlyMap<string, AnalysisReviewState['contact_edits'][number]>
  }
  setBallPosition: (frameIndex: number, position: { x: number; y: number }) => void
  markBallMissing: (frameIndex: number) => void
  clearBallOverride: (frameIndex: number) => void
  setPlayerBBox: (frameIndex: number, trackId: number, bbox: AnalysisFrameBBox) => void
  clearPlayerBBoxOverride: (frameIndex: number, trackId: number) => void
  setAction: (frameIndex: number, trackId: number, action: AnalysisReviewAction) => void
  clearActionOverride: (frameIndex: number, trackId: number) => void
  setContactActor: (keyPointId: string, trackId: number | null) => void
  clearContactActorOverride: (keyPointId: string) => void
  setContactTime: (keyPointId: string, frameIndex: number) => void
  clearContactTimeOverride: (keyPointId: string) => void
  addContact: (frameIndex: number, trackId?: number | null) => string
  deleteContact: (contactId: string, frameIndex: number) => void
  restoreContact: (contactId: string) => void
  applyChanges: () => Promise<void>
  discardChanges: () => Promise<void>
  recalculate: () => Promise<void>
  approve: () => Promise<void>
}

export interface AnalysisRevisionServiceOptions {
  manager: WorkstationActionManager
  review: AnalysisReviewPort
  feedback: WorkstationFeedbackService
  selectedAnalysisRunId: () => string | null
  overlayActive: () => boolean
  currentFrame: Ref<number>
  hits: () => readonly AnalysisRevisionHit[]
  resolveHitFrame: (keyPointId: string) => number | null
  seekFrame: (frameIndex: number) => void | Promise<void>
  refreshCoach: () => Promise<unknown>
  refreshOverlay: () => Promise<unknown>
  dependenciesPending: () => boolean
  hasBallOverride: () => boolean
  hasBBoxOverride: () => boolean
  hasActorOverride: () => boolean
  hasActionOverride: () => boolean
}

export function createAnalysisRevisionService(options: AnalysisRevisionServiceOptions) {
  const revisionMode = ref(false)
  const panelPage = ref<'root' | 'hits' | 'ball' | 'players'>('root')
  const ballRelabelEnabled = ref(false)
  const bboxRelabelEnabled = ref(false)
  const actorAssignmentMode = ref(false)
  const selectedTrackId = ref<number | null>(null)
  const selectedTrackAction = ref<string | null>(null)
  const selectedHitId = ref<string | null>(null)
  const analysisRunId = computed(options.selectedAnalysisRunId)
  const overlayActive = computed(options.overlayActive)
  const dependenciesPending = computed(options.dependenciesPending)

  function resetTools() {
    revisionMode.value = false
    panelPage.value = 'root'
    ballRelabelEnabled.value = false
    bboxRelabelEnabled.value = false
    actorAssignmentMode.value = false
    selectedTrackId.value = null
    selectedTrackAction.value = null
    selectedHitId.value = null
  }

  function closePanel() {
    panelPage.value = 'root'
    ballRelabelEnabled.value = false
    bboxRelabelEnabled.value = false
    actorAssignmentMode.value = false
    selectedTrackId.value = null
    selectedTrackAction.value = null
  }

  function closeToolbox() {
    if (bboxRelabelEnabled.value) {
      bboxRelabelEnabled.value = false
      return
    }
    closePanel()
  }

  function reconcileHits() {
    const hits = options.hits()
    if (selectedHitId.value && hits.some(hit => hit.keyPointId === selectedHitId.value)) return
    selectedHitId.value = hits[0]?.keyPointId ?? null
  }

  const stopRunWatch = watch(options.selectedAnalysisRunId, resetTools)
  const stopPageWatch = watch(panelPage, page => {
    ballRelabelEnabled.value = revisionMode.value && page === 'ball'
    actorAssignmentMode.value = revisionMode.value && page === 'hits'
    bboxRelabelEnabled.value = false
    if (page !== 'players') selectedTrackId.value = null
  })
  const stopRevisionWatch = watch(revisionMode, enabled => {
    ballRelabelEnabled.value = enabled && panelPage.value === 'ball'
    actorAssignmentMode.value = enabled && panelPage.value === 'hits'
    if (!enabled) bboxRelabelEnabled.value = false
  })

  function selectTrack(trackId: number, action: string | null) {
    selectedTrackId.value = trackId
    selectedTrackAction.value = action
    if (revisionMode.value && actorAssignmentMode.value && selectedHitId.value) {
      options.review.setContactActor(selectedHitId.value, trackId)
      return true
    }
    return false
  }

  function setBallPosition(position: { x: number; y: number }) {
    if (!revisionMode.value || !options.overlayActive() || !ballRelabelEnabled.value) return
    options.review.setBallPosition(options.currentFrame.value, position)
  }

  function setPlayerBBox(selection: { trackId: number; frameBBox: AnalysisFrameBBox }) {
    if (
      !revisionMode.value ||
      !options.overlayActive() ||
      !bboxRelabelEnabled.value ||
      selectedTrackId.value !== selection.trackId
    )
      return
    options.review.setPlayerBBox(options.currentFrame.value, selection.trackId, selection.frameBBox)
    bboxRelabelEnabled.value = false
  }

  function markBallMissing() {
    if (revisionMode.value && options.overlayActive())
      options.review.markBallMissing(options.currentFrame.value)
  }

  function clearBallOverride() {
    if (revisionMode.value && options.overlayActive())
      options.review.clearBallOverride(options.currentFrame.value)
  }

  function toggleBBoxRelabel() {
    if (!revisionMode.value || !options.overlayActive() || selectedTrackId.value === null) return
    bboxRelabelEnabled.value = !bboxRelabelEnabled.value
    if (bboxRelabelEnabled.value) {
      ballRelabelEnabled.value = false
      actorAssignmentMode.value = false
    }
  }

  function clearBBoxOverride() {
    if (!revisionMode.value || !options.overlayActive() || selectedTrackId.value === null) return
    options.review.clearPlayerBBoxOverride(options.currentFrame.value, selectedTrackId.value)
  }

  function setAction(action: AnalysisReviewAction) {
    if (!revisionMode.value || !options.overlayActive() || selectedTrackId.value === null) return
    selectedTrackAction.value = action
    options.review.setAction(options.currentFrame.value, selectedTrackId.value, action)
  }

  function clearAction() {
    if (!revisionMode.value || !options.overlayActive() || selectedTrackId.value === null) return
    options.review.clearActionOverride(options.currentFrame.value, selectedTrackId.value)
    selectedTrackAction.value = null
  }

  function selectHit(keyPointId: string) {
    const frameIndex = options.resolveHitFrame(keyPointId)
    if (frameIndex === null) return
    selectedHitId.value = keyPointId
    void options.seekFrame(frameIndex)
  }

  function adjustHitTime(keyPointId: string, deltaFrames: number) {
    if (!revisionMode.value) return
    const hits = options.hits()
    const hitIndex = hits.findIndex(hit => hit.keyPointId === keyPointId)
    const hit = hits[hitIndex]
    if (!hit || hit.anchorSource === 'human') return
    const nextFrame = hit.frameIndex + deltaFrames
    const previousFrame = hits[hitIndex - 1]?.frameIndex ?? -1
    const followingFrame = hits[hitIndex + 1]?.frameIndex ?? Number.MAX_SAFE_INTEGER
    if (nextFrame <= previousFrame || nextFrame >= followingFrame || nextFrame < 0) {
      options.feedback.notify({
        level: 'warning',
        title: '擊球點必須維持在前後事件之間',
      })
      return
    }
    options.review.setContactTime(keyPointId, nextFrame)
    selectedHitId.value = keyPointId
    void options.seekFrame(nextFrame)
  }

  function resetHitTime(keyPointId: string) {
    if (!revisionMode.value) return
    options.review.clearContactTimeOverride(keyPointId)
    selectHit(keyPointId)
  }

  function markHitNoActor(keyPointId: string) {
    if (!revisionMode.value) return
    options.review.setContactActor(keyPointId, null)
    selectedHitId.value = keyPointId
  }

  function clearHitActor(keyPointId: string) {
    if (!revisionMode.value) return
    options.review.clearContactActorOverride(keyPointId)
    selectedHitId.value = keyPointId
  }

  function addHit() {
    if (!revisionMode.value || !options.overlayActive()) return null
    const id = options.review.addContact(options.currentFrame.value, selectedTrackId.value)
    selectedHitId.value = id
    panelPage.value = 'hits'
    return id
  }

  function deleteHit(keyPointId: string) {
    if (!revisionMode.value) return
    const hit = options.hits().find(candidate => candidate.keyPointId === keyPointId)
    if (!hit) return
    options.review.deleteContact(keyPointId, hit.frameIndex)
    selectedHitId.value = null
  }

  function restoreHit(keyPointId: string) {
    if (!revisionMode.value) return
    options.review.restoreContact(keyPointId)
    selectedHitId.value = keyPointId
  }

  async function applyChanges() {
    if (!revisionMode.value) return
    try {
      await options.review.applyChanges()
      await Promise.all([options.refreshCoach(), options.refreshOverlay()])
      options.feedback.notify({
        level: 'success',
        title: '修改已同步',
        description: '已沿用既有逐幀分析；只有受影響的擊球關聯會在背景更新。',
      })
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: '修改套用失敗',
        description: cause instanceof Error ? cause.message : undefined,
      })
    }
  }

  async function discardChanges() {
    if (!revisionMode.value) return
    try {
      await options.review.discardChanges()
      options.feedback.notify({ level: 'info', title: '已捨棄尚未套用的修改' })
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: '無法還原修改',
        description: cause instanceof Error ? cause.message : undefined,
      })
    }
  }

  async function recalculate() {
    if (!revisionMode.value) return
    try {
      await options.review.recalculate()
      await Promise.all([options.refreshCoach(), options.refreshOverlay()])
      revisionMode.value = false
      options.feedback.notify({
        level: 'success',
        title: '修訂結果已重建',
        description: '使用既有追蹤、pose 與球路證據，沒有重新執行 AI 模型。',
      })
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: '重新分析失敗',
        description: cause instanceof Error ? cause.message : undefined,
      })
    }
  }

  async function approve() {
    try {
      await options.review.approve()
      revisionMode.value = false
      await options.refreshCoach()
      options.feedback.notify({ level: 'success', title: '片段已審核，教練端現在可查看' })
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: '審核發布失敗',
        description: cause instanceof Error ? cause.message : undefined,
      })
    }
  }

  function enter() {
    if (!options.selectedAnalysisRunId() || !options.overlayActive()) {
      options.feedback.notify({
        level: 'warning',
        title: '請先選取已完成分析、且可顯示 Overlay 的片段',
      })
      return
    }
    revisionMode.value = true
  }

  function exit() {
    if (options.review.dirtyCount.value > 0) {
      options.feedback.notify({ level: 'warning', title: '請先套用或捨棄尚未同步的修改' })
      return
    }
    revisionMode.value = false
    closePanel()
  }

  function reviewActionAvailability(action: 'apply' | 'discard' | 'recalculate' | 'approve') {
    if (!revisionMode.value)
      return { enabled: false, pending: options.review.pending.value, reason: '請先進入修訂模式' }
    if (options.review.pending.value)
      return { enabled: false, pending: true, reason: '分析修訂正在同步，請稍候' }
    if ((action === 'apply' || action === 'discard') && options.review.dirtyCount.value === 0)
      return { enabled: false, pending: false, reason: '目前沒有尚未套用的修改' }
    if ((action === 'recalculate' || action === 'approve') && options.review.dirtyCount.value > 0)
      return { enabled: false, pending: false, reason: '請先套用或捨棄尚未同步的修改' }
    if (action === 'recalculate' && options.dependenciesPending())
      return { enabled: false, pending: false, reason: '正在更新擊球與球員關聯' }
    if (action === 'approve' && options.review.status.value !== 'ready')
      return { enabled: false, pending: false, reason: '修訂結果尚未達到可審核狀態' }
    return { enabled: true, pending: false, reason: null }
  }

  const unregister = [
    options.manager.register({
      id: 'analysis.enter-revision',
      group: 'analysis',
      label: '修訂分析',
      availability: () => ({
        enabled: Boolean(options.selectedAnalysisRunId()) && options.overlayActive(),
        pending: options.review.pending.value,
        reason: '請先選取已完成分析、且可顯示 Overlay 的片段',
      }),
      execute: enter,
    }),
    options.manager.register({
      id: 'analysis.exit-revision',
      group: 'analysis',
      label: '結束修訂',
      availability: () => ({
        enabled: revisionMode.value && options.review.dirtyCount.value === 0,
        reason: '請先套用或捨棄尚未同步的修改',
      }),
      execute: exit,
    }),
    ...(
      [
        ['analysis.apply', '套用修改', 'apply'],
        ['analysis.discard', '捨棄修改', 'discard'],
        ['analysis.recalculate', '重建修訂結果', 'recalculate'],
        ['analysis.approve', '審核發布', 'approve'],
      ] as const
    ).map(([id, label, execute]) =>
      options.manager.register({
        id,
        group: 'analysis',
        label,
        resources: ['analysis-review'],
        availability: () => reviewActionAvailability(execute),
        execute:
          execute === 'apply'
            ? applyChanges
            : execute === 'discard'
              ? discardChanges
              : execute === 'recalculate'
                ? recalculate
                : approve,
      }),
    ),
    options.manager.register({
      id: 'analysis.add-contact',
      group: 'analysis',
      label: '新增擊球',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value && options.overlayActive(),
        pending: options.review.pending.value,
        reason: '請先進入修訂模式',
      }),
      execute: addHit,
    }),
    options.manager.register<string, void>({
      id: 'analysis.delete-contact',
      group: 'analysis',
      label: '刪除擊球',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value,
        pending: options.review.pending.value,
        reason: '請先進入修訂模式',
      }),
      execute: deleteHit,
    }),
    options.manager.register<string, void>({
      id: 'analysis.restore-contact',
      group: 'analysis',
      label: '復原擊球',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value,
        pending: options.review.pending.value,
        reason: '請先進入修訂模式',
      }),
      execute: restoreHit,
    }),
    options.manager.register<string, void>({
      id: 'analysis.select-contact',
      group: 'analysis',
      label: '選取擊球',
      availability: () => ({
        enabled: Boolean(options.selectedAnalysisRunId()),
        reason: '請先選取已完成分析的片段',
      }),
      execute: selectHit,
    }),
    options.manager.register<{ keyPointId: string; deltaFrames: number }, void>({
      id: 'analysis.adjust-contact-time',
      group: 'analysis',
      label: '調整擊球時間',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value,
        pending: options.review.pending.value,
        reason: '請先進入修訂模式',
      }),
      execute: payload => adjustHitTime(payload.keyPointId, payload.deltaFrames),
    }),
    options.manager.register<string, void>({
      id: 'analysis.reset-contact-time',
      group: 'analysis',
      label: '還原擊球時間',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value,
        pending: options.review.pending.value,
        reason: '請先進入修訂模式',
      }),
      execute: resetHitTime,
    }),
    options.manager.register<string, void>({
      id: 'analysis.set-contact-no-actor',
      group: 'analysis',
      label: '標記無擊球者',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value,
        pending: options.review.pending.value,
        reason: '請先進入修訂模式',
      }),
      execute: markHitNoActor,
    }),
    options.manager.register<string, void>({
      id: 'analysis.clear-contact-actor',
      group: 'analysis',
      label: '清除擊球者修正',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value && options.hasActorOverride(),
        pending: options.review.pending.value,
        reason: options.hasActorOverride() ? '請先進入修訂模式' : '目前沒有人工擊球者修正',
      }),
      execute: clearHitActor,
    }),
    options.manager.register({
      id: 'analysis.mark-ball-missing',
      group: 'analysis',
      label: '標記目前畫格無球',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value && options.overlayActive(),
        pending: options.review.pending.value,
        reason: '請先進入可用的分析修訂畫面',
      }),
      execute: markBallMissing,
    }),
    options.manager.register({
      id: 'analysis.clear-ball-override',
      group: 'analysis',
      label: '清除人工球點',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value && options.overlayActive() && options.hasBallOverride(),
        pending: options.review.pending.value,
        reason: options.hasBallOverride() ? '請先進入可用的分析修訂畫面' : '目前沒有人工球點修正',
      }),
      execute: clearBallOverride,
    }),
    options.manager.register({
      id: 'analysis.toggle-bbox-relabel',
      group: 'analysis',
      label: '重畫球員外框',
      availability: () => ({
        enabled: revisionMode.value && options.overlayActive() && selectedTrackId.value !== null,
        reason: '請先選取播放器中的球員',
      }),
      execute: toggleBBoxRelabel,
    }),
    options.manager.register({
      id: 'analysis.clear-bbox-override',
      group: 'analysis',
      label: '清除人工外框',
      resources: ['analysis-review'],
      availability: () => ({
        enabled:
          revisionMode.value &&
          options.overlayActive() &&
          selectedTrackId.value !== null &&
          options.hasBBoxOverride(),
        pending: options.review.pending.value,
        reason: options.hasBBoxOverride() ? '請先選取播放器中的球員' : '目前沒有人工外框修正',
      }),
      execute: clearBBoxOverride,
    }),
    options.manager.register<AnalysisReviewAction, void>({
      id: 'analysis.set-action',
      group: 'analysis',
      label: '修改球員動作',
      resources: ['analysis-review'],
      availability: () => ({
        enabled: revisionMode.value && options.overlayActive() && selectedTrackId.value !== null,
        pending: options.review.pending.value,
        reason: '請先選取播放器中的球員',
      }),
      execute: setAction,
    }),
    options.manager.register({
      id: 'analysis.clear-action',
      group: 'analysis',
      label: '清除動作修正',
      resources: ['analysis-review'],
      availability: () => ({
        enabled:
          revisionMode.value &&
          options.overlayActive() &&
          selectedTrackId.value !== null &&
          options.hasActionOverride(),
        pending: options.review.pending.value,
        reason: options.hasActionOverride() ? '請先選取播放器中的球員' : '目前沒有人工動作修正',
      }),
      execute: clearAction,
    }),
  ]

  function dispose() {
    stopRunWatch()
    stopPageWatch()
    stopRevisionWatch()
    unregister.forEach(stop => stop())
  }

  return {
    revisionMode: readonly(revisionMode),
    panelPage,
    ballRelabelEnabled,
    bboxRelabelEnabled,
    actorAssignmentMode,
    selectedTrackId,
    selectedTrackAction,
    selectedHitId,
    analysisRunId,
    overlayActive,
    dependenciesPending,
    selectTrack,
    setBallPosition,
    setPlayerBBox,
    markBallMissing,
    clearBallOverride,
    toggleBBoxRelabel,
    clearBBoxOverride,
    setAction,
    clearAction,
    selectHit,
    adjustHitTime,
    resetHitTime,
    markHitNoActor,
    clearHitActor,
    addHit,
    deleteHit,
    restoreHit,
    applyChanges,
    discardChanges,
    recalculate,
    approve,
    enter,
    exit,
    closePanel,
    closeToolbox,
    reconcileHits,
    resetTools,
    dispose,
  }
}
