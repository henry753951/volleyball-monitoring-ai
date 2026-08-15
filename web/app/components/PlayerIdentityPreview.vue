<script setup lang="ts">
import { ImageOff, LoaderCircle } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'
import type { CoachMatchAnalytics } from '~/lib/coachDomain'
import { previewFrameSeconds, selectPlayerPreviewTracks } from '~/utils/playerIdentityPreview'

const props = defineProps<{
  matchId: string
  rosterEntryId: string
  playerName: string
  jerseyNumber: string
  tracks: CoachMatchAnalytics['tracks']
  analysisRunId: string | null
  trackId: number | null
}>()

interface PreviewFrame {
  src: string
  setNumber: number
  rallyOrdinal: number
}
const previewCache = new Map<string, Promise<PreviewFrame[]>>()
const service = useIdentityAssignmentService()
const frames = shallowRef<PreviewFrame[]>([])
const loading = ref(false)
const failed = ref(false)
const activeFrame = ref(0)
let loadGeneration = 0
let rotationTimer: ReturnType<typeof setInterval> | null = null

const candidates = computed(() =>
  selectPlayerPreviewTracks(props.tracks, props.rosterEntryId, {
    analysisRunId: props.analysisRunId,
    trackId: props.trackId,
  }),
)
const current = computed(() => frames.value[activeFrame.value] ?? null)

function mediaEvent(element: HTMLVideoElement, eventName: 'loadedmetadata' | 'seeked') {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('預覽載入逾時')), 8_000)
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      element.removeEventListener(eventName, loaded)
      element.removeEventListener('error', errored)
      if (error) reject(error)
      else resolve()
    }
    const loaded = () => finish()
    const errored = () => finish(new Error('無法讀取片段預覽'))
    element.addEventListener(eventName, loaded, { once: true })
    element.addEventListener('error', errored, { once: true })
  })
}

function presentedVideoFrame(video: HTMLVideoElement) {
  return new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      resolve()
    }
    const timeout = window.setTimeout(finish, 600)
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(finish)
    else window.requestAnimationFrame(finish)
  })
}

async function captureFrames(url: string, seconds: number[]) {
  if (!seconds.length) return []
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = url
  try {
    await mediaEvent(video, 'loadedmetadata')
    const output: string[] = []
    for (const second of seconds) {
      video.currentTime = Math.max(0, Math.min(second, Math.max(0, video.duration - 0.04)))
      await mediaEvent(video, 'seeked')
      await presentedVideoFrame(video)
      if (!video.videoWidth || !video.videoHeight) continue
      const width = Math.min(420, video.videoWidth)
      const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')?.drawImage(video, 0, 0, width, height)
      output.push(canvas.toDataURL('image/webp', 0.76))
    }
    return output
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

async function loadCandidate(track: CoachMatchAnalytics['tracks'][number]) {
  const key = `${track.analysis_run_id}:${track.track_id}:${track.first_frame_index}:${track.last_frame_index}`
  const cached = previewCache.get(key)
  if (cached) return cached
  const promise = (async () => {
    const replay = await service.rallyReplay(track.rally_id)
    if (!replay?.clip) return []
    const seconds = previewFrameSeconds({
      firstFrameIndex: track.first_frame_index,
      lastFrameIndex: track.last_frame_index,
      fps: replay.clip.fps,
      durationUs: replay.clip.duration_us,
    })
    const sources = await captureFrames(replay.clip.url, seconds)
    return sources.map(src => ({
      src,
      setNumber: track.set_number,
      rallyOrdinal: track.rally_ordinal,
    }))
  })().catch(() => [])
  previewCache.set(key, promise)
  return promise
}

function stopRotation() {
  if (rotationTimer) clearInterval(rotationTimer)
  rotationTimer = null
}

function startRotation() {
  stopRotation()
  if (frames.value.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    return
  rotationTimer = setInterval(() => {
    activeFrame.value = (activeFrame.value + 1) % frames.value.length
  }, 500)
}

async function refresh() {
  const generation = ++loadGeneration
  stopRotation()
  frames.value = []
  activeFrame.value = 0
  failed.value = false
  if (!import.meta.client || !candidates.value.length) return
  loading.value = true
  const loaded = (await Promise.all(candidates.value.map(loadCandidate))).flat()
  if (generation !== loadGeneration) return
  frames.value = loaded
  failed.value = !loaded.length
  loading.value = false
  startRotation()
}

watch(
  () => [
    props.rosterEntryId,
    props.analysisRunId,
    props.trackId,
    candidates.value.map(track => `${track.analysis_run_id}:${track.track_id}`).join('|'),
  ],
  refresh,
  { immediate: true },
)
onBeforeUnmount(() => {
  loadGeneration += 1
  stopRotation()
})
</script>

<template>
  <div class="identity-preview">
    <header>
      <strong>#{{ jerseyNumber }} {{ playerName }}</strong
      ><span>最近片段</span>
    </header>
    <div class="identity-preview__media">
      <Transition name="identity-preview-frame" mode="out-in">
        <img
          v-if="current"
          :key="current.src"
          :src="current.src"
          :alt="`${playerName} 的過往片段預覽`"
        />
      </Transition>
      <div v-if="!current && loading" class="identity-preview__empty">
        <LoaderCircle class="spin" :size="17" />讀取辨識畫面
      </div>
      <div v-else-if="!current" class="identity-preview__empty">
        <ImageOff :size="17" />{{
          failed || candidates.length ? '無法產生預覽' : '尚無已確認的過往片段'
        }}
      </div>
      <span v-if="current" class="identity-preview__caption"
        >第 {{ current.setNumber }} 局 · 回合 {{ current.rallyOrdinal }}</span
      >
    </div>
    <div v-if="frames.length > 1" class="identity-preview__steps" aria-hidden="true">
      <i v-for="(_, index) in frames" :key="index" :class="{ active: index === activeFrame }" />
    </div>
  </div>
</template>

<style scoped>
.identity-preview {
  height: 100%;
  min-height: 176px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  padding: 10px;
  gap: 8px;
}
.identity-preview header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.identity-preview header strong {
  overflow: hidden;
  color: #f4f4f5;
  font-size: 0.65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity-preview header span {
  flex: none;
  color: #a1a1aa;
  font-size: 0.52rem;
}
.identity-preview__media {
  position: relative;
  min-height: 124px;
  overflow: hidden;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  background: #09090b;
}
.identity-preview__media img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.identity-preview__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  color: #a1a1aa;
  font-size: 0.56rem;
  text-align: center;
}
.identity-preview__caption {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 3px 5px;
  border-radius: 5px;
  background: #09090bd9;
  color: #e4e4e7;
  font-size: 0.5rem;
}
.identity-preview__steps {
  display: flex;
  justify-content: center;
  gap: 4px;
}
.identity-preview__steps i {
  width: 5px;
  height: 3px;
  border-radius: 999px;
  background: #3f3f46;
  transition:
    width 180ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 150ms ease-out;
}
.identity-preview__steps i.active {
  width: 15px;
  background: #a1a1aa;
}
.identity-preview-frame-enter-active {
  transition:
    opacity 170ms ease-out,
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1),
    filter 170ms ease-out;
}
.identity-preview-frame-leave-active {
  transition: opacity 110ms ease-in;
}
.identity-preview-frame-enter-from {
  opacity: 0;
  filter: blur(2px);
  transform: scale(1.025);
}
.identity-preview-frame-leave-to {
  opacity: 0;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
  .identity-preview-frame-enter-active,
  .identity-preview-frame-leave-active,
  .identity-preview__steps i {
    transition: none;
  }
}
</style>
