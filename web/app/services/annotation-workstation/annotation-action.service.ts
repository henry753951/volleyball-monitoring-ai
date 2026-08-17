import {
  decideBallEventShortcut,
  type AnnotationRallySnapshot,
  type BallEventShortcut,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { AnnotationClientObservation } from '~/lib/annotationCommandQueue'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import {
  boundaryCommandAvailability,
  draftCommandAvailability,
  type AnnotationSegmentRange,
} from '~/utils/annotationCommandAvailability'
import type { AnnotationAction } from '~/utils/annotationHotkeys'
import type { WorkstationActionId, WorkstationActionManager } from './workstation-action.service'

type AnnotationState = 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'

export interface AnnotationActionRoomPort {
  draftOwnedByClient: MaybeRefOrGetter<boolean>
  lastKeyPoint: MaybeRefOrGetter<{ key_point_id: string } | null>
  dispatch: (
    action: AnnotationAction,
    cursor: PlaybackCursorInput | null,
    observation?: AnnotationClientObservation,
    selectedKeyPointId?: string | null,
  ) => Promise<unknown>
  setBallEvent: (keyPointId: string, event: BallEventValue) => Promise<unknown>
  setBallEventActor: (keyPointId: string, actorRosterEntryId: string | null) => Promise<unknown>
}

export interface AnnotationActionServiceOptions {
  manager: WorkstationActionManager
  room: AnnotationActionRoomPort
  commandReady: MaybeRefOrGetter<boolean>
  state: MaybeRefOrGetter<AnnotationState>
  correctionActive: MaybeRefOrGetter<boolean>
  canMark: MaybeRefOrGetter<boolean>
  visualPlayhead: MaybeRefOrGetter<string | null>
  authoritativeFrameIndex: MaybeRefOrGetter<string | null>
  selectedKeyPointId: MaybeRefOrGetter<string | null>
  displayAnnotation: MaybeRefOrGetter<AnnotationRallySnapshot | null>
  observedCursor: MaybeRefOrGetter<PlaybackCursorInput | null>
  clipPreRollUs: MaybeRefOrGetter<bigint>
  clipPostRollUs: MaybeRefOrGetter<bigint>
  protectedSegments: MaybeRefOrGetter<readonly AnnotationSegmentRange[]>
  incompleteResultsNeedConfirmation: () => boolean
  requestIncompleteResultsConfirmation: () => void
  correctionSubmitRequired: MaybeRefOrGetter<boolean>
  requestCorrectionSubmit: () => void
  eventEditReady: MaybeRefOrGetter<boolean>
  submitReady: MaybeRefOrGetter<boolean>
}

export const annotationWorkstationActionId: Record<AnnotationAction, WorkstationActionId> = {
  service: 'segment.toggle-boundary',
  contact: 'mark.contact',
  spike: 'mark.spike',
  event_success: 'mark.event-success',
  event_failure: 'mark.event-failure',
  close_left: 'outcome.left',
  close_right: 'outcome.right',
  close_unknown: 'outcome.unknown',
  submit: 'submission.submit',
}

const labels: Record<AnnotationAction, string> = {
  service: '片段開始／結束',
  contact: 'HIT',
  spike: '殺球',
  event_success: '所選球點成功',
  event_failure: '所選球點失敗',
  close_left: '左側得分',
  close_right: '右側得分',
  close_unknown: '得分未知',
  submit: '送出片段',
}

const shortcuts: Partial<Record<AnnotationAction, string>> = {
  service: 'Z',
  contact: 'X',
  spike: 'C',
  event_success: 'V',
  event_failure: 'B',
  close_left: '<',
  close_right: '>',
  close_unknown: '?',
  submit: 'Enter',
}

function shortcutForAction(action: AnnotationAction): BallEventShortcut | null {
  if (action === 'spike') return 'C'
  return null
}

export function createAnnotationActionService(options: AnnotationActionServiceOptions) {
  function editableRange(snapshot: AnnotationRallySnapshot | null) {
    const start = snapshot?.snapshot.boundaries?.find(
      boundary => boundary.kind === 'start',
    )?.capture_time_us
    const explicitEnd = snapshot?.snapshot.boundaries?.find(
      boundary => boundary.kind === 'end',
    )?.capture_time_us
    if (!start) return { start: null, end: explicitEnd ?? null }
    if (explicitEnd) return { start, end: explicitEnd }
    const nextProtectedStart = toValue(options.protectedSegments).reduce<string | null>(
      (next, segment) => {
        if (
          segment.id === snapshot?.rally_id ||
          BigInt(segment.startCaptureTimeUs) <= BigInt(start)
        )
          return next
        return next === null || BigInt(segment.startCaptureTimeUs) < BigInt(next)
          ? segment.startCaptureTimeUs
          : next
      },
      null,
    )
    return {
      start,
      // The next Rally owns its start instant. Keep point creation strictly
      // inside this draft even though the visual segment boundary may touch it.
      end:
        nextProtectedStart && BigInt(nextProtectedStart) > 0n
          ? (BigInt(nextProtectedStart) - 1n).toString()
          : nextProtectedStart,
    }
  }

  function cursorRangeAvailability(
    snapshot: AnnotationRallySnapshot | null,
    cursor: string | null,
  ) {
    const range = editableRange(snapshot)
    return draftCommandAvailability({
      action: 'contact',
      state:
        (snapshot?.snapshot.annotation_status.toUpperCase() as AnnotationState | undefined) ??
        'IDLE',
      canMark: toValue(options.canMark),
      cursorCaptureTimeUs: cursor,
      serviceCaptureTimeUs: range.start,
      editableStartCaptureTimeUs: range.start,
      editableEndCaptureTimeUs: range.end,
      confirmedLastKeyPointId: toValue(options.room.lastKeyPoint)?.key_point_id ?? null,
    })
  }

  function ballEventAvailability(action: AnnotationAction) {
    const shortcut = shortcutForAction(action)
    if (!shortcut) return null
    const snapshot = toValue(options.displayAnnotation)
    if (!snapshot || !['open', 'ready'].includes(snapshot.snapshot.annotation_status)) {
      return { enabled: false, reason: '尚未開始片段' }
    }
    if (!toValue(options.room.draftOwnedByClient)) {
      return { enabled: false, reason: '此片段屬於另一個標註客戶端，只能檢視' }
    }
    const selectedKeyPointId = toValue(options.selectedKeyPointId)
    const visualPlayhead = toValue(options.visualPlayhead)
    if (!selectedKeyPointId && (!toValue(options.canMark) || !visualPlayhead)) {
      return { enabled: false, reason: '游標尚未確認' }
    }
    if (!selectedKeyPointId) {
      const rangeAvailability = cursorRangeAvailability(snapshot, visualPlayhead)
      if (!rangeAvailability.enabled) return rangeAvailability
    }
    const authoritativeFrameIndex = toValue(options.authoritativeFrameIndex)
    const decision = decideBallEventShortcut({
      shortcut,
      points: snapshot.snapshot.key_points.map(point => ({
        key_point_id: point.key_point_id,
        sequence_index: point.sequence_index,
        capture_time_us: point.capture_time_us,
        capture_frame_index: point.capture_frame_index,
        event: point.ball_event ?? null,
      })),
      boundaries: snapshot.snapshot.boundaries,
      selected_key_point_id: selectedKeyPointId,
      candidate_anchor:
        visualPlayhead && authoritativeFrameIndex
          ? {
              capture_time_us: visualPlayhead,
              capture_frame_index: authoritativeFrameIndex,
            }
          : null,
    })
    if (decision.allowed) return { enabled: true, reason: '' }
    const reasons = {
      NO_TARGET_POINT: '請先選擇擊球點，或等待目前畫格確認',
      SPIKE_REQUIRES_THIRD_POINT: '殺球只能標在第三球以後',
      OUTSIDE_RALLY_BOUNDARY: '目前畫格不在片段範圍內',
    } as const
    return { enabled: false, reason: reasons[decision.reason] }
  }

  function resultAvailability(action: AnnotationAction) {
    if (action !== 'event_success' && action !== 'event_failure') return null
    const snapshot = toValue(options.displayAnnotation)
    const selectedId = toValue(options.selectedKeyPointId)
    if (!snapshot || !['open', 'ready'].includes(snapshot.snapshot.annotation_status))
      return { enabled: false, reason: '尚未開始可編輯片段' }
    if (!toValue(options.room.draftOwnedByClient))
      return { enabled: false, reason: '此片段屬於另一個標註客戶端，只能檢視' }
    if (!selectedId) return { enabled: false, reason: '請先選擇球點' }
    if (!toValue(options.eventEditReady)) return { enabled: false, reason: '等待目前修改完成' }
    const event = snapshot.snapshot.key_points.find(
      point => point.key_point_id === selectedId,
    )?.ball_event
    if (!event || event.kind === 'CONTACT')
      return { enabled: false, reason: '請先將球點改為發球、接球或殺球' }
    return { enabled: true, reason: '' }
  }

  function availability(action: AnnotationAction) {
    if (!toValue(options.commandReady)) {
      return { enabled: false, reason: '標記狀態有衝突，請按上方「重新同步」' }
    }
    const state = toValue(options.state)
    const localDraft = toValue(options.room.draftOwnedByClient)
    const snapshot = toValue(options.displayAnnotation)
    const visualPlayhead = toValue(options.visualPlayhead)
    if (action === 'service') {
      const startBoundary = localDraft
        ? snapshot?.snapshot.boundaries?.find(boundary => boundary.kind === 'start')
        : undefined
      const endBoundary = localDraft
        ? snapshot?.snapshot.boundaries?.find(boundary => boundary.kind === 'end')
        : undefined
      const otherBoundaries = localDraft
        ? (snapshot?.snapshot.boundaries
            ?.filter(boundary => boundary.kind !== 'start')
            .map(boundary => boundary.capture_time_us) ?? [])
        : []
      return boundaryCommandAvailability({
        state: localDraft ? state : 'IDLE',
        activeSubmissionId: localDraft ? snapshot?.snapshot.active_submission_id : null,
        canMark: toValue(options.canMark),
        cursorCaptureTimeUs: visualPlayhead,
        currentRallyId: localDraft ? snapshot?.rally_id : null,
        startBoundaryCaptureTimeUs: startBoundary?.capture_time_us,
        endBoundaryCaptureTimeUs: endBoundary?.capture_time_us,
        currentDraftCaptureTimes: [
          ...(startBoundary ? [startBoundary.capture_time_us] : []),
          ...(snapshot?.snapshot.key_points.map(point => point.capture_time_us) ?? []),
          ...otherBoundaries,
        ],
        clipPreRollUs: toValue(options.clipPreRollUs),
        clipPostRollUs: toValue(options.clipPostRollUs),
        segments: toValue(options.protectedSegments),
      })
    }
    if ((state === 'OPEN' || state === 'READY') && !localDraft) {
      return { enabled: false, reason: '此片段屬於另一個標註客戶端，只能檢視' }
    }
    if (action === 'submit') {
      if (state !== 'READY' && !(state === 'OPEN' && toValue(options.correctionActive)))
        return { enabled: false, reason: '片段尚未完成' }
      return toValue(options.submitReady)
        ? { enabled: true, reason: '' }
        : { enabled: false, reason: '等待目前修改同步完成' }
    }
    const result = resultAvailability(action)
    if (result) return result
    const ballEvent = ballEventAvailability(action)
    if (ballEvent) return ballEvent
    const range = editableRange(snapshot)
    return draftCommandAvailability({
      action,
      state,
      canMark: toValue(options.canMark),
      cursorCaptureTimeUs: visualPlayhead,
      serviceCaptureTimeUs:
        snapshot?.snapshot.boundaries?.find(boundary => boundary.kind === 'start')
          ?.capture_time_us ?? null,
      editableStartCaptureTimeUs: range.start,
      editableEndCaptureTimeUs: range.end,
      confirmedLastKeyPointId: toValue(options.room.lastKeyPoint)?.key_point_id ?? null,
    })
  }

  function execute(action: AnnotationAction) {
    if (action === 'submit' && options.incompleteResultsNeedConfirmation()) {
      options.requestIncompleteResultsConfirmation()
      return
    }
    if (action === 'submit' && toValue(options.correctionSubmitRequired)) {
      options.requestCorrectionSubmit()
      return
    }
    const captureTimeUs = toValue(options.visualPlayhead)
    return options.room.dispatch(
      action,
      toValue(options.observedCursor),
      captureTimeUs
        ? {
            capture_time_us: captureTimeUs,
            capture_frame_index: toValue(options.authoritativeFrameIndex),
          }
        : undefined,
      toValue(options.selectedKeyPointId),
    )
  }

  const unregister = [
    ...(Object.keys(annotationWorkstationActionId) as AnnotationAction[]).map(action =>
      options.manager.register({
        id: annotationWorkstationActionId[action],
        group:
          action === 'service'
            ? 'segment'
            : action === 'submit'
              ? 'submission'
              : action.startsWith('close_')
                ? 'outcome'
                : 'marking',
        label: labels[action],
        shortcut: shortcuts[action],
        resources:
          action === 'event_success' || action === 'event_failure'
            ? ['annotation-ball-event']
            : undefined,
        availability: computed(() => availability(action)),
        execute: () => execute(action),
      }),
    ),
    options.manager.register<BallEventValue, unknown>({
      id: 'mark.set-event',
      group: 'marking',
      label: '修改球點結果',
      resources: ['annotation-ball-event'],
      availability: computed(() => {
        const snapshot = toValue(options.displayAnnotation)
        if (!snapshot || !['open', 'ready'].includes(snapshot.snapshot.annotation_status))
          return { enabled: false, reason: '尚未開始可編輯片段' }
        if (!toValue(options.room.draftOwnedByClient))
          return { enabled: false, reason: '此片段屬於另一個標註客戶端，只能檢視' }
        if (!toValue(options.selectedKeyPointId)) return { enabled: false, reason: '請先選擇球點' }
        return toValue(options.eventEditReady)
          ? { enabled: true, reason: '' }
          : { enabled: false, reason: '等待目前修改完成' }
      }),
      execute: event => options.room.setBallEvent(toValue(options.selectedKeyPointId)!, event),
    }),
    options.manager.register<string | null, unknown>({
      id: 'mark.set-actor',
      group: 'marking',
      label: '修改擊球球員',
      availability: computed(() => ({
        enabled: Boolean(toValue(options.selectedKeyPointId)) && toValue(options.eventEditReady),
        reason: toValue(options.selectedKeyPointId) ? '等待目前修改完成' : '請先選擇球點',
      })),
      execute: actorRosterEntryId =>
        options.room.setBallEventActor(toValue(options.selectedKeyPointId)!, actorRosterEntryId),
    }),
  ]

  function dispose() {
    unregister.forEach(stop => stop())
  }

  return { availability, execute, dispose }
}
