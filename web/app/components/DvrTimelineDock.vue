<script setup lang="ts">
import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { computed, ref } from 'vue'
import type { CaptureTimeline } from '~/lib/coreDomain'
import { timelineBounds, capturePercentBps, rulerTicks, pointerTarget, readyAt, gapRanges } from '~/lib/dvrTimeline'

const props = defineProps<{
  timeline: CaptureTimeline | null
  playhead: string | null
  annotation?: AnnotationRallySnapshot | null
  editable?: boolean
  selectedKeyPointId?: string | null
  softLocks?: Record<string, string[]>
}>()
const emit = defineEmits<{
  seek: [target: string]
  select: [keyPointId: string]
  editStart: [keyPointId: string]
  editCancel: [keyPointId: string]
  move: [keyPointId: string, targetCaptureTimeUs: string]
}>()
const fullBounds = computed(() => timelineBounds(props.timeline?.availableRanges ?? []))
const zoom = ref(1)
const pan = ref(1)
const dragging = ref(false)
const dragStartX = ref(0)
const dragStartPan = ref(1)
const dragged = ref(false)
const pointDrag = ref<{
  keyPointId: string
  pointerId: number
  startX: number
  targetCaptureTimeUs: string
  moved: boolean
  announced: boolean
} | null>(null)
const suppressPointClick = ref<string | null>(null)
const viewBounds = computed(() => {
  const bounds = fullBounds.value
  if (!bounds) return null
  const start = BigInt(bounds.startUs)
  const end = BigInt(bounds.endUs)
  const span = end - start
  if (span <= 1n || zoom.value <= 1) return bounds
  const visibleSpan = span / BigInt(Math.max(1, Math.round(zoom.value * 100))) * 100n
  const availablePan = span - visibleSpan
  const viewStart = start + availablePan * BigInt(Math.round(pan.value * 1_000)) / 1_000n
  return { startUs: viewStart.toString(), endUs: (viewStart + visibleSpan).toString() }
})
const ticks = computed(() => rulerTicks(viewBounds.value))
const gaps = computed(() => gapRanges(props.timeline?.availableRanges ?? []))
const annotationPoints = computed(() => props.annotation?.snapshot.key_points ?? [])
const immutable = computed(() => props.annotation?.snapshot.annotation_status === 'submitted')
const maskStart = computed(() => annotationPoints.value[0]?.capture_time_us ?? null)
const maskEnd = computed(() => annotationPoints.value.at(-1)?.capture_time_us ?? null)
const liveEdge = computed(() => props.timeline?.liveEdgeCaptureTimeUs ?? props.timeline?.availableRanges.at(-1)?.endUs ?? null)
const isVisible = (time: string) => Boolean(viewBounds.value && BigInt(time) >= BigInt(viewBounds.value.startUs) && BigInt(time) <= BigInt(viewBounds.value.endUs))
const position = (time: string) => viewBounds.value ? capturePercentBps(time, viewBounds.value) / 100 : 0
const remoteEditors = (keyPointId: string) => props.softLocks?.[keyPointId] ?? []
const pointPosition = (keyPointId: string, captureTimeUs: string) => position(pointDrag.value?.keyPointId === keyPointId ? pointDrag.value.targetCaptureTimeUs : captureTimeUs)

