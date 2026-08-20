<script setup lang="ts">
import type {
  PlaybackWindowDescriptor,
  PlaybackCursorInput,
} from '../composables/usePlaybackCursor'
import type { CanonicalFrameAnchor } from '../lib/mediaModel'
import { useDvrPlayback } from '../composables/useDvrPlayback'
import { createOmeLivePlaybackService } from '../services/annotation-workstation/ome-live-playback.service'
import {
  omePlayerSecondsForCaptureTime,
  omePresentationAnchorForPlayingDate,
  omePresentationOriginFromPlayingDate,
  type OmeLivePlaybackSource,
} from '../lib/omeLivePlayback'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from '../utils/playbackWindow'
import { boundedPlayerMediaSeconds } from '../utils/playerMediaTime'
import {
  mediaTimeRangeContains,
  mediaTimeRangesToCaptureRanges,
  type CanonicalMediaRange,
} from '../utils/mediaBuffer'
import { resolveFrameFromRate, resolveFrameFromTimeline } from '../utils/overlayFrameTimeline'
import type { ReplayContactEvent } from '../lib/coachDomain'
import type {
  OverlayBallOverride,
  OverlayFrameBBox,
  OverlayTrackMetadata,
  VolleyballOverlayLayers,
  VolleyballOverlayMode,
} from '../utils/volleyballOverlayRenderer'

const props = withDefaults(
  defineProps<{
    descriptor?: PlaybackWindowDescriptor | null
    liveSource?: OmeLivePlaybackSource | null
    controls?: boolean
    toggleOnClick?: boolean
    analysisRunId?: string | null
    analysisDataEnabled?: boolean
    overlayFrame?: number
    overlayCaptureTimeUs?: string | null
    overlayClipStartCaptureTimeUs?: string | null
    overlayMode?: VolleyballOverlayMode
    overlayLayers?: VolleyballOverlayLayers
    overlayInteractive?: boolean
    ballRelabel?: boolean
    bboxRelabel?: boolean
    selectedTrackId?: number | null
    ballCorrection?: OverlayBallOverride | null
    ballCorrections?: Record<number, OverlayBallOverride>
    actionCorrections?: Record<number, string>
    playerBboxCorrections?: Record<number, Record<number, OverlayFrameBBox>>
    contactActorCorrections?: Record<string, number | null>
    contactActorProjections?: Record<string, number | null>
    contactTimeCorrections?: Record<string, number>
    identityLabels?: Record<number, string>
    overlayEvents?: ReplayContactEvent[]
    overlayTracks?: OverlayTrackMetadata[]
    overlayTeamLabels?: { left: string; right: string }
  }>(),
  {
    controls: true,
    liveSource: null,
    toggleOnClick: false,
    analysisRunId: null,
    analysisDataEnabled: true,
    overlayFrame: -1,
    overlayCaptureTimeUs: null,
    overlayClipStartCaptureTimeUs: null,
    overlayMode: 'tracking',
    overlayLayers: () => ({
      bbox: true,
      trackId: true,
      playerLabel: true,
      action: true,
      ball: true,
      trail: true,
      footprint: true,
      confidence: false,
      court: true,
      nextHit: true,
    }),
    overlayInteractive: false,
    ballRelabel: false,
    bboxRelabel: false,
    selectedTrackId: null,
    ballCorrection: null,
    ballCorrections: () => ({}),
    actionCorrections: () => ({}),
    playerBboxCorrections: () => ({}),
    contactActorCorrections: () => ({}),
    contactActorProjections: () => ({}),
    contactTimeCorrections: () => ({}),
    identityLabels: () => ({}),
    overlayEvents: () => [],
    overlayTracks: () => [],
    overlayTeamLabels: undefined,
  },
)
const emit = defineEmits<{
  cursor: [value: PlaybackCursorInput]
  liveError: [value: Error]
  livePosition: [
    value: {
      atLiveEdge: boolean
      captureTimeUs: string | null
      mappingStatus: 'validated' | 'unmapped'
    },
  ]
  ready: [HTMLVideoElement]
  bufferActivity: []
  bufferState: [
    value: {
      buffered: CanonicalMediaRange[]
      mappingVersion: number | null
      playbackWindowId: string | null
      presentationOriginCaptureUs: string | null
      seekable: CanonicalMediaRange[]
    },
  ]
  error: [Error]
  overlayError: [Error]
  toggle: []
  ballPosition: [position: { x: number; y: number }]
  playerBbox: [selection: { trackId: number; frameBBox: OverlayFrameBBox }]
  trackSelect: [
    selection: { trackId: number; clientX: number; clientY: number; action: string | null },
  ]
  overlayFrame: [frame: number]
  overlayVideo: [value: { width: number; height: number } | null]
}>()

