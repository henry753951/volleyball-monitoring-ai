import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createWorkstationFeedbackService } from './workstation-feedback.service'
import { createWorkstationSelectionService } from './workstation-selection.service'
import { createTimelineSelectionService } from './timeline-selection.service'

function setup() {
  const cursorRallyId = ref<string | null>(null)
  const displayedRallyId = ref<string | null>('draft-1')
  const availableRallyIds = ref(new Set(['draft-1', 'rally-2', 'rally-3']))
  const selection = createWorkstationSelectionService({
    localDraftRallyId: displayedRallyId,
    cursorRallyId,
    availableRallyIds,
  })
  const room = { selectRally: vi.fn(async () => ({ rally_id: 'draft-1' })) }
  const seek = vi.fn(async () => undefined)
  const focusSegment = vi.fn()
  const feedback = createWorkstationFeedbackService()
  const notifications: string[] = []
  feedback.subscribe(message => notifications.push(message.title))
  const service = createTimelineSelectionService({
    room,
    selection,
    feedback,
    cursorRallyId,
    displayedRallyId: () => displayedRallyId.value,
    selectedKeyPointId: () =>
      selection.detail.value.kind === 'key-point' ? selection.detail.value.keyPointId : null,
    draftRallyIds: () => new Set(['draft-1']),
    seek,
    focusSegment,
    openAnalysis: vi.fn(),
  })
  return {
    service,
    selection,
    room,
    seek,
    focusSegment,
    notifications,
    cursorRallyId,
    displayedRallyId,
  }
}

const points = [
  { id: 'p1', captureTimeUs: '100', rallyId: 'draft-1', editable: true },
  { id: 'p2', captureTimeUs: '200', rallyId: 'draft-1', editable: true },
  { id: 'p3', captureTimeUs: '300', rallyId: 'rally-2', editable: false },
]

const segments = [
  { id: 'draft-1', startCaptureTimeUs: '100', endCaptureTimeUs: '150' },
  { id: 'rally-2', startCaptureTimeUs: '200', endCaptureTimeUs: '250' },
  { id: 'rally-3', startCaptureTimeUs: '300', endCaptureTimeUs: '350' },
]

describe('createTimelineSelectionService', () => {
  it('navigates in stable capture-time order from the explicit point', async () => {
    const context = setup()
    context.service.selectKeyPoint('p1')

    await context.service.navigate('next', points, '100')

    expect(context.selection.detail.value).toEqual({ kind: 'key-point', keyPointId: 'p2' })
    expect(context.seek).toHaveBeenCalledWith('200')
  })

  it('loads a local draft before selecting a point and ignores stale async results', async () => {
    const context = setup()
    let resolveFirst!: (value: { rally_id: string }) => void
    context.room.selectRally.mockImplementationOnce(
      () =>
        new Promise<{ rally_id: string }>(resolve => {
          resolveFirst = resolve
        }),
    )
    context.displayedRallyId.value = 'rally-2'

    const first = context.service.navigate('previous', points, '250')
    context.service.invalidateNavigation()
    resolveFirst({ rally_id: 'draft-1' })
    await first

    expect(context.selection.detail.value.kind).toBe('none')
    expect(context.seek).not.toHaveBeenCalled()
  })

  it('keeps cursor following separate from an explicit operator selection', () => {
    const context = setup()
    context.service.selectHistorical('rally-2', '0')
    context.service.followCursor('draft-1')

    expect(context.selection.explicitRallyId.value).toBe('rally-2')
    expect(context.service.selectedItem.value).toBe('segment')
  })

  it('keeps a historical key-point attached to its clicked segment', () => {
    const context = setup()
    context.service.selectKeyPoint('p3', 'rally-2')
    context.service.followCursor('rally-3')

    expect(context.selection.explicitRallyId.value).toBe('rally-2')
    expect(context.selection.detail.value).toEqual({ kind: 'key-point', keyPointId: 'p3' })
    expect(context.service.selectedItem.value).toBe('point')
  })

  it('uses the cursor instead of a previously selected point after the visual point selection is gone', async () => {
    const context = setup()
    context.service.selectKeyPoint('p1')
    await context.service.selectHistorical('rally-2', '0')

    await context.service.navigate('previous', points, '250')

    expect(context.selection.detail.value).toEqual({ kind: 'key-point', keyPointId: 'p2' })
    expect(context.seek).toHaveBeenCalledWith('200')
  })

  it('reports boundaries without changing the current selection', async () => {
    const context = setup()
    context.service.selectKeyPoint('p3')

    await context.service.navigate('next', points, '300')

    expect(context.notifications).toEqual(['已到最後一個擊球點'])
    expect(context.selection.detail.value).toEqual({ kind: 'key-point', keyPointId: 'p3' })
  })

  it('prioritizes an explicit segment selection over the cursor for segment navigation', async () => {
    const context = setup()
    await context.service.selectHistorical('rally-2', '0')
    context.cursorRallyId.value = 'draft-1'

    await context.service.navigateSegment('next', segments, '210')

    expect(context.selection.explicitRallyId.value).toBe('rally-3')
    expect(context.service.selectedItem.value).toBe('segment')
    expect(context.seek).toHaveBeenCalledWith('300')
    expect(context.focusSegment).toHaveBeenCalledWith(segments[2])
  })

  it('falls back to the cursor segment when there is no explicit selection', async () => {
    const context = setup()
    context.cursorRallyId.value = 'rally-2'

    await context.service.navigateSegment('previous', segments, '210')

    expect(context.room.selectRally).toHaveBeenCalledWith('draft-1')
    expect(context.selection.explicitRallyId.value).toBe('draft-1')
    expect(context.seek).toHaveBeenCalledWith('100')
    expect(context.focusSegment).toHaveBeenCalledWith(segments[0])
  })
})
