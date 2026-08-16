import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createSyncRecoveryService } from './sync-recovery.service'
import { createWorkstationActionManager } from './workstation-action.service'
import { createWorkstationConfirmationService } from './workstation-confirmation.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

function setup(conflict = false) {
  const feedback = createWorkstationFeedbackService()
  const actions = createWorkstationActionManager({ feedback })
  const confirmation = createWorkstationConfirmationService({ feedback })
  const room = {
    connection: ref('ready'),
    outboxNeedsConfirmation: ref(conflict),
    resync: vi.fn().mockResolvedValue(undefined),
  }
  const core = { retryProcessing: vi.fn().mockResolvedValue({ retriedStage: 'analysis' }) }
  const service = createSyncRecoveryService({
    room: room as never,
    core: core as never,
    actions,
    confirmation,
    feedback,
    selectedRallyId: () => 'rally-1',
    displayedRallyId: () => null,
    activeProcessing: () => ({ processing_status: 'failed' }) as never,
    refreshCoach: vi.fn().mockResolvedValue(undefined),
  })
  return { service, actions, confirmation, room, core }
}

describe('sync recovery service', () => {
  it('requires confirmation before discarding a conflicted outbox', async () => {
    const context = setup(true)

    await context.actions.execute('sync.resync')
    expect(context.confirmation.current.value?.id).toBe('annotation-resync')
    expect(context.room.resync).not.toHaveBeenCalled()
    await context.confirmation.confirm()

    expect(context.room.resync).toHaveBeenCalledWith({ discardConflicts: true })
    context.service.dispose()
  })

  it('retries only the selected failed Rally processing pipeline', async () => {
    const context = setup()

    await context.service.retryProcessing()

    expect(context.core.retryProcessing).toHaveBeenCalledWith('rally-1')
    expect(context.service.processingRetrying.value).toBe(false)
    context.service.dispose()
  })
})
