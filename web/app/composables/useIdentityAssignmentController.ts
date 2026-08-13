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
  savingTrackId: number | null
  error: string | null
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
    savingTrackId: null,
    error: null,
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
    busy: computed(() => state.loading || state.savingTrackId !== null),
  })

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
          identityMode: command.identityMode ?? 'from_here',
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
      state.error = cause instanceof Error ? cause.message : '儲存失敗'
    }
    finally {
      state.savingTrackId = null
    }
  }

  function continueAssignment(command: IdentityAssignmentCommand) {
    const current = view.model.track.byId(command.trackId)
    const player = view.model.players.byRosterEntry(command.rosterEntryId)
    if (command.rosterEntryId
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
      confirmReplacement,
      applyCorrection,
      setMappingCompleted,
      closeReplacement: () => { state.dialogs.replacement = null },
      closeCorrection: () => { state.dialogs.correction = null },
    },
  }
}
