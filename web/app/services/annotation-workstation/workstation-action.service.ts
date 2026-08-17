import {
  computed,
  readonly,
  ref,
  shallowReactive,
  toValue,
  type ComputedRef,
  type DeepReadonly,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

export type WorkstationActionId =
  | 'media.toggle-playback'
  | 'media.frame-previous'
  | 'media.frame-next'
  | 'media.key-point-previous'
  | 'media.key-point-next'
  | 'media.segment-previous'
  | 'media.segment-next'
  | 'media.go-live'
  | 'media.toggle-mute'
  | 'media.set-rate'
  | 'timeline.reset-zoom'
  | 'clip.download'
  | 'segment.toggle-boundary'
  | 'segment.reopen'
  | 'segment.void'
  | 'segment.delete-processing'
  | 'segment.start-next-set'
  | 'segment.swap-current-sides'
  | 'segment.swap-rally-sides'
  | 'segment.update-placement'
  | 'mark.contact'
  | 'mark.spike'
  | 'mark.event-success'
  | 'mark.event-failure'
  | 'mark.move'
  | 'mark.delete'
  | 'mark.set-event'
  | 'mark.set-actor'
  | 'outcome.left'
  | 'outcome.right'
  | 'outcome.unknown'
  | 'submission.submit'
  | 'correction.create'
  | 'correction.submit'
  | 'correction.cancel'
  | 'processing.retry'
  | 'analysis.enter-revision'
  | 'analysis.exit-revision'
  | 'analysis.apply'
  | 'analysis.discard'
  | 'analysis.recalculate'
  | 'analysis.approve'
  | 'analysis.add-contact'
  | 'analysis.delete-contact'
  | 'analysis.restore-contact'
  | 'analysis.select-contact'
  | 'analysis.adjust-contact-time'
  | 'analysis.reset-contact-time'
  | 'analysis.set-contact-no-actor'
  | 'analysis.clear-contact-actor'
  | 'analysis.mark-ball-missing'
  | 'analysis.clear-ball-override'
  | 'analysis.toggle-bbox-relabel'
  | 'analysis.clear-bbox-override'
  | 'analysis.set-action'
  | 'analysis.clear-action'
  | 'identity.assign'
  | 'identity.clear'
  | 'identity.refresh'
  | 'identity.assign-gid'
  | 'identity.apply-automatic'
  | 'identity.feature-rebuild'
  | 'identity.association-rerun'
  | 'identity.jersey-suggestions'
  | 'identity.apply-jersey-suggestions'
  | 'identity.apply-correction'
  | 'identity.swap-gid-binding'
  | 'sync.resync'
  | 'sync.discard-pending'
  | 'visualization.toggle-overlay'
  | 'visualization.open-settings'

export type WorkstationActionGroup =
  | 'media'
  | 'segment'
  | 'marking'
  | 'outcome'
  | 'submission'
  | 'correction'
  | 'processing'
  | 'analysis'
  | 'identity'
  | 'sync'
  | 'visualization'
  | 'timeline'
  | 'clip'

export interface WorkstationActionAvailability {
  visible: boolean
  enabled: boolean
  pending: boolean
  reason: string | null
}

export interface WorkstationActionDefinition<Payload = void, Result = unknown> {
  id: WorkstationActionId
  group: WorkstationActionGroup
  label: MaybeRefOrGetter<string>
  shortcut?: string
  resources?: readonly string[]
  availability?: MaybeRefOrGetter<Partial<WorkstationActionAvailability>>
  execute: (payload: Payload) => Result | Promise<Result>
}

export type WorkstationActionExecution<Result = unknown> =
  | { status: 'executed'; value: Result }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; error: Error }

export interface WorkstationActionView {
  id: WorkstationActionId
  group: WorkstationActionGroup
  label: string
  shortcut: string | null
  visible: boolean
  enabled: boolean
  pending: boolean
  reason: string | null
}

