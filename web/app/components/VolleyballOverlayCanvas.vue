<script setup lang="ts">
import {
  ANALYSIS_MISSING_ACTION_LABEL,
  type AnalysisFrameChunk,
} from '@volleyball-monitoring/contracts'
import { computed, onMounted, onUnmounted, reactive, ref, useTemplateRef, watch } from 'vue'
import type { ReplayContactEvent } from '~/lib/coachDomain'
import {
  hitTestOverlayTrack,
  overlayCanvasPointToVideo,
  overlayTrackGroupLabel,
  renderVolleyballOverlay,
  type OverlayTrackMetadata,
  type OverlayBallOverride,
  type OverlayFrameBBox,
  type VolleyballOverlayLayers,
  type VolleyballOverlayMode,
} from '~/utils/volleyballOverlayRenderer'

const props = withDefaults(
  defineProps<{
    events: ReplayContactEvent[]
    frame: number
    videoWidth: number
    videoHeight: number
    chunk?: AnalysisFrameChunk | null
    actionLabels?: string[]
    mode?: VolleyballOverlayMode
    layers: VolleyballOverlayLayers
    tracks?: OverlayTrackMetadata[]
    teamLabels?: { left: string; right: string }
    interactive?: boolean
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
  }>(),
  {
    chunk: null,
    actionLabels: () => [],
    mode: 'coach',
    tracks: () => [],
    teamLabels: undefined,
    interactive: false,
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
  },
)

const emit = defineEmits<{
  mediaClick: []
  ballPosition: [position: { x: number; y: number }]
  playerBbox: [selection: { trackId: number; frameBBox: OverlayFrameBBox }]
  trackSelect: [
    selection: { trackId: number; clientX: number; clientY: number; action: string | null },
  ]
}>()

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
let observer: ResizeObserver | null = null
let scheduledFrame: number | null = null
let dragStart: { x: number; y: number } | null = null
let dragCurrent: { x: number; y: number } | null = null
let suppressClick = false
const hoveredTrackId = ref<number | null>(null)
const hoverPoint = reactive({ x: 0, y: 0 })

const hoveredTrack = computed(() =>
  hoveredTrackId.value === null
    ? null
    : (props.tracks.find(track => track.trackId === hoveredTrackId.value) ?? null),
)
const hoveredIdentity = computed(() => {
  if (hoveredTrackId.value === null) return null
  const track = hoveredTrack.value
  return {
    name: props.identityLabels[hoveredTrackId.value] ?? track?.label ?? '未辨識球員',
    jersey: track?.jerseyNumber ? `#${track.jerseyNumber}` : null,
    gid: overlayTrackGroupLabel(track?.gidLabel),
    tid: `T${String(hoveredTrackId.value).padStart(3, '0')}`,
  }
})

function liveBBoxCorrections() {
  if (!dragStart || !dragCurrent || props.selectedTrackId === null)
    return props.playerBboxCorrections
  const frameBBox = {
    x1: Math.min(dragStart.x, dragCurrent.x),
    y1: Math.min(dragStart.y, dragCurrent.y),
    x2: Math.max(dragStart.x, dragCurrent.x),
    y2: Math.max(dragStart.y, dragCurrent.y),
  }
  return {
    ...props.playerBboxCorrections,
    [props.frame]: {
      ...props.playerBboxCorrections[props.frame],
      [props.selectedTrackId]: frameBBox,
    },
  }
}

function viewport(element: HTMLCanvasElement) {
  const rect = element.getBoundingClientRect()
  return { rect, viewport: { x: 0, y: 0, width: rect.width, height: rect.height } }
}

