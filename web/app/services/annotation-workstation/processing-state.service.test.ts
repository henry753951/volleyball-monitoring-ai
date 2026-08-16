import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import { mergeRallyProcessingUpdate } from './processing-state.service'

function update(
  processingStatus: AnnotationRallyProcessingUpdate['processing_status'],
  submissionId: string,
  updatedAt: string,
): AnnotationRallyProcessingUpdate {
  return {
    schema_version: '2.0.0',
    type: 'rally_processing_update',
    room_id: 'room-1',
    rally_id: 'rally-1',
    submission_id: submissionId,
    processing_status: processingStatus,
    ai_job_id: null,
    worker_instance_key: null,
    provider_build_id: null,
    progress: processingStatus === 'completed' ? 1 : 0.5,
    stage: processingStatus,
    updated_at: updatedAt,
    analysis_id: null,
    analysis_data_version: null,
    error: null,
  }
}

describe('mergeRallyProcessingUpdate', () => {
  it('keeps a query-backed terminal state monotonic for the same submission', () => {
    const completed = update('completed', 'submission-1', '2026-08-16T18:37:18.902Z')
    const delayedProcessing = update('ai_processing', 'submission-1', '2026-08-16T18:37:19.000Z')
    expect(mergeRallyProcessingUpdate(completed, delayedProcessing)).toBe(completed)
  })

  it('accepts processing for a newer immutable submission', () => {
    const completed = update('completed', 'submission-1', '2026-08-16T18:37:18.902Z')
    const successor = update('ai_processing', 'submission-2', '2026-08-16T18:37:19.000Z')
    expect(mergeRallyProcessingUpdate(completed, successor)).toBe(successor)
  })

  it('accepts a realtime terminal state over an older non-terminal query projection', () => {
    const processing = update('ai_processing', 'submission-1', '2026-08-16T18:37:18.000Z')
    const completed = update('completed', 'submission-1', '2026-08-16T18:37:18.902Z')
    expect(mergeRallyProcessingUpdate(processing, completed)).toBe(completed)
  })
})
