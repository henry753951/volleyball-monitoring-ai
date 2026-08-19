import type {
  ObservationSource,
  CursorStatus,
  PlaybackWindowDescriptor,
  PlaybackCursorInput,
} from '../lib/mediaModel'
import { isPlayerMediaTimeWithinWindow } from '../utils/playbackWindow'
export type {
  ObservationSource,
  CursorStatus,
  PlaybackWindowDescriptor,
  PlaybackCursorInput,
} from '../lib/mediaModel'

interface VideoFrameMetadataSubset {
  mediaTime: number
  presentedFrames?: number
}

export function usePlaybackCursor(
  video: Ref<HTMLVideoElement | null>,
  descriptor: Ref<PlaybackWindowDescriptor | null>,
) {
  const cursor = shallowRef<PlaybackCursorInput | null>(null)
  const cursorStatus = ref<CursorStatus>('stale')
  const seekGeneration = ref(0)
  let callbackId: number | null = null
  let fallbackTimer: ReturnType<typeof setInterval> | null = null
  let lastObservationAt = 0
  let staleTimer: ReturnType<typeof setInterval> | null = null
  let forcedGap = false

  const publish = (
    mediaTimeSeconds: number,
    source: ObservationSource,
    presentedFrames: number | undefined,
  ) => {
    const current = descriptor.value
    if (!current || !Number.isFinite(mediaTimeSeconds) || mediaTimeSeconds < 0) return

    lastObservationAt = performance.now()
    const playerMediaTimeUs = BigInt(Math.round(mediaTimeSeconds * 1_000_000))
    cursorStatus.value =
      forcedGap || !isPlayerMediaTimeWithinWindow(playerMediaTimeUs, current)
        ? 'gap'
        : video.value?.seeking
          ? 'seeking'
          : 'ready'
    cursor.value = {
      schema_version: '1.0.0',
      playback_window_id: current.playback_window_id,
      mapping_version: current.mapping_version,
      player_media_time_us: playerMediaTimeUs.toString(),
      observation_source: source,
      presented_frames: presentedFrames === undefined ? null : String(presentedFrames),
      seek_generation: seekGeneration.value,
      cursor_status: cursorStatus.value,
    }
  }

  const publishCurrentTime = () => {
    const element = video.value
    if (!element) return
    publish(element.currentTime, 'current_time_fallback', undefined)
  }

  const scheduleVideoFrameCallback = () => {
    const element = video.value
    if (!element) return

    if (typeof element.requestVideoFrameCallback === 'function') {
      const scheduledSeekGeneration = seekGeneration.value
      const scheduledWindow = descriptor.value
        ? `${descriptor.value.playback_window_id}:${descriptor.value.mapping_version}`
        : null
      callbackId = element.requestVideoFrameCallback((_now, metadata) => {
        const frame = metadata as VideoFrameMetadataSubset
        const currentWindow = descriptor.value
          ? `${descriptor.value.playback_window_id}:${descriptor.value.mapping_version}`
          : null
        const scheduledObservationStillCurrent =
          element === video.value &&
          currentWindow === scheduledWindow &&
          seekGeneration.value === scheduledSeekGeneration
        const presentedCurrentTarget =
          element === video.value &&
          !element.seeking &&
          currentWindow !== null &&
          Math.abs(frame.mediaTime - element.currentTime) <= 0.25
        if (scheduledObservationStillCurrent || presentedCurrentTarget)
          publish(frame.mediaTime, 'request_video_frame_callback', frame.presentedFrames)
        scheduleVideoFrameCallback()
      })
      return
    }
  }

  const markGap = (isGap: boolean) => {
    forcedGap = isGap
    cursorStatus.value = isGap ? 'gap' : 'stale'
  }

  watch(
    () =>
      descriptor.value
        ? `${descriptor.value.playback_window_id}:${descriptor.value.mapping_version}`
        : null,
    () => {
      forcedGap = false
      seekGeneration.value += 1
      cursorStatus.value = 'stale'
      cursor.value = null
    },
  )

  onMounted(() => {
    const element = video.value
    if (!element) return

    const onSeeking = () => {
      seekGeneration.value += 1
      cursorStatus.value = 'seeking'
      publishCurrentTime()
    }
    const onSeeked = () => {
      // requestVideoFrameCallback is not guaranteed to fire for a paused
      // seek. Publish the settled media time immediately so a legal paused
      // frame can be marked without first pressing Play.
      publishCurrentTime()
    }
    const onEmptied = () => {
      cursorStatus.value = 'stale'
    }
    const onStableMediaState = () => {
      // The frame callback loop advances while playing, but browsers may stop
      // presenting callbacks while paused. Media events are the authoritative
      // fallback for the current paused/loaded position.
      publishCurrentTime()
    }
    element.addEventListener('seeking', onSeeking)
    element.addEventListener('seeked', onSeeked)
    element.addEventListener('emptied', onEmptied)
    element.addEventListener('pause', onStableMediaState)
    element.addEventListener('loadedmetadata', onStableMediaState)
    element.addEventListener('loadeddata', onStableMediaState)
    element.addEventListener('canplay', onStableMediaState)
    element.addEventListener('timeupdate', onStableMediaState)

    scheduleVideoFrameCallback()
    const hasVideoFrameCallback = typeof element.requestVideoFrameCallback === 'function'
    // requestVideoFrameCallback can stop producing callbacks while a browser is
    // paused, seeking, or waiting on an MSE append. Keep a small watchdog so a
    // settled currentTime can still become the annotation cursor without asking
    // the operator to press Play again.
    fallbackTimer = setInterval(
      () => {
        const currentMediaTimeUs = Number.isFinite(element.currentTime)
          ? BigInt(Math.round(element.currentTime * 1_000_000))
          : null
        const observedMediaTimeUs =
          cursor.value?.schema_version === '1.0.0'
            ? BigInt(cursor.value.player_media_time_us)
            : null
        const mediaTimeChanged =
          currentMediaTimeUs !== null &&
          (observedMediaTimeUs === null || currentMediaTimeUs !== observedMediaTimeUs)
        if (
          !hasVideoFrameCallback ||
          element.paused ||
          element.seeking ||
          (performance.now() - lastObservationAt > 350 && mediaTimeChanged)
        )
          publishCurrentTime()
      },
      hasVideoFrameCallback ? 250 : 100,
    )
    staleTimer = setInterval(() => {
      // A paused frame is still a valid annotation target. Only a playing video that
      // stops presenting frames becomes stale.
      if (
        !element.paused &&
        !element.seeking &&
        cursorStatus.value === 'ready' &&
        performance.now() - lastObservationAt > 1_000
      ) {
        cursorStatus.value = 'stale'
        if (cursor.value) cursor.value = { ...cursor.value, cursor_status: 'stale' }
      }
    }, 250)

    onBeforeUnmount(() => {
      element.removeEventListener('seeking', onSeeking)
      element.removeEventListener('seeked', onSeeked)
      element.removeEventListener('emptied', onEmptied)
      element.removeEventListener('pause', onStableMediaState)
      element.removeEventListener('loadedmetadata', onStableMediaState)
      element.removeEventListener('loadeddata', onStableMediaState)
      element.removeEventListener('canplay', onStableMediaState)
      element.removeEventListener('timeupdate', onStableMediaState)
    })
  })

  onBeforeUnmount(() => {
    const element = video.value
    if (element && callbackId !== null && 'cancelVideoFrameCallback' in element) {
      element.cancelVideoFrameCallback(callbackId)
    }
    if (fallbackTimer !== null) clearInterval(fallbackTimer)
    if (staleTimer !== null) clearInterval(staleTimer)
  })

  return {
    cursor,
    cursorStatus: readonly(cursorStatus),
    canCreateKeyPoint: computed(() => cursor.value?.cursor_status === 'ready'),
    markGap,
    refresh: publishCurrentTime,
  }
}
