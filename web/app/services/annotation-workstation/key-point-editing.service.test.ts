import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkstationFeedbackService } from './workstation-feedback.service'
import { createKeyPointEditingService } from './key-point-editing.service'

function snapshot() {
  return {
    rally_id: 'rally-1',
    snapshot: {
      key_points: [
        {
          key_point_id: 'point-1',
          capture_time_us: '1000000',
          capture_frame_index: 25,
          timing_precision: 'exact',
        },
      ],
    },
  } as unknown as AnnotationRallySnapshot
}

function setup() {
  const roomSnapshot = shallowRef(snapshot())
  const edit = vi.fn().mockResolvedValue(undefined)
  const feedback = createWorkstationFeedbackService()
  const frameStep = vi
    .fn()
    .mockImplementation(
      async (request: {
        capture_frame_index: string
        direction: 'previous' | 'next'
        count: number
      }) => {
        const base = Number(request.capture_frame_index)
        const target = base + (request.direction === 'next' ? request.count : -request.count)
        return {
          playback_window_id: 'window-1',
          mapping_version: 1,
          player_media_time_us: String(target * 40_000),
          capture_time_us: String(target * 40_000),
          capture_frame_index: String(target),
        }
      },
    )
  const resolve = vi.fn().mockResolvedValue({ capture_time_us: '1040000' })
  const dvrCreate = vi.fn().mockResolvedValue({
    playback_window_id: 'window-2',
    mapping_version: 2,
    window_capture_start_us: '0',
    window_capture_end_us: '5000000',
    presentation_origin_capture_us: '0',
  })
  const room = {
    snapshot: roomSnapshot,
    edit,
    setEditingKeyPoint: vi.fn(),
    lastKeyPoint: shallowRef(null),
  }
  const overlay = {
    seekCanonicalFrame: vi.fn(() => true),
    seekCaptureTimeIfBuffered: vi.fn(() => true),
    previewPlayerMediaTime: vi.fn(() => true),
  }
  const video = { pause: vi.fn(), currentTime: 1 }
  let selectedKeyPointId: string | null = 'point-1'
  const service = createKeyPointEditingService({
    room: room as never,
    dvr: { create: dvrCreate, resolve } as never,
    media: { frameStep } as never,
    feedback,
    selectedCapture: () => ({ id: 'capture-1' }),
    descriptor: () =>
      ({
        playback_window_id: 'window-1',
        mapping_version: 1,
        window_capture_start_us: '0',
        window_capture_end_us: '5000000',
        presentation_origin_capture_us: '0',
      }) as never,
    video: () => video,
    overlay: () => overlay,
    selectedKeyPointId: () => selectedKeyPointId,
    selectKeyPoint: value => {
      selectedKeyPointId = value
    },
    editable: () => true,
    commandReady: () => true,
    editReady: () => true,
    estimatedFrameSeconds: () => 0.04,
    observedCursor: () => null,
    setObservedCursor: vi.fn(),
    setCursorReady: vi.fn(),
    clipPreRollUs: () => 100_000n,
    clipPostRollUs: () => 100_000n,
    protectedSegments: () => [],
    prepareAuthoritativeSeek: vi.fn(),
    clearGestureOwner: vi.fn(),
  })
  return { service, room, overlay, frameStep, dvrCreate, feedback }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('key-point editing service', () => {
  it('projects optimistic time without mutating the authoritative snapshot', () => {
    const { service, room } = setup()
    service.preview('point-1', '1250000')

    const projected = service.projectSnapshot(room.snapshot.value)

    expect(projected?.snapshot.key_points[0]?.capture_time_us).toBe('1250000')
    expect(room.snapshot.value.snapshot.key_points[0]?.capture_time_us).toBe('1000000')
  })

  it('rejects a move whose padded clip overlaps another segment', () => {
    const context = setup()
    context.service.dispose()
    const source = snapshot()
    const room = {
      snapshot: shallowRef(source),
      edit: vi.fn(),
      setEditingKeyPoint: vi.fn(),
      lastKeyPoint: shallowRef(null),
    }
    const service = createKeyPointEditingService({
      room: room as never,
      dvr: {} as never,
      media: {} as never,
      feedback: createWorkstationFeedbackService(),
      selectedCapture: () => ({ id: 'capture-1' }),
      descriptor: () => null,
      video: () => null,
      overlay: () => null,
      selectedKeyPointId: () => 'point-1',
      selectKeyPoint: vi.fn(),
      editable: () => true,
      commandReady: () => true,
      editReady: () => true,
      estimatedFrameSeconds: () => null,
      observedCursor: () => null,
      setObservedCursor: vi.fn(),
      setCursorReady: vi.fn(),
      clipPreRollUs: () => 100_000n,
      clipPostRollUs: () => 100_000n,
      protectedSegments: () => [
        { id: 'rally-2', startCaptureTimeUs: '1000000', endCaptureTimeUs: '1300000' },
      ],
      prepareAuthoritativeSeek: vi.fn(),
      clearGestureOwner: vi.fn(),
    })

    expect(service.wouldOverlap('point-1', '1100000')).toBe(true)
    service.dispose()
  })

  it('commits a buffered drag only after its matching authoritative cursor resolves', async () => {
    vi.useFakeTimers()
    const { service, room } = setup()
    await service.move('point-1', '1250000')

    expect(service.pendingMove.value).toEqual({
      keyPointId: 'point-1',
      playbackWindowId: 'window-1',
    })
    const cursor = {
      schema_version: '1.0.0',
      playback_window_id: 'window-1',
      mapping_version: 1,
      player_media_time_us: '1250000',
    } as never
    const handled = await service.completeResolvedMove(cursor, {
      capture_time_us: '1250000',
    } as never)

    expect(handled).toBe(true)
    expect(room.edit).toHaveBeenCalledWith('MOVE_KEY_POINT', {
      keyPointId: 'point-1',
      cursor,
      observation: {
        capture_time_us: '1250000',
        capture_frame_index: undefined,
      },
    })
    expect(service.pendingMove.value).toBeNull()
    service.dispose()
  })

  it('previews and flushes repeated key-point nudges before the held key is released', async () => {
    vi.useFakeTimers()
    const { service, room, overlay, frameStep } = setup()

    service.nudge('next', 1, 'keyboard')

    expect(overlay.previewPlayerMediaTime).toHaveBeenCalledWith(1.04)
    expect(frameStep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(80)
    expect(frameStep).toHaveBeenCalledWith(expect.objectContaining({ direction: 'next', count: 1 }))
    expect(room.edit).toHaveBeenCalledWith(
      'MOVE_KEY_POINT',
      expect.objectContaining({ keyPointId: 'point-1' }),
    )

    service.navigation.release('next')
    await vi.runAllTimersAsync()
    service.dispose()
  })

  it('uses the last resolved frame as the base for a queued rapid nudge', async () => {
    vi.useFakeTimers()
    const context = setup()
    let resolveFirst!: (value: unknown) => void
    const firstStep = new Promise(resolve => {
      resolveFirst = resolve
    })
    context.frameStep.mockImplementationOnce(() => firstStep)

    context.service.nudge('next', 1, 'keyboard')
    await vi.advanceTimersByTimeAsync(80)
    expect(context.frameStep).toHaveBeenCalledWith(
      expect.objectContaining({ capture_frame_index: '25', count: 1 }),
    )

    context.service.navigation.release('next')
    context.service.nudge('next', 1, 'keyboard')
    context.service.navigation.release('next')
    resolveFirst({
      playback_window_id: 'window-1',
      mapping_version: 1,
      player_media_time_us: '1040000',
      capture_time_us: '1040000',
      capture_frame_index: '26',
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.runAllTimersAsync()

    expect(context.frameStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ capture_frame_index: '26', count: 1 }),
    )
    context.service.dispose()
  })

  it('recreates the playback window when a nudge hits an expired mapping', async () => {
    vi.useFakeTimers()
    const context = setup()
    context.frameStep.mockRejectedValueOnce({
      code: 'WINDOW_EXPIRED',
      message: 'Playback window expired',
    })

    context.service.nudge('next', 1, 'keyboard')
    await vi.runAllTimersAsync()

    expect(context.dvrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_session_id: 'capture-1',
        target_capture_time_us: '1000000',
      }),
    )
    expect(context.frameStep).toHaveBeenCalledTimes(2)
    expect(context.room.edit).toHaveBeenCalledWith(
      'MOVE_KEY_POINT',
      expect.objectContaining({ keyPointId: 'point-1' }),
    )
    context.service.dispose()
  })

  it('recreates the playback window when mapping invalid is reported as not ready', async () => {
    vi.useFakeTimers()
    const context = setup()
    context.frameStep.mockRejectedValueOnce({
      code: 'MEDIA_NOT_READY',
      message: 'Playback window mapping is invalid',
    })

    context.service.nudge('next', 1, 'keyboard')
    await vi.runAllTimersAsync()

    expect(context.dvrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_session_id: 'capture-1',
        target_capture_time_us: '1000000',
      }),
    )
    expect(context.frameStep).toHaveBeenCalledTimes(2)
    expect(context.room.edit).toHaveBeenCalledWith(
      'MOVE_KEY_POINT',
      expect.objectContaining({ keyPointId: 'point-1' }),
    )
    context.service.dispose()
  })

  it('retries transient media failures without surfacing an error when recovery succeeds', async () => {
    vi.useFakeTimers()
    const context = setup()
    context.frameStep.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    context.service.nudge('next')
    await vi.runAllTimersAsync()

    expect(context.frameStep).toHaveBeenCalledTimes(2)
    expect(context.room.edit).toHaveBeenCalledWith(
      'MOVE_KEY_POINT',
      expect.objectContaining({ keyPointId: 'point-1' }),
    )
    expect(context.feedback.messages.value).toHaveLength(0)
    context.service.dispose()
  })
})
