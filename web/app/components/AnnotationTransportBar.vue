<script setup lang="ts">
import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'
import { usePreferredReducedMotion, useResizeObserver } from '@vueuse/core'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Send,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Trash2,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-vue-next'
import { AnimatePresence, Motion } from 'motion-v'
import { computed, ref } from 'vue'
import { formatTimelineScale } from '~/lib/dvrTimeline'

withDefaults(
  defineProps<{
    playing: boolean
    playerReady: boolean
    frameReady: boolean
    frameMovePending: boolean
    timecode: string
    liveActive: boolean
    liveAvailable: boolean
    terminalLabel?: string | null
    contextTitle: string
    contextHits: number
    contextDuration: string
    contextState: string
    processing?: AnnotationRallyProcessingUpdate | null
    processingRetrying?: boolean
    correctionActive: boolean
    correctionBlockReason?: string | null
    correctionCreating?: boolean
    correctionCancelling?: boolean
    submissionPending?: boolean
    submittedSelected: boolean
    clipSelected: boolean
    downloadAvailable?: boolean
    draftSelected: boolean
    submitEnabled: boolean
    navigable: boolean
    selectedPoint: boolean
    editable: boolean
    editReady: boolean
    pointDeleteEnabled: boolean
    muted: boolean
    playbackRate?: number
    timelineScale: number
    shortcuts: {
      play: string
      previousFrame: string
      nextFrame: string
      previousPoint: string
      nextPoint: string
    }
  }>(),
  {
    correctionBlockReason: null,
    correctionCreating: false,
    downloadAvailable: false,
    submissionPending: false,
    playbackRate: 1,
  },
)

const emit = defineEmits<{
  playPause: []
  framePrevious: []
  frameNext: []
  live: []
  cancelCorrection: []
  startCorrection: []
  submit: []
  retryProcessing: []
  keyPointPrevious: []
  keyPointNext: []
  nudgePrevious: []
  nudgeNext: []
  deleteClip: []
  downloadClip: []
  deletePoint: []
  toggleMute: []
  setPlaybackRate: [rate: number]
  resetTimelineZoom: []
}>()

const reducedMotion = usePreferredReducedMotion()
const playbackMenuOpen = ref(false)
const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

function choosePlaybackRate(rate: number) {
  emit('setPlaybackRate', rate)
  playbackMenuOpen.value = false
}
const clipActionsContent = ref<HTMLElement | null>(null)
const clipActionsWidth = ref(0)

useResizeObserver(clipActionsContent, ([entry]) => {
  if (!entry) return
  clipActionsWidth.value = Math.ceil(entry.target.getBoundingClientRect().width)
})

const clipInitial = computed(() =>
  reducedMotion.value === 'reduce'
    ? { width: 0, opacity: 0 }
    : { width: 0, opacity: 0, filter: 'blur(7px)' },
)
const clipAnimate = computed(() =>
  reducedMotion.value === 'reduce'
    ? { width: `${clipActionsWidth.value}px`, opacity: clipActionsWidth.value > 0 ? 1 : 0 }
    : {
        width: `${clipActionsWidth.value}px`,
        opacity: clipActionsWidth.value > 0 ? 1 : 0,
        filter: clipActionsWidth.value > 0 ? 'blur(0px)' : 'blur(7px)',
      },
)
const clipExit = computed(() =>
  reducedMotion.value === 'reduce'
    ? { width: 0, opacity: 0 }
    : { width: 0, opacity: 0, filter: 'blur(4px)' },
)
const clipTransition = computed(() =>
  reducedMotion.value === 'reduce'
    ? { duration: 0.01 }
    : { duration: 0.34, ease: [0.16, 1, 0.3, 1] },
)
</script>

