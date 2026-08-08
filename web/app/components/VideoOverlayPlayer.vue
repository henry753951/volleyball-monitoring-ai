
<script setup lang="ts">
import type { PlaybackWindowDescriptor, PlaybackCursorInput } from '../composables/usePlaybackCursor'
import { useDvrPlayback } from '../composables/useDvrPlayback'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from '../utils/playbackWindow'
import { mediaTimeRangesToCaptureRanges, type CanonicalMediaRange } from '../utils/mediaBuffer'
import ReplayOverlayCanvas, { type ReplayOverlayLayers, type ReplayOverlayMode } from './ReplayOverlayCanvas.vue'

const props = withDefaults(defineProps<{
  descriptor?: PlaybackWindowDescriptor | null
  controls?: boolean
  toggleOnClick?: boolean
  analysisRunId?: string | null
  overlayFrame?: number
  overlayCaptureTimeUs?: string | null
  overlayClipStartCaptureTimeUs?: string | null
  overlayMode?: ReplayOverlayMode
  overlayLayers?: ReplayOverlayLayers
}>(), {
  controls: true,
  toggleOnClick: false,
  analysisRunId: null,
  overlayFrame: -1,
  overlayCaptureTimeUs: null,
  overlayClipStartCaptureTimeUs: null,
  overlayMode: 'tracking',
  overlayLayers: () => ({ bbox: true, trackId: true, action: false, ball: true, trail: true, footprint: false, confidence: false }),
})
const emit = defineEmits<{
  cursor: [value: PlaybackCursorInput]
  ready: [HTMLVideoElement]
  bufferActivity: []
  bufferState: [value: { buffered: CanonicalMediaRange[], seekable: CanonicalMediaRange[] }]
  error: [Error]
  toggle: []
}>()

const video = ref<HTMLVideoElement | null>(null)
const retainedPreview = ref<string | null>(null)
const descriptorRef = computed(() => props.descriptor ?? null)
const { cursor } = usePlaybackCursor(video, descriptorRef)
function publishBufferState() {
  const element = video.value
  const descriptor = descriptorRef.value
  if (!element || !descriptor) {
    emit('bufferState', { buffered: [], seekable: [] })
    return
  }
  emit('bufferState', {
    buffered: mediaTimeRangesToCaptureRanges(element.buffered, descriptor.presentation_origin_capture_us),
    seekable: mediaTimeRangesToCaptureRanges(element.seekable, descriptor.presentation_origin_capture_us),
  })
}
const playback = useDvrPlayback(video, {
  onBufferActivity: () => {
    publishBufferState()
    emit('bufferActivity')
  },
})
const resolvedOverlayFrame = ref(props.overlayFrame)
const overlay = useOverlayChunks(() => props.analysisRunId ?? null, resolvedOverlayFrame)
watch([overlay.manifest, () => props.overlayFrame, () => props.overlayCaptureTimeUs, () => props.overlayClipStartCaptureTimeUs], ([manifest]) => {
  if (props.overlayFrame >= 0) { resolvedOverlayFrame.value = props.overlayFrame; return }
  if (!manifest || !props.overlayCaptureTimeUs || !props.overlayClipStartCaptureTimeUs) { resolvedOverlayFrame.value = -1; return }
  const delta = BigInt(props.overlayCaptureTimeUs) - BigInt(props.overlayClipStartCaptureTimeUs)
  resolvedOverlayFrame.value = delta < 0n ? -1 : Number(delta * BigInt(manifest.video.fps.num) / (1_000_000n * BigInt(manifest.video.fps.den)))
}, { immediate: true })

watch(cursor, (value) => {
  if (value) emit('cursor', value)
})
watch(overlay.error, (value) => { if (value) emit('error', value) })

let sourceGeneration = 0
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
  if (!descriptor) { playback.detach(); retainedPreview.value = null; publishBufferState(); return }
  const element = video.value
  if (!element) return
  const shouldResume = !element.paused && !element.ended
  const replacingPipeline = playback.activeWindow.value?.playback_window_id !== descriptor.playback_window_id
  if (replacingPipeline) retainedPreview.value = capturePresentedFrame(element)
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
  element.currentTime = captureTimeToPlayerSeconds(target, descriptor)
  return true
}
function previewCaptureTimeIfBuffered(targetCaptureTimeUs: string) {
  return seekCaptureTimeIfBuffered(targetCaptureTimeUs)
}
defineExpose({ seekCaptureTimeIfBuffered, previewCaptureTimeIfBuffered })

// Canvas drawing must map the actual video content rectangle, including letterboxing.
// It consumes lazy-loaded FlatBuffers chunks; it never draws the video pixels itself.
</script>

<template>
  <div class="relative size-full overflow-hidden rounded-xl bg-black">
    <video ref="video" class="block size-full object-contain" playsinline preload="auto" :controls="controls" @progress="publishBufferState" @durationchange="publishBufferState" @emptied="publishBufferState" @click="handleVideoClick" />
    <img v-if="retainedPreview" :src="retainedPreview" alt="" aria-hidden="true" class="pointer-events-none absolute inset-0 z-20 size-full object-contain" />
    <ReplayOverlayCanvas
      v-if="analysisRunId && resolvedOverlayFrame >= 0 && overlay.manifest.value"
      :events="[]"
      :frame="resolvedOverlayFrame"
      :video-width="overlay.manifest.value.video.width"
      :video-height="overlay.manifest.value.video.height"
      :chunk="overlay.currentChunk.value"
      :action-labels="overlay.actionLabels.value"
      :mode="overlayMode"
      :layers="overlayLayers"
    />
  </div>
</template>
