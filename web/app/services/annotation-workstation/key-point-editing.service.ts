import type {
  AnnotationRallySnapshot,
  CanonicalFrameAnchor,
  PlaybackWindowDescriptor,
  ResolvedMediaAnchor,
} from '@volleyball-monitoring/contracts'
import { readonly, shallowRef } from 'vue'
import type { MediaClient } from '~/lib/mediaClient'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import { clipRangeOverlaps, paddedClipRange } from '~/lib/dvrTimeline'
import type { createAnnotationRoomService } from './annotation-room.service'
import type { createAuthoritativeDvrWindowService } from './authoritative-dvr-window.service'
import { createCoalescedFrameNavigationService } from './coalesced-frame-navigation.service'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

type AnnotationRoomService = ReturnType<typeof createAnnotationRoomService>
type AuthoritativeDvrWindowService = ReturnType<typeof createAuthoritativeDvrWindowService>

interface KeyPointVideoPort {
  pause: () => void
  currentTime: number
}

interface KeyPointOverlayPort {
  seekCanonicalFrame: (anchor: CanonicalFrameAnchor) => boolean
  seekCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean
  previewPlayerMediaTime?: (targetPlayerSeconds: number) => boolean
}

interface ProtectedSegmentRange {
  id: string
  startCaptureTimeUs: string
  endCaptureTimeUs: string
}

export interface KeyPointEditingServiceOptions {
  room: AnnotationRoomService
  dvr: AuthoritativeDvrWindowService
  media: MediaClient
  feedback: WorkstationFeedbackService
  selectedCapture: () => { id: string } | null
  descriptor: () => PlaybackWindowDescriptor | null
  video: () => KeyPointVideoPort | null
  overlay: () => KeyPointOverlayPort | null
  selectedKeyPointId: () => string | null
  selectKeyPoint: (keyPointId: string | null) => void
  editable: () => boolean
  commandReady: () => boolean
  editReady: () => boolean
  estimatedFrameSeconds: () => number | null
  observedCursor: () => PlaybackCursorInput | null
  setObservedCursor: (cursor: PlaybackCursorInput) => void
  setCursorReady: () => void
  clipPreRollUs: () => bigint
  clipPostRollUs: () => bigint
  protectedSegments: () => readonly ProtectedSegmentRange[]
  prepareAuthoritativeSeek: () => void
  clearGestureOwner: () => void
  timeoutMs?: number
}

/**
 * Owns every mutable part of key-point editing. UI components only ask this
 * service to begin, preview, commit, nudge, or delete an edit; they never own a
 * second pending state or optimistic timestamp.
 */
