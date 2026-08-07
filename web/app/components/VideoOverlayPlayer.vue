
<script setup lang="ts">
import type { PlaybackWindowDescriptor, PlaybackCursorInput } from '../composables/usePlaybackCursor'
import { useDvrPlayback } from '../composables/useDvrPlayback'

const props = defineProps<{ descriptor?: PlaybackWindowDescriptor | null }>()
const emit = defineEmits<{ cursor: [value: PlaybackCursorInput]; ready: [HTMLVideoElement]; error: [Error] }>()

const video = ref<HTMLVideoElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const descriptorRef = computed(() => props.descriptor ?? null)
const { cursor, cursorStatus } = usePlaybackCursor(video, descriptorRef)
const playback = useDvrPlayback(video)

watch(cursor, (value) => {
  if (value) emit('cursor', value)
})

watch(() => props.descriptor, async (descriptor) => {
  if (!descriptor) return
  const element = video.value
  if (!element) return
  try {
    await playback.attach(descriptor)
    emit('ready', element)
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error('Media manifest failed to load'))
  }
}, { immediate: true })

// Canvas drawing must map the actual video content rectangle, including letterboxing.
// It consumes lazy-loaded FlatBuffers chunks; it never draws the video pixels itself.
</script>

<template>
  <div class="relative overflow-hidden rounded-xl bg-black">
    <video ref="video" class="block h-auto w-full" playsinline preload="metadata" controls />
    <canvas ref="canvas" class="pointer-events-none absolute inset-0 h-full w-full" />
    <span class="absolute right-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
      {{ cursorStatus }} · {{ cursor?.player_media_time_us ?? '—' }} μs
    </span>
  </div>
</template>
