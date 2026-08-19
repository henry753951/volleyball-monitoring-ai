import { computed, readonly, ref } from 'vue'
import type { CoachRally, createCoachDomainClient } from '~/lib/coachDomain'
import { GraphQLRequestError, type createCoreDomainClient } from '~/lib/coreDomain'
import type { createAnnotationRoomService } from './annotation-room.service'
import type { createTimelineSelectionService } from './timeline-selection.service'
import type { WorkstationActionManager } from './workstation-action.service'
import type { WorkstationConfirmationService } from './workstation-confirmation.service'
import type { WorkstationFeedbackService } from './workstation-feedback.service'
import type { createWorkstationSelectionService } from './workstation-selection.service'

type CoreDomainClient = ReturnType<typeof createCoreDomainClient>
type CoachDomainClient = ReturnType<typeof createCoachDomainClient>
type AnnotationRoomService = ReturnType<typeof createAnnotationRoomService>
type TimelineSelectionService = ReturnType<typeof createTimelineSelectionService>
type WorkstationSelectionService = ReturnType<typeof createWorkstationSelectionService>

interface TeamSummary {
  id: string
  name: string
}

interface AnalysisResetTarget {
  rallyId: string
  submissionId: string
}

export interface SideSwapTarget {
  rallyId?: string | null
  displaySetNumber?: number
  setId: string
  effectiveFromRallyOrdinal: number
  expectedLeftTeamId: string
  expectedRightTeamId: string
  label: string
  isDraft: boolean
}

export interface SegmentManagementServiceOptions {
  matchId: string
  core: CoreDomainClient
  coach: CoachDomainClient
  room: AnnotationRoomService
  selection: WorkstationSelectionService
  timeline: TimelineSelectionService
  actions: WorkstationActionManager
  confirmation: WorkstationConfirmationService
  feedback: WorkstationFeedbackService
  editReady: () => boolean
  canReopenLastSet: () => boolean
  currentSet: () => { id: string; set_number?: number } | null
  leftTeam: () => TeamSummary | null
  rightTeam: () => TeamSummary | null
  currentDraft: () => boolean
  sideSwapEffectiveOrdinal: () => number
  sideSwapTarget: () => SideSwapTarget | null
  effectiveSetNumberFor?: (rawSetNumber: number) => number
  currentEffectiveSetNumber?: () => number | null
  displayOrdinalFor?: (rallyId: string) => number
  selectedRallyId: () => string | null
  selectedSubmissionId: () => string | null
  clipSelected: () => boolean
  teamById: (teamId: string) => TeamSummary | null
  refreshMatch: () => Promise<void>
  refreshCoach: () => Promise<unknown>
  closePlacement: () => void
}

