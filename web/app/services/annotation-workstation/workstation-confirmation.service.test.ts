import { describe, expect, it, vi } from 'vitest'
import { createWorkstationConfirmationService } from './workstation-confirmation.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

describe('workstation confirmation service', () => {
  it('executes the current confirmation once and closes it', async () => {
    const onConfirm = vi.fn()
    const service = createWorkstationConfirmationService({
      feedback: createWorkstationFeedbackService(),
    })
    service.open({
      id: 'delete',
      title: '刪除',
      message: '確認刪除',
      confirmLabel: '刪除',
      onConfirm,
    })

    await Promise.all([service.confirm(), service.confirm()])

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(service.current.value).toBeNull()
  })

  it('keeps the dialog open and publishes feedback when execution fails', async () => {
    const feedback = createWorkstationFeedbackService()
    const service = createWorkstationConfirmationService({ feedback })
    service.open({
      id: 'failing',
      title: '操作',
      message: '確認',
      confirmLabel: '確認',
      onConfirm: () => {
        throw new Error('server unavailable')
      },
    })

    await service.confirm()

    expect(service.current.value?.id).toBe('failing')
    expect(feedback.messages.value.at(-1)?.title).toBe('server unavailable')
    expect(service.pending.value).toBe(false)
  })

  it('runs an explicit secondary decision', async () => {
    const onSecondary = vi.fn()
    const service = createWorkstationConfirmationService({
      feedback: createWorkstationFeedbackService(),
    })
    service.open({
      id: 'serve-result',
      title: '發球結果',
      message: '選擇結果',
      confirmLabel: '失誤',
      secondaryLabel: '得分',
      onConfirm: vi.fn(),
      onSecondary,
    })

    await service.secondary()

    expect(onSecondary).toHaveBeenCalledOnce()
    expect(service.current.value).toBeNull()
  })
})
