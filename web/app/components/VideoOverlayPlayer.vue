
<script setup lang="ts">
import type { PlaybackWindowDescriptor, PlaybackCursorInput } from '../composables/usePlaybackCursor'
import { useDvrPlayback } from '../composables/useDvrPlayback'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from '../utils/playbackWindow'
import { mediaTimeRangesToCaptureRanges, type CanonicalMediaRange } from '../utils/mediaBuffer'
import { resolveFrameFromRate, resolveFrameFromTimeline } from '../utils/overlayFrameTimeline'
import type { ReplayContactEvent } from '../lib/coachDomain'
import type { OverlayBallOverride, OverlayFrameBBox, OverlayTrackMetadata, VolleyballOverlayLayers, VolleyballOverlayMode } from '../utils/volleyballOverlayRenderer'

const props = withDefaults(defineProps<{
  descriptor?: PlaybackWindowDescriptor | null
  controls?: boolean
  toggleOnClick?: boolean
  analysisRunId?: string | null
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
  contactTimeCorrections?: Record<string, number>
  identityLabels?: Record<number, string>
  overlayEvents?: ReplayContactEvent[]
  overlayTracks?: OverlayTrackMetadata[]
  overlayTeamLabels?: { left: string; right: string }
}>(), {
  controls: true,
  toggleOnClick: false,
  analysisRunId: null,
  overlayFrame: -1,
  overlayCaptureTimeUs: null,
  overlayClipStartCaptureTimeUs: null,
  overlayMode: 'tracking',
  overlayLayers: () => ({ bbox: true, trackId: true, action: true, ball: true, trail: true, footprint: true, confidence: false, court: true, nextHit: true }),
  overlayInteractive: false,
  ballRelabel: false,
  bboxRelabel: false,
  selectedTrackId: null,
  ballCorrection: null,
  ballCorrections: () => ({}),
  actionCorrections: () => ({}),
  playerBboxCorrections: () => ({}),
  contactActorCorrections: () => ({}),
  contactTimeCorrections: () => ({}),
  identityLabels: () => ({}),
  overlayEvents: () => [],
  overlayTracks: () => [],
  overlayTeamLabels: undefined,
})
const emit = defineEmits<{
  cursor: [value: PlaybackCursorInput]
  ready: [HTMLVideoElement]
  bufferActivity: []
  bufferState: [value: {
    buffered: CanonicalMediaRange[]
    mappingVersion: number | null
    playbackWindowId: string | null
    presentationOriginCaptureUs: string | null
    seekable: CanonicalMediaRange[]
  }]
  error: [Error]
  toggle: []
  ballPosition: [position: { x: number; y: number }]
  playerBbox: [selection: { trackId: number; frameBBox: OverlayFrameBBox }]
  trackSelect: [selection: { trackId: number; clientX: number; clientY: number; action: string | null }]
  overlayFrame: [frame: number]
  overlayVideo: [value: { width: number; height: number } | null]
}>()

const video = ref<HTMLVideoElement | null>(null)
const retainedPreview = ref<string | null>(null)
const descriptorRef = computed(() => props.descriptor ?? null)
const { cursor } = usePlaybackCursor(video, descriptorRef)
function publishBufferState() {
  const element = video.value
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
    buffered: mediaTimeRangesToCaptureRanges(element.buffered, descriptor.presentation_origin_capture_us),
    mappingVersion: descriptor.mapping_version,
    playbackWindowId: descriptor.playback_window_id,
    presentationOriginCaptureUs: descriptor.presentation_origin_capture_us,
    seekable: mediaTimeRangesToCaptureRanges(element.seekable, descriptor.presentation_origin_capture_us),
  })
}
const playback = useDvrPlayback(video, {
  onBufferActivity: () => {
    publishBufferState()
    emit('bufferActivity')
  },
  onError: error => emit('error', error),
})
const resolvedOverlayFrame = ref(props.overlayFrame)
const overlay = useOverlayChunks(() => props.analysisRunId ?? null, resolvedOverlayFrame, () => props.overlayMode !== 'off')
watch([overlay.manifest, () => props.overlayFrame, () => props.overlayCaptureTimeUs, () => props.overlayClipStartCaptureTimeUs], ([manifest]) => {
  if (props.overlayFrame >= 0) { resolvedOverlayFrame.value = props.overlayFrame; return }
  if (!manifest || !props.overlayCaptureTimeUs) { resolvedOverlayFrame.value = -1; return }
  if (manifest.frame_timing) {
    resolvedOverlayFrame.value = resolveFrameFromTimeline(props.overlayCaptureTimeUs, manifest.frame_timing.capture_time_us, manifest.frame_timing.capture_end_time_us)
    return
  }
  if (!props.overlayClipStartCaptureTimeUs) { resolvedOverlayFrame.value = -1; return }
  const delta = BigInt(props.overlayCaptureTimeUs) - BigInt(props.overlayClipStartCaptureTimeUs)
  resolvedOverlayFrame.value = resolveFrameFromRate(delta.toString(), manifest.video.fps, manifest.video.total_frames)
}, { immediate: true })
watch(resolvedOverlayFrame, frame => emit('overlayFrame', frame), { immediate: true })
watch(overlay.manifest, manifest => emit('overlayVideo', manifest ? { width: manifest.video.width, height: manifest.video.height } : null), { immediate: true })