<template>
  <div class="transport-bar">
    <UiTooltip :content="`${playing ? '暫停' : '播放'} · ${shortcuts.play}`"
      ><button
        type="button"
        class="transport-button"
        :aria-label="playing ? '暫停' : '播放'"
        :disabled="!playerReady"
        @click="$emit('playPause')"
      >
        <Pause v-if="playing" :size="16" fill="currentColor" /><Play
          v-else
          :size="16"
          fill="currentColor"
        /></button
    ></UiTooltip>
    <UiTooltip :content="`上一幀；Ctrl 一次 5 幀 · ${shortcuts.previousFrame}`"
      ><button
        type="button"
        class="transport-button"
        aria-label="前一幀"
        :disabled="!frameReady || frameMovePending"
        @click="$emit('framePrevious')"
      >
        <ChevronLeft :size="18" stroke-width="2.2" /></button
    ></UiTooltip>
    <UiTooltip :content="`下一幀；Ctrl 一次 5 幀 · ${shortcuts.nextFrame}`"
      ><button
        type="button"
        class="transport-button"
        aria-label="後一幀"
        :disabled="!frameReady || frameMovePending"
        @click="$emit('frameNext')"
      >
        <ChevronRight :size="18" stroke-width="2.2" /></button
    ></UiTooltip>
    <div class="transport-media-group">
      <code class="timecode">{{ timecode }}</code>
      <UiPopover v-model:open="playbackMenuOpen" side="top" align="start">
        <template #trigger>
          <button
            type="button"
            class="playback-rate"
            aria-label="播放速度"
            :aria-expanded="playbackMenuOpen"
          >
            <Gauge :size="13" />{{ playbackRate }}×
          </button>
        </template>
        <div class="playback-rate-menu" role="menu" aria-label="播放速度">
          <button
            v-for="rate in playbackRates"
            :key="rate"
            type="button"
            role="menuitemradio"
            :aria-checked="playbackRate === rate"
            :class="{ active: playbackRate === rate }"
            @click="choosePlaybackRate(rate)"
          >
            {{ rate }}×
          </button>
        </div>
      </UiPopover>
      <button
        v-if="liveAvailable"
        type="button"
        class="live-badge"
        :class="{ active: liveActive }"
        @click="$emit('live')"
      >
        LIVE</button
      ><span v-else-if="terminalLabel" class="terminal-badge">{{ terminalLabel }}</span>
    </div>
    <i class="transport-separator" />
    <div class="transport-context">
      <div>
        <strong>{{ contextTitle }}</strong
        ><small>{{ contextHits }} 次擊球 · {{ contextDuration }}</small>
      </div>
      <AnnotationProcessingBadge
        :label="contextState"
        :processing="processing"
        :retrying="processingRetrying"
        @retry="$emit('retryProcessing')"
      />
    </div>
    <AnimatePresence :initial="false">
      <Motion
        v-if="clipSelected"
        key="clip-actions"
        class="clip-actions-shell"
        :initial="clipInitial"
        :animate="clipAnimate"
        :exit="clipExit"
        :transition="clipTransition"
      >
        <div ref="clipActionsContent" class="clip-actions" role="group" aria-label="片段工具">
          <i class="transport-separator context-separator" />
          <UiTooltip v-if="submissionPending" content="送出內容已安全保留，連線恢復後會自動完成"
            ><button
              type="button"
              class="tool-button pending"
              disabled
              aria-label="等待伺服器確認送出"
              aria-live="polite"
            >
              <RotateCcw :size="14" class="spinning" />等待確認
            </button></UiTooltip
          >
          <UiTooltip
            v-else-if="draftSelected"
            :content="submitEnabled ? '送出目前草稿並開始處理' : '片段尚未完成，或仍有操作正在同步'"
            ><button
              type="button"
              class="tool-button submit"
              :disabled="!submitEnabled"
              aria-label="送出片段"
              @click="$emit('submit')"
            >
              <Send :size="14" />送出
            </button></UiTooltip
          >
          <i
            v-if="draftSelected && !submissionPending"
            class="action-separator"
            aria-hidden="true"
          />
          <UiTooltip
            v-if="!submissionPending && correctionCreating"
            content="正在複製已送出的片段並切換到可編輯草稿"
            ><button
              type="button"
              class="tool-button pending"
              disabled
              aria-label="正在建立修正版草稿"
              aria-live="polite"
            >
              <RotateCcw :size="14" class="spinning" />建立修正版中
            </button></UiTooltip
          >
          <UiTooltip
            v-else-if="!submissionPending && correctionActive"
            content="取消本次修正並恢復上一個已送出版本；同步卡住時也可以使用"
            ><button
              type="button"
              class="tool-button danger"
              :disabled="correctionCancelling"
              aria-label="取消修正片段"
              @click="$emit('cancelCorrection')"
            >
              <XCircle :size="14" />{{ correctionCancelling ? '取消中' : '取消修正片段' }}
            </button></UiTooltip
          >
          <UiTooltip
            v-else-if="
              !submissionPending && submittedSelected && processing?.processing_status === 'failed'
            "
            content="保留目前標記，重新執行失敗的處理階段"
            ><button
              type="button"
              class="tool-button retry"
              :disabled="processingRetrying"
              aria-label="重新處理"
              @click="$emit('retryProcessing')"
            >
              <RotateCcw :size="14" :class="{ spinning: processingRetrying }" />{{
                processingRetrying ? '排程中' : '重新處理'
              }}
            </button></UiTooltip
          >
          <UiTooltip
            v-else-if="!submissionPending && submittedSelected"
            :content="correctionBlockReason || '複製目前已送出的片段，建立可編輯的修正版草稿'"
            ><button
              type="button"
              class="tool-button"
              aria-label="建立修正版草稿"
              @click="$emit('startCorrection')"
            >
              <RotateCcw :size="14" />建立修正版草稿
            </button></UiTooltip
          >
          <UiTooltip
            :content="downloadAvailable ? '下載影片或包含分析資料的 ZIP' : '片段尚未產出可下載影片'"
            ><button
              type="button"
              class="tool-button"
              :disabled="!downloadAvailable"
              aria-label="下載片段"
              @click="$emit('downloadClip')"
            >
              <Download :size="14" />下載片段
            </button></UiTooltip
          >
          <UiTooltip content="永久刪除目前選取的片段"
            ><button
              type="button"
              class="tool-button danger"
              aria-label="刪除所選片段"
              @click="$emit('deleteClip')"
            >
              <Trash2 :size="14" />刪除所選片段
            </button></UiTooltip
          >
        </div>
      </Motion>
    </AnimatePresence>
    <div class="keypoint-actions" role="group" aria-label="擊球點工具">
      <i class="transport-separator context-separator" />
      <UiTooltip :content="`上一個擊球點，可跨片段 · ${shortcuts.previousPoint}`"
        ><button
          type="button"
          class="tool-button icon-only"
          :disabled="!navigable"
          aria-label="上一個擊球點"
          @click="$emit('keyPointPrevious')"
        >
          <SkipBack :size="14" /></button
      ></UiTooltip>
      <UiTooltip :content="`下一個擊球點，可跨片段 · ${shortcuts.nextPoint}`"
        ><button
          type="button"
          class="tool-button icon-only"
          :disabled="!navigable"
          aria-label="下一個擊球點"
          @click="$emit('keyPointNext')"
        >
          <SkipForward :size="14" /></button
      ></UiTooltip>
      <UiTooltip content="所選擊球點向前一畫格"
        ><button
          type="button"
          class="tool-button icon-only"
          :disabled="!editable || !selectedPoint || !editReady"
          aria-label="擊球點前移一幀"
          @click="$emit('nudgePrevious')"
        >
          <StepBack :size="14" /></button
      ></UiTooltip>
      <UiTooltip content="所選擊球點向後一畫格"
        ><button
          type="button"
          class="tool-button icon-only"
          :disabled="!editable || !selectedPoint || !editReady"
          aria-label="擊球點後移一幀"
          @click="$emit('nudgeNext')"
        >
          <StepForward :size="14" /></button
      ></UiTooltip>
      <UiTooltip content="刪除目前選取的擊球點"
        ><button
          type="button"
          class="tool-button danger"
          :disabled="!pointDeleteEnabled || !editReady"
          aria-label="刪除所選擊球點"
          @click="$emit('deletePoint')"
        >
          <Trash2 :size="14" />刪除擊球點
        </button></UiTooltip
      >
    </div>
    <div class="transport-end">
      <UiTooltip content="時間軸倍率；30 秒視窗為 10×。按下恢復預設 0.1×"
        ><button
          type="button"
          class="timeline-scale"
          :aria-label="`時間軸倍率 ${formatTimelineScale(timelineScale)}；按下恢復預設`"
          @click="$emit('resetTimelineZoom')"
        >
          {{ formatTimelineScale(timelineScale) }}
        </button></UiTooltip
      >
      <UiTooltip :content="muted ? '開啟聲音' : '靜音'"
        ><button
          type="button"
          class="transport-button mute"
          :aria-label="muted ? '開啟聲音' : '靜音'"
          :disabled="!playerReady"
          @click="$emit('toggleMute')"
        >
          <VolumeX v-if="muted" :size="16" /><Volume2 v-else :size="16" /></button
      ></UiTooltip>
    </div>
  </div>
