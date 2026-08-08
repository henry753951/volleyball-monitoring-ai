<script setup lang="ts">
import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { Activity, Bot, CircleDotDashed, UserRound } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { CaptureTimeline } from '~/lib/coreDomain'
import { timelineBounds, capturePercentBps, rulerTicks, pointerTarget, readyAt, gapRanges, selectNonOverlappingRanges } from '~/lib/dvrTimeline'

const props = defineProps<{
  timeline: CaptureTimeline | null
  playhead: string | null
  annotation?: AnnotationRallySnapshot | null
  editable?: boolean
  selectedKeyPointId?: string | null
  maskSelected?: boolean
  softLocks?: Record<string, string[]>
  segments?: Array<{
    id: string
    label: string
    stateLabel?: string
    outcomeLabel?: string | null
    startCaptureTimeUs: string
    endCaptureTimeUs: string
    status: 'draft' | 'processing' | 'analyzed' | 'mapped'
    points?: Array<{ id: string; markerKind: string; isTerminal: boolean; captureTimeUs: string }>
    analysis?: {
      startCaptureTimeUs: string
      endCaptureTimeUs: string
      byteLength: string
      trackCount: number
      ballPathCount: number
      contactCount: number
      capabilities: string[]
    } | null
  }>
  selectedSegmentId?: string | null
  bufferedWindow?: { startCaptureTimeUs: string; endCaptureTimeUs: string } | null
  currentMaskStatus?: 'processing' | 'analyzed' | 'mapped'
  currentMaskLabel?: string | null
  currentMaskOutcome?: string | null
  cursorFollow?: boolean
  maskRange?: { startCaptureTimeUs: string; endCaptureTimeUs: string } | null
}>()

