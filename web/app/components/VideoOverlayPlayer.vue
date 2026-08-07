
<script setup lang="ts">
import type { PlaybackWindowDescriptor, PlaybackCursorInput } from '../composables/usePlaybackCursor'
import { useDvrPlayback } from '../composables/useDvrPlayback'

const props = withDefaults(defineProps<{
  descriptor?: PlaybackWindowDescriptor | null
  controls?: boolean
  toggleOnClick?: boolean
}>(), {
  controls: true,
  toggleOnClick: false,
})
const emit = defineEmits<{
  cursor: [value: PlaybackCursorInput]
  ready: [HTMLVideoElement]
  error: [Error]
  toggle: []
}>()

const video = ref<HTMLVideoElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const descriptorRef = computed(() => props.descriptor ?? null)
const { cursor } = usePlaybackCursor(video, descriptorRef)
const playback = useDvrPlayback(video)

watch(cursor, (value) => {
  if (value) emit('cursor', value)
})

const attachDescriptor = async (descriptor: PlaybackWindowDescriptor | null) => {
  if (!descriptor) { playback.detach(); return }
  const element = video.value
  if (!element) return
  try {
    await playback.attach(descriptor)
    emit('ready', element)
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error('Media manifest failed to load'))
  }
}
watch([() => props.descriptor, video], ([descriptor]) => { void attachDescriptor(descriptor ?? null) }, { immediate: true })

function handleVideoClick() {
  if (props.toggleOnClick) emit('toggle')
}

// Canvas drawing must map the actual video content rectangle, including letterboxing.
// It consumes lazy-loaded FlatBuffers chunks; it never draws the video pixels itself.
</script>

<template>
  <div class="relative overflow-hidden rounded-xl bg-black">
    <video ref="video" class="block h-auto w-full" playsinline preload="metadata" :controls="controls" @click="handleVideoClick" />
    <canvas ref="canvas" class="pointer-events-none absolute inset-0 h-full w-full" />
  </div>
</template>
