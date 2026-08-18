import { describe, expect, it } from 'vitest'
import {
  captureNeedsPolling,
  hasActiveRallyProcessing,
  nextCapturePollDelay,
} from './annotationPolling'

describe('annotation workstation polling policy', () => {
  it('polls only capture sessions whose timeline is still changing', () => {
    expect(captureNeedsPolling('STARTING')).toBe(true)
    expect(captureNeedsPolling('LIVE')).toBe(true)
    expect(captureNeedsPolling('STOPPING')).toBe(true)
    expect(captureNeedsPolling('FINISHED')).toBe(false)
    expect(captureNeedsPolling('FAILED')).toBe(false)
  })

  it('does not treat idle drafts or terminal rallies as active processing', () => {
    expect(
      hasActiveRallyProcessing([
        { processing_status: 'idle' },
        { processing_status: 'completed' },
        { processing_status: 'failed' },
      ]),
    ).toBe(false)
  })

  it('keeps polling while a clip or AI artifact is actually progressing', () => {
    expect(hasActiveRallyProcessing([{ processing_status: 'ai_processing' }])).toBe(true)
    expect(hasActiveRallyProcessing([{ processing_status: 'artifact_ingesting' }])).toBe(true)
  })

  it('backs off unchanged/error polling and snaps back when media advances', () => {
    expect(nextCapturePollDelay(2_500, 'unchanged')).toBe(3_375)
    expect(nextCapturePollDelay(5_000, 'unchanged')).toBe(5_000)
    expect(nextCapturePollDelay(5_000, 'failed')).toBe(9_000)
    expect(nextCapturePollDelay(15_000, 'failed')).toBe(15_000)
    expect(nextCapturePollDelay(15_000, 'changed')).toBe(1_000)
    expect(nextCapturePollDelay(1_000, 'skipped', false)).toBe(5_000)
  })
})
