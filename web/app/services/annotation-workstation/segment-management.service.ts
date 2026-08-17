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
  currentSet: () => { id: string } | null
  leftTeam: () => TeamSummary | null
  rightTeam: () => TeamSummary | null
  currentDraft: () => boolean
  sideSwapEffectiveOrdinal: () => number
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
  const placementSaving = ref(false)
  const deletePending = ref(false)
  const affectsCurrentDraft = computed(options.currentDraft)
  let sideSwapOperationGeneration = 0

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
      await options.refreshCoach().catch(() => undefined)
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
      message: `確認後會永久刪除這 ${targets.length} 個片段的 submission、裁切檔與分析資料，再還原成待送出草稿；START／END、Keypoint、球種與擊球員覆寫都會保留。`,
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
        '會永久刪除 submission、裁切檔與分析資料，片段則回到待送出狀態；START／END、Keypoint、球種與擊球員覆寫都會保留。',
      confirmLabel: '刪除分析，保留 Keypoint',
      danger: true,
      onConfirm: () => removeAnalysis(rallyId, submissionId, true),
    })
  }

  function requestDelete() {
    const rallyId = options.selectedRallyId()
    if (!options.clipSelected() || !rallyId) return
    const submissionId = options.selectedSubmissionId()
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

  async function startNextSet(winningTeamId: string) {
    await options.core.startNextSet({ matchId: options.matchId, winningTeamId })
    await Promise.all([options.refreshMatch(), options.refreshCoach()])
    success('新一局已開始')
  }

  function requestNextSet(side: 'left' | 'right') {
    if (!options.currentSet() || !options.editReady()) return
    const team = side === 'left' ? options.leftTeam() : options.rightTeam()
    if (!team) return
    options.confirmation.open({
      id: `next-set-${side}`,
      title: '開啟新一局',
      message: `${team.name}取得本局，比分歸零並開始下一局。`,
      confirmLabel: '確認並開始',
      onConfirm: () => startNextSet(team.id),
    })
  }

  async function swapCurrentCourtSides(affectsCurrentDraft: boolean) {
    const set = options.currentSet()
    const left = options.leftTeam()
    const right = options.rightTeam()
    if (!set || !left || !right || sideSwapPending.value) return
    sideSwapPending.value = true
    try {
      await options.core.swapCourtSides({
        effectiveFromRallyOrdinal: options.sideSwapEffectiveOrdinal(),
        expectedLeftTeamId: left.id,
        expectedRightTeamId: right.id,
        setId: set.id,
      })
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      success(
        affectsCurrentDraft ? '目前片段與後續片段的左右隊伍已對調' : '下一片段的左右隊伍已對調',
      )
    } catch (cause) {
      throw error(cause, '無法對調片段左右隊伍')
    } finally {
      sideSwapPending.value = false
    }
  }

  function requestCurrentSideSwap() {
    const set = options.currentSet()
    const left = options.leftTeam()
    const right = options.rightTeam()
    if (!set || !left || !right || !options.editReady() || sideSwapPending.value) return
    const affectsCurrentDraft = options.currentDraft()
    options.confirmation.open({
      id: 'swap-segment-sides',
      title: affectsCurrentDraft ? '對調目前片段左右' : '對調下一片段左右',
      message: affectsCurrentDraft
        ? `將目前片段改為左側 ${right.name}、右側 ${left.name}；畫面上的隊名、比分歸屬、球員判斷與後續片段都會使用新的左右順序。`
        : `下一個片段將從左側 ${right.name}、右側 ${left.name} 開始；畫面上的隊名、比分歸屬、球員判斷與後續片段都會使用新的左右順序。`,
      confirmLabel: '對調左右',
      onConfirm: () => swapCurrentCourtSides(affectsCurrentDraft),
    })
  }

  async function swapCompletedRallySides(rally: CoachRally) {
    if (sideSwapPending.value) return
    const operation = ++sideSwapOperationGeneration
    let draftCreated = false
    sideSwapPending.value = true
    try {
      await options.room.createCorrection(rally.submission.id, { reverseCourtSides: true })
      draftCreated = true
      if (operation !== sideSwapOperationGeneration) return
      options.selection.selectRally(rally.id)
      options.timeline.selectMask(rally.id)
      await options.room.submitCorrection()
      if (operation !== sideSwapOperationGeneration) return
      await options.timeline.selectHistorical(rally.id, '0')
      await Promise.all([options.refreshMatch(), options.refreshCoach()])
      success('片段場地配置已修正，隊伍名牌與得分歸屬已更新')
    } catch (cause) {
      await options.refreshCoach().catch(() => undefined)
      throw new Error(
        `${cause instanceof Error ? cause.message : '無法修正片段場地配置'}${
          draftCreated ? '；修正草稿仍保留，可取消修正以還原' : ''
        }`,
      )
    } finally {
      sideSwapPending.value = false
    }
  }

  function requestRallySideSwap(rally: CoachRally) {
    if (
      rally.submission.analysis?.status !== 'completed' ||
      sideSwapPending.value ||
      !options.editReady()
    )
      return
    const left = options.teamById(rally.submission.left_team_id)
    const right = options.teamById(rally.submission.right_team_id)
    options.confirmation.open({
      id: 'swap-rally-sides',
      title: '修正此片段的場地配置',
      message: `將${left?.name ?? '此片段左側隊伍'}與${right?.name ?? '右側隊伍'}的名牌、得分歸屬及球員指派規則交換。既有球場座標、球路與追蹤框不翻轉；不符合新隊伍的手動球員指派會清除。系統會建立新的不可變修正版，原版本保留於歷程。`,
      confirmLabel: '建立並套用修正',
      onConfirm: () => swapCompletedRallySides(rally),
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
        enabled: Boolean(options.currentSet()) && options.editReady(),
        pending: false,
        reason: '目前無法開啟新一局',
      })),
      execute: requestNextSet,
    }),
    options.actions.register({
      id: 'segment.swap-current-sides',
      group: 'segment',
      label: '對調片段左右',
      availability: computed(() => ({
        enabled:
          Boolean(options.currentSet() && options.leftTeam() && options.rightTeam()) &&
          options.editReady() &&
          !sideSwapPending.value,
        pending: sideSwapPending.value,
        reason: '目前無法對調片段左右',
      })),
      execute: requestCurrentSideSwap,
    }),
    options.actions.register<CoachRally, void>({
      id: 'segment.swap-rally-sides',
      group: 'segment',
      label: '修正片段場地配置',
      availability: computed(() => ({
        enabled: options.editReady() && !sideSwapPending.value,
        pending: sideSwapPending.value,
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
    placementSaving: readonly(placementSaving),
    deletePending: readonly(deletePending),
    affectsCurrentDraft,
    requestDelete,
    requestBatchAnalysisReset,
    resetAnalysisBatch,
    removeAnalysis,
    purge,
    requestNextSet,
    requestCurrentSideSwap,
    requestRallySideSwap,
    updatePlacement,
    dispose: () => unregister.forEach(stop => stop()),
  }
}

export type SegmentManagementService = ReturnType<typeof createSegmentManagementService>