const emit = defineEmits<{
  seek: [target: string]
  preview: [target: string | null]
  select: [keyPointId: string]
  selectMask: []
  editStart: [keyPointId: string]
  editCancel: [keyPointId: string]
  move: [keyPointId: string, targetCaptureTimeUs: string]
  selectSegment: [segmentId: string, targetCaptureTimeUs: string]
  clearSelection: []
}>()
const fullBounds = computed(() => timelineBounds(props.timeline?.availableRanges ?? []))
const zoom = ref(1)
const pan = ref(1)
const targetZoom = ref(1)
const targetPan = ref(1)
const stablePlayhead = ref<string | null>(props.playhead)
const optimisticPlayhead = ref<string | null>(null)
let animationFrame: number | null = null
let manualViewUntil = 0
let optimisticPlayheadTimer: ReturnType<typeof setTimeout> | null = null
const pointDrag = ref<{
  keyPointId: string
  pointerId: number
  startX: number
  targetCaptureTimeUs: string
  moved: boolean
  announced: boolean
} | null>(null)
const suppressPointClick = ref<string | null>(null)
const playheadDrag = ref<{ pointerId: number; targetCaptureTimeUs: string } | null>(null)
const viewBounds = computed(() => {
  const bounds = fullBounds.value
  if (!bounds) return null
  const start = BigInt(bounds.startUs)
  const end = BigInt(bounds.endUs)
  const span = end - start
  if (span <= 1n || zoom.value <= 1) return bounds
  const visibleSpan = span / BigInt(Math.max(1, Math.round(zoom.value * 100))) * 100n
  const availablePan = span - visibleSpan
  const viewStart = start + availablePan * BigInt(Math.round(pan.value * 1_000_000)) / 1_000_000n
  return { startUs: viewStart.toString(), endUs: (viewStart + visibleSpan).toString() }
})
const ticks = computed(() => rulerTicks(viewBounds.value, fullBounds.value?.startUs))
const gaps = computed(() => gapRanges(props.timeline?.availableRanges ?? []))
const annotationPoints = computed(() => props.annotation?.snapshot.key_points ?? [])
const immutable = computed(() => props.annotation?.snapshot.annotation_status === 'submitted')
const currentMaskTone = computed(() => immutable.value ? props.currentMaskStatus ?? 'processing' : 'draft')
const currentMaskLabel = computed(() => {
  if (props.currentMaskLabel) return props.currentMaskLabel
  if (!immutable.value) return props.annotation?.snapshot.active_submission_id ? '修正版' : '標記中'
  return '目前片段'
})
const maskStart = computed(() => props.maskRange?.startCaptureTimeUs ?? annotationPoints.value[0]?.capture_time_us ?? null)
const maskEnd = computed(() => props.maskRange?.endCaptureTimeUs ?? annotationPoints.value.at(-1)?.capture_time_us ?? null)
const liveEdge = computed(() => props.timeline?.liveEdgeCaptureTimeUs ?? props.timeline?.availableRanges.at(-1)?.endUs ?? null)
const displayPlayhead = computed(() => playheadDrag.value?.targetCaptureTimeUs ?? optimisticPlayhead.value ?? props.playhead ?? stablePlayhead.value)
const isVisible = (time: string) => Boolean(viewBounds.value && BigInt(time) >= BigInt(viewBounds.value.startUs) && BigInt(time) <= BigInt(viewBounds.value.endUs))
const position = (time: string) => viewBounds.value ? capturePercentBps(time, viewBounds.value) / 100 : 0
const remoteEditors = (keyPointId: string) => props.softLocks?.[keyPointId] ?? []
const isPendingPoint = (keyPointId: string) => keyPointId.startsWith('pending:')
const pointPosition = (keyPointId: string, captureTimeUs: string) => position(pointDrag.value?.keyPointId === keyPointId ? pointDrag.value.targetCaptureTimeUs : captureTimeUs)
type SegmentRange = { startCaptureTimeUs: string; endCaptureTimeUs: string }
const clippedSegmentRange = (segment: SegmentRange) => {
  const view = viewBounds.value
  if (!view) return null
  const start = BigInt(segment.startCaptureTimeUs) > BigInt(view.startUs) ? segment.startCaptureTimeUs : view.startUs
  const end = BigInt(segment.endCaptureTimeUs) < BigInt(view.endUs) ? segment.endCaptureTimeUs : view.endUs
  return BigInt(end) > BigInt(start) ? { startCaptureTimeUs: start, endCaptureTimeUs: end } : null
}
const segmentVisibleWidth = (segment: SegmentRange) => {
  const clipped = clippedSegmentRange(segment)
  return clipped ? Math.max(0, position(clipped.endCaptureTimeUs) - position(clipped.startCaptureTimeUs)) : 0
}
const segmentVisible = (segment: SegmentRange) => segmentVisibleWidth(segment) > 0
const segmentLeft = (segment: SegmentRange) => {
  const clipped = clippedSegmentRange(segment)
  return clipped ? position(clipped.startCaptureTimeUs) : 0
}
const segmentWidth = (segment: SegmentRange) => Math.max(.35, segmentVisibleWidth(segment))
const segmentDensityClass = (segment: SegmentRange) => {
  const width = segmentVisibleWidth(segment)
  return width < 5 ? 'density-micro' : width < 12 ? 'density-compact' : ''
}
const analysisRange = (segment: SegmentRange & { analysis?: { startCaptureTimeUs: string; endCaptureTimeUs: string } | null }): SegmentRange => ({
  startCaptureTimeUs: segment.analysis?.startCaptureTimeUs ?? segment.startCaptureTimeUs,
  endCaptureTimeUs: segment.analysis?.endCaptureTimeUs ?? segment.endCaptureTimeUs,
})
const currentMaskGeometry = computed(() => {
  if (!maskStart.value || !maskEnd.value) return null
  const range = { startCaptureTimeUs: maskStart.value, endCaptureTimeUs: maskEnd.value }
  return {
    visible: segmentVisible(range),
    left: segmentLeft(range),
    width: segmentWidth(range),
    density: segmentDensityClass(range),
  }
})
const segmentStatusLabel = (status: 'draft' | 'processing' | 'analyzed' | 'mapped') => status === 'draft' ? '未送出' : status === 'mapped' ? '球員已確認' : status === 'analyzed' ? '分析完成' : '分析中'
// A live/correction draft is the active representation of its time range.
// Suppress historical revisions rather than painting multiple masks together.
const displaySegments = computed(() => selectNonOverlappingRanges(
  props.segments ?? [],
  maskStart.value && maskEnd.value ? { startCaptureTimeUs: maskStart.value, endCaptureTimeUs: maskEnd.value } : null,
  props.selectedSegmentId,
))
const displayAnalysisSegments = computed(() => displaySegments.value.flatMap(segment => segment.analysis
  ? [{ segment, range: analysisRange(segment) }]
  : []))
