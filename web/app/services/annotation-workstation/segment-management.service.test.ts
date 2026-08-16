import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createSegmentManagementService } from './segment-management.service'
import { createWorkstationActionManager } from './workstation-action.service'
import { createWorkstationConfirmationService } from './workstation-confirmation.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

function setup() {
  const feedback = createWorkstationFeedbackService()
  const actions = createWorkstationActionManager({ feedback })
  const confirmation = createWorkstationConfirmationService({ feedback })
  const coach = {
    deleteRally: vi.fn().mockResolvedValue({ abortedJobCount: 0, cleanupWarnings: [] }),
    updateRallyPlacement: vi.fn().mockResolvedValue({ displaySetNumber: 2, displayOrdinal: 3 }),
  }
  const core = {
    startNextSet: vi.fn().mockResolvedValue(undefined),
    swapCourtSides: vi.fn().mockResolvedValue(undefined),
  }
  const room = {
    forgetRally: vi.fn(),
    createCorrection: vi.fn(),
    submitCorrection: vi.fn(),
  }
  const selection = {
    explicitRallyId: ref('rally-1'),
    releaseExplicitRally: vi.fn(),
    selectRally: vi.fn(),
  }
  const timeline = {
    clear: vi.fn(),
    selectMask: vi.fn(),
    selectHistorical: vi.fn(),
  }
  const refreshMatch = vi.fn().mockResolvedValue(undefined)
  const refreshCoach = vi.fn().mockResolvedValue(undefined)
  const service = createSegmentManagementService({
    matchId: 'match-1',
    core: core as never,
    coach: coach as never,
    room: room as never,
    selection: selection as never,
    timeline: timeline as never,
    actions,
    confirmation,
    feedback,
    editReady: () => true,
    currentSet: () => ({ id: 'set-1' }),
    leftTeam: () => ({ id: 'left', name: 'Left' }),
    rightTeam: () => ({ id: 'right', name: 'Right' }),
    currentDraft: () => true,
    sideSwapEffectiveOrdinal: () => 5,
    selectedRallyId: () => 'rally-1',
    clipSelected: () => true,
    teamById: id => ({ id, name: id }),
    refreshMatch,
    refreshCoach,
    closePlacement: vi.fn(),
  })
  return {
    service,
    actions,
    confirmation,
    coach,
    core,
    room,
    selection,
    timeline,
  }
}

describe('segment management service', () => {
  it('captures the selected rally in a confirmation before permanent deletion', async () => {
    const context = setup()

    context.service.requestDelete()
    expect(context.confirmation.current.value?.id).toBe('rally-delete')
    await context.confirmation.confirm()

    expect(context.coach.deleteRally).toHaveBeenCalledWith('rally-1')
    expect(context.room.forgetRally).toHaveBeenCalledWith('rally-1')
    expect(context.timeline.clear).toHaveBeenCalledOnce()
    context.service.dispose()
  })

  it('routes next-set UI commands through the shared action and confirmation managers', async () => {
    const context = setup()

    const result = await context.actions.execute('segment.start-next-set', 'right')
    expect(result.status).toBe('executed')
    expect(context.confirmation.current.value?.id).toBe('next-set-right')
    await context.confirmation.confirm()

    expect(context.core.startNextSet).toHaveBeenCalledWith({
      matchId: 'match-1',
      winningTeamId: 'right',
    })
    context.service.dispose()
  })

  it('locks side-swap commands to one operation and preserves the effective ordinal', async () => {
    const context = setup()

    await context.actions.execute('segment.swap-current-sides')
    await context.confirmation.confirm()

    expect(context.core.swapCourtSides).toHaveBeenCalledWith({
      effectiveFromRallyOrdinal: 5,
      expectedLeftTeamId: 'left',
      expectedRightTeamId: 'right',
      setId: 'set-1',
    })
    expect(context.service.sideSwapPending.value).toBe(false)
    context.service.dispose()
  })
})
