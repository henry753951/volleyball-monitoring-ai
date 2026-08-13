import { beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'
import {
  annotationWorkstationViewStorageKey,
  parseAnnotationWorkstationViewState,
  useAnnotationWorkstationViewState,
} from './useAnnotationWorkstationViewState'

function harness(matchId = 'match-1') {
  const scope = effectScope()
  let viewState!: ReturnType<typeof useAnnotationWorkstationViewState>
  scope.run(() => {
    viewState = useAnnotationWorkstationViewState(matchId)
  })
  return { viewState, stop: () => scope.stop() }
}

const availableRanges = [
  { startUs: '1000', endUs: '2000', discontinuity: 0 },
  { startUs: '3000', endUs: '5000', discontinuity: 1 },
]

describe('annotation workstation view persistence', () => {
  beforeEach(() => localStorage.clear())

  it('restores cursor, viewport, and scale only for the same match capture', async () => {
    const first = harness()
    first.viewState.rememberCursor('capture-1', '3500')
    first.viewState.rememberTimelineViewport({
      captureSessionId: 'capture-1',
      startCaptureTimeUs: '3000',
      endCaptureTimeUs: '4500',
      scale: 2.5,
    })
    await nextTick()

    expect(JSON.parse(localStorage.getItem(annotationWorkstationViewStorageKey('match-1'))!)).toMatchObject({
      schemaVersion: 1,
      captureSessionId: 'capture-1',
      cursorCaptureTimeUs: '3500',
      timelineViewport: {
        startCaptureTimeUs: '3000',
        endCaptureTimeUs: '4500',
        scale: 2.5,
      },
    })
    first.stop()

    const restored = harness()
    expect(restored.viewState.restoredStateForCapture('capture-1', availableRanges)).toMatchObject({
      cursorCaptureTimeUs: '3500',
      timelineViewport: {
        captureSessionId: 'capture-1',
        startCaptureTimeUs: '3000',
        endCaptureTimeUs: '4500',
        scale: 2.5,
      },
    })
    expect(restored.viewState.restoredStateForCapture('capture-2', availableRanges)).toBeNull()
    restored.stop()
  })

  it('does not restore a cursor that now falls in a gap, while retaining the viewport', () => {
    const current = harness()
    current.viewState.rememberCursor('capture-1', '2500')
    current.viewState.rememberTimelineViewport({
      captureSessionId: 'capture-1',
      startCaptureTimeUs: '1000',
      endCaptureTimeUs: '4000',
      scale: 0.1,
    })

    expect(current.viewState.restoredStateForCapture('capture-1', availableRanges)).toMatchObject({
      cursorCaptureTimeUs: null,
      timelineViewport: { startCaptureTimeUs: '1000', endCaptureTimeUs: '4000' },
    })
    current.stop()
  })

  it('rejects malformed or cross-capture stored values without throwing', () => {
    expect(parseAnnotationWorkstationViewState({ schemaVersion: 1, captureSessionId: 'capture-1', cursorCaptureTimeUs: '-1' })).toBeNull()
    expect(parseAnnotationWorkstationViewState({
      schemaVersion: 1,
      captureSessionId: 'capture-1',
      cursorCaptureTimeUs: '1200',
      timelineViewport: {
        captureSessionId: 'capture-2',
        startCaptureTimeUs: '1000',
        endCaptureTimeUs: '2000',
        scale: 1,
      },
    })).toMatchObject({ cursorCaptureTimeUs: '1200', timelineViewport: null })

    localStorage.setItem(annotationWorkstationViewStorageKey('match-1'), '{broken')
    const current = harness()
    expect(current.viewState.state.value).toBeNull()
    current.stop()
  })
})