</template>

<style scoped>
.transport-bar {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-bottom: 1px solid #292f35;
  color: #f4f4f5;
}
.transport-bar button {
  color: inherit;
  cursor: pointer;
}
.transport-bar button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.transport-button {
  width: 34px;
  min-height: 31px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: #18181b;
  transition:
    background-color 0.16s ease,
    transform 0.12s ease;
}
.transport-button:hover:not(:disabled) {
  background: #27272a;
}
.transport-button:active:not(:disabled),
.tool-button:active:not(:disabled),
.timeline-scale:active:not(:disabled) {
  transform: scale(0.96);
}
.transport-button:focus-visible,
.tool-button:focus-visible,
.live-badge:focus-visible,
.timeline-scale:focus-visible {
  outline: 2px solid #fca5a5;
  outline-offset: 2px;
}
.transport-media-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.timecode {
  min-width: 82px;
  margin-left: 3px;
  color: #fff;
  font:
    700 0.7rem 'Cascadia Mono',
    Consolas,
    monospace;
}
.playback-rate {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 7px;
  border: 1px solid #343a41;
  border-radius: 6px;
  background: #18181b;
  color: #d9dde2;
  font-size: 0.62rem;
  font-weight: 750;
}
.playback-rate-menu {
  display: grid;
  grid-template-columns: repeat(3, minmax(52px, 1fr));
  gap: 4px;
}
.playback-rate-menu button {
  min-height: 36px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #b9c1ca;
  font-size: 0.68rem;
  font-weight: 700;
}
.playback-rate-menu button.active {
  background: #ffffff17;
  color: #fff;
}
.live-badge {
  min-height: 22px;
  padding: 2px 7px;
  border: 0;
  border-radius: 999px;
  background: #27272a;
  color: #a1a1aa;
  font-size: 0.56rem;
  font-weight: 800;
}
.live-badge.active {
  background: #163c27;
  color: #86efac;
}
.terminal-badge {
  padding: 3px 7px;
  border: 1px solid #3f3f46;
  border-radius: 999px;
  color: #a1a1aa;
  font:
    800 0.56rem 'Cascadia Mono',
    Consolas,
    monospace;
}
.transport-separator {
  width: 1px;
  height: 23px;
  margin: 0 3px;
  background: #30363d;
}
.action-separator {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: #3b4249;
}
.transport-context {
  flex: 0 1 270px;
  min-width: 150px;
  max-width: 340px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
}
.transport-context > div {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.transport-context strong,
.transport-context small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transport-context strong {
  font-size: 0.65rem;
}
.transport-context small {
  color: #7f8a95;
  font-size: 0.56rem;
}
.transport-context > span {
  padding: 3px 7px;
  border-radius: 999px;
  background: #27272a;
  color: #d4d4d8;
  font-size: 0.56rem;
  font-weight: 750;
}
.clip-actions-shell {
  flex: none;
  min-width: 0;
  overflow: hidden;
}
.clip-actions,
.keypoint-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.clip-actions {
  width: max-content;
}
.tool-button {
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #aab3bc;
  font-size: 0.63rem;
  transition:
    background-color 0.16s ease,
    color 0.16s ease,
    transform 0.12s ease;
}
.tool-button:hover:not(:disabled),
.tool-button.active {
  background: #27272a;
  color: #fff;
}
.tool-button.danger {
  color: #dba1a5;
}
.tool-button.icon-only {
  width: 28px;
  justify-content: center;
  padding: 0;
}
.transport-end {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
}
.timeline-scale {
  min-width: 47px;
  min-height: 26px;
  padding: 0 8px;
  border: 1px solid #3d4b58;
  border-radius: 6px;
  background: #151a1f;
  color: #a9d6f7 !important;
  font:
    750 0.62rem 'Cascadia Mono',
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease,
    transform 0.12s ease;
}
.timeline-scale:hover {
  border-color: #62788b;
  background: #1c242b;
}
@media (max-width: 1280px) {
  .transport-context {
    max-width: 210px;
  }
  .transport-context small {
    display: none;
  }
}
@media (max-width: 980px) {
  .transport-context,
  .context-separator {
    display: none;
  }
}
.tool-button.retry {
  color: #ffb3b8;
}
.spinning {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
  .transport-button,
  .tool-button {
    transition-duration: 0.01ms;
  }
}
.tool-button.submit {
  color: #a9d6f7;
}
.tool-button.pending {
  color: #f8d18a;
  opacity: 1 !important;
}
</style>
