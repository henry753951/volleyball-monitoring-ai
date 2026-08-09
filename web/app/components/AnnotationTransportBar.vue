<script setup lang="ts">
import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SkipBack, SkipForward, StepBack, StepForward, Trash2, Volume2, VolumeX, XCircle } from 'lucide-vue-next'
import { formatTimelineScale } from '~/lib/dvrTimeline'

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
  correctionActive: boolean
  correctionCancelling?: boolean
  submittedSelected: boolean
  navigable: boolean
  selectedPoint: boolean
  editable: boolean
  editReady: boolean
  deleteEnabled: boolean
  muted: boolean
  timelineScale: number
  shortcuts: { play: string; previousFrame: string; nextFrame: string; previousPoint: string; nextPoint: string }
}>()

defineEmits<{
  playPause: []
  framePrevious: []
  frameNext: []
  live: []
  cancelCorrection: []
  startCorrection: []
  keyPointPrevious: []
  keyPointNext: []
  nudgePrevious: []
  nudgeNext: []
  deleteSelection: []
  toggleMute: []
  resetTimelineZoom: []
}>()
</script>

<template>
  <div class="transport-bar">
    <UiTooltip :content="`${playing ? '暫停' : '播放'} · ${shortcuts.play}`"><button type="button" class="transport-button" :aria-label="playing ? '暫停' : '播放'" :disabled="!playerReady" @click="$emit('playPause')"><Pause v-if="playing" :size="16" fill="currentColor" /><Play v-else :size="16" fill="currentColor" /></button></UiTooltip>
    <UiTooltip :content="`上一幀；Ctrl 一次 5 幀 · ${shortcuts.previousFrame}`"><button type="button" class="transport-button" aria-label="前一幀" :disabled="!frameReady || frameMovePending" @click="$emit('framePrevious')"><ChevronLeft :size="18" stroke-width="2.2" /></button></UiTooltip>
    <UiTooltip :content="`下一幀；Ctrl 一次 5 幀 · ${shortcuts.nextFrame}`"><button type="button" class="transport-button" aria-label="後一幀" :disabled="!frameReady || frameMovePending" @click="$emit('frameNext')"><ChevronRight :size="18" stroke-width="2.2" /></button></UiTooltip>
    <div class="transport-media-group"><code class="timecode">{{ timecode }}</code><button v-if="liveAvailable" type="button" class="live-badge" :class="{ active: liveActive }" @click="$emit('live')">LIVE</button><span v-else-if="terminalLabel" class="terminal-badge">{{ terminalLabel }}</span></div>
    <i class="transport-separator" />
    <div class="transport-context"><div><strong>{{ contextTitle }}</strong><small>{{ contextHits }} 次擊球 · {{ contextDuration }}</small></div><AnnotationProcessingBadge :label="contextState" :processing="processing" /></div>
    <i class="transport-separator context-separator" />
    <UiTooltip v-if="correctionActive" content="取消本次修正並恢復上一個 immutable submission；同步卡住時仍可使用"><button type="button" class="tool-button danger" :disabled="correctionCancelling" aria-label="取消修正片段" @click="$emit('cancelCorrection')"><XCircle :size="14" />{{ correctionCancelling ? '取消中' : '取消修正片段' }}</button></UiTooltip>
    <UiTooltip v-if="submittedSelected" content="以 immutable submission 建立修正版"><button type="button" class="tool-button" :disabled="!editReady" aria-label="建立修正版" @click="$emit('startCorrection')"><RotateCcw :size="14" />建立修正版</button></UiTooltip>
    <UiTooltip :content="`上一個擊球點，可跨片段 · ${shortcuts.previousPoint}`"><button type="button" class="tool-button icon-only" :disabled="!navigable" aria-label="上一個擊球點" @click="$emit('keyPointPrevious')"><SkipBack :size="14" /></button></UiTooltip>
    <UiTooltip :content="`下一個擊球點，可跨片段 · ${shortcuts.nextPoint}`"><button type="button" class="tool-button icon-only" :disabled="!navigable" aria-label="下一個擊球點" @click="$emit('keyPointNext')"><SkipForward :size="14" /></button></UiTooltip>
    <UiTooltip content="所選擊球點向前一畫格"><button type="button" class="tool-button icon-only" :disabled="!editable || !selectedPoint || !editReady" aria-label="擊球點前移一幀" @click="$emit('nudgePrevious')"><StepBack :size="14" /></button></UiTooltip>
    <UiTooltip content="所選擊球點向後一畫格"><button type="button" class="tool-button icon-only" :disabled="!editable || !selectedPoint || !editReady" aria-label="擊球點後移一幀" @click="$emit('nudgeNext')"><StepForward :size="14" /></button></UiTooltip>
    <UiTooltip content="刪除目前選取"><button type="button" class="tool-button danger" :disabled="!deleteEnabled || !editReady" aria-label="刪除所選" @click="$emit('deleteSelection')"><Trash2 :size="14" />刪除所選</button></UiTooltip>
    <div class="transport-end">
      <UiTooltip content="時間軸倍率；30 秒視窗為 10×。按下恢復預設 0.1×"><button type="button" class="timeline-scale" :aria-label="`時間軸倍率 ${formatTimelineScale(timelineScale)}；按下恢復預設`" @click="$emit('resetTimelineZoom')">{{ formatTimelineScale(timelineScale) }}</button></UiTooltip>
      <UiTooltip :content="muted ? '開啟聲音' : '靜音'"><button type="button" class="transport-button mute" :aria-label="muted ? '開啟聲音' : '靜音'" :disabled="!playerReady" @click="$emit('toggleMute')"><VolumeX v-if="muted" :size="16" /><Volume2 v-else :size="16" /></button></UiTooltip>
    </div>
  </div>
