import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createTransportActionService } from './transport-action.service'
import { createWorkstationActionManager } from './workstation-action.service'

describe('createTransportActionService', () => {
  it('keeps frame buttons enabled while the coalesced queue is in flight', async () => {
    const manager = createWorkstationActionManager()
    const frameMovePending = ref(false)
    const stepFrame = vi.fn()

    createTransportActionService({
      manager,
      playerReady: true,
      frameReady: true,
      frameMovePending,
      liveAvailable: false,
      correctionCreateEnabled: false,
      correctionCreateReason: null,
      correctionCreating: false,
      correctionCancelEnabled: false,
      correctionCancelling: false,
      processingRetryEnabled: false,
      navigableKeyPoints: false,
      navigableSegments: false,
      pointMoveEnabled: false,
      pointDeleteEnabled: false,
      clipDeleteEnabled: false,
      clipDownloadEnabled: false,
      togglePlayback: vi.fn(),
      stepFrame,
      goLive: vi.fn(),
      startCorrection: vi.fn(),
      cancelCorrection: vi.fn(),
      retryProcessing: vi.fn(),
      navigateKeyPoint: vi.fn(),
      navigateSegment: vi.fn(),
      movePoint: vi.fn(),
      deletePoint: vi.fn(),
      deleteClip: vi.fn(),
      downloadClip: vi.fn(),
      toggleMute: vi.fn(),
      setPlaybackRate: vi.fn(),
      resetTimelineZoom: vi.fn(),
    })

    frameMovePending.value = true

    expect(manager.state('media.frame-next').value.enabled).toBe(true)
    await manager.execute('media.frame-next')
    expect(stepFrame).toHaveBeenCalledWith('next', undefined, undefined)

    manager.dispose()
  })
})
