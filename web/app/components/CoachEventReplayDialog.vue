<script setup lang="ts">
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-vue-next'
import type { CoachRouteMapSideLabel } from '~/components/CoachBallRouteMap.vue'
import type { CoachRallyReplay } from '~/lib/coachDomain'
import {
  actionColor,
  formatActionTime,
  type CoachPlayerActionEvent,
} from '~/utils/coachPlayerActions'
import { coachEventReplayMediaUrl, coachEventReplayWindow } from '~/utils/coachEventReplay'
import { requestMediaPause, requestMediaPlay } from '~/utils/mediaPlaybackIntent'

type ReplayClip = NonNullable<CoachRallyReplay['clip']>

const props = defineProps<{
  matchId: string
  open: boolean
  event: CoachPlayerActionEvent | null
  events?: CoachPlayerActionEvent[]
  replay: { readonly clip: Readonly<ReplayClip> | null } | null
  sideLabels?: { left: CoachRouteMapSideLabel; right: CoachRouteMapSideLabel }
  loading?: boolean
}>()
const emit = defineEmits<{ close: []; select: [event: CoachPlayerActionEvent] }>()

const video = useTemplateRef<HTMLVideoElement>('video')
const playing = ref(false)
const currentTime = ref(0)
const mediaFailed = ref(false)

const rallyEvents = computed(() =>
  [...(props.events?.length ? props.events : props.event ? [props.event] : [])].sort(
    (left, right) => Number(BigInt(left.anchorTimeUs) - BigInt(right.anchorTimeUs)),
  ),
)
const activeEventIndex = computed(() =>
  rallyEvents.value.findIndex(event => event.id === props.event?.id),
)
const canSelectPrevious = computed(() => activeEventIndex.value > 0)
const canSelectNext = computed(
  () => activeEventIndex.value >= 0 && activeEventIndex.value < rallyEvents.value.length - 1,
)

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
const rallyReplayUrl = computed(() => {
  const event = props.event
  return event
    ? `/matches/${props.matchId}/replay/${event.rallyId}?event_us=${event.anchorTimeUs}`
    : '#'
})