function draw() {
  scheduledFrame = null
  const element = canvas.value
  if (!element || props.mode === 'off') return
  const { rect, viewport: bounds } = viewport(element)
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (element.width !== width) element.width = width
  if (element.height !== height) element.height = height
  const context = element.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, rect.width, rect.height)
  renderVolleyballOverlay({
    context,
    viewport: bounds,
    frame: props.frame,
    videoWidth: props.videoWidth,
    videoHeight: props.videoHeight,
    chunk: props.chunk,
    events: props.events,
    actionLabels: props.actionLabels,
    mode: props.mode,
    layers: props.layers,
    tracks: props.tracks,
    teamLabels: props.teamLabels,
    ballCorrection: props.ballCorrection,
    ballCorrections: props.ballCorrections,
    actionCorrections: props.actionCorrections,
    playerBBoxCorrections: liveBBoxCorrections(),
    contactActorCorrections: props.contactActorCorrections,
    contactActorProjections: props.contactActorProjections,
    contactTimeCorrections: props.contactTimeCorrections,
    identityLabels: props.identityLabels,
    selectedTrackId: props.selectedTrackId,
  })
}

function scheduleDraw() {
  if (scheduledFrame !== null) return
  scheduledFrame = requestAnimationFrame(draw)
}

function drawPresentedFrame() {
  // requestVideoFrameCallback already runs in the browser's rendering step.
  // Queuing another animation frame here makes the overlay trail the video by
  // one presented frame, which is especially visible on a fast moving ball.
  if (scheduledFrame !== null) {
    cancelAnimationFrame(scheduledFrame)
    scheduledFrame = null
  }
  draw()
}

function handleClick(event: MouseEvent) {
  if (!props.interactive) {
    if (props.mode !== 'off') emit('mediaClick')
    return
  }
  if (props.mode === 'off') return
  if (suppressClick) {
    suppressClick = false
    return
  }
  const element = canvas.value
  if (!element) return
  const { rect, viewport: bounds } = viewport(element)
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  if (props.ballRelabel) {
    const position = overlayCanvasPointToVideo(point, bounds, props.videoWidth, props.videoHeight)
    if (position) emit('ballPosition', position)
    return
  }
  if (props.bboxRelabel) return
  const hit = hitTestOverlayTrack(
    {
      chunk: props.chunk,
      frame: props.frame,
      videoWidth: props.videoWidth,
      videoHeight: props.videoHeight,
      viewport: bounds,
      playerBBoxCorrections: props.playerBboxCorrections,
    },
    point,
  )
  if (!hit) return
  const actionId = hit.actionId
  emit('trackSelect', {
    trackId: hit.trackId,
    clientX: event.clientX,
    clientY: event.clientY,
    action:
      props.actionCorrections[hit.trackId] ??
      (actionId === ANALYSIS_MISSING_ACTION_LABEL ? null : (props.actionLabels[actionId] ?? null)),
  })
}

function pointerVideoPosition(event: PointerEvent) {
  const element = canvas.value
  if (!element) return null
  const { rect, viewport: bounds } = viewport(element)
  return overlayCanvasPointToVideo(
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    bounds,
    props.videoWidth,
    props.videoHeight,
  )
}

function handlePointerDown(event: PointerEvent) {
  if (!props.interactive || !props.bboxRelabel || props.selectedTrackId === null) return
  const position = pointerVideoPosition(event)
  if (!position) return
  canvas.value?.setPointerCapture(event.pointerId)
  dragStart = position
  dragCurrent = position
  suppressClick = false
  scheduleDraw()
}

function handlePointerMove(event: PointerEvent) {
  updateHoveredTrack(event)
  if (!dragStart || !props.bboxRelabel) return
  const position = pointerVideoPosition(event)
  if (!position) return
  dragCurrent = position
  suppressClick = true
  scheduleDraw()
}

function updateHoveredTrack(event: PointerEvent) {
  if (props.mode === 'off') {
    hoveredTrackId.value = null
    return
  }
  const element = canvas.value
  if (!element) return
  const { rect, viewport: bounds } = viewport(element)
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  const hit = hitTestOverlayTrack(
    {
      chunk: props.chunk,
      frame: props.frame,
      videoWidth: props.videoWidth,
      videoHeight: props.videoHeight,
      viewport: bounds,
      playerBBoxCorrections: props.playerBboxCorrections,
    },
    point,
  )
  hoveredTrackId.value = hit?.trackId ?? null
  if (!hit) return
  hoverPoint.x = Math.max(8, Math.min(rect.width - 176, point.x + 10))
  hoverPoint.y = Math.max(8, Math.min(rect.height - 72, point.y + 10))
}

