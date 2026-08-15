import { computed, reactive, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'
import { useIdentityReplacementWarning } from '~/composables/useIdentityReplacementWarning'
import type { CoachMatchAnalytics } from '~/lib/coachDomain'
import { createIdentityAssignmentModel } from '~/lib/identityAssignmentModel'
import type {
  IdentityAssignmentCommand,
  IdentityCorrectionRequest,
  IdentityMode,
  IdentityReplacementRequest,
} from '~/types/identityAssignment'

interface IdentityAssignmentControllerOptions {
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
  dialogs: {
    replacement: IdentityReplacementRequest | null
    correction: IdentityCorrectionRequest | null
  }
}

export function useIdentityAssignmentController(options: IdentityAssignmentControllerOptions) {
  const service = useIdentityAssignmentService()
  const replacementWarning = useIdentityReplacementWarning()
  const state = reactive<IdentityAssignmentState>({
    analytics: null,
    loading: false,
    autoAssigning: false,
    savingTrackId: null,
    error: null,
    automaticAssignmentResult: null,
    dialogs: { replacement: null, correction: null },
  })
  const preferences = reactive({ replacementWarningEnabled: replacementWarning.enabled })
  let refreshGeneration = 0

  const model = computed(() => createIdentityAssignmentModel({
    analytics: state.analytics,
    analysisRunId: toValue(options.analysisRunId),
    currentFrame: options.currentFrame === undefined ? undefined : toValue(options.currentFrame),
  }))
  const view = reactive({
    model,
    busy: computed(() => state.loading || state.autoAssigning || state.savingTrackId !== null),
  })

  function assignmentErrorMessage(cause: unknown) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : null
    if (code === 'REID_OBSERVATION_NOT_FOUND') return '這個 Local ID 沒有 ReID 資料；請使用「只修正這個 Local ID」，或先重新執行 ReID'
    if (code === 'REID_IDENTITY_REQUIRED') return '這個 Local ID 尚未連到固定名單槽位；請先執行 ReID，或只修正目前片段'
    if (code === 'REID_TEAM_MISMATCH') return 'ReID 槽位與所選球員隊伍不一致；請只修正目前片段或重新執行 ReID'
    const message = cause instanceof Error ? cause.message : ''
    if (/run fixed-roster reid|no fixed-roster reid observation/i.test(message)) {
      return '這個 Local ID 尚無可沿用的 ReID 資料；請只修正目前片段或先重新執行 ReID'
    }
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
    }
    catch (cause) {
      if (generation === refreshGeneration) {
        state.error = cause instanceof Error ? cause.message : '無法載入球員指派'
      }
    }
    finally {
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
          identityMode: command.identityMode
            ?? (view.model.track.byId(command.trackId)?.gid_id ? 'from_here' : 'clip_only'),
        })
      }
      else {
        await service.clearTrackIdentity({ analysisRunId, trackId: command.trackId })
      }
      if (options.refreshAfterCommit) await refresh()
      options.onChanged?.()
      options.onCommitted?.()
    }
    catch (cause) {
      state.error = assignmentErrorMessage(cause)
    }
    finally {
      state.savingTrackId = null
    }
  }

  function continueAssignment(command: IdentityAssignmentCommand) {
    const current = view.model.track.byId(command.trackId)
    const player = view.model.players.byRosterEntry(command.rosterEntryId)
    if (command.scope !== 'gid'
      && command.rosterEntryId
      && current?.gid_id
      && current.roster_entry_id
      && current.roster_entry_id !== command.rosterEntryId
      && player) {
      state.dialogs.correction = {
        trackId: command.trackId,
        rosterEntryId: command.rosterEntryId,
        playerName: player.name,
      }
      return
    }
    void commit(command)
  }

  function requestAssignment(command: IdentityAssignmentCommand) {
    const current = view.model.track.byId(command.trackId)
    if ((current?.roster_entry_id ?? '') === command.rosterEntryId) return
    const conflict = view.model.track.conflictFor(command.trackId, command.rosterEntryId)
    const player = view.model.players.byRosterEntry(command.rosterEntryId)
    if (conflict && preferences.replacementWarningEnabled && player) {
      state.dialogs.replacement = {
        trackId: command.trackId,
        rosterEntryId: command.rosterEntryId,
        playerName: player.name,
        occupiedTrackId: conflict.track_id,
      }
      return
    }
    continueAssignment(command)
  }

  function requestGidAssignment(command: IdentityAssignmentCommand & { trackIds: number[] }) {
    if (!command.rosterEntryId) return
    const conflict = view.model.track.conflictForTracks(command.trackIds, command.rosterEntryId)
    const player = view.model.players.byRosterEntry(command.rosterEntryId)
    const scopedCommand = { ...command, scope: 'gid' as const, identityMode: 'from_here' as const }
    if (conflict && preferences.replacementWarningEnabled && player) {
      state.dialogs.replacement = {
        ...scopedCommand,
        playerName: player.name,
        occupiedTrackId: conflict.track_id,
      }
      return
    }
    void commit(scopedCommand)
  }

  function confirmReplacement() {
    const request = state.dialogs.replacement
    state.dialogs.replacement = null
    if (request) continueAssignment(request)
  }

  function applyCorrection(identityMode: IdentityMode) {
    const request = state.dialogs.correction
    state.dialogs.correction = null
    if (request) void commit({ ...request, identityMode })
  }

  async function setMappingCompleted(completed: boolean) {
    const analysisRunId = toValue(options.analysisRunId)
    if (!analysisRunId || state.loading) return
    state.loading = true
    state.error = null
    try {
      await service.setTrackIdentityMappingComplete({ analysisRunId, completed })
      options.onChanged?.()
    }
    catch (cause) {
      state.error = cause instanceof Error ? cause.message : '狀態更新失敗'
    }
    finally {
      state.loading = false
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
      state.automaticAssignmentResult = result.assigned_count > 0
        ? `已自動套用 ${result.assigned_count} 個 Local ID${result.unresolved_count ? `，另有 ${result.unresolved_count} 個需人工確認` : ''}`
        : result.unresolved_count > 0
          ? `沒有可沿用的既有關聯，仍有 ${result.unresolved_count} 個 Local ID 需人工確認`
          : '目前的 Local ID 都已完成分配'
      if (options.refreshAfterCommit) await refresh()
      options.onChanged?.()
    }
    catch (cause) {
      state.error = cause instanceof Error ? cause.message : 'ReID 自動分配失敗'
    }
    finally {
      state.autoAssigning = false
    }
  }

  watch([
    () => toValue(options.matchId),
    () => toValue(options.analysisRunId),
    () => options.enabled === undefined ? true : toValue(options.enabled),
    () => options.refreshKey === undefined ? null : toValue(options.refreshKey),
  ], () => void refresh(), { immediate: true })

  return {
    state,
    preferences,
    view,
    actions: {
      refresh,
      requestAssignment,
      requestGidAssignment,
      confirmReplacement,
      applyCorrection,
      applyAutomaticAssignments,
      setMappingCompleted,
      closeReplacement: () => { state.dialogs.replacement = null },
      closeCorrection: () => { state.dialogs.correction = null },
    },
  }
}