function resetView() { zoom.value = 1; pan.value = 1 }
function wheel(event: WheelEvent) {
  if (event.shiftKey) zoom.value = Math.max(1, Math.min(64, zoom.value * (event.deltaY < 0 ? 1.18 : .85)))
  else pan.value = Math.max(0, Math.min(1, pan.value + (event.deltaX || event.deltaY) / 1_000))
}
function beginPan(event: PointerEvent) {
  if (zoom.value <= 1 || (event.target as HTMLElement).closest('button')) return
  dragging.value = true
  dragged.value = false
  dragStartX.value = event.clientX
  dragStartPan.value = pan.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function movePan(event: PointerEvent) {
  if (!dragging.value) return
  const element = event.currentTarget as HTMLElement
  const delta = event.clientX - dragStartX.value
  if (Math.abs(delta) > 3) dragged.value = true
  const panDelta = delta / Math.max(1, element.clientWidth) / Math.max(1, zoom.value - 1)
  pan.value = Math.max(0, Math.min(1, dragStartPan.value - panDelta))
}
function endPan(event: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
}
function seek(event: MouseEvent) {
  if (dragged.value) { dragged.value = false; return }
  if (!viewBounds.value || !props.timeline) return
  const target = pointerTarget(event.clientX, (event.currentTarget as HTMLElement).getBoundingClientRect(), viewBounds.value)
  if (readyAt(target, props.timeline.availableRanges)) emit('seek', target)
}
function selectPoint(keyPointId: string, captureTimeUs: string) {
  emit('select', keyPointId)
  if (props.timeline && readyAt(captureTimeUs, props.timeline.availableRanges)) emit('seek', captureTimeUs)
}
function beginPointDrag(event: PointerEvent, keyPointId: string, captureTimeUs: string) {
  if (!props.editable || immutable.value) return
  pointDrag.value = { keyPointId, pointerId: event.pointerId, startX: event.clientX, targetCaptureTimeUs: captureTimeUs, moved: false, announced: false }
  const element = event.currentTarget as HTMLElement
  if (typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId)
}
function movePointDrag(event: PointerEvent) {
  const drag = pointDrag.value
  if (!drag || drag.pointerId !== event.pointerId || !viewBounds.value || !props.timeline) return
  if (!drag.moved && Math.abs(event.clientX - drag.startX) <= 3) return
  drag.moved = true
  if (!drag.announced) {
    drag.announced = true
    emit('editStart', drag.keyPointId)
  }
  const lane = (event.currentTarget as HTMLElement).parentElement
  if (!lane) return
  const target = pointerTarget(event.clientX, lane.getBoundingClientRect(), viewBounds.value)
  if (readyAt(target, props.timeline.availableRanges)) drag.targetCaptureTimeUs = target
}
function endPointDrag(event: PointerEvent) {
  const drag = pointDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  const element = event.currentTarget as HTMLElement
  if (typeof element.releasePointerCapture === 'function' && element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
  pointDrag.value = null
  if (!drag.moved || !drag.announced) return
  suppressPointClick.value = drag.keyPointId
  emit('move', drag.keyPointId, drag.targetCaptureTimeUs)
}
function cancelPointDrag(event: PointerEvent) {
  const drag = pointDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  pointDrag.value = null
  if (drag.announced) emit('editCancel', drag.keyPointId)
}
function clickPoint(keyPointId: string, captureTimeUs: string) {
  if (suppressPointClick.value === keyPointId) {
    suppressPointClick.value = null
    return
  }
  selectPoint(keyPointId, captureTimeUs)
}
</script>

<template>
  <section class="timeline-surface" :class="{ dragging }" aria-label="Server DVR timeline" @wheel.prevent="wheel" @pointerdown="beginPan" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan">
    <div class="ruler-row"><span v-for="tick in ticks" :key="tick.value" class="ruler-tick" :style="{ left: `${tick.percentBps / 100}%` }" :title="tick.value">{{ tick.label }}<i /></span></div>
    <div class="lane-row mask-lane"><span class="lane-label">MASK</span><div class="lane-content" role="slider" tabindex="0" aria-label="DVR seek" :aria-valuemin="viewBounds?.startUs ?? '0'" :aria-valuemax="viewBounds?.endUs ?? '0'" :aria-valuenow="playhead ?? viewBounds?.startUs ?? '0'" @click="seek"><i v-for="range in timeline?.availableRanges ?? []" :key="`${range.startUs}-${range.endUs}`" class="ready-range" :style="{ left: `${position(range.startUs)}%`, width: `${Math.max(0, position(range.endUs) - position(range.startUs))}%` }" /><i v-for="gap in gaps" :key="`${gap.startUs}-${gap.endUs}`" class="gap-range" :style="{ left: `${position(gap.startUs)}%`, width: `${Math.max(0, position(gap.endUs) - position(gap.startUs))}%` }" /><button v-if="maskStart && maskEnd" type="button" class="timeline-mask" :class="immutable ? 'submitted' : 'draft'" :style="{ left: `${position(maskStart)}%`, width: `${Math.max(.35, position(maskEnd) - position(maskStart))}%` }">{{ immutable ? 'SUBMITTED' : annotation?.snapshot.active_submission_id ? 'CORRECTION DRAFT' : 'DRAFT' }}</button></div></div>
    <div class="lane-row keypoint-lane"><span class="lane-label">KEYPOINTS</span><div class="lane-content" @click="seek"><button v-for="point in annotationPoints" v-show="isVisible(point.capture_time_us)" :key="point.key_point_id" type="button" class="keypoint-dot" :class="{ service: point.marker_kind === 'service', terminal: point.is_terminal, locked: immutable || !editable, editable: editable && !immutable, selected: selectedKeyPointId === point.key_point_id, 'soft-locked': remoteEditors(point.key_point_id).length, 'point-dragging': pointDrag?.keyPointId === point.key_point_id }" :style="{ left: `${pointPosition(point.key_point_id, point.capture_time_us)}%` }" :aria-label="`${point.marker_kind} marker at frame ${point.capture_frame_index}${remoteEditors(point.key_point_id).length ? `; ${remoteEditors(point.key_point_id).join('、')} 正在調整` : ''}`" :aria-pressed="selectedKeyPointId === point.key_point_id" :title="`${point.marker_kind} · frame ${point.capture_frame_index}${editable && !immutable ? ' · click to fine-tune or drag to move' : ''}${remoteEditors(point.key_point_id).length ? ` · ${remoteEditors(point.key_point_id).join('、')} 正在調整（提示，不阻擋）` : ''}`" @pointerdown.stop="beginPointDrag($event, point.key_point_id, point.capture_time_us)" @pointermove.stop="movePointDrag" @pointerup.stop="endPointDrag" @pointercancel.stop="cancelPointDrag" @click.stop="clickPoint(point.key_point_id, point.capture_time_us)" /></div></div>
    <div v-if="playhead && isVisible(playhead)" class="playhead" :style="{ left: `calc(78px + (100% - 78px) * ${position(playhead) / 100})` }"><span /></div>
    <div v-if="liveEdge && isVisible(liveEdge)" class="live-edge" :style="{ left: `calc(78px + (100% - 78px) * ${position(liveEdge) / 100})` }"><span>LIVE</span></div>
    <div class="timeline-meta"><span>{{ timeline?.availableRanges.length ?? 0 }} READY RANGES · STREAM BUFFER</span><button type="button" class="zoom-readout" @click="resetView">{{ zoom.toFixed(1) }}× · RESET</button></div>
  </section>
</template>

<style scoped>
.timeline-surface{position:relative;min-height:0;margin:0 12px;overflow:hidden;background:#0c0f12;cursor:ew-resize;touch-action:none;user-select:none;color:#edf1f4}.timeline-surface.dragging{cursor:grabbing}.ruler-row{position:absolute;inset:0 0 auto 78px;height:26px;border-bottom:1px solid #353b42}.ruler-tick{position:absolute;top:4px;transform:translateX(-50%);color:#7f8993;font:.58rem "Cascadia Mono",Consolas,monospace;white-space:nowrap}.ruler-tick:first-child{transform:none}.ruler-tick:last-child{transform:translateX(-100%)}.ruler-tick i{position:absolute;left:50%;top:15px;width:1px;height:7px;background:#56616b}.lane-row{position:absolute;left:0;right:0;height:36px;border-bottom:1px solid #292f35}.mask-lane{top:26px}.keypoint-lane{top:62px;border-bottom:0}.lane-label{position:absolute;inset:0 auto 0 0;width:78px;display:grid;place-items:center start;padding-left:8px;border-right:1px solid #30363d;color:#717b84;font:700 .59rem "Cascadia Mono",Consolas,monospace;pointer-events:none}.lane-content{position:absolute;inset:0 0 0 78px;overflow:hidden}.lane-content:focus-visible{outline:2px solid #62a9ff;outline-offset:-2px}.ready-range,.gap-range{position:absolute;top:0;bottom:0;background:#49d88a0a;pointer-events:none}.gap-range{background:#ff6b721c}.timeline-mask{position:absolute;top:5px;height:25px;min-height:0;padding:0 5px;overflow:hidden;border:1px solid #69737c;border-radius:3px;background:#838e9854;color:#e5eaee;font:700 .6rem "Cascadia Mono",Consolas,monospace;text-align:left;white-space:nowrap}.timeline-mask.submitted{border-color:#338b60;background:#29915c57;color:#b8f2d2}.timeline-mask.draft{pointer-events:none}.keypoint-dot{position:absolute;top:11px;width:13px;height:13px;min-height:0;padding:0;transform:translateX(-50%);border:2px solid #f4f7fa;border-radius:50%;background:#62a9ff}.keypoint-dot.service{background:#f5b84b}.keypoint-dot.terminal{border-radius:2px;transform:translateX(-50%) rotate(45deg)}.keypoint-dot.editable{cursor:grab}.keypoint-dot.point-dragging{z-index:6;cursor:grabbing}.keypoint-dot.selected{z-index:3;box-shadow:0 0 0 3px #62a9ff55,0 0 12px #62a9ff}.keypoint-dot.soft-locked{z-index:4;border-color:#f3c2ff;box-shadow:0 0 0 4px #cf77e64d,0 0 14px #cf77e6}.keypoint-dot.locked{opacity:.62}.playhead{position:absolute;z-index:5;top:0;bottom:0;width:1px;background:#ff6b72;pointer-events:none}.playhead span{position:absolute;left:50%;top:0;width:9px;height:9px;transform:translateX(-50%);background:#ff6b72;clip-path:polygon(0 0,100% 0,50% 100%)}.live-edge{position:absolute;z-index:4;top:0;bottom:0;width:1px;background:#49d88a80;pointer-events:none}.live-edge span{position:absolute;right:4px;top:4px;color:#83e8af;font:700 .54rem "Cascadia Mono",Consolas,monospace}.timeline-meta{position:absolute;right:4px;bottom:2px;z-index:7;display:flex;align-items:center;gap:7px;color:#717b84;font:.56rem "Cascadia Mono",Consolas,monospace}.zoom-readout{min-height:22px;padding:2px 5px;border:1px solid #43515e;border-radius:4px;background:#171c21;color:#9fc7eb;font:700 .58rem "Cascadia Mono",Consolas,monospace;cursor:pointer}
</style>
