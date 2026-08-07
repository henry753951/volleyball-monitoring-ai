
import type { ObservationSource, CursorStatus, PlaybackWindowDescriptor, PlaybackCursorInput } from '../lib/mediaModel'
export type { ObservationSource, CursorStatus, PlaybackWindowDescriptor, PlaybackCursorInput } from '../lib/mediaModel'

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

  const publish = (
    mediaTimeSeconds: number,
    source: ObservationSource,
    presentedFrames: number | undefined,
  ) => {
    const current = descriptor.value
    if (!current || !Number.isFinite(mediaTimeSeconds) || mediaTimeSeconds < 0) return

    lastObservationAt = performance.now()
    const playerMediaTimeUs = BigInt(Math.round(mediaTimeSeconds * 1_000_000))
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

  const scheduleVideoFrameCallback = () => {
    const element = video.value
    if (!element) return

    if (typeof element.requestVideoFrameCallback === 'function') {
      callbackId = element.requestVideoFrameCallback((_now, metadata) => {
        const frame = metadata as VideoFrameMetadataSubset
        if (cursorStatus.value !== 'gap') cursorStatus.value = element.seeking ? 'seeking' : 'ready'
        publish(frame.mediaTime, 'request_video_frame_callback', frame.presentedFrames)
        scheduleVideoFrameCallback()
      })
      return
    }

    fallbackTimer = setInterval(() => {
      if (cursorStatus.value !== 'gap') cursorStatus.value = element.seeking ? 'seeking' : 'ready'
      publish(element.currentTime, 'current_time_fallback', undefined)
    }, 100)
  }

  const markGap = (isGap: boolean) => {
    cursorStatus.value = isGap ? 'gap' : 'stale'
  }


  watch(descriptor, () => {
    seekGeneration.value += 1
    cursorStatus.value = 'stale'
    cursor.value = null
  })

  onMounted(() => {
    const element = video.value
    if (!element) return

    element.addEventListener('seeking', () => {
      seekGeneration.value += 1
      cursorStatus.value = 'seeking'
    })
    element.addEventListener('seeked', () => {
      cursorStatus.value = 'stale'
    })
    element.addEventListener('emptied', () => {
      cursorStatus.value = 'stale'
    })

    scheduleVideoFrameCallback()
    staleTimer = setInterval(() => {
      // A paused frame is still a valid annotation target. Only a playing video that
      // stops presenting frames becomes stale.
      if (
        !element.paused
        && !element.seeking
        && cursorStatus.value === 'ready'
        && performance.now() - lastObservationAt > 1_000
      ) {
        cursorStatus.value = 'stale'
        if (cursor.value) cursor.value = { ...cursor.value, cursor_status: 'stale' }
      }
    }, 250)
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
  }
}
