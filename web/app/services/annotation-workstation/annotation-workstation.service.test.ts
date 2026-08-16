import { describe, expect, it, vi } from 'vitest'
import { createAnnotationWorkstationService } from './annotation-workstation.service'
import { createWorkstationActionManager } from './workstation-action.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

describe('createAnnotationWorkstationService', () => {
  it('uses the page action manager and feedback bus instead of creating isolated UI state', () => {
    const feedback = createWorkstationFeedbackService()
    const actions = createWorkstationActionManager({ feedback })
    actions.register({
      id: 'media.key-point-next',
      group: 'media',
      label: '下一個球點',
      execute: vi.fn(),
    })

    const service = createAnnotationWorkstationService({
      room: {} as never,
      model: {} as never,
      selection: {} as never,
      actions,
      feedback,
      playback: {
        togglePlayback: vi.fn(),
        stepFrame: vi.fn(),
        releaseFrame: vi.fn(),
        navigateKeyPoint: vi.fn(),
        seek: vi.fn(),
        previewSeek: vi.fn(),
        setRate: vi.fn(),
      },
      visualization: {
        setOverlayEnabled: vi.fn(),
        openSettings: vi.fn(),
      },
    })

    expect(service.actions).toBe(actions)
    expect(service.feedback).toBe(feedback)
    expect(service.actions.has('media.key-point-next')).toBe(true)
    expect(service.actions.has('visualization.open-settings')).toBe(true)

    service.dispose()

    expect(service.actions.has('media.key-point-next')).toBe(false)
  })
})