const video = ref<HTMLVideoElement | null>(null)
const retainedPreview = ref<string | null>(null)
const descriptorRef = computed(() => props.descriptor ?? null)
const liveSourceRef = computed(() => props.liveSource ?? null)
const { cursor, refresh: refreshCursor } = usePlaybackCursor(video, descriptorRef)
const omeSeekGeneration = ref(0)
function livePresentationOriginCaptureUs() {
  const element = video.value
  const source = liveSourceRef.value
  if (!element || !source) return null
  return omePresentationOriginFromPlayingDate(
    source.presentationAnchors,
    omePlayback.playingDate(),
    element.currentTime,
  )
}
function publishBufferState() {
  const element = video.value
  const liveSource = liveSourceRef.value
  if (element && liveSource) {
    const presentationOriginCaptureUs = livePresentationOriginCaptureUs()
    emit('bufferState', {
      buffered: presentationOriginCaptureUs
        ? mediaTimeRangesToCaptureRanges(element.buffered, presentationOriginCaptureUs)
        : [],
      mappingVersion: null,
      playbackWindowId: null,
      presentationOriginCaptureUs,
      seekable: presentationOriginCaptureUs
        ? mediaTimeRangesToCaptureRanges(element.seekable, presentationOriginCaptureUs)
        : [],
    })
    return
  }
  const descriptor = descriptorRef.value
  if (!element || !descriptor) {
    emit('bufferState', {
      buffered: [],
      mappingVersion: null,
      playbackWindowId: null,
      presentationOriginCaptureUs: null,
      seekable: [],
    })
    return
  }
  emit('bufferState', {
    buffered: mediaTimeRangesToCaptureRanges(
      element.buffered,
      descriptor.presentation_origin_capture_us,
    ),
    mappingVersion: descriptor.mapping_version,
    playbackWindowId: descriptor.playback_window_id,
    presentationOriginCaptureUs: descriptor.presentation_origin_capture_us,
    seekable: mediaTimeRangesToCaptureRanges(
      element.seekable,
      descriptor.presentation_origin_capture_us,
    ),
  })
}
const playback = useDvrPlayback(video, {
  onBufferActivity: () => {
    publishBufferState()
    emit('bufferActivity')
  },
  onError: error => emit('error', error),
})
const omePlayback = createOmeLivePlaybackService(video, useMediaPlaybackPreferences().profile, {
  onBufferActivity: () => {
    publishBufferState()
    emit('bufferActivity')
  },
  onError: error => emit('liveError', error),
})
const resolvedOverlayFrame = ref(props.overlayFrame)
const overlay = useAnalysisFrameChunks(
  () => props.analysisRunId ?? null,
  resolvedOverlayFrame,
  () => props.analysisDataEnabled && props.overlayMode !== 'off',
)
watch(
  [
    overlay.manifest,
    () => props.overlayFrame,
    () => props.overlayCaptureTimeUs,
    () => props.overlayClipStartCaptureTimeUs,
  ],
  ([manifest]) => {
    if (props.overlayFrame >= 0) {
      resolvedOverlayFrame.value = props.overlayFrame
      return
    }
    if (!manifest || !props.overlayCaptureTimeUs) {
      resolvedOverlayFrame.value = -1
      return
    }
    if (manifest.frame_timing) {
      resolvedOverlayFrame.value = resolveFrameFromTimeline(
        props.overlayCaptureTimeUs,
        manifest.frame_timing.capture_time_us,
        manifest.frame_timing.capture_end_time_us,
      )
      return
    }
    if (!props.overlayClipStartCaptureTimeUs) {
      resolvedOverlayFrame.value = -1
      return
    }
    const delta = BigInt(props.overlayCaptureTimeUs) - BigInt(props.overlayClipStartCaptureTimeUs)
    resolvedOverlayFrame.value = resolveFrameFromRate(
      delta.toString(),
      manifest.video.fps,
      manifest.video.total_frames,
    )
  },
  { immediate: true },
)
watch(resolvedOverlayFrame, frame => emit('overlayFrame', frame), { immediate: true })
watch(
  overlay.manifest,
  manifest =>
    emit(
      'overlayVideo',
      manifest ? { width: manifest.video.width, height: manifest.video.height } : null,
    ),
  { immediate: true },
)