export function createSegmentManagementService(options: SegmentManagementServiceOptions) {
  const sideSwapPending = ref(false)
  const sideSwapConfirmationPending = ref(false)
  const reopenLastSetPending = ref(false)
  const placementSaving = ref(false)
  const deletePending = ref(false)
  const affectsCurrentDraft = computed(options.currentDraft)
  const sideSwapLocked = computed(() => sideSwapPending.value || sideSwapConfirmationPending.value)

  const resolvedSideSwapTarget = computed(
    () =>
      options.sideSwapTarget() ??
      (() => {
        const set = options.currentSet()
        const left = options.leftTeam()
        const right = options.rightTeam()
        if (!set || !left || !right) return null
        return {
          rallyId: options.selectedRallyId(),
          effectiveFromRallyOrdinal: options.sideSwapEffectiveOrdinal(),
          expectedLeftTeamId: left.id,
          expectedRightTeamId: right.id,
          isDraft: options.currentDraft(),
          label: options.currentDraft()
            ? '目前片段起'
            : `第 ${options.sideSwapEffectiveOrdinal()} 回合起`,
          setId: set.id,
          displaySetNumber: set.set_number,
        }
      })(),
  )

  function isCurrentSetWinnerTarget(target: SideSwapTarget | null) {
    const current = options.currentSet()
    if (!current || !target?.rallyId) return false
    // The set id is the authoritative server identity. The display number is
    // a client projection and can intentionally merge raw sets after a winner
    // marker is removed, so it must not disable a valid current-set target.
    if (target.setId === current.id) return true
    if (target.displaySetNumber !== undefined && current.set_number !== undefined)
      return (
        (options.effectiveSetNumberFor?.(target.displaySetNumber) ?? target.displaySetNumber) ===
        (options.currentEffectiveSetNumber?.() ?? current.set_number)
      )
    return false
  }

  function success(title: string) {
    options.feedback.notify({ level: 'success', title })
  }

  function error(cause: unknown, fallback: string) {
    return cause instanceof Error ? cause : new Error(fallback)
  }

  function clearDeletedRallySelection(rallyId: string) {
    options.room.forgetRally(rallyId)
    if (options.selection.explicitRallyId.value === rallyId)
      options.selection.releaseExplicitRally()
    options.timeline.clear()
  }

  async function purge(rallyId: string) {
    if (deletePending.value) return
    deletePending.value = true
    try {
      const receipt = await options.coach.deleteRally(rallyId)
      clearDeletedRallySelection(rallyId)
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      success(receipt.abortedJobCount > 0 ? '片段已刪除，處理工作已中止' : '片段與分析資料已刪除')
      for (const warning of receipt.cleanupWarnings)
        options.feedback.notify({ level: 'warning', title: warning })
    } catch (cause) {
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      if (cause instanceof GraphQLRequestError && cause.code === 'NOT_FOUND') {
        clearDeletedRallySelection(rallyId)
        success('片段已刪除，已清除本機殘留')
      } else {
        throw error(cause, '無法刪除片段')
      }
    } finally {
      deletePending.value = false
    }
  }

  async function removeAnalysis(rallyId: string, submissionId: string, preserveKeyPoints: boolean) {
    if (deletePending.value) return
    deletePending.value = true
    try {
      if (!preserveKeyPoints) {
        throw new Error('目前只支援保留 Keypoint 的分析重設')
      }
      const receipt = await options.coach.deleteRallyAnalysis(rallyId)
      options.room.forgetRally(rallyId)
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      await options.timeline.selectHistorical(rallyId, '0')
      success('分析資料已刪除；片段已回到待送出狀態，START／END 與 Keypoint 已保留')
      for (const warning of receipt.cleanupWarnings)
        options.feedback.notify({ level: 'warning', title: warning })
    } catch (cause) {
      void options.refreshCoach().catch(() => undefined)
      throw error(cause, '無法刪除分析結果')
    } finally {
      deletePending.value = false
    }
  }

  async function resetAnalysisBatch(targets: readonly AnalysisResetTarget[]) {
    if (deletePending.value) return
    const uniqueTargets = [...new Map(targets.map(target => [target.rallyId, target])).values()]
    if (!uniqueTargets.length) return
    deletePending.value = true
    const completed: AnalysisResetTarget[] = []
    const failed: Array<{ target: AnalysisResetTarget; cause: unknown }> = []
    try {
      for (const target of uniqueTargets) {
        try {
          await options.coach.deleteRallyAnalysis(target.rallyId)
          options.room.forgetRally(target.rallyId)
          completed.push(target)
        } catch (cause) {
          failed.push({ cause, target })
        }
      }
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      const last = completed.at(-1)
      if (last) {
        await options.timeline.selectHistorical(last.rallyId, '0')
        success(`已刪除 ${completed.length} 個片段的分析：START／END 與 Keypoint 已保留`)
      }
      if (failed.length) {
        options.feedback.notify({
          level: 'error',
          title: `${failed.length} 個片段無法重設，請重新整理後再試`,
        })
      }
    } finally {
      deletePending.value = false
    }
  }

  function requestBatchAnalysisReset(rallies: readonly CoachRally[]) {
    const targets = rallies
      .filter(rally => rally.submission.analysis?.status === 'completed')
      .map(rally => ({ rallyId: rally.id, submissionId: rally.submission.id }))
    if (!targets.length || deletePending.value) return
    options.confirmation.open({
      id: 'rally-analysis-batch-reset',
      title: `刪除 ${targets.length} 個片段的分析`,
      message: `確認後會永久刪除這 ${targets.length} 個片段的 submission、裁切檔與分析資料，再還原成待送出草稿；START／END、Keypoint 與人工球種都會保留。`,
      confirmLabel: `刪除 ${targets.length} 個分析`,
      danger: true,
      onConfirm: () => resetAnalysisBatch(targets),
    })
  }

  function requestAnalysisDelete(rallyId: string, submissionId: string) {
    options.confirmation.open({
      id: 'rally-analysis-delete',
      title: '刪除分析並保留標記',
      message:
        '會永久刪除 submission、裁切檔與分析資料，片段則回到待送出狀態；START／END、Keypoint 與人工球種都會保留。',
      confirmLabel: '刪除分析，保留 Keypoint',
      danger: true,
      onConfirm: () => removeAnalysis(rallyId, submissionId, true),
    })
  }

  function requestDelete(targetRallyId?: string, targetSubmissionId?: string | null) {
    const rallyId = targetRallyId ?? options.selectedRallyId()
    if (!rallyId || (!targetRallyId && !options.clipSelected())) return
    const submissionId =
      targetSubmissionId === undefined ? options.selectedSubmissionId() : targetSubmissionId
    options.confirmation.open({
      id: 'rally-delete',
      title: '刪除片段內容',
      message: submissionId
        ? '選擇要刪除的範圍。刪除整個片段會永久移除所有標記；只刪除分析則會保留 START／END 與 Keypoint，並回到待送出狀態。'
        : '此片段與相關資料會永久刪除；若仍在處理，工作會先中止。此動作無法復原。',
      confirmLabel: '刪除整個片段',
      ...(submissionId
        ? {
            secondaryLabel: '刪除分析，保留 Keypoint',
            onSecondary: () => requestAnalysisDelete(rallyId, submissionId),
          }
        : {}),
      danger: true,
      onConfirm: () => purge(rallyId),
    })
  }

  async function startNextSet(winningTeamId: string, target: SideSwapTarget | null) {
    await options.core.startNextSet({
      effectiveFromRallyId: target?.rallyId ?? null,
      matchId: options.matchId,
      winningTeamId,
    })
    await Promise.all([options.refreshMatch(), options.refreshCoach()])
    success('已標記本局最後回合，下一回合起進入新局')
  }

  function requestNextSet(side: 'left' | 'right') {
    if (!options.editReady()) return
    const target = resolvedSideSwapTarget.value
    if (!isCurrentSetWinnerTarget(target)) return
    const teamId =
      side === 'left'
        ? (target?.expectedLeftTeamId ?? options.leftTeam()?.id)
        : (target?.expectedRightTeamId ?? options.rightTeam()?.id)
    const team = teamId ? options.teamById(teamId) : null
    if (!team) return
    options.confirmation.open({
      id: `next-set-${side}`,
      title: '開啟新一局',
      message: `目前選取的${target?.label ?? '回合'}會標記為本局最後一回合，由${team.name}勝局。下一個回合起比分從 0 : 0 重新計算；這不會改動影片 PTS 或原始標註。若標錯，可直接刪除該局勝局結果。`,
      confirmLabel: '確認並開始',
      onConfirm: () => startNextSet(team.id, target),
    })
  }

  async function reopenLastSet(setId?: string, setNumber?: number) {
    if (reopenLastSetPending.value) return
    reopenLastSetPending.value = true
    try {
      await options.core.reopenLastSet({
        matchId: options.matchId,
        ...(setId ? { setId } : {}),
      })
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      success(setNumber ? `已刪除第 ${setNumber} 局勝局結果` : '已刪除最近勝局結果')
    } catch (cause) {
      throw error(cause, '無法刪除勝局結果')
    } finally {
      reopenLastSetPending.value = false
    }
  }

  function requestReopenLastSet(setId?: string, setNumber?: number) {
    if (!options.canReopenLastSet() || !options.editReady() || reopenLastSetPending.value) return
    const targetLabel = setNumber ? `第 ${setNumber} 局` : '最近一局'
    options.confirmation.open({
      id: setId ? `clear-set-winner-${setId}` : 'reopen-last-set',
      title: `刪除${targetLabel}勝局結果`,
      message: `${targetLabel}只會移除左／右勝利結果；回合、比分、START／END、球點、座標與分析資料都會保留。`,
      confirmLabel: '刪除勝局結果',
      danger: true,
      onConfirm: () => reopenLastSet(setId, setNumber),
    })
  }

  async function swapCurrentCourtSides(target = resolvedSideSwapTarget.value, confirmed = false) {
    if (!target || sideSwapPending.value || (sideSwapLocked.value && !confirmed)) return
    sideSwapPending.value = true
    try {
      await options.core.swapCourtSides({
        effectiveFromRallyOrdinal: target.effectiveFromRallyOrdinal,
        expectedLeftTeamId: target.expectedLeftTeamId,
        expectedRightTeamId: target.expectedRightTeamId,
        setId: target.setId,
      })
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      success(`${target.label}包含後續片段的左右隊伍已對調`)
    } catch (cause) {
      throw error(cause, '無法對調片段左右隊伍')
    } finally {
      sideSwapPending.value = false
    }
  }

  function requestCurrentSideSwap() {
    const target = resolvedSideSwapTarget.value
    if (!target || !options.editReady() || sideSwapLocked.value) return
    sideSwapConfirmationPending.value = true
    options.confirmation.open({
      id: 'swap-segment-sides',
      title: `從${target.label}對調左右`,
      message:
        '這會建立新的場地左右邊界：選取回合與之後的所有回合都套用反轉後的左右隊伍。之後仍可在另一個回合再次對調，且不會改動 PTS、球點或追蹤座標。',
      confirmLabel: '對調左右',
      onClose: () => {
        sideSwapConfirmationPending.value = false
      },
      onConfirm: () => {
        return swapCurrentCourtSides(target, true)
      },
    })
  }

  function requestRallySideSwap(rally: CoachRally) {
    if (sideSwapLocked.value || !options.editReady()) return
    const target: SideSwapTarget = {
      effectiveFromRallyOrdinal: rally.ordinal,
      expectedLeftTeamId: rally.submission.left_team_id,
      expectedRightTeamId: rally.submission.right_team_id,
      isDraft: false,
      label: `第 ${options.displayOrdinalFor?.(rally.id) ?? rally.display_ordinal} 回合起`,
      setId: rally.set_id,
    }
    options.confirmation.open({
      id: 'swap-rally-sides',
      title: `從第 ${options.displayOrdinalFor?.(rally.id) ?? rally.display_ordinal} 回合起對調左右`,
      message:
        '選取回合與之後的所有回合都會套用新的左右隊伍。這不會改動原始 PTS、球點或追蹤座標；之後仍可從其他回合再次切換。',
      confirmLabel: '對調左右',
      onClose: () => {
        sideSwapConfirmationPending.value = false
      },
      onConfirm: () => {
        return swapCurrentCourtSides(target, true)
      },
    })
  }

  async function updatePlacement(input: { rallyId: string; setNumber: number; ordinal: number }) {
    if (placementSaving.value) return
    placementSaving.value = true
    try {
      const placement = await options.coach.updateRallyPlacement(input)
      await options.refreshCoach()
      options.closePlacement()
      success(`已調整為第 ${placement.displaySetNumber} 局 · 回合 ${placement.displayOrdinal}`)
    } catch (cause) {
      options.feedback.notify({
        level: 'error',
        title: cause instanceof Error ? cause.message : '無法調整局與回合',
      })
    } finally {
      placementSaving.value = false
    }
  }

  const unregister = [
    options.actions.register<'left' | 'right', void>({
      id: 'segment.start-next-set',
      group: 'segment',
      label: '開啟新一局',
      availability: computed(() => ({
        enabled: isCurrentSetWinnerTarget(resolvedSideSwapTarget.value) && options.editReady(),
        pending: false,
        reason: '請先選取目前這一局的回合，再標記勝局',
      })),
      execute: requestNextSet,
    }),
    options.actions.register({
      id: 'segment.reopen-last-set',
      group: 'segment',
      label: '刪除勝局結果',
      availability: computed(() => ({
        enabled: options.canReopenLastSet() && options.editReady() && !reopenLastSetPending.value,
        pending: reopenLastSetPending.value,
        reason: '目前沒有可刪除的勝局結果',
      })),
      execute: (setId?: string) => requestReopenLastSet(setId),
    }),
    options.actions.register({
      id: 'segment.swap-current-sides',
      group: 'segment',
      label: '對調片段左右',
      resources: ['court-side-swap'],
      availability: computed(() => ({
        enabled:
          Boolean(resolvedSideSwapTarget.value) && options.editReady() && !sideSwapLocked.value,
        pending: sideSwapLocked.value,
        reason: '目前無法對調片段左右',
      })),
      execute: requestCurrentSideSwap,
    }),
    options.actions.register<CoachRally, void>({
      id: 'segment.swap-rally-sides',
      group: 'segment',
      label: '從此回合起對調左右',
      resources: ['court-side-swap'],
      availability: computed(() => ({
        enabled: options.editReady() && !sideSwapLocked.value,
        pending: sideSwapLocked.value,
        reason: '目前無法修正片段場地配置',
      })),
      execute: requestRallySideSwap,
    }),
    options.actions.register<{ rallyId: string; setNumber: number; ordinal: number }, void>({
      id: 'segment.update-placement',
      group: 'segment',
      label: '調整局與回合',
      availability: computed(() => ({
        enabled: !placementSaving.value,
        pending: placementSaving.value,
        reason: '局與回合正在儲存',
      })),
      execute: updatePlacement,
    }),
  ]

  return {
    sideSwapPending: readonly(sideSwapPending),
    reopenLastSetPending: readonly(reopenLastSetPending),
    placementSaving: readonly(placementSaving),
    deletePending: readonly(deletePending),
    affectsCurrentDraft,
    sideSwapTarget: resolvedSideSwapTarget,
    requestDelete,
    requestBatchAnalysisReset,
    resetAnalysisBatch,
    removeAnalysis,
    purge,
    requestNextSet,
    requestReopenLastSet,
    requestCurrentSideSwap,
    requestRallySideSwap,
    updatePlacement,
    dispose: () => unregister.forEach(stop => stop()),
  }
}

export type SegmentManagementService = ReturnType<typeof createSegmentManagementService>