watch(cursor, (value) => {
  if (value) emit('cursor', value)
})
watch(overlay.error, (value) => { if (value) emit('error', value) })

let sourceGeneration = 0
let previewGeneration = 0
function capturePresentedFrame(element: HTMLVideoElement) {
  if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !element.videoWidth || !element.videoHeight) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = element.videoWidth
    canvas.height = element.videoHeight
    canvas.getContext('2d')?.drawImage(element, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', .78)
  }
  catch { return null }
}
async function waitForPresentedFrame(element: HTMLVideoElement) {
  if (typeof element.requestVideoFrameCallback !== 'function') return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(finish, 1_500)
    element.requestVideoFrameCallback(finish)
  })
}
const attachDescriptor = async (descriptor: PlaybackWindowDescriptor | null) => {
  const generation = ++sourceGeneration
  previewGeneration += 1
  if (!descriptor) { playback.detach(); retainedPreview.value = null; publishBufferState(); return }
  const element = video.value
  if (!element) return
  const shouldResume = !element.paused && !element.ended
  const replacingPipeline = playback.activeWindow.value?.playback_window_id !== descriptor.playback_window_id
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
watch([() => props.descriptor, video], ([descriptor]) => { void attachDescriptor(descriptor ?? null) }, { immediate: true })

function handleVideoClick() {
  if (props.toggleOnClick) emit('toggle')
}
function seekCaptureTimeIfBuffered(targetCaptureTimeUs: string) {
  const descriptor = playback.activeWindow.value
  const element = video.value
  const target = BigInt(targetCaptureTimeUs)
  if (!descriptor || !element || Date.parse(descriptor.expires_at) <= Date.now() + 30_000 || !isCaptureTimeWithinWindow(target, descriptor)) return false
  const generation = ++previewGeneration
  retainedPreview.value = capturePresentedFrame(element)
  element.currentTime = captureTimeToPlayerSeconds(target, descriptor)
  void waitForPresentedFrame(element).then(() => {
    if (generation === previewGeneration) retainedPreview.value = null
  })
  return true
}
function previewCaptureTimeIfBuffered(targetCaptureTimeUs: string) {
  return seekCaptureTimeIfBuffered(targetCaptureTimeUs)
}
function overlayFrameCaptureTime(frame: number) {
  const manifest = overlay.manifest.value
  if (!manifest || frame < 0) return null
  const timed = manifest.frame_timing?.capture_time_us[frame]
  if (timed) return timed
  if (!props.overlayClipStartCaptureTimeUs) return null
  return (BigInt(props.overlayClipStartCaptureTimeUs) + BigInt(frame) * 1_000_000n * BigInt(manifest.video.fps.den) / BigInt(manifest.video.fps.num)).toString()
}
function seekOverlayFrameIfBuffered(frame: number) {
  const captureTime = overlayFrameCaptureTime(frame)
  return captureTime ? seekCaptureTimeIfBuffered(captureTime) : false
}
function recoverPlayback() {
  return playback.recover()
}
defineExpose({ overlayFrameCaptureTime, previewCaptureTimeIfBuffered, recoverPlayback, seekCaptureTimeIfBuffered, seekOverlayFrameIfBuffered })

// Canvas drawing must map the actual video content rectangle, including letterboxing.
// It consumes lazy-loaded FlatBuffers chunks; it never draws the video pixels itself.
</script>

<template>
  <div class="relative size-full overflow-hidden rounded-xl bg-black">
    <video ref="video" class="block size-full object-contain" playsinline preload="auto" :controls="controls" @progress="publishBufferState" @loadeddata="publishBufferState" @durationchange="publishBufferState" @emptied="publishBufferState" @click="handleVideoClick" />
    <img v-if="retainedPreview" :src="retainedPreview" alt="" aria-hidden="true" class="pointer-events-none absolute inset-0 z-20 size-full object-contain" />
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
      :contact-time-corrections="contactTimeCorrections"
      :identity-labels="identityLabels"
      :tracks="overlayTracks"
      :team-labels="overlayTeamLabels"
      @ball-position="emit('ballPosition', $event)"
      @player-bbox="emit('playerBbox', $event)"
      @track-select="emit('trackSelect', $event)"
    />
  </div>
</template>