watch(cursor, value => {
  if (value && !liveSourceRef.value) emit('cursor', value)
})
watch(overlay.error, value => {
  if (value) emit('overlayError', value)
})

let sourceGeneration = 0
let previewGeneration = 0
let pendingCanonicalFrame: Pick<
  CanonicalFrameAnchor,
  'playback_window_id' | 'mapping_version' | 'player_media_time_us'
> | null = null
function capturePresentedFrame(element: HTMLVideoElement) {
  if (
    element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !element.videoWidth ||
    !element.videoHeight
  )
    return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = element.videoWidth
    canvas.height = element.videoHeight
    canvas.getContext('2d')?.drawImage(element, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.78)
  } catch {
    return null
  }
}
async function waitForPresentedFrame(element: HTMLVideoElement, expectedMediaTime?: number) {
  if (typeof element.requestVideoFrameCallback !== 'function') return
  await new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const inspect = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (settled) return
      if (
        expectedMediaTime === undefined ||
        Math.abs(metadata.mediaTime - expectedMediaTime) <= 0.25
      ) {
        finish()
        return
      }
      element.requestVideoFrameCallback(inspect)
    }
    const timeout = setTimeout(finish, 3_000)
    element.requestVideoFrameCallback(inspect)
  })
}
const attachDescriptor = async (descriptor: PlaybackWindowDescriptor | null) => {
  const generation = ++sourceGeneration
  previewGeneration += 1
  if (!descriptor) {
    pendingCanonicalFrame = null
    playback.detach()
    retainedPreview.value = null
    publishBufferState()
    return
  }
  const element = video.value
  if (!element) return
  if (
    pendingCanonicalFrame &&
    pendingCanonicalFrame.playback_window_id !== descriptor.playback_window_id
  )
    pendingCanonicalFrame = null
  const shouldResume = !element.paused && !element.ended
  const replacingPipeline =
    playback.activeWindow.value?.playback_window_id !== descriptor.playback_window_id
  if (replacingPipeline) {
    retainedPreview.value = capturePresentedFrame(element)
    emit('bufferState', {
      buffered: [],
      mappingVersion: descriptor.mapping_version,
      playbackWindowId: descriptor.playback_window_id,
      presentationOriginCaptureUs: descriptor.presentation_origin_capture_us,
      seekable: [],
    })
  }
  try {
    await playback.attach(descriptor)
    if (generation !== sourceGeneration) return
    applyPendingCanonicalFrame(replacingPipeline)
    refreshCursor()
    emit('ready', element)
    publishBufferState()
    if (shouldResume) await element.play().catch(() => undefined)
    if (replacingPipeline) await waitForPresentedFrame(element)
    if (generation === sourceGeneration && replacingPipeline) retainedPreview.value = null
  } catch (error) {
    if (generation !== sourceGeneration) return
    emit('error', error instanceof Error ? error : new Error('Media manifest failed to load'))
  }
}
const attachLiveSource = async (source: OmeLivePlaybackSource) => {
  const generation = ++sourceGeneration
  previewGeneration += 1
  pendingCanonicalFrame = null
  if (playback.activeWindow.value) playback.detach()
  const element = video.value
  if (!element) return
  const replacingPipeline =
    omePlayback.activeSource.value?.captureSessionId !== source.captureSessionId
  if (replacingPipeline) retainedPreview.value = capturePresentedFrame(element)
  try {
    await omePlayback.attach(source)
    if (generation !== sourceGeneration) return
    emit('ready', element)
    publishBufferState()
    if (replacingPipeline) await waitForPresentedFrame(element)
    if (generation === sourceGeneration && replacingPipeline) retainedPreview.value = null
  } catch (error) {
    if (generation !== sourceGeneration) return
    emit('liveError', error instanceof Error ? error : new Error('OME LL-HLS failed to load'))
  }
}
watch(
  [() => props.descriptor, () => props.liveSource, video],
  ([descriptor, liveSource]) => {
    if (liveSource) {
      void attachLiveSource(liveSource)
      return
    }
    if (omePlayback.activeSource.value) omePlayback.detach()
    void attachDescriptor(descriptor ?? null)
  },
  { immediate: true },
)

