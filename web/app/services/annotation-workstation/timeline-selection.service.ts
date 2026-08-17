import { ref, type Ref } from 'vue'
import type { CoachRally } from '~/lib/coachDomain'
import {
  adjacentAnnotationKeyPoint,
  type NavigableAnnotationKeyPoint,
} from '~/lib/annotationKeyPointNavigation'
import type { AnnotationSegmentRange } from '~/utils/annotationCommandAvailability'
import type { TimelineSelectionItem } from '~/utils/timelineSelection'
import type { createWorkstationSelectionService } from './workstation-selection.service'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

export interface TimelineSelectionRoomPort {
  selectRally: (rallyId: string) => Promise<unknown>
}

export interface TimelineSelectionServiceOptions {
  room: TimelineSelectionRoomPort
  selection: ReturnType<typeof createWorkstationSelectionService>
  feedback: WorkstationFeedbackService
  cursorRallyId: Ref<string | null>
  displayedRallyId: () => string | null
  selectedKeyPointId: () => string | null
  draftRallyIds: () => ReadonlySet<string>
  seek: (captureTimeUs: string) => Promise<unknown>
  focusSegment?: (segment: AnnotationSegmentRange) => void
  openAnalysis: () => void
}

export function createTimelineSelectionService(options: TimelineSelectionServiceOptions) {
  const selectedItem = ref<TimelineSelectionItem>(null)
  let navigationGeneration = 0

  function invalidateNavigation() {
    navigationGeneration += 1
  }

  function selectKeyPoint(keyPointId: string, rallyId = options.displayedRallyId()) {
    navigationGeneration += 1
    options.selection.selectRally(rallyId)
    options.selection.selectKeyPoint(keyPointId)
    selectedItem.value = 'point'
  }

  function selectMask(rallyId = options.displayedRallyId()) {
    invalidateNavigation()
    options.selection.selectRally(rallyId)
    options.selection.clearDetail()
    selectedItem.value = 'mask'
  }

  function clear() {
    invalidateNavigation()
    options.selection.releaseExplicitRally()
    selectedItem.value = options.cursorRallyId.value ? 'segment' : null
  }

  async function selectHistorical(segmentId: string, targetCaptureTimeUs: string) {
    if (options.draftRallyIds().has(segmentId)) {
      const selected = await options.room.selectRally(segmentId)
      if (!selected) return
      options.selection.selectRally(segmentId)
      selectedItem.value = 'mask'
      options.selection.clearDetail()
      if (targetCaptureTimeUs !== '0') await options.seek(targetCaptureTimeUs)
      return
    }
    options.selection.selectRally(segmentId)
    selectedItem.value = 'segment'
    options.selection.clearDetail()
  }

  function selectAnalysis(segmentId: string) {
    options.selection.selectRally(segmentId)
    selectedItem.value = 'segment'
    options.selection.clearDetail()
    options.openAnalysis()
  }

  function selectRally(rally: CoachRally) {
    options.selection.selectRally(rally.id)
    selectedItem.value = 'segment'
    options.selection.clearDetail()
    if (rally.submission.clip) void options.seek(rally.submission.clip.start_capture_time_us)
  }

  async function navigate(
    direction: 'previous' | 'next',
    points: readonly NavigableAnnotationKeyPoint[],
    referenceCaptureTimeUs: string | null,
  ) {
    if (!points.length) return
    const target = adjacentAnnotationKeyPoint(points, {
      direction,
      selectedId: selectedItem.value === 'point' ? options.selectedKeyPointId() : null,
      referenceCaptureTimeUs,
    })
    if (!target) {
      options.feedback.notify({
        level: 'info',
        title: direction === 'next' ? '已到最後一個擊球點' : '已到第一個擊球點',
      })
      return
    }
    const generation = ++navigationGeneration
    if (target.rallyId === options.displayedRallyId()) {
      options.selection.selectKeyPoint(target.id)
      selectedItem.value = 'point'
    } else if (target.rallyId && options.draftRallyIds().has(target.rallyId)) {
      try {
        const selected = await options.room.selectRally(target.rallyId)
        if (generation !== navigationGeneration || !selected) return
        options.selection.selectRally(target.rallyId)
        options.selection.selectKeyPoint(target.id)
        selectedItem.value = 'point'
      } catch (cause) {
        if (generation === navigationGeneration) {
          options.feedback.notify({
            level: 'error',
            title: '無法載入擊球點',
            description: cause instanceof Error ? cause.message : undefined,
          })
        }
        return
      }
    } else {
      options.selection.selectRally(target.rallyId)
      options.selection.selectKeyPoint(target.id)
      selectedItem.value = 'point'
    }
    if (generation === navigationGeneration) await options.seek(target.captureTimeUs)
  }

  async function navigateSegment(
    direction: 'previous' | 'next',
    segments: readonly AnnotationSegmentRange[],
    referenceCaptureTimeUs: string | null,
  ) {
    if (!segments.length) return
    const ordered = [...segments].sort((left, right) => {
      const difference = BigInt(left.startCaptureTimeUs) - BigInt(right.startCaptureTimeUs)
      return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
    })
    const explicitRallyId = options.selection.explicitRallyId.value
    const cursorRallyId = options.cursorRallyId.value
    const currentIndex = [explicitRallyId, cursorRallyId]
      .map(id => (id ? ordered.findIndex(segment => segment.id === id) : -1))
      .find(index => index >= 0)

    let target =
      currentIndex === undefined
        ? undefined
        : ordered[currentIndex + (direction === 'next' ? 1 : -1)]
    if (currentIndex === undefined) {
      const reference = referenceCaptureTimeUs ? BigInt(referenceCaptureTimeUs) : null
      target = reference
        ? direction === 'next'
          ? ordered.find(segment => BigInt(segment.startCaptureTimeUs) > reference)
          : [...ordered].reverse().find(segment => BigInt(segment.startCaptureTimeUs) < reference)
        : direction === 'next'
          ? ordered[0]
          : ordered.at(-1)
    }

    if (!target) {
      options.feedback.notify({
        level: 'info',
        title: direction === 'next' ? '已到最後一個片段' : '已到第一個片段',
      })
      return
    }

    const generation = ++navigationGeneration
    try {
      if (options.draftRallyIds().has(target.id)) {
        const selected = await options.room.selectRally(target.id)
        if (generation !== navigationGeneration || !selected) return
      }
      if (generation !== navigationGeneration) return
      options.selection.selectRally(target.id)
      options.selection.clearDetail()
      selectedItem.value = 'segment'
      await options.seek(target.startCaptureTimeUs)
      if (generation === navigationGeneration) options.focusSegment?.(target)
    } catch (cause) {
      if (generation === navigationGeneration) {
        options.feedback.notify({
          level: 'error',
          title: '無法載入片段',
          description: cause instanceof Error ? cause.message : undefined,
        })
      }
    }
  }

  function followCursor(rallyId: string | null) {
    if (options.selection.explicitRallyId.value) return
    selectedItem.value = rallyId ? 'segment' : null
    options.selection.clearDetail()
  }

  function clearPointForDisplayedRallyChange() {
    invalidateNavigation()
    options.selection.clearDetail()
    if (selectedItem.value === 'point') {
      selectedItem.value = options.selection.explicitRallyId.value
        ? 'mask'
        : options.cursorRallyId.value
          ? 'segment'
          : null
    }
  }

  return {
    selectedItem,
    invalidateNavigation,
    selectKeyPoint,
    selectMask,
    clear,
    selectHistorical,
    selectAnalysis,
    selectRally,
    navigate,
    navigateSegment,
    followCursor,
    clearPointForDisplayedRallyChange,
  }
}
