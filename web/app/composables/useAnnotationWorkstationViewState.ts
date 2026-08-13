import { useLocalStorage } from '@vueuse/core'
import { readonly } from 'vue'
import type { CaptureTimelineRange } from '../lib/mediaModel'
import { clampTimelineScale, type TimelineViewport } from '../lib/dvrTimeline'

const STORAGE_PREFIX = 'vollyai.annotation-workstation-view.v1'

export interface AnnotationWorkstationViewState {
  schemaVersion: 1
  captureSessionId: string
  cursorCaptureTimeUs: string | null
  timelineViewport: TimelineViewport | null
}

function isDecimalTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function normalizeViewport(value: unknown, captureSessionId: string): TimelineViewport | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<TimelineViewport>
  if (
    candidate.captureSessionId !== captureSessionId
    || !isDecimalTime(candidate.startCaptureTimeUs)
    || !isDecimalTime(candidate.endCaptureTimeUs)
    || typeof candidate.scale !== 'number'
    || !Number.isFinite(candidate.scale)
  ) return null

  try {
    if (BigInt(candidate.endCaptureTimeUs) <= BigInt(candidate.startCaptureTimeUs)) return null
  }
  catch {
    return null
  }

  return {
    captureSessionId,
    startCaptureTimeUs: candidate.startCaptureTimeUs,
    endCaptureTimeUs: candidate.endCaptureTimeUs,
    scale: clampTimelineScale(candidate.scale),
  }
}

export function parseAnnotationWorkstationViewState(value: unknown): AnnotationWorkstationViewState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AnnotationWorkstationViewState>
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.captureSessionId !== 'string'
    || !candidate.captureSessionId
    || (candidate.cursorCaptureTimeUs !== null && !isDecimalTime(candidate.cursorCaptureTimeUs))
  ) return null

  return {
    schemaVersion: 1,
    captureSessionId: candidate.captureSessionId,
    cursorCaptureTimeUs: candidate.cursorCaptureTimeUs ?? null,
    timelineViewport: normalizeViewport(candidate.timelineViewport, candidate.captureSessionId),
  }
}

export function annotationWorkstationViewStorageKey(matchId: string) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(matchId.trim().toLowerCase())}`
}

function cursorWithinAvailableRanges(cursorCaptureTimeUs: string | null, ranges: readonly CaptureTimelineRange[]) {
  if (!cursorCaptureTimeUs) return null
  try {
    const cursor = BigInt(cursorCaptureTimeUs)
    return ranges.some(range => cursor >= BigInt(range.startUs) && cursor < BigInt(range.endUs))
      ? cursorCaptureTimeUs
      : null
  }
  catch {
    return null
  }
}

export function useAnnotationWorkstationViewState(matchId: string) {
  const state = useLocalStorage<AnnotationWorkstationViewState | null>(
    annotationWorkstationViewStorageKey(matchId),
    null,
    {
      listenToStorageChanges: false,
      writeDefaults: false,
      serializer: {
        read(raw) {
          try {
            return parseAnnotationWorkstationViewState(JSON.parse(raw))
          }
          catch {
            return null
          }
        },
        write(value) {
          return JSON.stringify(value)
        },
      },
      // View restoration is optional convenience. Storage denial must never
      // interrupt annotation or authoritative media controls.
      onError: () => undefined,
    },
  )

  function currentForCapture(captureSessionId: string): AnnotationWorkstationViewState {
    return state.value?.captureSessionId === captureSessionId
      ? state.value
      : {
          schemaVersion: 1,
          captureSessionId,
          cursorCaptureTimeUs: null,
          timelineViewport: null,
        }
  }

  function rememberCursor(captureSessionId: string, cursorCaptureTimeUs: string) {
    if (!captureSessionId || !isDecimalTime(cursorCaptureTimeUs)) return
    state.value = {
      ...currentForCapture(captureSessionId),
      cursorCaptureTimeUs,
    }
  }

  function rememberTimelineViewport(viewport: TimelineViewport) {
    const normalized = normalizeViewport(viewport, viewport.captureSessionId)
    if (!normalized) return
    state.value = {
      ...currentForCapture(normalized.captureSessionId),
      timelineViewport: normalized,
    }
  }

  function restoredStateForCapture(
    captureSessionId: string,
    availableRanges: readonly CaptureTimelineRange[],
  ): AnnotationWorkstationViewState | null {
    const current = state.value
    if (!current || current.captureSessionId !== captureSessionId) return null
    return {
      ...current,
      cursorCaptureTimeUs: cursorWithinAvailableRanges(current.cursorCaptureTimeUs, availableRanges),
    }
  }

  return {
    state: readonly(state),
    rememberCursor,
    rememberTimelineViewport,
    restoredStateForCapture,
  }
}
