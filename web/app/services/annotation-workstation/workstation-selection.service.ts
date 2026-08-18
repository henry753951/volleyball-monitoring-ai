import { computed, readonly, ref, toValue, type MaybeRefOrGetter } from 'vue'

export type WorkstationSegmentSelection =
  | { kind: 'none' }
  | { kind: 'local-draft'; rallyId: string }
  | { kind: 'timeline'; rallyId: string; source: 'cursor' | 'explicit' }

export type WorkstationDetailSelection =
  | { kind: 'none' }
  | { kind: 'key-point'; keyPointId: string }
  | { kind: 'analysis-track'; trackId: number }
  | { kind: 'analysis-contact'; contactId: string }

export interface WorkstationSelectionServiceOptions {
  localDraftRallyId: MaybeRefOrGetter<string | null>
  cursorRallyId: MaybeRefOrGetter<string | null>
  availableRallyIds: MaybeRefOrGetter<ReadonlySet<string>>
}

export function createWorkstationSelectionService(options: WorkstationSelectionServiceOptions) {
  const explicitRallyId = ref<string | null>(null)
  const detail = ref<WorkstationDetailSelection>({ kind: 'none' })

  const segment = computed<WorkstationSegmentSelection>(() => {
    const available = toValue(options.availableRallyIds)
    if (explicitRallyId.value && available.has(explicitRallyId.value)) {
      const localDraft = toValue(options.localDraftRallyId)
      return explicitRallyId.value === localDraft
        ? { kind: 'local-draft', rallyId: explicitRallyId.value }
        : { kind: 'timeline', rallyId: explicitRallyId.value, source: 'explicit' }
    }
    const cursorRally = toValue(options.cursorRallyId)
    if (cursorRally && available.has(cursorRally)) {
      const localDraft = toValue(options.localDraftRallyId)
      return cursorRally === localDraft
        ? { kind: 'local-draft', rallyId: cursorRally }
        : { kind: 'timeline', rallyId: cursorRally, source: 'cursor' }
    }
    // A draft can remain displayed for editing, but it is not the selected
    // segment when the cursor is outside every segment. Keeping it here made
    // the toolbar and worker status report a stale rally after the cursor left
    // its range.
    return { kind: 'none' }
  })

  const activeRallyId = computed(() =>
    segment.value.kind === 'none' ? null : segment.value.rallyId,
  )

  function selectRally(rallyId: string | null) {
    explicitRallyId.value = rallyId
    detail.value = { kind: 'none' }
  }

  function selectKeyPoint(keyPointId: string) {
    detail.value = { kind: 'key-point', keyPointId }
  }

  function selectAnalysisTrack(trackId: number) {
    detail.value = { kind: 'analysis-track', trackId }
  }

  function selectAnalysisContact(contactId: string) {
    detail.value = { kind: 'analysis-contact', contactId }
  }

  function clearDetail() {
    detail.value = { kind: 'none' }
  }

  function releaseExplicitRally() {
    explicitRallyId.value = null
    clearDetail()
  }

  return {
    explicitRallyId: readonly(explicitRallyId),
    detail: readonly(detail),
    segment,
    activeRallyId,
    selectRally,
    selectKeyPoint,
    selectAnalysisTrack,
    selectAnalysisContact,
    clearDetail,
    releaseExplicitRally,
  }
}
