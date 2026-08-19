import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createSegmentManagementService, type SideSwapTarget } from './segment-management.service'
import { createWorkstationActionManager } from './workstation-action.service'
import { createWorkstationConfirmationService } from './workstation-confirmation.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

function setup(
  options: {
    currentSet?: { id: string; set_number?: number }
    selectedSubmissionId?: string | null
    sideSwapTarget?: SideSwapTarget | null
  } = {},
) {
  const feedback = createWorkstationFeedbackService()
  const actions = createWorkstationActionManager({ feedback })
  const confirmation = createWorkstationConfirmationService({ feedback })
  const coach = {
    deleteRallyAnalysis: vi.fn().mockResolvedValue({ cleanupWarnings: [] }),
    deleteRally: vi.fn().mockResolvedValue({ abortedJobCount: 0, cleanupWarnings: [] }),
    updateRallyPlacement: vi.fn().mockResolvedValue({ displaySetNumber: 2, displayOrdinal: 3 }),
  }
  const core = {
    reopenLastSet: vi.fn().mockResolvedValue(undefined),
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
    canReopenLastSet: () => true,
    currentSet: () => options.currentSet ?? ({ id: 'set-1' } as const),
    leftTeam: () => ({ id: 'left', name: 'Left' }),
    rightTeam: () => ({ id: 'right', name: 'Right' }),
    currentDraft: () => true,
    sideSwapEffectiveOrdinal: () => 5,
    sideSwapTarget: () => options.sideSwapTarget ?? null,
    selectedRallyId: () => 'rally-1',
    selectedSubmissionId: () => options.selectedSubmissionId ?? null,
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
    feedback,
    refreshCoach,
  }
}