function relativeClock(value: number) {
  const tenths = Math.max(0, Math.round((value - windowStart.value) * 10))
  const seconds = Math.floor(tenths / 10)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`
}

function resetPlayback() {
  const element = video.value
  if (!element) return
  requestMediaPause(element)
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
    element.currentTime = windowStart.value
    currentTime.value = windowStart.value
  } else {
    currentTime.value = 0
  }
  playing.value = false
}

async function autoplayPlayback() {
  const element = video.value
  if (!element) return
  if (
    element.readyState >= HTMLMediaElement.HAVE_METADATA &&
    (element.currentTime < windowStart.value || element.currentTime >= windowEnd.value - 0.025)
  )
    element.currentTime = windowStart.value
  try {
    await requestMediaPlay(element)
  } catch {
    // Browsers may block autoplay; the visible play control remains available.
  }
  updatePlayback()
}

function handleLoadedMetadata() {
  mediaFailed.value = false
  resetPlayback()
  void autoplayPlayback()
}

function handleMediaError() {
  mediaFailed.value = true
  playing.value = false
}

function updatePlayback() {
  const element = video.value
  if (!element) return
  if (element.currentTime >= windowEnd.value - 0.025) {
    requestMediaPause(element)
    element.currentTime = windowEnd.value
  }
  currentTime.value = element.currentTime
  playing.value = !element.paused
}

async function togglePlayback() {
  const element = video.value
  if (!element) return
  if (!element.paused) {
    requestMediaPause(element)
    updatePlayback()
    return
  }
  if (element.currentTime >= windowEnd.value - 0.025) element.currentTime = windowStart.value
  try {
    await requestMediaPlay(element)
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

function selectRelative(offset: -1 | 1) {
  const target = rallyEvents.value[activeEventIndex.value + offset]
  if (target) emit('select', target)
}

watch(
  () => [props.open, props.event?.id, mediaUrl.value] as const,
  async ([open]) => {
    if (!open) return
    mediaFailed.value = false
    await nextTick()
    const element = video.value
    if (!element || element.readyState < HTMLMediaElement.HAVE_METADATA) return
    resetPlayback()
    void autoplayPlayback()
  },
)
</script>

<template>
  <UiAnimatedModal
    :open="open"
    :title="dialogTitle"
    :description="dialogDescription"
    width="full"
    @close="emit('close')"
  >
    <div class="event-replay" :style="{ '--event-color': actionColor(event?.actionKey ?? 'hit') }">
      <div v-if="event && clip" class="event-replay__content">
        <div class="event-replay__stage">
          <video
            ref="video"
            :key="`${clip.id}:${event.id}`"
            :src="mediaUrl"
            playsinline
            preload="metadata"
            :aria-label="`${event.actionLabel}短回放`"
            @click="togglePlayback"
            @loadedmetadata="handleLoadedMetadata"
            @error="handleMediaError"
            @timeupdate="updatePlayback"
            @play="updatePlayback"
            @pause="updatePlayback"
            @ended="resetPlayback"
          />
          <button
            v-if="!playing && !mediaFailed"
            type="button"
            class="event-replay__center-play"
            aria-label="播放短回放"
            @click="togglePlayback"
          >
            <Play :size="28" fill="currentColor" />
          </button>
          <div v-if="mediaFailed" class="event-replay__media-error" role="alert">
            <strong>來源影片已不存在</strong>
            <span>球路分析仍保留；請重新產生這個回合的片段後再播放。</span>
          </div>
          <span class="event-replay__type">{{ event.actionLabel }}</span>
        </div>
        <aside class="event-replay__analysis">
          <CoachBallRouteMap
            :events="rallyEvents"
            :label="`總回合 ${event.rallyOrdinal} · 完整球路`"
            :side-labels="sideLabels"
            :selected-event-id="event.id"
            @select="emit('select', $event)"
          />
          <section class="event-replay__balls" aria-label="本回合球種時間軸">
            <header>
              <span><strong>本回合球種</strong><small>依擊球時間排序</small></span>
              <b>{{ activeEventIndex + 1 }} / {{ rallyEvents.length }}</b>
            </header>
            <div class="event-replay__ball-nav">
              <button
                type="button"
                :disabled="!canSelectPrevious"
                aria-label="上一球"
                @click="selectRelative(-1)"
              >
                <ChevronLeft :size="16" />上一球
              </button>
              <button
                type="button"
                :disabled="!canSelectNext"
                aria-label="下一球"
                @click="selectRelative(1)"
              >
                下一球<ChevronRight :size="16" />
              </button>
            </div>
            <div class="event-replay__ball-list">
              <button
                v-for="(rallyEvent, index) in rallyEvents"
                :key="rallyEvent.id"
                type="button"
                :class="{ active: rallyEvent.id === event.id }"
                :aria-pressed="rallyEvent.id === event.id"
                @click="emit('select', rallyEvent)"
              >
                <i :style="{ background: actionColor(rallyEvent.actionKey) }" />
                <span
                  ><b>{{ index + 1 }}</b
                  ><strong>{{ rallyEvent.actionLabel }}</strong></span
                >
                <time>{{ formatActionTime(rallyEvent.anchorTimeUs) }}</time>
              </button>
            </div>
          </section>
          <NuxtLink class="event-replay__rally-link" :to="rallyReplayUrl" @click="emit('close')">
            前往總回合 {{ event.rallyOrdinal }}
            <ArrowUpRight :size="16" />
          </NuxtLink>
        </aside>
      </div>

      <div v-if="event && clip" class="event-replay__controls">
        <button
          type="button"
          class="event-replay__transport"
          :disabled="mediaFailed"
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
            :disabled="mediaFailed"
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

      <div v-else-if="loading" class="event-replay__empty">
        <strong>正在載入短片</strong>
        <span>正在取得這個球路所屬回合的短回放，請稍候。</span>
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
.event-replay__content {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(330px, 32%);
}
.event-replay__stage {
  position: relative;
  min-height: min(68dvh, 680px);
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #000;
}
.event-replay__analysis {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(260px, 1fr) auto auto;
  overflow: hidden;
  background: #111a22;
}
.event-replay__analysis :deep(.route-map) {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-radius: 0;
}
.event-replay__analysis :deep(.route-map__canvas) {
  height: 100%;
  min-height: 0;
}
.event-replay__analysis :deep(.route-map__legend) {
  display: none;
}
.event-replay__balls {
  display: grid;
  gap: 9px;
  padding: 12px 14px;
  border-top: 1px solid #ffffff12;
  background: #0f171f;
}
.event-replay__balls > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.event-replay__balls > header > span {
  display: grid;
  gap: 2px;
}
.event-replay__balls header strong {
  color: #eef4f8;
  font-size: 0.68rem;
}
.event-replay__balls header small {
  color: #81909d;
  font-size: 0.53rem;
}
.event-replay__balls header > b {
  color: #9dccff;
  font-size: 0.6rem;
  font-variant-numeric: tabular-nums;
}
.event-replay__ball-nav {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.event-replay__ball-nav button {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid #2d3a45;
  border-radius: 9px;
  background: #18232d;
  color: #e7eef4;
  font-size: 0.61rem;
  font-weight: 720;
}
.event-replay__ball-nav button:hover:not(:disabled) {
  border-color: #4f6f8d;
  background: #22313e;
}
.event-replay__ball-nav button:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}
.event-replay__ball-list {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-color: #3b4b59 transparent;
}
.event-replay__ball-list button {
  position: relative;
  min-width: 90px;
  min-height: 49px;
  display: grid;
  grid-template-columns: 4px minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 2px 7px;
  padding: 7px 9px;
  border: 1px solid #26333e;
  border-radius: 10px;
  background: #121c24;
  color: #b7c2cc;
  text-align: left;
}
.event-replay__ball-list button:hover {
  border-color: #4b6173;
  background: #192630;
}
.event-replay__ball-list button.active {
  border-color: #5facf5;
  background: #18334c;
  color: #fff;
  box-shadow: 0 5px 14px rgb(0 0 0 / 22%);
}
.event-replay__ball-list button > i {
  width: 3px;
  height: 28px;
  grid-row: 1 / 3;
  align-self: center;
  border-radius: 3px;
}
.event-replay__ball-list button > span {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.event-replay__ball-list button span b {
  color: #7f91a1;
  font-size: 0.51rem;
  font-variant-numeric: tabular-nums;
}
.event-replay__ball-list button strong {
  font-size: 0.61rem;
}
.event-replay__ball-list time {
  color: #8e9aa5;
  font-size: 0.51rem;
  font-variant-numeric: tabular-nums;
}
.event-replay__ball-nav button:focus-visible,
.event-replay__ball-list button:focus-visible {
  outline: 2px solid #72b7ff;
  outline-offset: 2px;
}
.event-replay__rally-link {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-top: 1px solid #ffffff12;
  background: #0c1218;
  color: #9dccff;
  font-size: 0.68rem;
  font-weight: 760;
  text-decoration: none;
}
.event-replay__rally-link:hover {
  background: #16222d;
  color: #fff;
}
.event-replay__stage video {
  width: 100%;
  height: 100%;
  max-height: min(68dvh, 680px);
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
.event-replay__media-error {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(360px, calc(100% - 48px));
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 18px 20px;
  transform: translate(-50%, -50%);
  border: 1px solid #ffffff1c;
  border-radius: 13px;
  background: #111920f2;
  box-shadow: 0 16px 36px rgb(0 0 0 / 34%);
  color: #aebbc5;
  text-align: center;
}
.event-replay__media-error strong {
  color: #f2f6f8;
  font-size: 0.76rem;
}
.event-replay__media-error span {
  font-size: 0.6rem;
  line-height: 1.5;
}
.event-replay__type {
  position: absolute;
  top: 14px;
  left: 14px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 760;
  letter-spacing: 0.01em;
  text-shadow: 0 1px 3px rgb(0 0 0 / 72%);
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
.event-replay__transport:disabled,
.event-replay__timeline input:disabled {
  cursor: not-allowed;
  opacity: 0.38;
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
  .event-replay__content {
    grid-template-columns: 1fr;
  }
  .event-replay__analysis {
    max-height: 460px;
  }
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
  .event-replay__center-play {
    background: #0c1218;
    backdrop-filter: none;
  }
}
</style>
