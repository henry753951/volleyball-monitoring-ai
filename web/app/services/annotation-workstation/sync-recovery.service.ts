import { computed, readonly, ref } from 'vue'
import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'
import type { createCoreDomainClient } from '~/lib/coreDomain'
import type { createAnnotationRoomService } from './annotation-room.service'
import type { WorkstationActionManager } from './workstation-action.service'
import type { WorkstationConfirmationService } from './workstation-confirmation.service'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

type CoreDomainClient = ReturnType<typeof createCoreDomainClient>
type AnnotationRoomService = ReturnType<typeof createAnnotationRoomService>

export interface SyncRecoveryServiceOptions {
  room: AnnotationRoomService
  core: CoreDomainClient
  actions: WorkstationActionManager
  confirmation: WorkstationConfirmationService
  feedback: WorkstationFeedbackService
  selectedRallyId: () => string | null
  displayedRallyId: () => string | null
  activeProcessing: () => AnnotationRallyProcessingUpdate | null
  refreshCoach: () => Promise<unknown>
}

export function createSyncRecoveryService(options: SyncRecoveryServiceOptions) {
  const resyncing = ref(false)
  const processingRetrying = ref(false)

  async function performResync(discardConflicts: boolean) {
    if (resyncing.value) return
    resyncing.value = true
    try {
      await options.room.resync({ discardConflicts })
      options.feedback.notify({
        level: 'success',
        title:
          options.room.connection.value === 'ready'
            ? '標註狀態已重新同步'
            : '已取得最新狀態，標註連線正在重新建立',
      })
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('無法重新同步標註狀態')
    } finally {
      resyncing.value = false
    }
  }

  function requestResync() {
    if (resyncing.value) return
    if (options.room.outboxNeedsConfirmation.value) {
      options.confirmation.open({
        id: 'annotation-resync',
        title: '重新同步標註狀態',
        message:
          '有一筆本機操作已和伺服器最新狀態衝突。重新同步會捨棄尚未確認的操作，再載入最新片段；已由伺服器確認的標記不會被刪除。',
        confirmLabel: '捨棄衝突並同步',
        onConfirm: () => performResync(true),
      })
      return
    }
    void performResync(false).catch(cause =>
      options.feedback.notify({
        level: 'error',
        title: cause instanceof Error ? cause.message : '無法重新同步標註狀態',
      }),
    )
  }

  async function retryProcessing() {
    const rallyId = options.selectedRallyId() ?? options.displayedRallyId()
    if (
      !rallyId ||
      processingRetrying.value ||
      options.activeProcessing()?.processing_status !== 'failed'
    )
      return
    processingRetrying.value = true
    try {
      const result = await options.core.retryProcessing(rallyId)
      await options.refreshCoach()
      options.feedback.notify({
        level: 'success',
        title: result.retriedStage === 'clip' ? '已重新排程剪切片段' : '已重新排程 AI 分析',
      })
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('無法重新處理片段')
    } finally {
      processingRetrying.value = false
    }
  }

  const unregister = [
    options.actions.register({
      id: 'sync.resync',
      group: 'sync',
      label: '重新同步',
      availability: computed(() => ({
        enabled: !resyncing.value,
        pending: resyncing.value,
        reason: '標註狀態正在重新同步',
      })),
      execute: requestResync,
    }),
    options.actions.register({
      id: 'sync.discard-pending',
      group: 'sync',
      label: '捨棄衝突並同步',
      availability: computed(() => ({
        enabled: options.room.outboxNeedsConfirmation.value && !resyncing.value,
        pending: resyncing.value,
        reason: '目前沒有需要捨棄的衝突操作',
      })),
      execute: () => performResync(true),
    }),
  ]

  return {
    resyncing: readonly(resyncing),
    processingRetrying: readonly(processingRetrying),
    requestResync,
    performResync,
    retryProcessing,
    dispose: () => unregister.forEach(stop => stop()),
  }
}

export type SyncRecoveryService = ReturnType<typeof createSyncRecoveryService>