function handleVideoClick() {
  if (props.toggleOnClick) emit('toggle')
}
function seekCaptureTimeIfBuffered(targetCaptureTimeUs: string) {
  const liveSource = liveSourceRef.value
  const element = video.value
  if (liveSource && element) {
    const origin = livePresentationOriginCaptureUs()
    if (!origin) return false
    const targetPlayerSeconds = omePlayerSecondsForCaptureTime(targetCaptureTimeUs, origin)
    if (!mediaTimeRangeContains(element.seekable, targetPlayerSeconds)) return false
    previewGeneration += 1
    retainedPreview.value = null
    element.currentTime = targetPlayerSeconds
    refreshCursor()
    return true
  }
  const descriptor = playback.activeWindow.value
  const target = BigInt(targetCaptureTimeUs)
  if (
    !descriptor ||
    !element ||
    Date.parse(descriptor.expires_at) <= Date.now() + 30_000 ||
    !isCaptureTimeWithinWindow(target, descriptor)
  )
    return false
  const targetPlayerSeconds = captureTimeToPlayerSeconds(target, descriptor)
  if (!mediaTimeRangeContains(element.buffered, targetPlayerSeconds)) return false
  previewGeneration += 1
  retainedPreview.value = null
  element.currentTime = targetPlayerSeconds
  refreshCursor()
  return true
}
function previewCaptureTimeIfBuffered(targetCaptureTimeUs: string) {
  return seekCaptureTimeIfBuffered(targetCaptureTimeUs)
}
function previewPlayerMediaTime(targetPlayerSeconds: number) {
  const element = video.value
  if (!element || !Number.isFinite(targetPlayerSeconds)) return false
  previewGeneration += 1
  pendingCanonicalFrame = null
  retainedPreview.value = null
  if (!element.paused) element.pause()
  element.currentTime = boundedPlayerMediaSeconds(
    String(Math.round(targetPlayerSeconds * 1_000_000)),
  )
  refreshCursor()
  return true
}
function applyPendingCanonicalFrame(preserveRetainedPreview = false) {
  const anchor = pendingCanonicalFrame
  const descriptor = playback.activeWindow.value
  const element = video.value
  if (
    !anchor ||
    !descriptor ||
    !element ||
    anchor.playback_window_id !== descriptor.playback_window_id ||
    anchor.mapping_version !== descriptor.mapping_version
  )
    return false
  pendingCanonicalFrame = null
  const generation = ++previewGeneration
  if (preserveRetainedPreview)
    retainedPreview.value = capturePresentedFrame(element) ?? retainedPreview.value
  else retainedPreview.value = null
  element.currentTime = boundedPlayerMediaSeconds(anchor.player_media_time_us)
  refreshCursor()
  if (preserveRetainedPreview)
    void waitForPresentedFrame(element).then(() => {
      if (generation === previewGeneration) retainedPreview.value = null
    })
  return true
}
function seekCanonicalFrame(
  anchor: Pick<
    CanonicalFrameAnchor,
    'playback_window_id' | 'mapping_version' | 'player_media_time_us'
  >,
) {
  if (liveSourceRef.value) return false
  pendingCanonicalFrame = anchor
  return applyPendingCanonicalFrame()
}
function overlayFrameCaptureTime(frame: number) {
  const manifest = overlay.manifest.value
  if (!manifest || frame < 0) return null
  const timed = manifest.frame_timing?.capture_time_us[frame]
  if (timed) return timed
  if (!props.overlayClipStartCaptureTimeUs) return null
  return (
    BigInt(props.overlayClipStartCaptureTimeUs) +
    (BigInt(frame) * 1_000_000n * BigInt(manifest.video.fps.den)) / BigInt(manifest.video.fps.num)
  ).toString()
}
function seekOverlayFrameIfBuffered(frame: number) {
  const captureTime = overlayFrameCaptureTime(frame)
  return captureTime ? seekCaptureTimeIfBuffered(captureTime) : false
}
function recoverPlayback() {
  return liveSourceRef.value ? omePlayback.recover() : playback.recover()
}
function seekLiveEdge() {
  const element = video.value
  if (!liveSourceRef.value || !element || element.seekable.length === 0) return false
  const lastRange = element.seekable.length - 1
  element.currentTime = Math.max(
    element.seekable.start(lastRange),
    element.seekable.end(lastRange) - 0.5,
  )
  refreshCursor()
  return true
}
function publishLivePosition() {
  const element = video.value
  if (!element || !liveSourceRef.value || element.seekable.length === 0) return
  const seekableEnd = element.seekable.end(element.seekable.length - 1)
  const origin = livePresentationOriginCaptureUs()
  const playingDate = omePlayback.playingDate()
  const anchor = omePresentationAnchorForPlayingDate(
    liveSourceRef.value.presentationAnchors,
    playingDate,
  )
  if (origin && anchor && playingDate) {
    emit('cursor', {
      schema_version: '2.0.0',
      media_backend: 'ome_llhls',
      capture_session_id: liveSourceRef.value.captureSessionId,
      presentation_anchor_sequence: anchor.sequenceIndex,
      program_date_time: playingDate.toISOString(),
      player_media_time_us: BigInt(Math.round(element.currentTime * 1_000_000)).toString(),
      observation_source: 'current_time_fallback',
      presented_frames: null,
      seek_generation: omeSeekGeneration.value,
      cursor_status: element.seeking ? 'seeking' : 'ready',
    })
  }
  emit('livePosition', {
    atLiveEdge: seekableEnd - element.currentTime <= 3,
    captureTimeUs: origin
      ? (
          BigInt(origin) + BigInt(Math.max(0, Math.round(element.currentTime * 1_000_000)))
        ).toString()
      : null,
    mappingStatus: origin ? 'validated' : 'unmapped',
  })
}
function handleLiveSeeking() {
  if (!liveSourceRef.value) return
  omeSeekGeneration.value += 1
  publishLivePosition()
}
defineExpose({
  overlayFrameCaptureTime,
  previewPlayerMediaTime,
  previewCaptureTimeIfBuffered,
  recoverPlayback,
  seekCanonicalFrame,
  refreshCursor,
  seekCaptureTimeIfBuffered,
  seekLiveEdge,
  seekOverlayFrameIfBuffered,
})

