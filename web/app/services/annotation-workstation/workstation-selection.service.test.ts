import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { createWorkstationSelectionService } from './workstation-selection.service'

describe('createWorkstationSelectionService', () => {
  it('keeps an explicit selection stable when the cursor enters another rally', () => {
    const localDraftRallyId = ref<string | null>(null)
    const cursorRallyId = ref<string | null>('rally-a')
    const availableRallyIds = ref<ReadonlySet<string>>(new Set(['rally-a', 'rally-b']))
    const selection = createWorkstationSelectionService({
      localDraftRallyId,
      cursorRallyId,
      availableRallyIds,
    })

    selection.selectRally('rally-a')
    cursorRallyId.value = 'rally-b'

    expect(selection.segment.value).toEqual({
      kind: 'timeline',
      rallyId: 'rally-a',
      source: 'explicit',
    })
  })

  it('keeps the client-owned draft distinct without treating peers as local state', () => {
    const localDraftRallyId = ref<string | null>('draft-local')
    const cursorRallyId = ref<string | null>('peer-draft')
    const availableRallyIds = ref<ReadonlySet<string>>(new Set(['draft-local', 'peer-draft']))
    const selection = createWorkstationSelectionService({
      localDraftRallyId,
      cursorRallyId,
      availableRallyIds,
    })

    expect(selection.segment.value).toEqual({
      kind: 'timeline',
      rallyId: 'peer-draft',
      source: 'cursor',
    })
    selection.selectRally('peer-draft')
    expect(selection.segment.value).toEqual({
      kind: 'timeline',
      rallyId: 'peer-draft',
      source: 'explicit',
    })
  })

  it('falls back safely when an explicit rally disappears after synchronization', () => {
    const availableRallyIds = ref<ReadonlySet<string>>(new Set(['rally-a', 'rally-b']))
    const cursorRallyId = ref<string | null>('rally-b')
    const selection = createWorkstationSelectionService({
      localDraftRallyId: ref(null),
      cursorRallyId,
      availableRallyIds,
    })

    selection.selectRally('rally-a')
    selection.selectKeyPoint('point-a')
    availableRallyIds.value = new Set(['rally-b'])

    expect(selection.activeRallyId.value).toBe('rally-b')
  })

  it('does not keep a local draft selected when the cursor leaves every segment', () => {
    const cursorRallyId = ref<string | null>('rally-a')
    const selection = createWorkstationSelectionService({
      localDraftRallyId: ref('draft-local'),
      cursorRallyId,
      availableRallyIds: ref<ReadonlySet<string>>(new Set(['draft-local', 'rally-a'])),
    })

    expect(selection.activeRallyId.value).toBe('rally-a')

    cursorRallyId.value = null

    expect(selection.segment.value).toEqual({ kind: 'none' })
    expect(selection.activeRallyId.value).toBeNull()
  })
})
