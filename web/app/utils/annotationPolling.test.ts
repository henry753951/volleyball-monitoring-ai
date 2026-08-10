import { describe, expect, it } from 'vitest'
import { captureNeedsPolling, hasActiveRallyProcessing } from './annotationPolling'

describe('annotation workstation polling policy', () => {
  it('polls only capture sessions whose timeline is still changing', () => {
    expect(captureNeedsPolling('STARTING')).toBe(true)
    expect(captureNeedsPolling('LIVE')).toBe(true)
    expect(captureNeedsPolling('STOPPING')).toBe(true)
    expect(captureNeedsPolling('FINISHED')).toBe(false)
    expect(captureNeedsPolling('FAILED')).toBe(false)
  })

  it('does not treat idle drafts or terminal rallies as active processing', () => {
    expect(hasActiveRallyProcessing([
      { processing_status: 'idle' },
      { processing_status: 'completed' },
      { processing_status: 'failed' },
    ])).toBe(false)
  })

  it('keeps polling while a clip or AI artifact is actually progressing', () => {
    expect(hasActiveRallyProcessing([{ processing_status: 'ai_processing' }])).toBe(true)
    expect(hasActiveRallyProcessing([{ processing_status: 'artifact_ingesting' }])).toBe(true)
  })
})
