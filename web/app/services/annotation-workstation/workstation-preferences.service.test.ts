import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkstationFeedbackService } from './workstation-feedback.service'
import { createWorkstationPreferencesService } from './workstation-preferences.service'

beforeEach(() => localStorage.clear())

describe('workstation preferences service', () => {
  it('persists overlay choice per browser and restores it', () => {
    const options = {
      matchId: 'match-1',
      core: { updateMatchClipPolicy: vi.fn() } as never,
      feedback: createWorkstationFeedbackService(),
      refreshCoach: vi.fn(),
    }
    const first = createWorkstationPreferencesService(options)
    first.setOverlayEnabled(false)
    const restored = createWorkstationPreferencesService(options)

    expect(restored.overlayEnabled.value).toBe(false)
  })

  it('updates the match clip policy once and exposes pending/error state', async () => {
    const updatedMatch = { id: 'match-1' }
    const onMatchUpdated = vi.fn()
    const refreshCoach = vi.fn().mockResolvedValue(undefined)
    const updateMatchClipPolicy = vi.fn().mockResolvedValue(updatedMatch)
    const service = createWorkstationPreferencesService({
      matchId: 'match-1',
      core: { updateMatchClipPolicy } as never,
      feedback: createWorkstationFeedbackService(),
      refreshCoach,
      onMatchUpdated: onMatchUpdated as never,
    })

    await service.updateClipPolicy(2, 4)

    expect(updateMatchClipPolicy).toHaveBeenCalledWith({
      matchId: 'match-1',
      preRollSeconds: 2,
      postRollSeconds: 4,
    })
    expect(onMatchUpdated).toHaveBeenCalledWith(updatedMatch)
    expect(refreshCoach).toHaveBeenCalledOnce()
    expect(service.clipPolicySaving.value).toBe(false)
    expect(service.clipPolicyError.value).toBeNull()
  })
})