export function createKeyPointEditingService(options: KeyPointEditingServiceOptions) {
  const optimisticMoves = shallowRef<Record<string, string>>({})
  const pendingMove = shallowRef<{
    keyPointId: string
    playbackWindowId: string | null
  } | null>(null)
  const timeoutMs = options.timeoutMs ?? 8_000
  let moveTimeout: ReturnType<typeof setTimeout> | null = null
  let nudgeTargetId: string | null = null

  function notifyError(cause: unknown, fallback: string) {
    options.feedback.notify({
      level: 'error',
      title: cause instanceof Error ? cause.message : fallback,
    })
  }

  function projectSnapshot(source: AnnotationRallySnapshot | null) {
    if (!source || !Object.keys(optimisticMoves.value).length) return source
    const projected = structuredClone(source)
    projected.snapshot.key_points = projected.snapshot.key_points.map(point => {
      const captureTimeUs = optimisticMoves.value[point.key_point_id]
      return captureTimeUs
        ? { ...point, capture_time_us: captureTimeUs, timing_precision: 'estimated' as const }
        : point
    })
    return projected
  }

  function preview(keyPointId: string, captureTimeUs: string) {
    optimisticMoves.value = { ...optimisticMoves.value, [keyPointId]: captureTimeUs }
  }

  function clearPreview(keyPointId: string) {
    const next = { ...optimisticMoves.value }
    Reflect.deleteProperty(next, keyPointId)
    optimisticMoves.value = next
  }

  function releaseEditingIntent() {
    options.room.setEditingKeyPoint(null)
  }

  function clearMoveTimeout() {
    if (moveTimeout) clearTimeout(moveTimeout)
    moveTimeout = null
  }

  function cancelPendingMove(message?: string) {
    const current = pendingMove.value
    pendingMove.value = null
    clearMoveTimeout()
    if (current) clearPreview(current.keyPointId)
    releaseEditingIntent()
    if (message) options.feedback.notify({ level: 'error', title: message })
  }

  function armMoveTimeout(keyPointId: string) {
    clearMoveTimeout()
    moveTimeout = setTimeout(() => {
      if (pendingMove.value?.keyPointId !== keyPointId) return
      cancelPendingMove('無法解析拖曳位置，擊球點未變更')
    }, timeoutMs)
  }

  function wouldOverlap(keyPointId: string, targetCaptureTimeUs: string) {
    const snapshot = options.room.snapshot.value
    if (!snapshot) return true
    const range = paddedClipRange(
      snapshot.snapshot.key_points.map(point =>
        point.key_point_id === keyPointId ? targetCaptureTimeUs : point.capture_time_us,
      ),
      options.clipPreRollUs(),
      options.clipPostRollUs(),
    )
    return !range || clipRangeOverlaps(range, options.protectedSegments(), snapshot.rally_id)
  }

  async function editSelected(kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT') {
    const keyPointId = options.selectedKeyPointId()
    if (!keyPointId || !options.editable() || !options.editReady()) return
    const points = options.room.viewSnapshot.value?.snapshot.key_points ?? []
    const selectedIndex = points.findIndex(point => point.key_point_id === keyPointId)
    const nextSelection =
      selectedIndex >= 0
        ? (points[selectedIndex + 1]?.key_point_id ?? points[selectedIndex - 1]?.key_point_id ?? null)
        : null
    if (kind === 'MOVE_KEY_POINT') options.room.setEditingKeyPoint(keyPointId)
    try {
      await options.room.edit(kind, {
        keyPointId,
        cursor: options.observedCursor(),
      })
      if (kind === 'DELETE_KEY_POINT') options.selectKeyPoint(nextSelection)
    } catch {
      // Annotation room owns command failure and recovery feedback.
    } finally {
      if (kind === 'MOVE_KEY_POINT') releaseEditingIntent()
    }
  }

  function begin(keyPointId: string) {
    if (!options.editable() || !options.editReady()) return false
    options.selectKeyPoint(keyPointId)
    options.room.setEditingKeyPoint(keyPointId)
    return true
  }

  function cancel(keyPointId: string) {
    if (pendingMove.value?.keyPointId === keyPointId) return
    releaseEditingIntent()
  }

  async function move(keyPointId: string, targetCaptureTimeUs: string) {
    if (!options.editable() || !options.editReady() || !options.selectedCapture()) {
      releaseEditingIntent()
      return
    }
    if (wouldOverlap(keyPointId, targetCaptureTimeUs)) {
      options.feedback.notify({
        level: 'error',
        title: '移動後的片段範圍會與其他片段重疊',
      })
      releaseEditingIntent()
      return
    }
    preview(keyPointId, targetCaptureTimeUs)
    options.selectKeyPoint(keyPointId)
    options.room.setEditingKeyPoint(keyPointId)
    pendingMove.value = { keyPointId, playbackWindowId: null }
    try {
      options.prepareAuthoritativeSeek()
      const descriptor = options.descriptor()
      if (descriptor && options.overlay()?.seekCaptureTimeIfBuffered(targetCaptureTimeUs)) {
        pendingMove.value = {
          keyPointId,
          playbackWindowId: descriptor.playback_window_id,
        }
        armMoveTimeout(keyPointId)
        return
      }
      const capture = options.selectedCapture()
      if (!capture) throw new Error('目前沒有可用的媒體來源')
      const created = await options.dvr.create({
        schema_version: '1.0.0',
        capture_session_id: capture.id,
        mode: 'archive',
        target_capture_time_us: targetCaptureTimeUs,
      })
      if (!created || pendingMove.value?.keyPointId !== keyPointId)
        throw new Error('拖曳播放視窗已被較新的操作取代')
      pendingMove.value = {
        keyPointId,
        playbackWindowId: created.playback_window_id,
      }
      armMoveTimeout(keyPointId)
    } catch (cause) {
      cancelPendingMove()
      notifyError(cause, '拖曳擊球點失敗')
    }
  }

  async function completeResolvedMove(
    cursor: PlaybackCursorInput,
    resolved: ResolvedMediaAnchor | null,
  ) {
    const current = pendingMove.value
    if (!resolved || !current || current.playbackWindowId !== cursor.playback_window_id)
      return false
    pendingMove.value = null
    clearMoveTimeout()
    try {
      if (
        options.editable() &&
        options.selectedKeyPointId() === current.keyPointId &&
        options.editReady()
      ) {
        await options.room.edit('MOVE_KEY_POINT', {
          keyPointId: current.keyPointId,
          cursor,
          observation: {
            capture_time_us: resolved.capture_time_us,
            capture_frame_index: resolved.capture_frame_index,
          },
        })
      }
    } finally {
      clearPreview(current.keyPointId)
      releaseEditingIntent()
    }
    return true
  }

  function previewNudge(delta: number) {
    if (!nudgeTargetId) return
    const point = options.room.snapshot.value?.snapshot.key_points.find(
      candidate => candidate.key_point_id === nudgeTargetId,
    )
    const frameSeconds = options.estimatedFrameSeconds()
    if (!point || frameSeconds === null) return
    const estimatedFrameUs = BigInt(Math.max(1, Math.round(frameSeconds * 1_000_000)))
    const previewUs =
      BigInt(optimisticMoves.value[nudgeTargetId] ?? point.capture_time_us) +
      BigInt(delta) * estimatedFrameUs
    if (previewUs < 0n) return
    const captureTimeUs = previewUs.toString()
    preview(nudgeTargetId, captureTimeUs)
    const descriptor = options.descriptor()
    const video = options.video()
    if (
      video &&
      descriptor &&
      previewUs >= BigInt(descriptor.window_capture_start_us) &&
      previewUs < BigInt(descriptor.window_capture_end_us)
    ) {
      const targetPlayerSeconds =
        Number(previewUs - BigInt(descriptor.presentation_origin_capture_us)) / 1_000_000
      if (!options.overlay()?.previewPlayerMediaTime?.(targetPlayerSeconds)) {
        video.pause()
        video.currentTime = targetPlayerSeconds
      }
    }
  }

  async function performNudge(direction: 'previous' | 'next', count: number) {
    const keyPointId = nudgeTargetId
    const point = options.room.snapshot.value?.snapshot.key_points.find(
      candidate => candidate.key_point_id === keyPointId,
    )
    const capture = options.selectedCapture()
    if (!point || !capture || !options.editable()) throw new Error('目前擊球點已無法編輯')
    let descriptor = options.descriptor()
    if (
      !descriptor ||
      BigInt(point.capture_time_us) < BigInt(descriptor.window_capture_start_us) ||
      BigInt(point.capture_time_us) >= BigInt(descriptor.window_capture_end_us)
    ) {
      descriptor = await options.dvr.create({
        schema_version: '1.0.0',
        capture_session_id: capture.id,
        mode: 'archive',
        target_capture_time_us: point.capture_time_us,
      })
    }
    if (!descriptor) throw new Error('無法建立擊球點微調視窗')
    const frame = await options.media.frameStep({
      schema_version: '1.1.0',
      capture_session_id: capture.id,
      playback_window_id: descriptor.playback_window_id,
      mapping_version: descriptor.mapping_version,
      capture_frame_index: point.capture_frame_index,
      direction,
      count,
    })
    const cursor: PlaybackCursorInput = {
      schema_version: '1.0.0',
      playback_window_id: frame.playback_window_id,
      mapping_version: frame.mapping_version,
      player_media_time_us: frame.player_media_time_us,
      observation_source: 'current_time_fallback',
      presented_frames: null,
      seek_generation: (options.observedCursor()?.seek_generation ?? 0) + 1,
      cursor_status: 'ready',
    }
    options.setObservedCursor(cursor)
    options.setCursorReady()
    const resolved = await options.dvr.resolve(cursor)
    if (!resolved) throw new Error('伺服器無法解析微調畫格')
    if (wouldOverlap(point.key_point_id, resolved.capture_time_us))
      throw new Error('移動後的片段範圍會與其他片段重疊')
    await options.room.edit('MOVE_KEY_POINT', {
      keyPointId: point.key_point_id,
      cursor,
      observation: {
        capture_time_us: resolved.capture_time_us,
        capture_frame_index: resolved.capture_frame_index,
      },
    })
    return frame
  }

  const navigation = createCoalescedFrameNavigationService<CanonicalFrameAnchor>({
    preview: previewNudge,
    step: performNudge,
    apply: frame => {
      options.overlay()?.seekCanonicalFrame(frame)
    },
    onError: cause => notifyError(cause, '擊球點微調失敗'),
    onSettled: () => {
      if (nudgeTargetId) clearPreview(nudgeTargetId)
      nudgeTargetId = null
      releaseEditingIntent()
      options.clearGestureOwner()
    },
    settleMs: 90,
    heldFlushMs: 80,
    holdWatchdogMs: 650,
    flushWhileHeld: true,
  })

  function nudge(
    direction: 'previous' | 'next',
    count = 1,
    input: 'keyboard' | 'button' = 'button',
  ) {
    const keyPointId = options.selectedKeyPointId()
    const point = options.room.snapshot.value?.snapshot.key_points.find(
      candidate => candidate.key_point_id === keyPointId,
    )
    if (
      !point ||
      !options.selectedCapture() ||
      !options.editable() ||
      !options.commandReady() ||
      pendingMove.value ||
      (!options.editReady() && !navigation.active.value)
    )
      return
    if (nudgeTargetId && nudgeTargetId !== point.key_point_id) return
    nudgeTargetId = point.key_point_id
    options.room.setEditingKeyPoint(point.key_point_id)
    navigation.enqueue(direction, count, input)
  }

  function deleteSelected() {
    return editSelected('DELETE_KEY_POINT')
  }

  function dispose() {
    navigation.stop()
    cancelPendingMove()
  }

  return {
    optimisticMoves: readonly(optimisticMoves),
    pendingMove: readonly(pendingMove),
    navigation,
    projectSnapshot,
    preview,
    clearPreview,
    wouldOverlap,
    begin,
    cancel,
    move,
    completeResolvedMove,
    nudge,
    deleteSelected,
    releaseEditingIntent,
    cancelPendingMove,
    dispose,
  }
}

export type KeyPointEditingService = ReturnType<typeof createKeyPointEditingService>
