import { computed, reactive, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { IdentityAssignmentService } from './identity-assignment.service'
import type { CoachMatchAnalytics, ReidJerseySuggestionRun } from '~/lib/coachDomain'
import { createIdentityAssignmentModel } from '~/lib/identityAssignmentModel'
import type {
  IdentityAssignmentCommand,
  IdentityCorrectionRequest,
  IdentityMode,
} from '~/types/identityAssignment'
import type { WorkstationActionManager } from './workstation-action.service'

export interface IdentityAssignmentControllerOptions {
  matchId: MaybeRefOrGetter<string>
  analysisRunId: MaybeRefOrGetter<string | null>
  currentFrame?: MaybeRefOrGetter<number | undefined>
  enabled?: MaybeRefOrGetter<boolean>
  refreshKey?: MaybeRefOrGetter<unknown>
  refreshAfterCommit?: boolean
  onChanged?: () => void
  onCommitted?: () => void
}

interface IdentityAssignmentState {
  analytics: CoachMatchAnalytics | null
  loading: boolean
  autoAssigning: boolean
  savingTrackId: number | null
  error: string | null
  automaticAssignmentResult: string | null
  reidJobAction: 'feature' | 'association' | null
  reidJobResult: string | null
  jerseySuggestionRun: ReidJerseySuggestionRun | null
  jerseySuggestionRequesting: boolean
  jerseySuggestionApplyingIds: string[]
  jerseySuggestionResult: string | null
  interactionSurface: 'panel' | 'popover'
  dialogs: {
    correction: IdentityCorrectionRequest | null
    jerseySuggestions: boolean
  }
}

export function createIdentityAssignmentControllerService(
  options: IdentityAssignmentControllerOptions,
  service: IdentityAssignmentService,
  manager?: WorkstationActionManager,
) {
  const state = reactive<IdentityAssignmentState>({
    analytics: null,
    loading: false,
    autoAssigning: false,
    savingTrackId: null,
    error: null,
    automaticAssignmentResult: null,
    reidJobAction: null,
    reidJobResult: null,
    jerseySuggestionRun: null,
    jerseySuggestionRequesting: false,
    jerseySuggestionApplyingIds: [],
    jerseySuggestionResult: null,
    interactionSurface: 'panel',
    dialogs: { correction: null, jerseySuggestions: false },
  })
  let refreshGeneration = 0
  let jobPollGeneration = 0
  let jobPollTimer: ReturnType<typeof setTimeout> | null = null
  let jerseyPollGeneration = 0
  let jerseyPollTimer: ReturnType<typeof setTimeout> | null = null

  const model = computed(() =>
    createIdentityAssignmentModel({
      analytics: state.analytics,
      analysisRunId: toValue(options.analysisRunId),
      currentFrame: options.currentFrame === undefined ? undefined : toValue(options.currentFrame),
    }),
  )
  const view = reactive({
    model,
    busy: computed(() => state.loading || state.autoAssigning || state.savingTrackId !== null),
  })

  function assignmentErrorMessage(cause: unknown) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : null
    if (code === 'REID_EVIDENCE_PENDING')
      return '新版 ReID evidence 尚在背景建立；目前仍會先保存此片段的球員指派'
    if (code === 'REID_TEAM_MISMATCH')
      return '這個 Local ID 的場側與所選球員隊伍不一致；請確認隊伍或只修正目前片段'
    if (code === 'REID_GID_CANNOT_LINK')
      return '這兩個人員群組曾在同一 frame 出現，不能合併；請選擇「GID 與球員配對錯了」來交換綁定'
    const message = cause instanceof Error ? cause.message : ''
    return message || '儲存失敗'
  }

  async function refresh() {
    const generation = ++refreshGeneration
    const enabled = options.enabled === undefined || toValue(options.enabled)
    const analysisRunId = toValue(options.analysisRunId)
    if (!enabled || !analysisRunId) {
      state.analytics = null
      return
    }
    state.loading = true
    state.error = null
    try {
      const analytics = await service.analytics(toValue(options.matchId))
      if (generation === refreshGeneration) state.analytics = analytics
    } catch (cause) {
      if (generation === refreshGeneration) {
        state.error = cause instanceof Error ? cause.message : '無法載入球員指派'
      }
    } finally {
      if (generation === refreshGeneration) state.loading = false
    }
  }

  async function commit(command: IdentityAssignmentCommand) {
    const analysisRunId = toValue(options.analysisRunId)
    if (!analysisRunId) return
    state.savingTrackId = command.trackId
    state.error = null
    try {
      if (command.rosterEntryId) {
        await service.assignTrackIdentity({
          analysisRunId,
          trackId: command.trackId,
          rosterEntryId: command.rosterEntryId,
          identityMode: command.identityMode ?? 'from_here',
        })
      } else {
        await service.clearTrackIdentity({ analysisRunId, trackId: command.trackId })
      }
      if (options.refreshAfterCommit) await refresh()
      options.onChanged?.()
      options.onCommitted?.()
    } catch (cause) {
      state.error = assignmentErrorMessage(cause)
    } finally {
      state.savingTrackId = null
    }
  }

  function continueAssignment(command: IdentityAssignmentCommand) {
    const current = view.model.track.byId(command.trackId)
    const rosterEntryId = command.rosterEntryId
    const player = rosterEntryId ? view.model.players.byRosterEntry(rosterEntryId) : null
    const occupied = command.rosterEntryId
      ? view.model.track.conflictFor(command.trackId, command.rosterEntryId)
      : null
    if (
      command.scope !== 'gid' &&
      command.rosterEntryId &&
      current?.gid_id &&
      (occupied ||
        (current.roster_entry_id && current.roster_entry_id !== command.rosterEntryId)) &&
      player
    ) {
      const previousPlayer = current.roster_entry_id
        ? view.model.players.byRosterEntry(current.roster_entry_id)
        : null
      state.dialogs.correction = {
        trackId: command.trackId,
        rosterEntryId: command.rosterEntryId,
        playerName: player.name,
        previousPlayerName: previousPlayer?.name ?? null,
        occupiedGidLabel: occupied ? view.model.track.gidLabel(occupied) : null,
        occupiedTrackId: occupied?.track_id ?? null,
        swapCandidates: view.model.track.gidBindingsForRoster(
          command.trackId,
          command.rosterEntryId,
        ),
      }
      return
    }
    void commit(command)
  }

  function requestAssignment(command: IdentityAssignmentCommand) {
    const current = view.model.track.byId(command.trackId)
    if ((current?.roster_entry_id ?? '') === command.rosterEntryId) return
    continueAssignment(command)
  }

  function requestGidAssignment(command: IdentityAssignmentCommand & { trackIds: number[] }) {
    const rosterEntryId = command.rosterEntryId
    if (!rosterEntryId) return
    const conflict = view.model.track.conflictForTracks(command.trackIds, rosterEntryId)
    const player = view.model.players.byRosterEntry(rosterEntryId)
    const scopedCommand = {
      ...command,
      rosterEntryId,
      scope: 'gid' as const,
      identityMode: 'from_here' as const,
    }
    if (conflict && player) {
      const current = view.model.track.byId(command.trackId)
      state.dialogs.correction = {
        trackId: command.trackId,
        rosterEntryId,
        playerName: player.name,
        previousPlayerName: current?.roster_entry_id
          ? (view.model.players.byRosterEntry(current.roster_entry_id)?.name ?? null)
          : null,
        occupiedGidLabel: view.model.track.gidLabel(conflict),
        occupiedTrackId: conflict.track_id,
        swapCandidates: view.model.track.gidBindingsForRoster(command.trackId, rosterEntryId),
      }
      return
    }
    void commit(scopedCommand)
  }

  async function commitGidSwap(request: IdentityCorrectionRequest, targetPersonClusterId: string) {
    const analysisRunId = toValue(options.analysisRunId)
    if (!analysisRunId) return
    state.savingTrackId = request.trackId
    state.error = null
    try {
      await service.swapTrackGidRosterBindings({
        analysisRunId,
        trackId: request.trackId,
        targetPersonClusterId,
        reason: `operator confirmed co-visible GID swap for Local ${request.trackId}`,
      })
      if (options.refreshAfterCommit) await refresh()
      options.onChanged?.()
      options.onCommitted?.()
    } catch (cause) {
      state.error = assignmentErrorMessage(cause)
    } finally {
      state.savingTrackId = null
    }
  }

  async function applyCorrection(identityMode: IdentityMode) {
    const request = state.dialogs.correction
    state.dialogs.correction = null
    if (!request) return
    const occupiedTrack =
      request.occupiedTrackId === null ? null : view.model.track.byId(request.occupiedTrackId)
    if (identityMode === 'from_here' && occupiedTrack?.gid_id) {
      await commitGidSwap(request, occupiedTrack.gid_id)
      return
    }
    await commit({ ...request, identityMode })
  }

  async function swapGidBinding(targetPersonClusterId: string) {
    const request = state.dialogs.correction
    state.dialogs.correction = null
    if (!request) return
    await commitGidSwap(request, targetPersonClusterId)
  }

  function stopJerseyPolling() {
    jerseyPollGeneration += 1
    if (jerseyPollTimer) clearTimeout(jerseyPollTimer)
    jerseyPollTimer = null
  }

  async function pollJerseySuggestions(runId: string, generation: number) {
    try {
      const run = await service.reidJerseySuggestionRun(runId)
      if (generation !== jerseyPollGeneration || !run) return
      state.jerseySuggestionRun = run
      const completed = run.items.filter(item =>
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(item.status),
      ).length
      if (run.status === 'COMPLETED') {
        state.jerseySuggestionRequesting = false
        state.jerseySuggestionResult = `背號感知完成 ${completed}/${run.items.length}；請檢查差異後再套用。`
        state.dialogs.jerseySuggestions = true
        return
      }
      if (['FAILED', 'CANCELLED'].includes(run.status)) {
        state.jerseySuggestionRequesting = false
        state.error = run.error_message || '背號感知未完成，未修改任何球員指派'
        return
      }
      state.jerseySuggestionResult = `背號感知處理中 ${completed}/${run.items.length}；不影響目前的人工指派。`
      jerseyPollTimer = setTimeout(() => void pollJerseySuggestions(runId, generation), 2_000)
    } catch {
      if (generation !== jerseyPollGeneration) return
      state.jerseySuggestionResult = '暫時無法取得背號感知進度，系統會自動重試。'
      jerseyPollTimer = setTimeout(() => void pollJerseySuggestions(runId, generation), 4_000)
    }
  }

  async function requestJerseySuggestions() {
    const analysisRunId = toValue(options.analysisRunId)
    if (!analysisRunId || state.jerseySuggestionRequesting) return
    stopJerseyPolling()
    state.jerseySuggestionRequesting = true
    state.jerseySuggestionRun = null
    state.jerseySuggestionResult = '正在建立背號感知工作…'
    state.error = null
    const runId = crypto.randomUUID()
    try {
      await service.requestReidJerseySuggestions({ runId, analysisRunId })
      const generation = jerseyPollGeneration
      await pollJerseySuggestions(runId, generation)
    } catch (cause) {
      state.jerseySuggestionRequesting = false
      state.error = cause instanceof Error ? cause.message : '無法啟動背號感知'
    }
  }

  async function applyJerseySuggestions(suggestionIds: string[]) {
    const run = state.jerseySuggestionRun
    const pendingIds = [
      ...new Set(
        suggestionIds.filter(id =>
          run?.items.some(
            item =>
              item.suggestion_id === id &&
              item.changed &&
              item.suggested_roster_entry_id &&
              !item.applied_at,
          ),
        ),
      ),
    ]
    if (!pendingIds.length) return
    state.jerseySuggestionApplyingIds = pendingIds
    state.error = null
    let applied = 0
    const failures: string[] = []
    for (const suggestionId of pendingIds) {
      try {
        await service.applyReidJerseySuggestion(suggestionId)
        applied += 1
        const item = run?.items.find(candidate => candidate.suggestion_id === suggestionId)
        if (item) item.applied_at = new Date().toISOString()
      } catch (cause) {
        const item = run?.items.find(candidate => candidate.suggestion_id === suggestionId)
        failures.push(
          `${item ? `Local ${item.track_id}` : suggestionId}: ${assignmentErrorMessage(cause)}`,
        )
      }
    }
    state.jerseySuggestionApplyingIds = []
    state.jerseySuggestionResult = failures.length
      ? `已套用 ${applied} 筆；${failures.length} 筆保留未變更，請回到 Local 列表人工確認。`
      : `已套用 ${applied} 筆背號建議；其餘 Local ID 保持原狀。`
    if (failures.length) state.error = failures.join('；')
    if (options.refreshAfterCommit && applied) await refresh()
    if (applied) {
      options.onChanged?.()
      options.onCommitted?.()
    }
  }

  async function applyAutomaticAssignments() {
    const analysisRunId = toValue(options.analysisRunId)
    if (!analysisRunId || state.autoAssigning) return
    state.autoAssigning = true
    state.error = null
    state.automaticAssignmentResult = null
    try {
      const response = await service.applyReidAutomaticAssignments({ analysisRunId })
      const result = response.applyReidAutomaticAssignments
      state.automaticAssignmentResult =
        result.assigned_count > 0
          ? `已自動套用 ${result.assigned_count} 個 Local ID${result.unresolved_count ? `，另有 ${result.unresolved_count} 個需人工確認` : ''}`
          : result.unresolved_count > 0
            ? `沒有可沿用的既有關聯，仍有 ${result.unresolved_count} 個 Local ID 需人工確認`
            : '目前的 Local ID 都已完成分配'
      if (options.refreshAfterCommit) await refresh()
      options.onChanged?.()
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : '套用最新配對失敗'
    } finally {
      state.autoAssigning = false
    }
  }

  function stopJobPolling() {
    jobPollGeneration += 1
    if (jobPollTimer) clearTimeout(jobPollTimer)
    jobPollTimer = null
  }

  async function pollReidJob(
    kind: 'feature' | 'association',
    requestId: string,
    generation: number,
  ) {
    try {
      const request =
        kind === 'feature'
          ? await service.reidFeatureRebuildRequest(requestId)
          : await service.reidAssociationRerunRequest(requestId)
      if (generation !== jobPollGeneration || !request) return
      if (request.status === 'COMPLETED') {
        state.reidJobAction = null
        state.reidJobResult =
          kind === 'feature'
            ? '特徵 generation 已完成並安全切換；Pose 沒有重跑。'
            : '重新配對已完成；人工指派仍保持優先。'
        if (options.refreshAfterCommit) await refresh()
        options.onChanged?.()
        return
      }
      if (['FAILED', 'CANCELLED'].includes(request.status)) {
        state.reidJobAction = null
        state.error =
          request.error_message || (kind === 'feature' ? '重新取特徵失敗' : '重新配對失敗')
        return
      }
      state.reidJobResult =
        request.status === 'RUNNING'
          ? kind === 'feature'
            ? '正在重新取特徵；可繼續進行人工指派。'
            : '正在以既有 evidence 重新配對；可繼續進行人工指派。'
          : '工作已排入佇列；可繼續進行人工指派。'
      jobPollTimer = setTimeout(() => void pollReidJob(kind, requestId, generation), 2_000)
    } catch {
      if (generation !== jobPollGeneration) return
      state.reidJobResult = '暫時無法取得背景工作狀態，系統會自動重試。'
      jobPollTimer = setTimeout(() => void pollReidJob(kind, requestId, generation), 4_000)
    }
  }

  async function requestReidJob(kind: 'feature' | 'association') {
    const analysisRunId = toValue(options.analysisRunId)
    if (!analysisRunId || state.reidJobAction) return
    stopJobPolling()
    state.reidJobAction = kind
    state.reidJobResult = '正在建立背景工作…'
    state.error = null
    const requestId = crypto.randomUUID()
    try {
      if (kind === 'feature')
        await service.requestReidFeatureRebuild({
          requestId,
          analysisRunId,
          reason: 'operator requested feature rebuild from annotation identity panel',
        })
      else
        await service.requestReidAssociationRerun({
          requestId,
          analysisRunId,
          reason: 'operator requested association rerun from annotation identity panel',
        })
      const generation = jobPollGeneration
      await pollReidJob(kind, requestId, generation)
    } catch (cause) {
      state.reidJobAction = null
      state.error =
        cause instanceof Error
          ? cause.message
          : kind === 'feature'
            ? '重新取特徵失敗'
            : '重新配對失敗'
    }
  }

  const stopRefreshWatch = watch(
    [
      () => toValue(options.matchId),
      () => toValue(options.analysisRunId),
      () => (options.enabled === undefined ? true : toValue(options.enabled)),
      () => (options.refreshKey === undefined ? null : toValue(options.refreshKey)),
    ],
    () => void refresh(),
    { immediate: true },
  )
  const stopAnalysisRunWatch = watch(
    () => toValue(options.analysisRunId),
    () => {
      stopJobPolling()
      stopJerseyPolling()
      state.reidJobAction = null
      state.reidJobResult = null
      state.jerseySuggestionRun = null
      state.jerseySuggestionRequesting = false
      state.jerseySuggestionApplyingIds = []
      state.jerseySuggestionResult = null
      state.dialogs.jerseySuggestions = false
    },
  )
  const unregisterActions = manager
    ? [
        manager.register({
          id: 'identity.refresh',
          group: 'identity',
          label: '重新載入球員關聯',
          resources: ['identity-read'],
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)),
            pending: state.loading,
            reason: '請先選取已完成分析的片段',
          }),
          execute: refresh,
        }),
        manager.register<IdentityAssignmentCommand, void>({
          id: 'identity.assign',
          group: 'identity',
          label: '指派球員',
          resources: ['identity-write'],
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && state.savingTrackId === null,
            pending: state.savingTrackId !== null,
            reason: '請先選取已完成分析的片段',
          }),
          execute: requestAssignment,
        }),
        manager.register<IdentityAssignmentCommand, void>({
          id: 'identity.clear',
          group: 'identity',
          label: '清除球員關聯',
          resources: ['identity-write'],
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && state.savingTrackId === null,
            pending: state.savingTrackId !== null,
            reason: '請先選取已完成分析的片段',
          }),
          execute: command => requestAssignment({ ...command, rosterEntryId: null }),
        }),
        manager.register<IdentityAssignmentCommand & { trackIds: number[] }, void>({
          id: 'identity.assign-gid',
          group: 'identity',
          label: '指派跨片段球員群組',
          resources: ['identity-write'],
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && state.savingTrackId === null,
            pending: state.savingTrackId !== null,
            reason: '請先選取已完成分析的片段',
          }),
          execute: requestGidAssignment,
        }),
        manager.register({
          id: 'identity.apply-automatic',
          group: 'identity',
          label: '套用最新自動配對',
          resources: ['identity-write'],
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && !state.autoAssigning,
            pending: state.autoAssigning,
            reason: '請先選取已完成分析的片段',
          }),
          execute: applyAutomaticAssignments,
        }),
        manager.register({
          id: 'identity.feature-rebuild',
          group: 'identity',
          label: '重新取特徵',
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && state.reidJobAction === null,
            pending: state.reidJobAction === 'feature',
            reason: '請先等待目前的 ReID 背景工作完成',
          }),
          execute: () => requestReidJob('feature'),
        }),
        manager.register({
          id: 'identity.association-rerun',
          group: 'identity',
          label: '重新配對',
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && state.reidJobAction === null,
            pending: state.reidJobAction === 'association',
            reason: '請先等待目前的 ReID 背景工作完成',
          }),
          execute: () => requestReidJob('association'),
        }),
        manager.register({
          id: 'identity.jersey-suggestions',
          group: 'identity',
          label: '背號感知',
          availability: () => ({
            enabled: Boolean(toValue(options.analysisRunId)) && !state.jerseySuggestionRequesting,
            pending: state.jerseySuggestionRequesting,
            reason: '請先選取具備影片、逐 frame Pose 與 ReID evidence 的分析片段',
          }),
          execute: requestJerseySuggestions,
        }),
        manager.register<string[], void>({
          id: 'identity.apply-jersey-suggestions',
          group: 'identity',
          label: '套用選取的背號建議',
          resources: ['identity-write'],
          availability: () => ({
            enabled:
              state.dialogs.jerseySuggestions && state.jerseySuggestionApplyingIds.length === 0,
            pending: state.jerseySuggestionApplyingIds.length > 0,
            reason: '目前沒有可套用的背號建議',
          }),
          execute: applyJerseySuggestions,
        }),
        manager.register<IdentityMode, void>({
          id: 'identity.apply-correction',
          group: 'identity',
          label: '套用 ReID 人工修正範圍',
          resources: ['identity-write'],
          availability: () => ({
            enabled: state.dialogs.correction !== null,
            reason: '目前沒有待確認的 ReID 修正',
          }),
          execute: applyCorrection,
        }),
        manager.register<string, void>({
          id: 'identity.swap-gid-binding',
          group: 'identity',
          label: '交換兩個 GID 的球員綁定',
          resources: ['identity-write'],
          availability: () => ({
            enabled:
              state.dialogs.correction !== null &&
              state.dialogs.correction.swapCandidates.length > 0,
            reason: '目前沒有可交換的既有 GID',
          }),
          execute: swapGidBinding,
        }),
      ]
    : []
  function dispose() {
    stopRefreshWatch()
    stopAnalysisRunWatch()
    stopJobPolling()
    stopJerseyPolling()
    unregisterActions.forEach(unregister => unregister())
  }

  return {
    state,
    view,
    actions: {
      refresh,
      requestAssignment,
      requestGidAssignment,
      applyCorrection,
      swapGidBinding,
      applyAutomaticAssignments,
      requestFeatureRebuild: () => requestReidJob('feature'),
      requestAssociationRerun: () => requestReidJob('association'),
      requestJerseySuggestions,
      applyJerseySuggestions,
      setInteractionSurface: (surface: 'panel' | 'popover') => {
        state.interactionSurface = surface
      },
      closeCorrection: () => {
        state.dialogs.correction = null
      },
      closeJerseySuggestions: () => {
        state.dialogs.jerseySuggestions = false
      },
    },
    dispose,
  }
}
