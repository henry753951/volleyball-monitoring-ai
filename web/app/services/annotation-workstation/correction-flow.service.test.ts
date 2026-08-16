import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { createCorrectionFlowService } from './correction-flow.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

function setup() {
  const outboxNeedsConfirmation = ref(false)
  const pendingCount = ref(0)
  const busy = ref(false)
  const state = ref<'OPEN' | 'READY'>('READY')
  const createCorrection = vi.fn().mockResolvedValue({ rally_id: 'draft-rally' })
  const selectRally = vi.fn().mockResolvedValue({ rally_id: 'draft-rally' })
  const edit = vi.fn().mockResolvedValue(undefined)
  const submitCorrection = vi.fn().mockResolvedValue(undefined)
  const cancelCorrection = vi.fn().mockResolvedValue({ rally_id: 'draft-rally' })
  const selectedRallies: Array<string | null> = []
  const timelineSelections: unknown[] = []
  const pointSelections: Array<string | null> = []
  const refreshCoach = vi.fn().mockResolvedValue(undefined)
  const requestResync = vi.fn()
  const feedback = createWorkstationFeedbackService()
  const service = createCorrectionFlowService({
    room: {
      outboxNeedsConfirmation,
      pendingCount,
      busy,
      createCorrection: createCorrection as unknown as (
        submissionId: string,
        options: { preserveAnalysisContacts: boolean; regenerateAnalysisContacts: boolean },
      ) => Promise<AnnotationRallySnapshot | null>,
      selectRally,
      edit,
      submitCorrection,
      cancelCorrection,
    },
    feedback,
    selectedSubmissionId: () => 'submission-1',
    pendingTimelineMove: () => false,
    selectedAnalysisRunId: () => 'analysis-1',
    loadedAnalysisRunId: () => 'analysis-1',
    analysisDirtyCount: () => 0,
    overlayContactCount: () => 3,
    annotationState: () => state.value,
    displayedCorrectionDraft: () => true,
    correctionContactIds: () => ['point-1', 'point-2'],
    correctionActive: () => true,
    correctionRallyId: () => 'draft-rally',
    displayedRallyId: () => 'draft-rally',
    selectRally: rallyId => selectedRallies.push(rallyId),
    setTimelineSelection: selection => timelineSelections.push(selection),
    setKeyPointSelection: keyPointId => pointSelections.push(keyPointId),
    requestCreateConfirmation: vi.fn(),
    requestSubmitConfirmation: vi.fn(),
    requestResync,
    refreshCoach,
  })
  return {
    service,
    feedback,
    outboxNeedsConfirmation,
    createCorrection,
    edit,
    submitCorrection,
    cancelCorrection,
    selectedRallies,
    timelineSelections,
    pointSelections,
    refreshCoach,
    requestResync,
  }
}

describe('createCorrectionFlowService', () => {
  it('routes outbox conflicts through the common recovery path', () => {
    const { service, feedback, outboxNeedsConfirmation, requestResync } = setup()
    outboxNeedsConfirmation.value = true
    service.requestCreate()
    expect(requestResync).toHaveBeenCalledOnce()
    expect(feedback.messages.value.at(-1)?.level).toBe('warning')
  })

  it('creates and selects the exact returned correction draft', async () => {
    const { service, createCorrection, selectedRallies, timelineSelections, pointSelections } =
      setup()
    await service.create('submission-1')
    expect(createCorrection).toHaveBeenCalledWith('submission-1', {
      preserveAnalysisContacts: false,
      regenerateAnalysisContacts: false,
    })
    expect(selectedRallies).toEqual(['draft-rally'])
    expect(timelineSelections).toEqual(['mask'])
    expect(pointSelections).toEqual([null])
  })

  it('removes regenerated contacts before submitting the successor', async () => {
    const { service, edit, submitCorrection, timelineSelections, pointSelections } = setup()
    await service.submit('regenerate')
    expect(edit.mock.calls).toEqual([
      ['DELETE_KEY_POINT', { keyPointId: 'point-1' }],
      ['DELETE_KEY_POINT', { keyPointId: 'point-2' }],
    ])
    expect(submitCorrection).toHaveBeenCalledOnce()
    expect(timelineSelections.at(-1)).toBe('segment')
    expect(pointSelections.at(-1)).toBeNull()
  })

  it('cancels the draft and returns selection to its restored rally', async () => {
    const { service, cancelCorrection, selectedRallies } = setup()
    await service.cancel()
    expect(cancelCorrection).toHaveBeenCalledWith('draft-rally')
    expect(selectedRallies).toEqual(['draft-rally'])
  })
})
