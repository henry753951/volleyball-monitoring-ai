<script setup lang="ts">
import { Pause, Play, RotateCcw } from 'lucide-vue-next'
import type { CoachRallyReplay } from '~/lib/coachDomain'
import {
  actionColor,
  formatActionTime,
  type CoachPlayerActionEvent,
} from '~/utils/coachPlayerActions'
import { coachEventReplayMediaUrl, coachEventReplayWindow } from '~/utils/coachEventReplay'

type ReplayClip = NonNullable<CoachRallyReplay['clip']>

const props = defineProps<{
  open: boolean
  event: CoachPlayerActionEvent | null
  replay: { readonly clip: Readonly<ReplayClip> | null } | null
}>()
const emit = defineEmits<{ close: [] }>()

const video = useTemplateRef<HTMLVideoElement>('video')
const playing = ref(false)
const currentTime = ref(0)

const clip = computed(() => props.replay?.clip ?? null)
const replayWindow = computed(() =>
  coachEventReplayWindow(props.event?.anchorTimeUs ?? '0', clip.value?.duration_us),
)
const eventSeconds = computed(() => replayWindow.value.eventSeconds)
const windowStart = computed(() => replayWindow.value.startSeconds)
const windowEnd = computed(() => replayWindow.value.endSeconds)
const windowDuration = computed(() => Math.max(0, windowEnd.value - windowStart.value))
const eventPosition = computed(() => {
  if (windowDuration.value <= 0) return 0
  return ((eventSeconds.value - windowStart.value) / windowDuration.value) * 100
})
const progress = computed(() => {
  if (windowDuration.value <= 0) return 0
  return ((currentTime.value - windowStart.value) / windowDuration.value) * 100
})
const mediaUrl = computed(() => {
  if (!clip.value) return ''
  return coachEventReplayMediaUrl(clip.value.url, replayWindow.value)
})
const dialogTitle = computed(() =>
  props.event ? `${props.event.actionLabel}短回放` : '球路短回放',
)
const dialogDescription = computed(() => {
  const event = props.event
  if (!event) return ''
  return `第 ${event.setNumber} 局 · 回合 ${event.rallyOrdinal} · ID ${event.trackId} · ${formatActionTime(event.anchorTimeUs)}`
})

