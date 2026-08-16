import { readonly, ref } from 'vue'
import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import type { TimelineSelectionItem } from '~/utils/timelineSelection'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

export interface CorrectionFlowRoomPort {
  outboxNeedsConfirmation: { readonly value: boolean }
  pendingCount: { readonly value: number }
  busy: { readonly value: boolean }
  createCorrection: (
    submissionId: string,
    options: { preserveAnalysisContacts: boolean; regenerateAnalysisContacts: boolean },
  ) => Promise<AnnotationRallySnapshot | null>
  selectRally: (rallyId: string) => Promise<AnnotationRallySnapshot | null>
  edit: (kind: 'DELETE_KEY_POINT', options: { keyPointId: string }) => Promise<unknown>
  submitCorrection: () => Promise<unknown>
  cancelCorrection: (rallyId: string) => Promise<AnnotationRallySnapshot | null | unknown>
}

export interface CorrectionFlowServiceOptions {
  room: CorrectionFlowRoomPort
  feedback: WorkstationFeedbackService
  selectedSubmissionId: () => string | null
  pendingTimelineMove: () => boolean
  selectedAnalysisRunId: () => string | null
  loadedAnalysisRunId: () => string | null
  analysisDirtyCount: () => number
  overlayContactCount: () => number
  annotationState: () => 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'
  displayedCorrectionDraft: () => boolean
  correctionContactIds: () => readonly string[]
  correctionActive: () => boolean
  correctionRallyId: () => string | null
  displayedRallyId: () => string | null
  selectRally: (rallyId: string | null) => void
  setTimelineSelection: (selection: TimelineSelectionItem) => void
  setKeyPointSelection: (keyPointId: string | null) => void
  requestCreateConfirmation: (submissionId: string) => void
  requestSubmitConfirmation: () => void
  requestResync: () => void
  refreshCoach: () => Promise<unknown>
}

export function createCorrectionFlowService(options: CorrectionFlowServiceOptions) {
  const creating = ref(false)
  const submitting = ref(false)
  const cancelling = ref(false)
  let operationGeneration = 0

  function requestCreate() {
    const submissionId = options.selectedSubmissionId()
    if (!submissionId || creating.value) return
    if (options.room.outboxNeedsConfirmation.value) {
      options.feedback.notify({
        level: 'warning',
        title: '先重新同步標註狀態，再建立修正版',
        description: '本機待送出操作與伺服器狀態衝突。',
      })
      options.requestResync()
      return
    }
    if (
      options.room.pendingCount.value > 0 ||
      options.room.busy.value ||
      options.pendingTimelineMove()
    ) {
      options.feedback.notify({
        level: 'info',
        title: '前一筆標記操作仍在同步',
        description: '同步完成後即可建立修正版。',
      })
      return
    }
    const analysisRunId = options.selectedAnalysisRunId()
    if (analysisRunId && options.loadedAnalysisRunId() !== analysisRunId) {
      options.feedback.notify({ level: 'info', title: '正在同步擊球點修改，請稍後再試' })
      return
    }
    if (options.analysisDirtyCount() > 0) {
      options.feedback.notify({ level: 'warning', title: '請先套用或捨棄尚未儲存的分析修改' })
      return
    }
    options.requestCreateConfirmation(submissionId)
  }

  async function create(submissionId: string) {
    if (creating.value) return
    const operation = ++operationGeneration
    creating.value = true
    try {
      const draft = await options.room.createCorrection(submissionId, {
        // A correction starts from the immutable human submission. Analysis
        // contacts are a separate review layer and must never replace or clear
        // the operator's key points while the draft is being hydrated.
        preserveAnalysisContacts: false,
        regenerateAnalysisContacts: false,
      })
      if (operation !== operationGeneration) return
      const rallyId = draft?.rally_id
      if (!rallyId) throw new Error('修正版已建立，但尚未取得片段狀態')
      options.selectRally(rallyId)
      // A correction draft inherits the immutable points, but it must not
      // inherit a stale point selection from the previously viewed submission.
      // Leaving point selection empty makes the first A/D navigation resolve
      // from the visible playhead, which is the operator's actual context.
      options.setTimelineSelection('mask')
      options.setKeyPointSelection(null)
      if (!['OPEN', 'READY'].includes(options.annotationState())) {
        await options.room.selectRally(rallyId)
      }
      if (!['OPEN', 'READY'].includes(options.annotationState())) {
        throw new Error('修正版已建立，正在重新同步；請稍後再選取此片段')
      }
      await options.refreshCoach()
      if (operation !== operationGeneration) return
      options.feedback.notify({
        level: 'success',
        title: '修正版草稿已建立',
        description: '已保留原送出版本的球點、球種與球員關聯。',
      })
    } catch (cause) {
      if (operation === operationGeneration) {
        await options.refreshCoach().catch(() => undefined)
        options.feedback.notify({
          level: 'error',
          title: '無法建立修正版草稿',
          description: cause instanceof Error ? cause.message : undefined,
        })
      }
    } finally {
      if (operation === operationGeneration) creating.value = false
    }
  }

  function requestSubmit() {
    if (!options.displayedCorrectionDraft() || submitting.value) return
    if (options.correctionContactIds().length === 0) {
      void submit('regenerate')
      return
    }
    options.requestSubmitConfirmation()
  }

  async function submit(contactStrategy: 'regenerate' | 'preserve') {
    if (submitting.value) return
    submitting.value = true
    try {
      if (contactStrategy === 'regenerate') {
        for (const keyPointId of [...options.correctionContactIds()]) {
          await options.room.edit('DELETE_KEY_POINT', { keyPointId })
        }
      }
      await options.room.submitCorrection()
      options.setTimelineSelection('segment')
      options.setKeyPointSelection(null)
      await options.refreshCoach()
      options.feedback.notify({
        level: 'success',
        title: '修正版已送出',
        description:
          contactStrategy === 'preserve'
            ? '已保留目前標記點；系統會依修改範圍重用既有分析或重新處理必要工作。'
            : '已清除人工擊球點；系統將重新產生擊球點並處理必要分析。',
      })
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: '無法送出修正版',
        description: cause instanceof Error ? cause.message : undefined,
      })
    } finally {
      submitting.value = false
    }
  }

  async function cancel() {
    if (!options.correctionActive() || cancelling.value) return
    const rallyId = options.correctionRallyId() ?? options.displayedRallyId()
    if (!rallyId) return
    operationGeneration += 1
    cancelling.value = true
    try {
      const restored = await options.room.cancelCorrection(rallyId)
      options.selectRally(restored ? rallyId : null)
      options.setTimelineSelection(restored ? 'segment' : null)
      options.setKeyPointSelection(null)
      await options.refreshCoach()
      options.feedback.notify({
        level: 'success',
        title: restored ? '已取消修正' : '草稿已不存在',
        description: restored ? '原送出版本維持有效。' : '已清除本機殘留。',
      })
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: '無法取消修正版草稿',
        description: cause instanceof Error ? cause.message : '請重試',
      })
    } finally {
      cancelling.value = false
    }
  }

  return {
    creating: readonly(creating),
    submitting: readonly(submitting),
    cancelling: readonly(cancelling),
    requestCreate,
    create,
    requestSubmit,
    submit,
    cancel,
  }
}
