import { readonly, shallowRef } from 'vue'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

export interface WorkstationConfirmationRequest {
  id: string
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  onSecondary?: () => void | Promise<void>
  onClose?: () => void
}

export function createWorkstationConfirmationService(options: {
  feedback: WorkstationFeedbackService
}) {
  const current = shallowRef<WorkstationConfirmationRequest | null>(null)
  const pending = shallowRef(false)
  let generation = 0

  function open(request: WorkstationConfirmationRequest) {
    generation += 1
    current.value?.onClose?.()
    current.value = request
    pending.value = false
  }

  function close() {
    if (pending.value) return
    generation += 1
    const request = current.value
    current.value = null
    request?.onClose?.()
  }

  async function execute(kind: 'confirm' | 'secondary') {
    const request = current.value
    const handler = kind === 'confirm' ? request?.onConfirm : request?.onSecondary
    if (!request || !handler || pending.value) return
    const requestGeneration = generation
    pending.value = true
    try {
      await handler()
      if (requestGeneration === generation) {
        generation += 1
        current.value = null
        request.onClose?.()
      }
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: cause instanceof Error ? cause.message : '無法完成確認操作',
      })
    } finally {
      pending.value = false
    }
  }

  return {
    current: readonly(current),
    pending: readonly(pending),
    open,
    close,
    confirm: () => execute('confirm'),
    secondary: () => execute('secondary'),
  }
}

export type WorkstationConfirmationService = ReturnType<typeof createWorkstationConfirmationService>