// Canvas drawing must map the actual video content rectangle, including letterboxing.
// It consumes lazy-loaded FlatBuffers chunks; it never draws the video pixels itself.
</script>

<template>
  <div
    class="relative size-full overflow-hidden rounded-xl bg-black"
    :data-media-backend="liveSource ? 'ome_llhls' : 'legacy_playback_window'"
  >
    <video
      ref="video"
      class="block size-full object-contain"
      playsinline
      preload="auto"
      :controls="controls"
      @progress="publishBufferState"
      @loadeddata="publishBufferState"
      @durationchange="publishBufferState"
      @emptied="publishBufferState"
      @timeupdate="publishLivePosition"
      @seeking="handleLiveSeeking"
      @seeked="publishLivePosition"
      @click="handleVideoClick"
    />
    <img
      v-if="retainedPreview"
      :src="retainedPreview"
      alt=""
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 z-20 size-full object-contain"
    />
    <VolleyballOverlayCanvas
      v-if="analysisRunId && resolvedOverlayFrame >= 0 && overlay.manifest.value"
      :events="overlayEvents"
      :frame="resolvedOverlayFrame"
      :video-width="overlay.manifest.value.video.width"
      :video-height="overlay.manifest.value.video.height"
      :chunk="overlay.currentChunk.value"
      :action-labels="overlay.actionLabels.value"
      :mode="overlayMode"
      :layers="overlayLayers"
      :interactive="overlayInteractive"
      :ball-relabel="ballRelabel"
      :bbox-relabel="bboxRelabel"
      :selected-track-id="selectedTrackId"
      :ball-correction="ballCorrection"
      :ball-corrections="ballCorrections"
      :action-corrections="actionCorrections"
      :player-bbox-corrections="playerBboxCorrections"
      :contact-actor-corrections="contactActorCorrections"
      :contact-actor-projections="contactActorProjections"
      :contact-time-corrections="contactTimeCorrections"
      :identity-labels="identityLabels"
      :tracks="overlayTracks"
      :team-labels="overlayTeamLabels"
      @media-click="handleVideoClick"
      @ball-position="emit('ballPosition', $event)"
      @player-bbox="emit('playerBbox', $event)"
      @track-select="emit('trackSelect', $event)"
    />
  </div>
</template>