function relativeClock(value: number) {
  const tenths = Math.max(0, Math.round((value - windowStart.value) * 10))
  const seconds = Math.floor(tenths / 10)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`
}

function resetPlayback() {
  const element = video.value
  if (!element) return
  element.pause()
  element.currentTime = windowStart.value
  currentTime.value = windowStart.value
  playing.value = false
}

function updatePlayback() {
  const element = video.value
  if (!element) return
  if (element.currentTime >= windowEnd.value - 0.025) {
    element.pause()
    element.currentTime = windowEnd.value
  }
  currentTime.value = element.currentTime
  playing.value = !element.paused
}

async function togglePlayback() {
  const element = video.value
  if (!element) return
  if (!element.paused) {
    element.pause()
    updatePlayback()
    return
  }
  if (element.currentTime >= windowEnd.value - 0.025) element.currentTime = windowStart.value
  try {
    await element.play()
  } catch {
    // Safari may defer playback until the next direct tap; the control remains available.
  }
  updatePlayback()
}

function seekWithinWindow(event: Event) {
  const element = video.value
  if (!element) return
  const value = Number((event.target as HTMLInputElement).value)
  element.currentTime = Math.max(windowStart.value, Math.min(windowEnd.value, value))
  updatePlayback()
}

watch(
  () => [props.open, props.event?.id, mediaUrl.value] as const,
  async ([open]) => {
    if (!open) return
    await nextTick()
    resetPlayback()
  },
)
</script>

<template>
  <UiAnimatedModal
    :open="open"
    :title="dialogTitle"
    :description="dialogDescription"
    width="wide"
    @close="emit('close')"
  >
    <div class="event-replay" :style="{ '--event-color': actionColor(event?.actionKey ?? 'hit') }">
      <div v-if="event && clip" class="event-replay__stage">
        <video
          ref="video"
          :key="`${clip.id}:${event.id}`"
          :src="mediaUrl"
          playsinline
          preload="metadata"
          :aria-label="`${event.actionLabel}短回放`"
          @click="togglePlayback"
          @loadedmetadata="resetPlayback"
          @timeupdate="updatePlayback"
          @play="updatePlayback"
          @pause="updatePlayback"
          @ended="resetPlayback"
        />
        <button
          v-if="!playing"
          type="button"
          class="event-replay__center-play"
          aria-label="播放短回放"
          @click="togglePlayback"
        >
          <Play :size="28" fill="currentColor" />
        </button>
        <span class="event-replay__type">{{ event.actionLabel }}</span>
      </div>

      <div v-if="event && clip" class="event-replay__controls">
        <button
          type="button"
          class="event-replay__transport"
          :aria-label="playing ? '暫停短回放' : '播放短回放'"
          @click="togglePlayback"
        >
          <Pause v-if="playing" :size="18" fill="currentColor" />
          <Play v-else :size="18" fill="currentColor" />
        </button>
        <button
          type="button"
          class="event-replay__transport"
          aria-label="從短回放開頭重播"
          @click="resetPlayback"
        >
          <RotateCcw :size="17" />
        </button>
        <div class="event-replay__timeline">
          <input
            type="range"
            :min="windowStart"
            :max="windowEnd"
            :value="currentTime"
            step="0.01"
            aria-label="短回放時間"
            :style="{
              '--replay-progress': `${progress}%`,
              '--event-position': `${eventPosition}%`,
            }"
            @input="seekWithinWindow"
          />
          <span class="event-replay__event-label" :style="{ left: `${eventPosition}%` }">擊球</span>
        </div>
        <time>{{ relativeClock(currentTime) }} / {{ relativeClock(windowEnd) }}</time>
      </div>

      <div v-else class="event-replay__empty">
        <strong>這筆球路目前沒有可播放影片</strong>
        <span>分析紀錄仍會保留；片段完成後即可在這裡觀看短回放。</span>
      </div>
    </div>
  </UiAnimatedModal>
</template>

<style scoped>
.event-replay {
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  background: #05080b;
  color: #f6f8fa;
}
.event-replay__stage {
  position: relative;
  min-height: min(58dvh, 560px);
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #000;
}
.event-replay__stage video {
  width: 100%;
  height: 100%;
  max-height: min(58dvh, 560px);
  display: block;
  object-fit: contain;
  cursor: pointer;
}
.event-replay__center-play {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  padding-left: 4px;
  transform: translate(-50%, -50%);
  border: 0;
  border-radius: 50%;
  background: rgb(6 10 14 / 82%);
  box-shadow: 0 10px 26px rgb(0 0 0 / 42%);
  color: #fff;
  backdrop-filter: blur(12px);
}
.event-replay__type {
  position: absolute;
  top: 14px;
  left: 14px;
  padding: 5px 9px;
  border-radius: 7px;
  background: rgb(4 8 12 / 78%);
  box-shadow: inset 3px 0 var(--event-color);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 760;
  backdrop-filter: blur(10px);
}
.event-replay__controls {
  min-height: 66px;
  display: grid;
  grid-template-columns: 42px 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid #202932;
  background: #0c1218;
}
.event-replay__transport {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 9px;
  background: #18212a;
  color: #f5f7f9;
}
.event-replay__transport:hover {
  background: #24313d;
}
.event-replay__transport:focus-visible,
.event-replay__center-play:focus-visible,
.event-replay__timeline input:focus-visible {
  outline: 2px solid #72b7ff;
  outline-offset: 2px;
}
.event-replay__timeline {
  position: relative;
  min-width: 0;
  padding-block: 17px 8px;
}
.event-replay__timeline input {
  width: 100%;
  height: 4px;
  display: block;
  margin: 0;
  appearance: none;
  border-radius: 4px;
  background: linear-gradient(
    to right,
    #73b9ff 0 var(--replay-progress),
    #3b4650 var(--replay-progress) 100%
  );
  cursor: pointer;
}
.event-replay__timeline input::before {
  content: '';
}
.event-replay__timeline input::-webkit-slider-thumb {
  width: 16px;
  height: 16px;
  appearance: none;
  border: 3px solid #0c1218;
  border-radius: 50%;
  background: #f5f8fa;
  box-shadow: 0 2px 7px rgb(0 0 0 / 38%);
}
.event-replay__timeline input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 3px solid #0c1218;
  border-radius: 50%;
  background: #f5f8fa;
  box-shadow: 0 2px 7px rgb(0 0 0 / 38%);
}
.event-replay__event-label {
  position: absolute;
  top: 0;
  padding: 1px 5px;
  transform: translateX(-50%);
  border-radius: 5px;
  background: var(--event-color);
  color: #071018;
  font-size: 0.52rem;
  font-weight: 800;
  white-space: nowrap;
}
.event-replay__event-label::after {
  position: absolute;
  top: 100%;
  left: 50%;
  width: 1px;
  height: 12px;
  background: var(--event-color);
  content: '';
}
.event-replay__controls time {
  min-width: 78px;
  color: #aeb8c1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.event-replay__empty {
  min-height: 320px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  padding: 24px;
  color: #8d99a4;
  text-align: center;
}
.event-replay__empty strong {
  color: #e7ecf0;
  font-size: 0.8rem;
}
.event-replay__empty span {
  max-width: 42ch;
  font-size: 0.63rem;
  line-height: 1.5;
}
@media (max-width: 720px) {
  .event-replay__controls {
    grid-template-columns: 42px 42px minmax(0, 1fr);
  }
  .event-replay__controls time {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .event-replay__center-play {
    backdrop-filter: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .event-replay__center-play,
  .event-replay__type {
    background: #0c1218;
    backdrop-filter: none;
  }
}
</style>