export interface WorkstationActionManager {
  runningActionIds: DeepReadonly<Ref<ReadonlySet<WorkstationActionId>>>
  register: <Payload, Result>(
    definition: WorkstationActionDefinition<Payload, Result>,
  ) => () => void
  state: (id: WorkstationActionId) => ComputedRef<WorkstationActionView>
  execute: <Result = unknown>(
    id: WorkstationActionId,
    payload?: unknown,
  ) => Promise<WorkstationActionExecution<Result>>
  has: (id: WorkstationActionId) => boolean
  dispose: () => void
}

const MISSING_ACTION_REASON = '此操作尚未在目前工作區註冊'
const ACTION_BUSY_REASON = '相關操作正在執行，請稍候'

export function createWorkstationActionManager(
  options: {
    feedback?: WorkstationFeedbackService
  } = {},
): WorkstationActionManager {
  const definitions = shallowReactive(
    new Map<WorkstationActionId, WorkstationActionDefinition<unknown, unknown>>(),
  )
  const runningActionIds = ref<ReadonlySet<WorkstationActionId>>(new Set())
  const lockedResources = new Set<string>()
  const lockRevision = ref(0)
  const stateCache = new Map<WorkstationActionId, ComputedRef<WorkstationActionView>>()
  let disposed = false

  function actionView(id: WorkstationActionId): WorkstationActionView {
    // Make resource locks observable without exposing a mutable collection.
    void lockRevision.value
    const definition = definitions.get(id)
    if (!definition) {
      return {
        id,
        group: id.split('.')[0] as WorkstationActionGroup,
        label: id,
        shortcut: null,
        visible: false,
        enabled: false,
        pending: false,
        reason: MISSING_ACTION_REASON,
      }
    }
    const declared = definition.availability ? toValue(definition.availability) : {}
    const resourcePending = definition.resources?.some(resource => lockedResources.has(resource))
    const pending =
      Boolean(declared.pending) || runningActionIds.value.has(id) || Boolean(resourcePending)
    const enabled = (declared.enabled ?? true) && !pending && !disposed
    return {
      id,
      group: definition.group,
      label: toValue(definition.label),
      shortcut: definition.shortcut ?? null,
      visible: declared.visible ?? true,
      enabled,
      pending,
      reason: enabled ? null : (declared.reason ?? (pending ? ACTION_BUSY_REASON : null)),
    }
  }

  function state(id: WorkstationActionId) {
    const cached = stateCache.get(id)
    if (cached) return cached
    const next = computed(() => actionView(id))
    stateCache.set(id, next)
    return next
  }

  function register<Payload, Result>(definition: WorkstationActionDefinition<Payload, Result>) {
    if (definitions.has(definition.id))
      throw new Error(`Duplicate workstation action: ${definition.id}`)
    definitions.set(definition.id, definition as WorkstationActionDefinition<unknown, unknown>)
    return () => {
      if (definitions.get(definition.id) === definition) definitions.delete(definition.id)
    }
  }

  async function execute<Result = unknown>(
    id: WorkstationActionId,
    payload?: unknown,
  ): Promise<WorkstationActionExecution<Result>> {
    const definition = definitions.get(id)
    const current = actionView(id)
    if (!definition || !current.enabled) {
      const reason = current.reason ?? MISSING_ACTION_REASON
      options.feedback?.notify({ level: 'warning', title: current.label, description: reason })
      return { status: 'blocked', reason }
    }
    runningActionIds.value = new Set([...runningActionIds.value, id])
    definition.resources?.forEach(resource => lockedResources.add(resource))
    lockRevision.value += 1
    try {
      const value = (await definition.execute(payload)) as Result
      return { status: 'executed', value }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('操作失敗')
      options.feedback?.notify({ level: 'error', title: current.label, description: error.message })
      return { status: 'failed', error }
    } finally {
      const running = new Set(runningActionIds.value)
      running.delete(id)
      runningActionIds.value = running
      definition.resources?.forEach(resource => lockedResources.delete(resource))
      lockRevision.value += 1
    }
  }

  function dispose() {
    disposed = true
    definitions.clear()
    stateCache.clear()
    lockedResources.clear()
    lockRevision.value += 1
    runningActionIds.value = new Set()
  }

  return {
    runningActionIds: readonly(runningActionIds),
    register,
    state,
    execute,
    has: id => definitions.has(id),
    dispose,
  }
}