</template>

<style scoped>
.transport-bar{min-width:0;display:flex;align-items:center;gap:4px;padding:4px 10px;border-bottom:1px solid #292f35;color:#f4f4f5}.transport-bar button{color:inherit;cursor:pointer}.transport-bar button:disabled{opacity:.35;cursor:not-allowed}.transport-button{width:34px;min-height:31px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:#18181b}.transport-button:hover:not(:disabled){background:#27272a}.transport-button:focus-visible,.tool-button:focus-visible,.live-badge:focus-visible,.timeline-scale:focus-visible{outline:2px solid #fca5a5;outline-offset:2px}.transport-media-group{display:flex;align-items:center;gap:6px}.timecode{min-width:82px;margin-left:3px;color:#fff;font:700 .7rem "Cascadia Mono",Consolas,monospace}.live-badge{min-height:22px;padding:2px 7px;border:0;border-radius:999px;background:#27272a;color:#a1a1aa;font-size:.56rem;font-weight:800}.live-badge.active{background:#163c27;color:#86efac}.terminal-badge{padding:3px 7px;border:1px solid #3f3f46;border-radius:999px;color:#a1a1aa;font:800 .56rem "Cascadia Mono",Consolas,monospace}.transport-separator{width:1px;height:23px;margin:0 3px;background:#30363d}.transport-context{flex:0 1 270px;min-width:150px;max-width:340px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:0 8px}.transport-context>div{min-width:0;display:grid;gap:1px}.transport-context strong,.transport-context small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transport-context strong{font-size:.65rem}.transport-context small{color:#7f8a95;font-size:.56rem}.transport-context>span{padding:3px 7px;border-radius:999px;background:#27272a;color:#d4d4d8;font-size:.56rem;font-weight:750}.tool-button{min-height:30px;display:flex;align-items:center;gap:5px;padding:0 5px;border:0;border-radius:6px;background:transparent;color:#aab3bc;font-size:.63rem}.tool-button:hover:not(:disabled),.tool-button.active{background:#27272a;color:#fff}.tool-button.danger{color:#dba1a5}.tool-button.icon-only{width:28px;justify-content:center;padding:0}.transport-end{margin-left:auto;display:flex;align-items:center;gap:5px}.timeline-scale{min-width:47px;min-height:26px;padding:0 8px;border:1px solid #3d4b58;border-radius:6px;background:#151a1f;color:#a9d6f7!important;font:750 .62rem "Cascadia Mono",Consolas,monospace;font-variant-numeric:tabular-nums}.timeline-scale:hover{border-color:#62788b;background:#1c242b}@media(max-width:1280px){.transport-context{max-width:210px}.transport-context small{display:none}}@media(max-width:980px){.transport-context,.context-separator{display:none}}
</style>