// Rally clips are guaranteed to be non-overlapping. Keep one generous visual lane
// so the mask label remains readable instead of creating artificial parallel lanes.
const maskTop = () => 8
const pointTop = () => 62

watch(() => props.playhead, (value) => {
  if (!value) return
  stablePlayhead.value = value
  if (optimisticPlayhead.value && absDiff(value, optimisticPlayhead.value) <= 100_000n) clearOptimisticPlayhead()
  const bounds = fullBounds.value
  const view = viewBounds.value
  if (!bounds || !view || targetZoom.value <= 1 || Date.now() < manualViewUntil || playheadDrag.value) return
  const target = BigInt(value)
  if (target >= BigInt(view.startUs) && target <= BigInt(view.endUs)) return
  const fullStart = BigInt(bounds.startUs)
  const fullSpan = BigInt(bounds.endUs) - fullStart
  const viewSpan = BigInt(view.endUs) - BigInt(view.startUs)
  const availablePan = fullSpan - viewSpan
  if (availablePan <= 0n) return
  const desiredStart = target - viewSpan / 2n - fullStart
  const clamped = desiredStart < 0n ? 0n : desiredStart > availablePan ? availablePan : desiredStart
  targetPan.value = Number(clamped * 1_000_000n / availablePan) / 1_000_000
  animateView()
})
function absDiff(left: string, right: string) {
  const difference = BigInt(left) - BigInt(right)
  return difference < 0n ? -difference : difference
}
function clearOptimisticPlayhead() {
  optimisticPlayhead.value = null
  if (optimisticPlayheadTimer) clearTimeout(optimisticPlayheadTimer)
  optimisticPlayheadTimer = null
}
function requestSeek(target: string) {
  stablePlayhead.value = target
  optimisticPlayhead.value = target
  if (optimisticPlayheadTimer) clearTimeout(optimisticPlayheadTimer)
  optimisticPlayheadTimer = setTimeout(clearOptimisticPlayhead, 5_000)
  emit('seek', target)
}
function animateView() {
  if (animationFrame !== null) return
  const reduceMotion = typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion) {
    zoom.value = targetZoom.value
    pan.value = targetPan.value
    return
  }
  const tick = () => {
    zoom.value += (targetZoom.value - zoom.value) * .16
    pan.value += (targetPan.value - pan.value) * .16
    if (Math.abs(targetZoom.value - zoom.value) < .001 && Math.abs(targetPan.value - pan.value) < .000001) {
      zoom.value = targetZoom.value
      pan.value = targetPan.value
      animationFrame = null
      return
    }
    animationFrame = requestAnimationFrame(tick)
  }
  animationFrame = requestAnimationFrame(tick)
}
function resetView() { targetZoom.value = 1; targetPan.value = 1; animateView() }
function wheel(event: WheelEvent) {
  manualViewUntil = Date.now() + 3_000
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 240 : 1
  const normalizedDelta = Math.max(-120, Math.min(120, delta * unit))
  if (event.shiftKey) {
    const bounds = fullBounds.value
    const currentView = viewBounds.value
    if (!bounds || !currentView) return
    const laneLeft = 78
    const surface = event.currentTarget as HTMLElement
    const laneWidth = Math.max(1, surface.clientWidth - laneLeft)
    const anchor = Math.max(0, Math.min(1, (event.clientX - surface.getBoundingClientRect().left - laneLeft) / laneWidth))
    const nextZoom = Math.max(1, Math.min(64, targetZoom.value * Math.exp(-normalizedDelta * .0007)))
    const fullStart = BigInt(bounds.startUs)
    const fullEnd = BigInt(bounds.endUs)
    const fullSpan = fullEnd - fullStart
    const currentStart = BigInt(currentView.startUs)
    const currentSpan = BigInt(currentView.endUs) - currentStart
    const anchorCapture = currentStart + currentSpan * BigInt(Math.round(anchor * 1_000_000)) / 1_000_000n
    const nextVisibleSpan = fullSpan / BigInt(Math.max(1, Math.round(nextZoom * 100))) * 100n
    const availablePan = fullSpan - nextVisibleSpan
    const desiredStart = anchorCapture - nextVisibleSpan * BigInt(Math.round(anchor * 1_000_000)) / 1_000_000n - fullStart
    const clampedStart = desiredStart < 0n ? 0n : desiredStart > availablePan ? availablePan : desiredStart
    targetZoom.value = nextZoom
    targetPan.value = availablePan > 0n ? Number(clampedStart * 1_000_000n / availablePan) / 1_000_000 : 0
  }
  else if (targetZoom.value > 1.001) {
    const surface = event.currentTarget as HTMLElement
    const laneWidth = Math.max(1, surface.clientWidth - 78)
    const screenShift = normalizedDelta / laneWidth * .32
    const panShift = screenShift / Math.max(.25, targetZoom.value - 1)
    targetPan.value = Math.max(0, Math.min(1, targetPan.value + panShift))
  }
  animateView()
}
function beginPlayheadDrag(event: PointerEvent) {
  const value = displayPlayhead.value
  if (!value) return
  playheadDrag.value = { pointerId: event.pointerId, targetCaptureTimeUs: value }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function movePlayheadDrag(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId || !viewBounds.value || !props.timeline) return
  const root = (event.currentTarget as HTMLElement).closest('.timeline-surface') as HTMLElement | null
  const lane = root?.querySelector<HTMLElement>('.lane-content')
  if (!lane) return
  const target = pointerTarget(event.clientX, lane.getBoundingClientRect(), viewBounds.value)
  if (readyAt(target, props.timeline.availableRanges)) {
    drag.targetCaptureTimeUs = target
    emit('preview', target)
  }
}
function endPlayheadDrag(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  const element = event.currentTarget as HTMLElement
  if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
  optimisticPlayhead.value = drag.targetCaptureTimeUs
  playheadDrag.value = null
  emit('preview', null)
  requestSeek(drag.targetCaptureTimeUs)
}
function cancelPlayheadDrag(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  playheadDrag.value = null
  emit('preview', null)
}
function playheadDragLabel() {
  const target = playheadDrag.value?.targetCaptureTimeUs
  const bounds = fullBounds.value
  if (!target || !bounds) return ''
  const milliseconds = Number((BigInt(target) - BigInt(bounds.startUs)) / 1_000n)
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  const seconds = Math.max(0, Math.floor(milliseconds % 60_000 / 1_000))
  const ms = Math.max(0, milliseconds % 1_000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}
function seek(event: MouseEvent) {
  emit('clearSelection')
  if (!viewBounds.value || !props.timeline) return
  const target = pointerTarget(event.clientX, (event.currentTarget as HTMLElement).getBoundingClientRect(), viewBounds.value)
  if (readyAt(target, props.timeline.availableRanges)) requestSeek(target)
}
function selectPoint(keyPointId: string, captureTimeUs: string) {
  emit('select', keyPointId)
  if (props.cursorFollow && props.timeline && readyAt(captureTimeUs, props.timeline.availableRanges)) requestSeek(captureTimeUs)
}
function selectHistoricalPoint(segmentId: string, captureTimeUs: string) {
  emit('selectSegment', segmentId, captureTimeUs)
  if (props.cursorFollow && props.timeline && readyAt(captureTimeUs, props.timeline.availableRanges)) requestSeek(captureTimeUs)
}
function focusRange(startCaptureTimeUs: string, endCaptureTimeUs: string, seekTarget: string | null = startCaptureTimeUs) {
  const bounds = fullBounds.value
  if (!bounds) return
  const fullStart = BigInt(bounds.startUs)
  const fullEnd = BigInt(bounds.endUs)
  const rangeStart = BigInt(startCaptureTimeUs)
  const rangeEnd = BigInt(endCaptureTimeUs)
  const fullSpan = fullEnd - fullStart
  const rangeSpan = rangeEnd > rangeStart ? rangeEnd - rangeStart : 1n
  if (fullSpan <= 1n) return
  const paddedSpan = rangeSpan * 3n / 2n
  const nextZoom = Math.max(1, Math.min(64, Number(fullSpan) / Math.max(1, Number(paddedSpan))))
  const visibleSpan = Number(fullSpan) / nextZoom
  const availablePan = Math.max(0, Number(fullSpan) - visibleSpan)
  const center = Number(rangeStart + rangeEnd) / 2 - Number(fullStart)
  const desiredStart = Math.max(0, Math.min(availablePan, center - visibleSpan / 2))
  targetZoom.value = nextZoom
  targetPan.value = availablePan > 0 ? desiredStart / availablePan : 0
  animateView()
  if (seekTarget) requestSeek(seekTarget)
}
function focusHistoricalSegment(segment: { id: string; startCaptureTimeUs: string; endCaptureTimeUs: string }) {
  focusRange(segment.startCaptureTimeUs, segment.endCaptureTimeUs, null)
}
function focusCurrentMask() {
  if (!maskStart.value || !maskEnd.value) return
  emit('selectMask')
  focusRange(maskStart.value, maskEnd.value)
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
function formatBytes(value: string) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(bytes >= 100_000 ? 0 : 1)} KB`
  return `${bytes} B`
}
onBeforeUnmount(() => {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame)
  if (optimisticPlayheadTimer) clearTimeout(optimisticPlayheadTimer)
})
</script>

<template>
  <section class="timeline-surface" aria-label="影音時間軸" @wheel.prevent="wheel">
    <div class="ruler-row" title="點擊跳轉" @click="seek"><span v-for="(tick, index) in ticks" :key="`${tick.value}-${index}`" class="ruler-tick" :style="{ left: `${tick.percentBps / 100}%` }" :title="tick.value">{{ tick.label }}<i /></span></div>
    <div class="buffer-status" role="slider" aria-label="影片定位" :aria-valuemin="viewBounds?.startUs ?? '0'" :aria-valuemax="viewBounds?.endUs ?? '0'" :aria-valuenow="displayPlayhead ?? viewBounds?.startUs ?? '0'" @click="seek"><i v-for="range in timeline?.availableRanges ?? []" :key="`${range.startUs}-${range.endUs}`" class="ready-range" :style="{ left: `${position(range.startUs)}%`, width: `${Math.max(0, position(range.endUs) - position(range.startUs))}%` }" /><i v-if="bufferedWindow" class="playback-ready" :style="{ left: `${position(bufferedWindow.startCaptureTimeUs)}%`, width: `${Math.max(.2, position(bufferedWindow.endCaptureTimeUs) - position(bufferedWindow.startCaptureTimeUs))}%` }" /><i v-for="gap in gaps" :key="`${gap.startUs}-${gap.endUs}`" class="gap-range" :style="{ left: `${position(gap.startUs)}%`, width: `${Math.max(0, position(gap.endUs) - position(gap.startUs))}%` }" /></div>
    <div class="lane-row clip-lane">
      <span class="lane-label">片段</span>
      <div class="lane-content" @click="emit('clearSelection')">
        <button v-for="segment in displaySegments" v-show="segmentVisible(segment)" :key="segment.id" data-timeline-interactive type="button" class="timeline-mask historical" :class="[segment.status, segmentDensityClass(segment), { selected: selectedSegmentId === segment.id }]" :style="{ left: `${segmentLeft(segment)}%`, top: `${maskTop()}px`, width: `${segmentWidth(segment)}%` }" :aria-label="`${segment.label} · ${segmentStatusLabel(segment.status)}`" @click.stop="emit('selectSegment', segment.id, segment.startCaptureTimeUs)" @dblclick.stop="focusHistoricalSegment(segment)"><span>{{ segment.label }}</span><small>{{ segment.outcomeLabel || segment.stateLabel || segmentStatusLabel(segment.status) }}</small><b v-if="segment.status === 'analyzed'">待指派</b></button>
        <button v-if="currentMaskGeometry" v-show="currentMaskGeometry.visible" data-timeline-interactive type="button" class="timeline-mask current" :class="[currentMaskTone, currentMaskGeometry.density, { selected: maskSelected }]" :style="{ left: `${currentMaskGeometry.left}%`, top: `${maskTop()}px`, width: `${currentMaskGeometry.width}%` }" @click.stop="emit('selectMask')" @dblclick.stop="focusCurrentMask"><span>{{ currentMaskLabel }}</span><small>{{ currentMaskOutcome || (annotation?.snapshot.active_submission_id ? '修正版' : '未送出') }}</small></button>
        <div v-for="item in displayAnalysisSegments" v-show="segmentVisible(item.range)" :key="`${item.segment.id}:analysis`" class="analysis-rail" :class="segmentDensityClass(item.range)" :style="{ left: `${segmentLeft(item.range)}%`, width: `${segmentWidth(item.range)}%` }"><Bot :size="11" /><span>{{ formatBytes(item.segment.analysis?.byteLength ?? '0') }}</span><UserRound v-if="item.segment.analysis?.capabilities.includes('player_tracking')" :size="11" /><CircleDotDashed v-if="item.segment.analysis?.capabilities.includes('ball_tracking')" :size="11" /><Activity v-if="item.segment.analysis?.capabilities.includes('contact_association')" :size="11" /></div>
        <button v-for="point in annotationPoints" v-show="isVisible(point.capture_time_us)" :key="point.key_point_id" data-timeline-interactive type="button" class="keypoint-dot" :class="[{ service: point.marker_kind === 'service', terminal: point.is_terminal, pending: isPendingPoint(point.key_point_id), locked: immutable || !editable || isPendingPoint(point.key_point_id), editable: editable && !immutable && !isPendingPoint(point.key_point_id), selected: selectedKeyPointId === point.key_point_id, 'soft-locked': remoteEditors(point.key_point_id).length, 'point-dragging': pointDrag?.keyPointId === point.key_point_id }, currentMaskGeometry?.density]" :style="{ left: `${pointPosition(point.key_point_id, point.capture_time_us)}%`, top: `${pointTop()}px` }" :aria-label="`${point.marker_kind} marker at frame ${point.capture_frame_index}${isPendingPoint(point.key_point_id) ? '; syncing' : ''}${remoteEditors(point.key_point_id).length ? `; ${remoteEditors(point.key_point_id).join('、')} 正在調整` : ''}`" :aria-pressed="selectedKeyPointId === point.key_point_id" :title="isPendingPoint(point.key_point_id) ? `${point.marker_kind} · 本機已標記，等待伺服器確認` : `${point.marker_kind} · frame ${point.capture_frame_index}${editable && !immutable ? ' · 拖曳移動' : ''}${remoteEditors(point.key_point_id).length ? ` · ${remoteEditors(point.key_point_id).join('、')} 正在調整（提示，不阻擋）` : ''}`" @pointerdown.stop="beginPointDrag($event, point.key_point_id, point.capture_time_us)" @pointermove.stop="movePointDrag" @pointerup.stop="endPointDrag" @pointercancel.stop="cancelPointDrag" @click.stop="clickPoint(point.key_point_id, point.capture_time_us)" />
      </div>
    </div>
    <template v-for="segment in displaySegments" :key="`${segment.id}:points`"><button v-for="point in segment.points ?? []" v-show="isVisible(point.captureTimeUs)" :key="point.id" data-timeline-interactive type="button" class="keypoint-dot historical-point locked" :class="[{ service: point.markerKind === 'service', terminal: point.isTerminal }, segmentDensityClass(segment)]" :style="{ left: `calc(78px + (100% - 78px) * ${position(point.captureTimeUs) / 100})`, top: `${34 + pointTop()}px` }" :aria-label="`${segment.label} · ${point.markerKind}`" @click.stop="selectHistoricalPoint(segment.id, point.captureTimeUs)" /></template>
    <div v-if="displayPlayhead && isVisible(displayPlayhead)" class="playhead" :class="{ dragging: playheadDrag }" :style="{ left: `calc(78px + (100% - 78px) * ${position(displayPlayhead) / 100})` }"><button data-timeline-interactive type="button" class="playhead-handle" role="slider" aria-label="播放游標" :aria-valuemin="viewBounds?.startUs" :aria-valuemax="viewBounds?.endUs" :aria-valuenow="displayPlayhead" @pointerdown.stop="beginPlayheadDrag" @pointermove.stop="movePlayheadDrag" @pointerup.stop="endPlayheadDrag" @pointercancel.stop="cancelPlayheadDrag"><span /><i /></button><output v-if="playheadDrag">{{ playheadDragLabel() }}</output></div>
    <div v-if="liveEdge && isVisible(liveEdge)" class="live-edge" :style="{ left: `calc(78px + (100% - 78px) * ${position(liveEdge) / 100})` }"><span>LIVE</span></div>
    <button v-if="targetZoom > 1" data-timeline-interactive type="button" class="zoom-readout" title="重設縮放" @click="resetView">{{ targetZoom.toFixed(1) }}×</button>
  </section>
</template>

<style scoped>
.timeline-surface{position:relative;min-height:0;margin:0 12px;overflow:hidden;background:#0c0f12;touch-action:pan-y;user-select:none;color:#edf1f4}.ruler-row{position:absolute;inset:0 0 auto 78px;height:26px;border-bottom:1px solid #353b42}.ruler-tick{position:absolute;top:4px;transform:translateX(-50%);color:#7f8993;font:.58rem "Cascadia Mono",Consolas,monospace;white-space:nowrap}.ruler-tick:first-child{transform:none}.ruler-tick:last-child{transform:translateX(-100%)}.ruler-tick i{position:absolute;left:50%;top:15px;width:1px;height:7px;background:#56616b}.buffer-status{position:absolute;z-index:2;left:78px;right:0;top:27px;height:4px;overflow:hidden;background:#594516}.buffer-status .ready-range,.buffer-status .playback-ready,.buffer-status .gap-range{position:absolute;inset-block:0}.buffer-status .ready-range{background:#24483a}.buffer-status .playback-ready{z-index:2;background:#45d58b;box-shadow:0 0 8px #45d58b}.buffer-status .gap-range{z-index:3;background:#d9a62f}.lane-row{position:absolute;left:0;right:0;border-bottom:1px solid #292f35}.clip-lane{top:34px;bottom:0}.lane-label{position:absolute;inset:0 auto 0 0;width:78px;display:grid;place-items:center start;padding-left:8px;border-right:1px solid #30363d;color:#717b84;font:700 .66rem "Segoe UI Variable Text","Segoe UI",sans-serif;pointer-events:none}.lane-content{position:absolute;inset:0 0 0 78px;overflow:hidden;cursor:default}.timeline-mask{position:absolute;top:8px;height:72px;min-height:0;padding:8px 12px 38px;overflow:hidden;border:1px solid #69737c;border-radius:8px;background:#838e9854;color:#e5eaee;font:700 .72rem/1.25 "Segoe UI Variable Text","Segoe UI",sans-serif;text-align:left;white-space:nowrap}.timeline-mask.draft{pointer-events:auto}.timeline-mask.processing{border-color:#aa7c22;background:#8c651c73;color:#ffe3a1}.timeline-mask.analyzed{border-color:#327fb8;background:#246fa573;color:#c0e3fc}.timeline-mask.mapped{border-color:#318a5e;background:#24744873;color:#bdf1d2}.timeline-mask.historical{z-index:1}.timeline-mask.current{z-index:2;background:#69737c38}.timeline-mask.selected{z-index:3;box-shadow:0 0 0 2px #dceeff,0 0 12px #62a9ff80}.keypoint-dot{position:absolute;z-index:4;top:56px;width:15px;height:15px;min-height:0;padding:0;transform:translate(-50%,-50%);border:2px solid #f4f7fa;border-radius:50%;background:#62a9ff}.keypoint-dot.service{background:#f5b84b}.keypoint-dot.terminal{border-radius:2px;transform:translate(-50%,-50%) rotate(45deg)}.keypoint-dot.editable{cursor:grab}.keypoint-dot.point-dragging{z-index:6;cursor:grabbing}.keypoint-dot.selected{z-index:5;box-shadow:0 0 0 3px #62a9ff55,0 0 12px #62a9ff}.keypoint-dot.soft-locked{z-index:5;border-color:#f3c2ff;box-shadow:0 0 0 4px #cf77e64d,0 0 14px #cf77e6}.keypoint-dot.locked{opacity:.62}.playhead{position:absolute;z-index:8;top:0;bottom:0;width:24px;margin-left:-12px;pointer-events:auto;cursor:col-resize;touch-action:none}.playhead::before{position:absolute;top:0;bottom:0;left:50%;width:2px;transform:translateX(-50%);background:#ff6b72;content:""}.playhead span{position:absolute;left:50%;top:0;width:13px;height:13px;transform:translateX(-50%);background:#ff6b72;clip-path:polygon(0 0,100% 0,50% 100%);filter:drop-shadow(0 1px 3px #000)}.playhead.dragging{cursor:grabbing}.live-edge{position:absolute;z-index:4;top:0;bottom:0;width:1px;background:#49d88a80;pointer-events:none}.live-edge span{display:none}.zoom-readout{position:absolute;right:4px;bottom:2px;z-index:9;min-height:20px;padding:2px 5px;border:1px solid #43515e;border-radius:4px;background:#171c21;color:#9fc7eb;font:700 .56rem "Cascadia Mono",Consolas,monospace;cursor:pointer}.timeline-surface button:focus,.timeline-surface [role="slider"]:focus{outline:none}
.timeline-mask.current.processing{border-color:#aa7c22;background:#8c651c73;color:#ffe3a1}
.timeline-mask.current.analyzed{border-color:#327fb8;background:#246fa573;color:#c0e3fc}
.timeline-mask.current.mapped{border-color:#318a5e;background:#24744873;color:#bdf1d2}
.keypoint-dot.pending{border-style:dashed;opacity:.82}
</style>
<style scoped>
.playhead output{position:absolute;left:50%;bottom:calc(100% + 5px);padding:4px 7px;transform:translateX(-50%);border:1px solid #3f3f46;border-radius:6px;background:#09090b;color:#fafafa;font:700 .6rem "Cascadia Mono",Consolas,monospace;white-space:nowrap}
.historical-point{top:auto}
.ruler-row,.buffer-status{cursor:pointer}.buffer-status{height:7px}.timeline-mask{height:84px;padding:8px 10px 44px}.timeline-mask span,.timeline-mask small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.timeline-mask small{margin-top:3px;color:currentColor;font-size:.58rem;font-weight:600;opacity:.72}.timeline-mask b{position:absolute;right:7px;top:7px;padding:2px 5px;border:1px solid currentColor;border-radius:999px;font-size:.52rem;opacity:.84}.analysis-rail{position:absolute;z-index:3;top:99px;height:20px;display:flex;align-items:center;gap:5px;min-width:44px;padding:0 6px;overflow:hidden;border:1px solid #444b52;border-radius:4px;background:#15191d;color:#aeb8c2;font:650 .54rem "Cascadia Mono",Consolas,monospace;white-space:nowrap;pointer-events:none}.playhead{pointer-events:none}.playhead::before{display:block;pointer-events:none}.playhead-handle{position:absolute;top:0;left:50%;width:20px;height:34px;min-height:0;padding:0;transform:translateX(-50%);border:0;background:transparent;pointer-events:auto;cursor:col-resize;touch-action:none}.playhead-handle>*{pointer-events:none}.playhead-handle i{position:absolute;inset:0 auto auto 50%;width:2px;height:34px;transform:translateX(-50%);background:#ff6b72}.playhead-handle span{top:0}.playhead.dragging .playhead-handle{cursor:grabbing}
.timeline-mask span,.timeline-mask small,.timeline-mask b,.keypoint-dot,.analysis-rail{transition:opacity 140ms cubic-bezier(.2,.8,.2,1)}
.timeline-mask.density-compact small,.timeline-mask.density-compact b{opacity:0;pointer-events:none}
.timeline-mask.density-micro span,.timeline-mask.density-micro small,.timeline-mask.density-micro b{opacity:0;pointer-events:none}
.analysis-rail.density-compact svg:not(:first-child){display:none}
.analysis-rail.density-micro{visibility:hidden;opacity:0}
.keypoint-dot.density-compact:not(.service):not(.terminal):not(.selected){opacity:.22}
.keypoint-dot.density-micro:not(.service):not(.terminal):not(.selected){opacity:0;pointer-events:none}
</style>