describe('segment management service', () => {
  it('offers whole-segment deletion and analysis-only deletion before changing data', async () => {
    const context = setup({ selectedSubmissionId: 'submission-1' })

    context.service.requestDelete()
    expect(context.confirmation.current.value?.id).toBe('rally-delete')
    expect(context.confirmation.current.value?.confirmLabel).toBe('刪除整個片段')
    expect(context.confirmation.current.value?.secondaryLabel).toBe('刪除分析，保留 Keypoint')
    await context.confirmation.confirm()

    expect(context.coach.deleteRally).toHaveBeenCalledWith('rally-1')
    expect(context.room.forgetRally).toHaveBeenCalledWith('rally-1')
    expect(context.timeline.clear).toHaveBeenCalledOnce()
    context.service.dispose()
  })

  it('allows a selected in-progress draft to delete the whole segment', async () => {
    const context = setup()

    context.service.requestDelete()
    expect(context.confirmation.current.value?.id).toBe('rally-delete')
    expect(context.confirmation.current.value?.title).toBe('刪除片段內容')
    expect(context.confirmation.current.value?.secondaryLabel).toBeUndefined()
    await context.confirmation.confirm()

    expect(context.coach.deleteRally).toHaveBeenCalledWith('rally-1')
    context.service.dispose()
  })

  it('preserves reviewed keypoints and manual ball events when requested', async () => {
    const context = setup({ selectedSubmissionId: 'submission-1' })

    context.service.requestDelete()
    await context.confirmation.secondary()
    expect(context.confirmation.current.value?.id).toBe('rally-analysis-delete')
    expect(context.confirmation.current.value?.title).toBe('刪除分析並保留標記')
    expect(context.confirmation.current.value?.message).toContain('人工球種')
    await context.confirmation.confirm()

    expect(context.coach.deleteRallyAnalysis).toHaveBeenCalledWith('rally-1')
    expect(context.room.createCorrection).not.toHaveBeenCalled()
    expect(context.coach.deleteRally).not.toHaveBeenCalled()
    expect(context.timeline.selectHistorical).toHaveBeenCalledWith('rally-1', '0')
    context.service.dispose()
  })

  it('only offers the keypoint-preserving analysis deletion path', async () => {
    const context = setup({ selectedSubmissionId: 'submission-1' })

    context.service.requestDelete()
    await context.confirmation.secondary()
    expect(context.confirmation.current.value?.secondaryLabel).toBeUndefined()
    await context.confirmation.confirm()

    expect(context.coach.deleteRallyAnalysis).toHaveBeenCalledWith('rally-1')
    expect(context.room.createCorrection).not.toHaveBeenCalled()
    expect(context.coach.deleteRally).not.toHaveBeenCalled()
    context.service.dispose()
  })

  it('unlocks a failed deletion even when the background refresh does not settle', async () => {
    const context = setup({ selectedSubmissionId: 'submission-1' })
    context.coach.deleteRallyAnalysis.mockRejectedValueOnce(new Error('analysis deletion failed'))
    context.refreshCoach.mockImplementationOnce(() => new Promise(() => undefined))

    context.service.requestDelete()
    await context.confirmation.secondary()
    await context.confirmation.confirm()

    expect(context.confirmation.pending.value).toBe(false)
    expect(context.confirmation.current.value?.id).toBe('rally-analysis-delete')
    expect(context.feedback.messages.value.at(-1)?.title).toContain('analysis deletion failed')
    context.service.dispose()
  })

  it('deletes multiple completed analyses into keypoint-preserving ready drafts', async () => {
    const context = setup()
    const rallies = [
      { id: 'rally-1', submission: { id: 'submission-1', analysis: { status: 'completed' } } },
      { id: 'rally-2', submission: { id: 'submission-2', analysis: { status: 'completed' } } },
    ]

    context.service.requestBatchAnalysisReset(rallies as never)
    expect(context.confirmation.current.value?.id).toBe('rally-analysis-batch-reset')
    expect(context.confirmation.current.value?.confirmLabel).toBe('刪除 2 個分析')
    await context.confirmation.confirm()

    expect(context.coach.deleteRallyAnalysis).toHaveBeenNthCalledWith(1, 'rally-1')
    expect(context.coach.deleteRallyAnalysis).toHaveBeenNthCalledWith(2, 'rally-2')
    expect(context.timeline.selectHistorical).toHaveBeenCalledWith('rally-2', '0')
    context.service.dispose()
  })

  it('routes next-set UI commands through the shared action and confirmation managers', async () => {
    const context = setup()

    const result = await context.actions.execute('segment.start-next-set', 'right')
    expect(result.status).toBe('executed')
    expect(context.confirmation.current.value?.id).toBe('next-set-right')
    await context.confirmation.confirm()

    expect(context.core.startNextSet).toHaveBeenCalledWith({
      effectiveFromRallyId: 'rally-1',
      matchId: 'match-1',
      winningTeamId: 'right',
    })
    context.service.dispose()
  })

  it('offers a safe undo for the latest set winner marker', async () => {
    const context = setup()

    const result = await context.actions.execute('segment.reopen-last-set')
    expect(result.status).toBe('executed')
    expect(context.confirmation.current.value?.id).toBe('reopen-last-set')
    expect(context.confirmation.current.value?.message).toContain('下一局已經新增標註')
    await context.confirmation.confirm()

    expect(context.core.reopenLastSet).toHaveBeenCalledWith({ matchId: 'match-1' })
    context.service.dispose()
  })

  it('blocks a winner action when the selected rally belongs to an older display set', async () => {
    const context = setup({
      currentSet: { id: 'set-4', set_number: 4 },
      sideSwapTarget: {
        displaySetNumber: 1,
        effectiveFromRallyOrdinal: 5,
        expectedLeftTeamId: 'left',
        expectedRightTeamId: 'right',
        isDraft: false,
        label: '第 5 回合起',
        rallyId: 'rally-1',
        setId: 'set-1',
      },
    })

    const result = await context.actions.execute('segment.start-next-set', 'right')
    expect(result.status).toBe('blocked')
    expect(context.core.startNextSet).not.toHaveBeenCalled()
    context.service.dispose()
  })

  it('locks side-swap commands to one operation and preserves the effective ordinal', async () => {
    const context = setup()

    await context.actions.execute('segment.swap-current-sides')
    await context.confirmation.confirm()

    expect(context.core.swapCourtSides).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveFromRallyOrdinal: 5,
        expectedLeftTeamId: 'left',
        expectedRightTeamId: 'right',
        setId: 'set-1',
      }),
    )
    expect(context.service.sideSwapPending.value).toBe(false)
    context.service.dispose()
  })

  it('uses a selected rally as the suffix-swap target', async () => {
    const target: SideSwapTarget = {
      effectiveFromRallyOrdinal: 12,
      expectedLeftTeamId: 'team-a',
      expectedRightTeamId: 'team-b',
      isDraft: false,
      label: '第 7 回合起',
      setId: 'set-2',
    }
    const context = setup({ sideSwapTarget: target })

    await context.actions.execute('segment.swap-current-sides')
    await context.confirmation.confirm()

    expect(context.core.swapCourtSides).toHaveBeenCalledWith({
      effectiveFromRallyOrdinal: target.effectiveFromRallyOrdinal,
      expectedLeftTeamId: target.expectedLeftTeamId,
      expectedRightTeamId: target.expectedRightTeamId,
      setId: target.setId,
    })
    context.service.dispose()
  })

  it('keeps both side-swap entry points locked while confirmation or mutation is active', async () => {
    const context = setup()
    let releaseMutation!: () => void
    context.core.swapCourtSides.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseMutation = resolve
        }),
    )

    await context.actions.execute('segment.swap-current-sides')
    expect(context.actions.state('segment.swap-rally-sides').value.enabled).toBe(false)
    context.confirmation.close()
    expect(context.actions.state('segment.swap-rally-sides').value.enabled).toBe(true)

    await context.actions.execute('segment.swap-current-sides')
    const confirmation = context.confirmation.confirm()
    await Promise.resolve()
    expect(context.service.sideSwapPending.value).toBe(true)
    expect(context.actions.state('segment.swap-current-sides').value.enabled).toBe(false)
    expect(context.actions.state('segment.swap-rally-sides').value.enabled).toBe(false)

    releaseMutation()
    await confirmation
    expect(context.service.sideSwapPending.value).toBe(false)
    expect(context.actions.state('segment.swap-current-sides').value.enabled).toBe(true)
    context.service.dispose()
  })
})