function clearHoveredTrack() {
  hoveredTrackId.value = null
}

function finishBBox(event: PointerEvent) {
  if (!dragStart || !dragCurrent || props.selectedTrackId === null) return
  const frameBBox = {
    x1: Math.min(dragStart.x, dragCurrent.x),
    y1: Math.min(dragStart.y, dragCurrent.y),
    x2: Math.max(dragStart.x, dragCurrent.x),
    y2: Math.max(dragStart.y, dragCurrent.y),
  }
  dragStart = null
  dragCurrent = null
  canvas.value?.releasePointerCapture(event.pointerId)
  scheduleDraw()
  if (frameBBox.x2 - frameBBox.x1 >= 4 && frameBBox.y2 - frameBBox.y1 >= 4)
    emit('playerBbox', { trackId: props.selectedTrackId, frameBBox })
}

watch(() => props.frame, drawPresentedFrame, { flush: 'sync' })

watch(
  () => [
    props.events,
    props.videoWidth,
    props.videoHeight,
    props.chunk,
    props.mode,
    props.layers.bbox,
    props.layers.trackId,
    props.layers.action,
    props.layers.ball,
    props.layers.trail,
    props.layers.footprint,
    props.layers.confidence,
    props.layers.court,
    props.layers.nextHit,
    props.actionLabels,
    props.tracks,
    props.teamLabels,
    props.ballCorrection,
    props.ballCorrections,
    props.actionCorrections,
    props.playerBboxCorrections,
    props.contactActorCorrections,
    props.contactTimeCorrections,
    props.identityLabels,
    props.selectedTrackId,
    props.bboxRelabel,
  ],
  scheduleDraw,
)

onMounted(() => {
  observer = new ResizeObserver(scheduleDraw)
  if (canvas.value) observer.observe(canvas.value)
  scheduleDraw()
})

onUnmounted(() => {
  observer?.disconnect()
  if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame)
})
</script>

<template>
  <div class="absolute inset-0 size-full" @pointerleave="clearHoveredTrack">
    <canvas
      ref="canvas"
      class="absolute inset-0 size-full"
      :class="
        interactive || mode !== 'off'
          ? ballRelabel || bboxRelabel
            ? 'pointer-events-auto cursor-crosshair touch-none'
            : 'pointer-events-auto cursor-pointer'
          : 'pointer-events-none'
      "
      :aria-label="
        interactive
          ? ballRelabel
            ? '點擊影片修改此幀球座標'
            : bboxRelabel
              ? '在影片上拖曳新的球員框'
              : '點擊球員框選取追蹤球員'
          : undefined
      "
      :aria-hidden="interactive ? undefined : true"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="finishBBox"
      @pointercancel="finishBBox"
      @click="handleClick"
    />
    <div
      v-if="hoveredIdentity"
      class="overlay-track-tooltip"
      :style="{ left: `${hoverPoint.x}px`, top: `${hoverPoint.y}px` }"
      aria-hidden="true"
    >
      <strong>{{ hoveredIdentity.name }}</strong>
      <span>{{
        [hoveredIdentity.jersey, hoveredIdentity.gid, hoveredIdentity.tid]
          .filter(Boolean)
          .join(' · ')
      }}</span>
    </div>
  </div>
</template>

<style scoped>
.overlay-track-tooltip {
  position: absolute;
  z-index: 4;
  display: grid;
  max-width: min(240px, calc(100% - 16px));
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid #ffffff2b;
  border-radius: 8px;
  background: #0c1219d9;
  box-shadow: 0 6px 18px #0005;
  color: #f3f6f8;
  font-size: 0.64rem;
  line-height: 1.25;
  pointer-events: none;
  backdrop-filter: blur(8px);
}
.overlay-track-tooltip strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.overlay-track-tooltip span {
  overflow: hidden;
  color: #b9c5d0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
