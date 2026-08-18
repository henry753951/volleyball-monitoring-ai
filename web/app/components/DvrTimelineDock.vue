<script setup lang="ts">
import type { AnnotationRallySnapshot, BallEventValue } from '@volleyball-monitoring/contracts'
import { Activity, Bot, CircleDotDashed, Trophy, UserRound } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { CaptureTimeline } from '~/lib/coreDomain'
import type { CapturePlaybackMode } from '~/lib/mediaTimeline'
import {
  DEFAULT_TIMELINE_SCALE,
  MAX_TIMELINE_SCALE,
  MIN_TIMELINE_SCALE,
  timelineBounds,
  timelineScaleForZoom,
  timelineZoomForScale,
  timelineViewForRange,
  timelineViewForScale,
  focusedTimelineView,
  capturePercentBps,
  rulerTicks,
  pointerTarget,
  readyAt,
  gapRanges,
  selectNonOverlappingRanges,
  type TimelineViewport,
} from '~/lib/dvrTimeline'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'
import {
  BALL_EVENT_TONE_COLORS,
  ballEventLabel,
  ballEventTone,
} from '~/utils/annotationBallEventPresentation'

const props = defineProps<{
  timeline: CaptureTimeline | null
  playhead: string | null
  playbackMode?: CapturePlaybackMode | null
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
    outcomeSide?: 'left' | 'right' | null
    outcomeTeamLabel?: string | null
    startCaptureTimeUs: string
    endCaptureTimeUs: string
    reservedByPeer?: boolean
    status: 'draft' | 'idle' | 'failed' | 'processing' | 'analyzed' | 'mapped'
    points?: Array<{
      id: string
      markerKind: string
      isTerminal: boolean
      captureTimeUs: string
      ballEvent?: BallEventValue | null
    }>
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
  bufferedRanges?: Array<{ startCaptureTimeUs: string; endCaptureTimeUs: string }>
  currentMaskStatus?: 'idle' | 'failed' | 'processing' | 'analyzed' | 'mapped'
  currentMaskLabel?: string | null
  currentMaskOutcome?: string | null
  currentMaskOutcomeSide?: 'left' | 'right' | null
  currentMaskOutcomeTeamLabel?: string | null
  maskRange?: { startCaptureTimeUs: string; endCaptureTimeUs: string } | null
  restoredView?: TimelineViewport | null
}>()

const emit = defineEmits<{
  scaleChange: [scale: number]
  viewChange: [viewport: TimelineViewport]
}>()

function outcomeSideBadge(side?: 'left' | 'right' | null) {
  return side === 'left' ? 'L' : side === 'right' ? 'R' : '?'
}
const workstation = useAnnotationWorkstationService()
if (!workstation.timeline || !workstation.annotation.keyPoints)
  throw new Error('Timeline dock requires timeline and key-point workstation services')
const timelineSelection = workstation.timeline
const keyPointEditing = workstation.annotation.keyPoints
const readyBounds = computed(() => timelineBounds(props.timeline?.availableRanges ?? []))
const fullBounds = computed(() => {
  const timeline = props.timeline
  const ready = readyBounds.value
  if (!timeline || !ready) return ready
  const start =
    BigInt(timeline.captureStartTimeUs) < BigInt(ready.startUs)
      ? timeline.captureStartTimeUs
      : ready.startUs
  const candidateEnds = [
    ready.endUs,
    timeline.ingestFrontierCaptureTimeUs,
    timeline.sourceEndCaptureTimeUs,
  ].filter((value): value is string => Boolean(value))
  const end = candidateEnds.reduce(
    (latest, value) => (BigInt(value) > BigInt(latest) ? value : latest),
    ready.endUs,
  )
  return { startUs: start, endUs: end }
})
const timelineOriginUs = computed(
  () => props.timeline?.captureStartTimeUs ?? fullBounds.value?.startUs ?? null,
)
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
const playheadDrag = ref<{
  pointerId: number
  startCaptureTimeUs: string
  targetCaptureTimeUs: string
  committedAtStart: boolean
} | null>(null)
function calculateViewBounds(
  bounds: { startUs: string; endUs: string } | null,
  zoomValue: number,
  panValue: number,
) {
  if (!bounds) return null
  const start = BigInt(bounds.startUs)
  const end = BigInt(bounds.endUs)
  const span = end - start
  if (span <= 1n || zoomValue <= 1) return bounds
  const visibleSpan = BigInt(Math.max(1, Math.round(Number(span) / zoomValue)))
  const availablePan = span - visibleSpan
  const normalizedPan = Math.max(0, Math.min(1, Number.isFinite(panValue) ? panValue : 0))
  const viewStart = start + BigInt(Math.round(Number(availablePan) * normalizedPan))
  return { startUs: viewStart.toString(), endUs: (viewStart + visibleSpan).toString() }
}
const viewBounds = computed(() => calculateViewBounds(fullBounds.value, zoom.value, pan.value))
const targetViewBounds = computed(() =>
  calculateViewBounds(fullBounds.value, targetZoom.value, targetPan.value),
)
const ticks = computed(() => rulerTicks(viewBounds.value, timelineOriginUs.value ?? undefined))
const gaps = computed(() => {
  const values = [
    ...gapRanges(props.timeline?.availableRanges ?? []),
    ...(props.timeline?.gapRanges ?? []),
  ]
  return values.filter(
    (range, index) =>
      values.findIndex(
        candidate => candidate.startUs === range.startUs && candidate.endUs === range.endUs,
      ) === index,
  )
})
const annotationPoints = computed(() => props.annotation?.snapshot.key_points ?? [])
const immutable = computed(() => props.annotation?.snapshot.annotation_status === 'submitted')
const currentMaskTone = computed(() =>
  immutable.value ? (props.currentMaskStatus ?? 'processing') : 'draft',
)
const currentMaskLabel = computed(() => {
  if (props.currentMaskLabel) return props.currentMaskLabel
  if (!immutable.value)
    return props.annotation?.snapshot.active_submission_id ? '修正版草稿' : '標記中'
  return '目前片段'
})
const currentMaskStateLabel = computed(() => {
  const status = props.annotation?.snapshot.annotation_status
  if (status === 'open')
    return props.annotation?.snapshot.active_submission_id ? '修正版草稿' : '標記中'
  if (status === 'ready')
    return props.annotation?.snapshot.active_submission_id ? '修正版草稿 · 待送出' : '待送出'
  return segmentStatusLabel(currentMaskTone.value)
})
const maskStart = computed(
  () => props.maskRange?.startCaptureTimeUs ?? annotationPoints.value[0]?.capture_time_us ?? null,
)
const maskEnd = computed(
  () => props.maskRange?.endCaptureTimeUs ?? annotationPoints.value.at(-1)?.capture_time_us ?? null,
)
const liveEdge = computed(() =>
  props.playbackMode === 'active_live'
    ? (props.timeline?.liveEdgeCaptureTimeUs ??
      props.timeline?.availableRanges.at(-1)?.endUs ??
      null)
    : null,
)
const terminalEdge = computed(() =>
  ['complete_vod', 'ended_live', 'failed'].includes(props.playbackMode ?? '')
    ? (props.timeline?.sourceEndCaptureTimeUs ??
      props.timeline?.availableRanges.at(-1)?.endUs ??
      null)
    : null,
)
const progressiveEdge = computed(() =>
  ['progressive_vod', 'stopping'].includes(props.playbackMode ?? '')
    ? (props.timeline?.ingestFrontierCaptureTimeUs ??
      props.timeline?.availableRanges.at(-1)?.endUs ??
      null)
    : null,
)
const displayPlayhead = computed(
  () =>
    playheadDrag.value?.targetCaptureTimeUs ??
    optimisticPlayhead.value ??
    props.playhead ??
    stablePlayhead.value,
)
const isVisible = (time: string) =>
  Boolean(
    viewBounds.value &&
    BigInt(time) >= BigInt(viewBounds.value.startUs) &&
    BigInt(time) <= BigInt(viewBounds.value.endUs),
  )
const position = (time: string) =>
  viewBounds.value ? capturePercentBps(time, viewBounds.value) / 100 : 0
const remoteEditors = (keyPointId: string) => props.softLocks?.[keyPointId] ?? []
const isPendingPoint = (keyPointId: string) => keyPointId.startsWith('pending:')
const pointPosition = (keyPointId: string, captureTimeUs: string) =>
  position(
    pointDrag.value?.keyPointId === keyPointId
      ? pointDrag.value.targetCaptureTimeUs
      : captureTimeUs,
  )
type SegmentRange = { startCaptureTimeUs: string; endCaptureTimeUs: string }
const clippedSegmentRange = (segment: SegmentRange) => {
  const view = viewBounds.value
  if (!view) return null
  const start =
    BigInt(segment.startCaptureTimeUs) > BigInt(view.startUs)
      ? segment.startCaptureTimeUs
      : view.startUs
  const end =
    BigInt(segment.endCaptureTimeUs) < BigInt(view.endUs) ? segment.endCaptureTimeUs : view.endUs
  return BigInt(end) > BigInt(start) ? { startCaptureTimeUs: start, endCaptureTimeUs: end } : null
}
const segmentVisibleWidth = (segment: SegmentRange) => {
  const clipped = clippedSegmentRange(segment)
  return clipped
    ? Math.max(0, position(clipped.endCaptureTimeUs) - position(clipped.startCaptureTimeUs))
    : 0
}
const segmentVisible = (segment: SegmentRange) => segmentVisibleWidth(segment) > 0
const segmentLeft = (segment: SegmentRange) => {
  const clipped = clippedSegmentRange(segment)
  return clipped ? position(clipped.startCaptureTimeUs) : 0
}
const segmentWidth = (segment: SegmentRange) => Math.max(0.35, segmentVisibleWidth(segment))
const segmentDensityClass = (segment: SegmentRange) => {
  const width = segmentVisibleWidth(segment)
  return width < 5 ? 'density-micro' : width < 12 ? 'density-compact' : ''
}
const readyRails = computed(() =>
  (props.timeline?.availableRanges ?? [])
    .map(range => ({
      id: `${range.startUs}-${range.endUs}`,
      startCaptureTimeUs: range.startUs,
      endCaptureTimeUs: range.endUs,
    }))
    .filter(segmentVisible),
)
const gapRails = computed(() =>
  gaps.value
    .map(range => ({
      id: `${range.startUs}-${range.endUs}`,
      startCaptureTimeUs: range.startUs,
      endCaptureTimeUs: range.endUs,
    }))
    .filter(segmentVisible),
)
const bufferedRails = computed(() =>
  (props.bufferedRanges ?? [])
    .map(range => ({
      id: `${range.startCaptureTimeUs}-${range.endCaptureTimeUs}`,
      ...range,
    }))
    .filter(segmentVisible),
)
const playbackWindowRail = computed(() =>
  props.bufferedWindow && segmentVisible(props.bufferedWindow) ? props.bufferedWindow : null,
)
const serverPendingRail = computed<SegmentRange | null>(() => {
  const readyEnd = props.timeline?.availableRanges.at(-1)?.endUs
  const frontier = props.timeline?.ingestFrontierCaptureTimeUs
  if (!readyEnd || !frontier || BigInt(frontier) <= BigInt(readyEnd)) return null
  return { startCaptureTimeUs: readyEnd, endCaptureTimeUs: frontier }
})
const unavailableSourceRail = computed<SegmentRange | null>(() => {
  const timeline = props.timeline
  if (!timeline?.sourceEndCaptureTimeUs || timeline.availabilityComplete) return null
  const start =
    timeline.ingestFrontierCaptureTimeUs ??
    timeline.availableRanges.at(-1)?.endUs ??
    timeline.captureStartTimeUs
  if (BigInt(timeline.sourceEndCaptureTimeUs) <= BigInt(start)) return null
  return { startCaptureTimeUs: start, endCaptureTimeUs: timeline.sourceEndCaptureTimeUs }
})
const analysisRange = (
  segment: SegmentRange & {
    analysis?: { startCaptureTimeUs: string; endCaptureTimeUs: string } | null
  },
): SegmentRange => ({
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
const segmentStatusLabel = (
  status: 'draft' | 'idle' | 'failed' | 'processing' | 'analyzed' | 'mapped',
) =>
  status === 'draft'
    ? '未送出'
    : status === 'idle'
      ? '待重新分析'
      : status === 'failed'
        ? '處理失敗'
        : status === 'mapped'
          ? '球員已確認'
          : status === 'analyzed'
            ? '分析完成'
            : '分析中'
// A live/correction draft is the active representation of its time range.
// Suppress historical revisions rather than painting multiple masks together.
const displaySegments = computed(() =>
  selectNonOverlappingRanges(
    props.segments ?? [],
    maskStart.value && maskEnd.value
      ? { startCaptureTimeUs: maskStart.value, endCaptureTimeUs: maskEnd.value }
      : null,
    props.selectedSegmentId,
  ),
)
// Analysis coverage is an independent timeline layer. Do not derive it from
// displaySegments: that list intentionally removes the current segment mask to
// avoid painting it twice. The model can omit a predecessor result while a
// correction draft is active, so only segments with an analysis payload render.
const displayAnalysisSegments = computed(() =>
  selectNonOverlappingRanges(
    (props.segments ?? []).filter(segment => Boolean(segment.analysis)),
    null,
    props.selectedSegmentId,
  ).map(segment => ({ segment, range: analysisRange(segment) })),
)
type TimelinePointItem = {
  id: string
  rallyId: string | null
  segmentLabel: string
  markerKind: string
  isTerminal: boolean
  captureTimeUs: string
  ballEvent: BallEventValue | null
  previousBallEvent: BallEventValue | null
  current: boolean
  editable: boolean
  density: string
}
const timelinePointItems = computed<TimelinePointItem[]>(() => {
  const currentRallyId = props.annotation?.rally_id ?? null
  const items: TimelinePointItem[] = []
  const seen = new Set<string>()
  for (const segment of displaySegments.value) {
    if (segment.id === currentRallyId) continue
    const orderedPoints = [...(segment.points ?? [])].sort((left, right) => {
      const difference = BigInt(left.captureTimeUs) - BigInt(right.captureTimeUs)
      return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
    })
    for (const [index, point] of orderedPoints.entries()) {
      if (seen.has(point.id)) continue
      seen.add(point.id)
      items.push({
        id: point.id,
        rallyId: segment.id,
        segmentLabel: segment.label,
        markerKind: point.markerKind,
        isTerminal: point.isTerminal,
        captureTimeUs: point.captureTimeUs,
        ballEvent: point.ballEvent ?? null,
        previousBallEvent: orderedPoints[index - 1]?.ballEvent ?? null,
        current: false,
        editable: false,
        density: segmentDensityClass(segment),
      })
    }
  }
  const orderedCurrentPoints = [...annotationPoints.value].sort((left, right) => {
    const difference = BigInt(left.capture_time_us) - BigInt(right.capture_time_us)
    return difference < 0n
      ? -1
      : difference > 0n
        ? 1
        : left.sequence_index - right.sequence_index ||
          left.key_point_id.localeCompare(right.key_point_id)
  })
  for (const [index, point] of orderedCurrentPoints.entries()) {
    if (seen.has(point.key_point_id)) continue
    seen.add(point.key_point_id)
    items.push({
      id: point.key_point_id,
      rallyId: currentRallyId,
      segmentLabel: currentMaskLabel.value,
      markerKind: point.marker_kind,
      isTerminal: point.is_terminal,
      captureTimeUs: point.capture_time_us,
      ballEvent: point.ball_event ?? null,
      previousBallEvent: orderedCurrentPoints[index - 1]?.ball_event ?? null,
      current: true,
      editable: Boolean(props.editable && !immutable.value && !isPendingPoint(point.key_point_id)),
      density: currentMaskGeometry.value?.density ?? '',
    })
  }
  return items.sort((left, right) => {
    const difference = BigInt(left.captureTimeUs) - BigInt(right.captureTimeUs)
    return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
  })
})
const selectedCurrentPoint = computed(() =>
  timelinePointItems.value.find(point => point.current && point.id === props.selectedKeyPointId),
)
const selectedPointEditorLeft = computed(() => {
  const point = selectedCurrentPoint.value
  if (!point || !isVisible(point.captureTimeUs)) return null
  // Keep the editor anchored to the actual point. The surface allows it to
  // overflow so a point near either edge does not appear to jump and stick to
  // an artificial 14%/86% boundary.
  return pointPosition(point.id, point.captureTimeUs)
})
// Rally clips are guaranteed to be non-overlapping. Keep one generous visual lane
// so the mask label remains readable instead of creating artificial parallel lanes.
const maskTop = () => 8
const pointTop = () => 62
const timelineScale = computed(() =>
  fullBounds.value
    ? timelineScaleForZoom(fullBounds.value, targetZoom.value)
    : DEFAULT_TIMELINE_SCALE,
)
let defaultViewInitialized = false
let defaultViewAnchoredToPlayhead = Boolean(props.playhead)
let initializedCaptureSessionId: string | null = null

function restoredTimelineView(bounds: { startUs: string; endUs: string }) {
  const restored = props.restoredView
  if (
    !restored ||
    restored.captureSessionId !== props.timeline?.captureSessionId ||
    !Number.isFinite(restored.scale) ||
    restored.scale < MIN_TIMELINE_SCALE ||
    restored.scale > MAX_TIMELINE_SCALE
  )
    return null
  try {
    if (BigInt(restored.endCaptureTimeUs) <= BigInt(restored.startCaptureTimeUs)) return null
    return timelineViewForRange(bounds, {
      startUs: restored.startCaptureTimeUs,
      endUs: restored.endCaptureTimeUs,
    })
  } catch {
    return null
  }
}

watch(
  fullBounds,
  (bounds, previousBounds) => {
    if (!bounds) return
    const captureSessionId = props.timeline?.captureSessionId ?? null
    const switchedSource =
      defaultViewInitialized && initializedCaptureSessionId !== captureSessionId
    if (!defaultViewInitialized || switchedSource || !previousBounds) {
      defaultViewInitialized = true
      initializedCaptureSessionId = captureSessionId
      if (switchedSource) {
        stablePlayhead.value = props.playhead
        clearOptimisticPlayhead()
      }
      const restored = restoredTimelineView(bounds)
      if (switchedSource && animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
        animationFrame = null
      }
      const initialAnchor = props.playhead ?? stablePlayhead.value
      defaultViewAnchoredToPlayhead = Boolean(restored || initialAnchor)
      const initial =
        restored ??
        timelineViewForScale(bounds, DEFAULT_TIMELINE_SCALE, initialAnchor ?? bounds.endUs)
      zoom.value = targetZoom.value = initial.zoom
      pan.value = targetPan.value = initial.pan
      return
    }

    // A live capture or progressive download extends fullBounds frequently. Keep
    // both the rendered and animation-target windows fixed to their old absolute
    // capture times so new media appears off-screen instead of stretching or
    // shifting the operator's current view.
    const previousView = calculateViewBounds(previousBounds, zoom.value, pan.value)
    const previousTargetView = calculateViewBounds(
      previousBounds,
      targetZoom.value,
      targetPan.value,
    )
    if (previousView) {
      const preserved = timelineViewForRange(bounds, previousView)
      zoom.value = preserved.zoom
      pan.value = preserved.pan
    }
    if (previousTargetView) {
      const preservedTarget = timelineViewForRange(bounds, previousTargetView)
      targetZoom.value = preservedTarget.zoom
      targetPan.value = preservedTarget.pan
    }
  },
  { immediate: true },
)
watch(timelineScale, value => emit('scaleChange', value), { immediate: true })
watch(
  [targetViewBounds, timelineScale, () => props.timeline?.captureSessionId ?? null],
  ([bounds, scale, captureSessionId]) => {
    // During hydration the computed bounds can invalidate before the
    // initialization watcher has applied a persisted viewport. Do not emit
    // that transient default view back to storage or it will erase the value
    // we are about to restore.
    if (
      !bounds ||
      !captureSessionId ||
      !defaultViewInitialized ||
      initializedCaptureSessionId !== captureSessionId
    )
      return
    emit('viewChange', {
      captureSessionId,
      startCaptureTimeUs: bounds.startUs,
      endCaptureTimeUs: bounds.endUs,
      scale,
    })
  },
  { immediate: true },
)

watch(
  () => props.playhead,
  value => {
    if (!value) return
    stablePlayhead.value = value
    if (optimisticPlayhead.value && absDiff(value, optimisticPlayhead.value) <= 100_000n)
      clearOptimisticPlayhead()
    const bounds = fullBounds.value
    const view = viewBounds.value
    if (
      bounds &&
      defaultViewInitialized &&
      !defaultViewAnchoredToPlayhead &&
      Date.now() >= manualViewUntil
    ) {
      defaultViewAnchoredToPlayhead = true
      const initial = timelineViewForScale(bounds, DEFAULT_TIMELINE_SCALE, value)
      targetZoom.value = initial.zoom
      targetPan.value = initial.pan
      animateView()
      return
    }
    if (
      !bounds ||
      !view ||
      targetZoom.value <= 1 ||
      Date.now() < manualViewUntil ||
      optimisticPlayhead.value ||
      playheadDrag.value
    )
      return
    const target = BigInt(value)
    if (target >= BigInt(view.startUs) && target <= BigInt(view.endUs)) return
    const fullStart = BigInt(bounds.startUs)
    const fullSpan = BigInt(bounds.endUs) - fullStart
    const viewSpan = BigInt(view.endUs) - BigInt(view.startUs)
    const availablePan = fullSpan - viewSpan
    if (availablePan <= 0n) return
    const desiredStart = target - viewSpan / 2n - fullStart
    const clamped =
      desiredStart < 0n ? 0n : desiredStart > availablePan ? availablePan : desiredStart
    targetPan.value = Number((clamped * 1_000_000n) / availablePan) / 1_000_000
    animateView()
  },
)
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
  optimisticPlayhead.value = target
  if (optimisticPlayheadTimer) clearTimeout(optimisticPlayheadTimer)
  optimisticPlayheadTimer = setTimeout(clearOptimisticPlayhead, 12_000)
  void Promise.resolve(workstation.playback.seek(target)).catch(clearOptimisticPlayhead)
}
function animateView() {
  if (animationFrame !== null) return
  const reduceMotion =
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion) {
    zoom.value = targetZoom.value
    pan.value = targetPan.value
    return
  }
  const tick = () => {
    zoom.value += (targetZoom.value - zoom.value) * 0.16
    pan.value += (targetPan.value - pan.value) * 0.16
    if (
      Math.abs(targetZoom.value - zoom.value) < 0.001 &&
      Math.abs(targetPan.value - pan.value) < 0.000001
    ) {
      zoom.value = targetZoom.value
      pan.value = targetPan.value
      animationFrame = null
      return
    }
    animationFrame = requestAnimationFrame(tick)
  }
  animationFrame = requestAnimationFrame(tick)
}
function resetView() {
  const bounds = fullBounds.value
  if (!bounds) return
  const initial = timelineViewForScale(
    bounds,
    DEFAULT_TIMELINE_SCALE,
    displayPlayhead.value ?? bounds.endUs,
  )
  targetZoom.value = initial.zoom
  targetPan.value = initial.pan
  defaultViewAnchoredToPlayhead = true
  manualViewUntil = Date.now() + 3_000
  animateView()
}
function wheel(event: WheelEvent) {
  defaultViewAnchoredToPlayhead = true
  manualViewUntil = Date.now() + 3_000
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? 240
        : 1
  const normalizedDelta = Math.max(-120, Math.min(120, delta * unit))
  if (event.shiftKey) {
    const bounds = fullBounds.value
    const currentView = targetViewBounds.value
    if (!bounds || !currentView) return
    const laneLeft = 78
    const surface = event.currentTarget as HTMLElement
    const laneWidth = Math.max(1, surface.clientWidth - laneLeft)
    let anchor = Math.max(
      0,
      Math.min(1, (event.clientX - surface.getBoundingClientRect().left - laneLeft) / laneWidth),
    )
    const nextScale = Math.max(
      MIN_TIMELINE_SCALE,
      Math.min(MAX_TIMELINE_SCALE, timelineScale.value * Math.exp(-normalizedDelta * 0.0007)),
    )
    const nextZoom = timelineZoomForScale(bounds, nextScale)
    const fullStart = BigInt(bounds.startUs)
    const fullEnd = BigInt(bounds.endUs)
    const fullSpan = fullEnd - fullStart
    const currentStart = BigInt(currentView.startUs)
    const currentSpan = BigInt(currentView.endUs) - currentStart
    const playhead = displayPlayhead.value ? BigInt(displayPlayhead.value) : null
    if (playhead !== null && playhead >= currentStart && playhead <= BigInt(currentView.endUs)) {
      anchor = Number(((playhead - currentStart) * 1_000_000n) / currentSpan) / 1_000_000
    }
    const anchorCapture =
      playhead !== null && playhead >= currentStart && playhead <= BigInt(currentView.endUs)
        ? playhead
        : currentStart + (currentSpan * BigInt(Math.round(anchor * 1_000_000))) / 1_000_000n
    const calculatedSpan = (fullSpan / BigInt(Math.max(1, Math.round(nextZoom * 100)))) * 100n
    const nextVisibleSpan = calculatedSpan > 0n ? calculatedSpan : 1n
    const availablePan = fullSpan - nextVisibleSpan
    const desiredStart =
      anchorCapture -
      (nextVisibleSpan * BigInt(Math.round(anchor * 1_000_000))) / 1_000_000n -
      fullStart
    const clampedStart =
      desiredStart < 0n ? 0n : desiredStart > availablePan ? availablePan : desiredStart
    targetZoom.value = nextZoom
    targetPan.value =
      availablePan > 0n ? Number((clampedStart * 1_000_000n) / availablePan) / 1_000_000 : 0
  } else if (targetZoom.value > 1.001) {
    const surface = event.currentTarget as HTMLElement
    const laneWidth = Math.max(1, surface.clientWidth - 78)
    const screenShift = (normalizedDelta / laneWidth) * 0.32
    const panShift = screenShift / Math.max(0.25, targetZoom.value - 1)
    targetPan.value = Math.max(0, Math.min(1, targetPan.value + panShift))
  }
  animateView()
}
function beginPlayheadDrag(event: PointerEvent) {
  const value = displayPlayhead.value
  if (!value) return
  playheadDrag.value = {
    pointerId: event.pointerId,
    startCaptureTimeUs: value,
    targetCaptureTimeUs: value,
    committedAtStart: false,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function movePlayheadDrag(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId || !viewBounds.value || !props.timeline) return
  const root = (event.currentTarget as HTMLElement).closest(
    '.timeline-surface',
  ) as HTMLElement | null
  const lane = root?.querySelector<HTMLElement>('.lane-content')
  if (!lane) return
  const target = pointerTarget(event.clientX, lane.getBoundingClientRect(), viewBounds.value)
  if (readyAt(target, props.timeline.availableRanges)) {
    drag.targetCaptureTimeUs = target
    workstation.playback.previewSeek(target)
  }
}
function endPlayheadDrag(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  const element = event.currentTarget as HTMLElement
  if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
  optimisticPlayhead.value = drag.targetCaptureTimeUs
  playheadDrag.value = null
  workstation.playback.previewSeek(null)
  if (!drag.committedAtStart || drag.targetCaptureTimeUs !== drag.startCaptureTimeUs)
    requestSeek(drag.targetCaptureTimeUs)
}
function cancelPlayheadDrag(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  playheadDrag.value = null
  workstation.playback.previewSeek(null)
}
function playheadDragLabel() {
  const target = playheadDrag.value?.targetCaptureTimeUs
  const origin = timelineOriginUs.value
  if (!target || !origin) return ''
  const milliseconds = Number((BigInt(target) - BigInt(origin)) / 1_000n)
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  const seconds = Math.max(0, Math.floor((milliseconds % 60_000) / 1_000))
  const ms = Math.max(0, milliseconds % 1_000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}
function beginTimelineScrub(event: PointerEvent) {
  defaultViewAnchoredToPlayhead = true
  if (!viewBounds.value || !props.timeline) return
  const target = pointerTarget(
    event.clientX,
    (event.currentTarget as HTMLElement).getBoundingClientRect(),
    viewBounds.value,
  )
  if (!readyAt(target, props.timeline.availableRanges)) return
  // Keep pointer movement entirely client-side. One canonical seek is emitted
  // only when the gesture commits on pointerup.
  optimisticPlayhead.value = target
  workstation.playback.previewSeek(target)
  playheadDrag.value = {
    pointerId: event.pointerId,
    startCaptureTimeUs: target,
    targetCaptureTimeUs: target,
    committedAtStart: false,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function moveTimelineScrub(event: PointerEvent) {
  const drag = playheadDrag.value
  if (!drag || drag.pointerId !== event.pointerId || !viewBounds.value || !props.timeline) return
  const target = pointerTarget(
    event.clientX,
    (event.currentTarget as HTMLElement).getBoundingClientRect(),
    viewBounds.value,
  )
  if (!readyAt(target, props.timeline.availableRanges)) return
  drag.targetCaptureTimeUs = target
  workstation.playback.previewSeek(target)
}
function selectPoint(keyPointId: string, captureTimeUs: string) {
  timelineSelection.selectKeyPoint(keyPointId)
  if (props.timeline && readyAt(captureTimeUs, props.timeline.availableRanges))
    requestSeek(captureTimeUs)
}
async function selectHistoricalPoint(segmentId: string, keyPointId: string, captureTimeUs: string) {
  await timelineSelection.selectHistorical(segmentId, captureTimeUs)
  timelineSelection.selectKeyPoint(keyPointId, segmentId)
  if (props.timeline && readyAt(captureTimeUs, props.timeline.availableRanges))
    requestSeek(captureTimeUs)
}
function focusRange(
  startCaptureTimeUs: string,
  endCaptureTimeUs: string,
  seekTarget: string | null = startCaptureTimeUs,
) {
  const bounds = fullBounds.value
  if (!bounds) return
  defaultViewAnchoredToPlayhead = true
  manualViewUntil = Date.now() + 3_000
  const focused = focusedTimelineView(bounds, { startCaptureTimeUs, endCaptureTimeUs })
  targetZoom.value = focused.zoom
  targetPan.value = focused.pan
  animateView()
  if (seekTarget) requestSeek(seekTarget)
}
function focusHistoricalSegment(segment: {
  id: string
  startCaptureTimeUs: string
  endCaptureTimeUs: string
}) {
  focusRange(segment.startCaptureTimeUs, segment.endCaptureTimeUs)
}
function focusCurrentMask() {
  if (!maskStart.value || !maskEnd.value) return
  timelineSelection.selectMask()
  focusRange(maskStart.value, maskEnd.value)
}

function focusDenseCurrentMaskForEditing() {
  if (currentMaskGeometry.value?.density !== 'density-micro' || !maskStart.value || !maskEnd.value)
    return
  // At the full-match scale several contacts can occupy the same physical
  // pixels. Expand only the viewport; preserving the playhead is important so
  // selecting a draft never looks like a seek to an earlier rally.
  focusRange(maskStart.value, maskEnd.value, null)
}

function selectCurrentMask() {
  timelineSelection.selectMask()
  focusDenseCurrentMaskForEditing()
}

watch(
  () => props.selectedKeyPointId,
  selectedKeyPointId => {
    if (!selectedKeyPointId || selectedCurrentPoint.value?.id !== selectedKeyPointId) return
    focusDenseCurrentMaskForEditing()
  },
  { flush: 'post' },
)
function beginPointDrag(event: PointerEvent, keyPointId: string, captureTimeUs: string) {
  if (!props.editable || immutable.value) return
  pointDrag.value = {
    keyPointId,
    pointerId: event.pointerId,
    startX: event.clientX,
    targetCaptureTimeUs: captureTimeUs,
    moved: false,
    announced: false,
  }
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
    keyPointEditing.begin(drag.keyPointId)
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
  if (
    typeof element.releasePointerCapture === 'function' &&
    element.hasPointerCapture?.(event.pointerId)
  )
    element.releasePointerCapture(event.pointerId)
  pointDrag.value = null
  if (!drag.moved || !drag.announced) return
  suppressPointClick.value = drag.keyPointId
  void keyPointEditing.move(drag.keyPointId, drag.targetCaptureTimeUs)
}
function cancelPointDrag(event: PointerEvent) {
  const drag = pointDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  pointDrag.value = null
  if (drag.announced) keyPointEditing.cancel(drag.keyPointId)
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
defineExpose({ focusRange, resetView })
</script>

<template>
  <section class="timeline-surface" aria-label="影音時間軸" @wheel.prevent="wheel">
    <div
      class="ruler-row"
      role="slider"
      aria-label="時間軸跳轉"
      :aria-valuemin="viewBounds?.startUs ?? '0'"
      :aria-valuemax="viewBounds?.endUs ?? '0'"
      :aria-valuenow="displayPlayhead ?? viewBounds?.startUs ?? '0'"
      @pointerdown.left="beginTimelineScrub"
      @pointermove="moveTimelineScrub"
      @pointerup="endPlayheadDrag"
      @pointercancel="cancelPlayheadDrag"
    >
      <span
        v-for="(tick, index) in ticks"
        :key="`${tick.value}-${index}`"
        class="ruler-tick"
        :style="{ left: `${tick.percentBps / 100}%` }"
        :title="tick.value"
        >{{ tick.label }}<i
      /></span>
    </div>
    <div
      class="buffer-status"
      role="slider"
      aria-label="影片定位"
      :aria-valuemin="viewBounds?.startUs ?? '0'"
      :aria-valuemax="viewBounds?.endUs ?? '0'"
      :aria-valuenow="displayPlayhead ?? viewBounds?.startUs ?? '0'"
      @pointerdown.left="beginTimelineScrub"
      @pointermove="moveTimelineScrub"
      @pointerup="endPlayheadDrag"
      @pointercancel="cancelPlayheadDrag"
    >
      <i
        v-if="unavailableSourceRail"
        v-show="segmentVisible(unavailableSourceRail)"
        class="source-unavailable"
        :style="{
          left: `${segmentLeft(unavailableSourceRail)}%`,
          width: `${segmentWidth(unavailableSourceRail)}%`,
        }"
        title="來源尚未下載"
      />
      <i
        v-if="serverPendingRail"
        v-show="segmentVisible(serverPendingRail)"
        class="server-pending"
        :style="{
          left: `${segmentLeft(serverPendingRail)}%`,
          width: `${segmentWidth(serverPendingRail)}%`,
        }"
        title="伺服器正在建立索引"
      />
      <i
        v-for="range in readyRails"
        :key="range.id"
        class="ready-range"
        :style="{ left: `${segmentLeft(range)}%`, width: `${segmentWidth(range)}%` }"
        title="伺服器可用"
      />
      <i
        v-if="playbackWindowRail"
        class="playback-window"
        :style="{
          left: `${segmentLeft(playbackWindowRail)}%`,
          width: `${segmentWidth(playbackWindowRail)}%`,
        }"
        title="目前播放視窗"
      />
      <i
        v-for="range in bufferedRails"
        :key="`buffered-${range.id}`"
        class="playback-ready"
        :style="{ left: `${segmentLeft(range)}%`, width: `${segmentWidth(range)}%` }"
        title="瀏覽器已載入"
      />
      <i
        v-for="gap in gapRails"
        :key="gap.id"
        class="gap-range"
        :style="{ left: `${segmentLeft(gap)}%`, width: `${segmentWidth(gap)}%` }"
        title="媒體中斷"
      />
    </div>
    <div class="lane-row clip-lane">
      <span class="lane-label">片段</span>
      <div class="lane-content" @click="timelineSelection.clear()">
        <button
          v-for="segment in displaySegments"
          v-show="segmentVisible(segment)"
          :key="segment.id"
          data-timeline-interactive
          type="button"
          class="timeline-mask historical"
          :class="[
            segment.status,
            segmentDensityClass(segment),
            {
              'peer-reservation': segment.reservedByPeer,
              selected: selectedSegmentId === segment.id,
            },
          ]"
          :style="{
            left: `${segmentLeft(segment)}%`,
            top: `${maskTop()}px`,
            width: `${segmentWidth(segment)}%`,
          }"
          :aria-label="`${segment.label} · ${segment.outcomeLabel ? `${segment.outcomeLabel} · ` : ''}${segment.stateLabel || segmentStatusLabel(segment.status)}`"
          :aria-pressed="selectedSegmentId === segment.id"
          @click.stop="timelineSelection.selectHistorical(segment.id, segment.startCaptureTimeUs)"
          @dblclick.stop="focusHistoricalSegment(segment)"
        >
          <span>{{ segment.label }}</span
          ><strong
            v-if="segment.outcomeLabel"
            class="mask-outcome"
            :class="{ unknown: !segment.outcomeSide }"
            :aria-label="segment.outcomeLabel"
            ><Trophy :size="15" :stroke-width="2.3" aria-hidden="true" /><span
              class="outcome-team"
              >{{ segment.outcomeTeamLabel ?? '未知' }}</span
            ><span
              class="outcome-side"
              :class="segment.outcomeSide ?? 'unknown'"
              aria-hidden="true"
              >{{ outcomeSideBadge(segment.outcomeSide) }}</span
            ></strong
          >
          <small>{{ segment.stateLabel || segmentStatusLabel(segment.status) }}</small>
        </button>
        <button
          v-if="currentMaskGeometry"
          v-show="currentMaskGeometry.visible"
          data-timeline-interactive
          type="button"
          class="timeline-mask current"
          :class="[currentMaskTone, currentMaskGeometry.density, { selected: maskSelected }]"
          :style="{
            left: `${currentMaskGeometry.left}%`,
            top: `${maskTop()}px`,
            width: `${currentMaskGeometry.width}%`,
          }"
          :aria-label="`${currentMaskLabel} · ${currentMaskOutcome ? `${currentMaskOutcome} · ` : ''}${currentMaskStateLabel}`"
          :aria-pressed="maskSelected"
          @click.stop="selectCurrentMask"
          @dblclick.stop="focusCurrentMask"
        >
          <span>{{ currentMaskLabel }}</span
          ><strong
            v-if="currentMaskOutcome"
            class="mask-outcome"
            :class="{ unknown: !currentMaskOutcomeSide }"
            :aria-label="currentMaskOutcome"
            ><Trophy :size="15" :stroke-width="2.3" aria-hidden="true" /><span
              class="outcome-team"
              >{{ currentMaskOutcomeTeamLabel ?? '未知' }}</span
            ><span
              class="outcome-side"
              :class="currentMaskOutcomeSide ?? 'unknown'"
              aria-hidden="true"
              >{{ outcomeSideBadge(currentMaskOutcomeSide) }}</span
            ></strong
          >
          <small>{{ currentMaskStateLabel }}</small>
        </button>
        <button
          v-for="item in displayAnalysisSegments"
          v-show="segmentVisible(item.range)"
          :key="`${item.segment.id}:analysis`"
          data-timeline-interactive
          type="button"
          class="analysis-rail"
          :class="segmentDensityClass(item.range)"
          :style="{ left: `${segmentLeft(item.range)}%`, width: `${segmentWidth(item.range)}%` }"
          :aria-label="`${item.segment.label} · 開啟分析結果 · ${formatBytes(item.segment.analysis?.byteLength ?? '0')}`"
          @click.stop="timelineSelection.selectAnalysis(item.segment.id)"
        >
          <Bot :size="11" /><span>{{ formatBytes(item.segment.analysis?.byteLength ?? '0') }}</span
          ><UserRound
            v-if="item.segment.analysis?.capabilities.includes('player_tracking')"
            :size="11"
          /><CircleDotDashed
            v-if="item.segment.analysis?.capabilities.includes('ball_tracking')"
            :size="11"
          /><Activity
            v-if="item.segment.analysis?.capabilities.includes('contact_association')"
            :size="11"
          />
        </button>
        <button
          v-for="point in timelinePointItems"
          v-show="isVisible(point.captureTimeUs)"
          :key="`${point.rallyId ?? 'current'}:${point.id}`"
          data-timeline-interactive
          type="button"
          class="keypoint-dot"
          :class="[
            `tone-${ballEventTone(point.ballEvent, { isTerminal: point.isTerminal, markerKind: point.markerKind })}`,
            {
              terminal: point.isTerminal,
              pending: isPendingPoint(point.id),
              locked: !point.editable,
              editable: point.editable,
              selected: selectedKeyPointId === point.id,
              'soft-locked': remoteEditors(point.id).length,
              'point-dragging': pointDrag?.keyPointId === point.id,
            },
            point.density,
          ]"
          :style="{
            '--point-color':
              BALL_EVENT_TONE_COLORS[
                ballEventTone(point.ballEvent, {
                  isTerminal: point.isTerminal,
                  markerKind: point.markerKind,
                })
              ],
            left: `${pointPosition(point.id, point.captureTimeUs)}%`,
            top: `${pointTop()}px`,
          }"
          :aria-label="`${point.segmentLabel} · ${ballEventLabel(point.ballEvent, { isTerminal: point.isTerminal, markerKind: point.markerKind, previousEvent: point.previousBallEvent })}${isPendingPoint(point.id) ? ' · 等待同步' : ''}${remoteEditors(point.id).length ? ` · ${remoteEditors(point.id).join('、')} 正在調整` : ''}`"
          :aria-pressed="selectedKeyPointId === point.id"
          :title="
            isPendingPoint(point.id)
              ? `${ballEventLabel(point.ballEvent, { isTerminal: point.isTerminal, markerKind: point.markerKind, previousEvent: point.previousBallEvent })} · 本機已標記，等待伺服器確認`
              : `${ballEventLabel(point.ballEvent, { isTerminal: point.isTerminal, markerKind: point.markerKind, previousEvent: point.previousBallEvent })}${point.editable ? ' · 拖曳移動' : ''}${remoteEditors(point.id).length ? ` · ${remoteEditors(point.id).join('、')} 正在調整（提示，不阻擋）` : ''}`
          "
          @pointerdown.stop="point.current && beginPointDrag($event, point.id, point.captureTimeUs)"
          @pointermove.stop="movePointDrag"
          @pointerup.stop="endPointDrag"
          @pointercancel.stop="cancelPointDrag"
          @click.stop="
            point.current
              ? clickPoint(point.id, point.captureTimeUs)
              : selectHistoricalPoint(point.rallyId!, point.id, point.captureTimeUs)
          "
        />
        <div
          v-if="selectedPointEditorLeft !== null"
          class="selected-point-editor-anchor"
          :style="{ left: `${selectedPointEditorLeft}%` }"
          @click.stop
          @pointerdown.stop
        >
          <slot name="selected-point-editor" />
        </div>
      </div>
    </div>
    <div
      v-if="displayPlayhead && isVisible(displayPlayhead)"
      class="playhead"
      :class="{ dragging: playheadDrag }"
      :style="{ left: `calc(78px + (100% - 78px) * ${position(displayPlayhead) / 100})` }"
    >
      <button
        data-timeline-interactive
        type="button"
        class="playhead-handle"
        aria-label="拖曳播放游標"
        @pointerdown.stop="beginPlayheadDrag"
        @pointermove.stop="movePlayheadDrag"
        @pointerup.stop="endPlayheadDrag"
        @pointercancel.stop="cancelPlayheadDrag"
      >
        <span /><i /></button
      ><output v-if="playheadDrag">{{ playheadDragLabel() }}</output>
    </div>
    <div
      v-if="liveEdge && isVisible(liveEdge)"
      class="live-edge"
      :style="{ left: `calc(78px + (100% - 78px) * ${position(liveEdge) / 100})` }"
    >
      <span>LIVE</span>
    </div>
    <div
      v-else-if="terminalEdge && isVisible(terminalEdge)"
      class="source-edge terminal"
      :style="{ left: `calc(78px + (100% - 78px) * ${position(terminalEdge) / 100})` }"
    >
      <span>END</span>
    </div>
    <div
      v-else-if="progressiveEdge && isVisible(progressiveEdge)"
      class="source-edge progressive"
      :style="{ left: `calc(78px + (100% - 78px) * ${position(progressiveEdge) / 100})` }"
    >
      <span>載入中</span>
    </div>
  </section>
</template>

<style scoped>
.timeline-surface {
  position: relative;
  min-height: 0;
  margin: 0 12px;
  overflow: visible;
  background: #0c0f12;
  touch-action: pan-y;
  user-select: none;
  color: #edf1f4;
}
.ruler-row {
  position: absolute;
  inset: 0 0 auto 78px;
  height: 26px;
  border-bottom: 1px solid #353b42;
  cursor: col-resize;
  touch-action: none;
}
.ruler-tick {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  color: #7f8993;
  font:
    0.58rem 'Cascadia Mono',
    Consolas,
    monospace;
  white-space: nowrap;
  pointer-events: none;
}
.ruler-tick:first-child {
  transform: none;
}
.ruler-tick:last-child {
  transform: translateX(-100%);
}
.ruler-tick i {
  position: absolute;
  left: 50%;
  top: 15px;
  width: 1px;
  height: 7px;
  background: #56616b;
}
.buffer-status {
  position: absolute;
  z-index: 2;
  left: 78px;
  right: 0;
  top: 27px;
  height: 4px;
  overflow: hidden;
  background: #191c20;
  touch-action: none;
}
.buffer-status .ready-range,
.buffer-status .playback-window,
.buffer-status .playback-ready,
.buffer-status .gap-range,
.buffer-status .server-pending,
.buffer-status .source-unavailable {
  position: absolute;
  inset-block: 0;
}
.buffer-status .source-unavailable {
  z-index: 0;
  background: repeating-linear-gradient(135deg, #191c20 0 4px, #23272c 4px 7px);
}
.buffer-status .server-pending {
  z-index: 1;
  background: #9a7228;
}
.buffer-status .ready-range {
  z-index: 2;
  background: #2b3534;
}
.buffer-status .playback-ready {
  z-index: 3;
  background: #45d58b;
  box-shadow: 0 0 5px #45d58b66;
}
.buffer-status .playback-window {
  z-index: 4;
  border: 1px solid #647b8d;
  background: transparent;
}
.buffer-status .gap-range {
  z-index: 5;
  background: repeating-linear-gradient(135deg, #292d32 0 3px, #111316 3px 6px);
}
.lane-row {
  position: absolute;
  left: 0;
  right: 0;
  border-bottom: 1px solid #292f35;
}
.clip-lane {
  top: 34px;
  bottom: 0;
}
.lane-label {
  position: absolute;
  inset: 0 auto 0 0;
  width: 78px;
  display: grid;
  place-items: center start;
  padding-left: 8px;
  border-right: 1px solid #30363d;
  color: #717b84;
  font:
    700 0.66rem 'Segoe UI Variable Text',
    'Segoe UI',
    sans-serif;
  pointer-events: none;
}
.lane-content {
  position: absolute;
  inset: 0 0 0 78px;
  overflow: visible;
  cursor: default;
}
.timeline-mask {
  box-sizing: border-box;
  position: absolute;
  top: 8px;
  height: 72px;
  min-width: 0;
  min-height: 0;
  padding: 8px 12px 38px;
  overflow: hidden;
  border: 1px solid #69737c;
  border-radius: 8px;
  background: #838e9854;
  color: #e5eaee;
  font:
    700 0.72rem/1.25 'Segoe UI Variable Text',
    'Segoe UI',
    sans-serif;
  text-align: left;
  white-space: nowrap;
}
.timeline-mask.draft {
  pointer-events: auto;
}
.timeline-mask.peer-reservation {
  border-style: dashed;
}
.timeline-mask.processing {
  border-color: #aa7c22;
  background: #8c651c73;
  color: #ffe3a1;
}
.timeline-mask.analyzed {
  border-color: #327fb8;
  background: #246fa573;
  color: #c0e3fc;
}
.timeline-mask.mapped {
  border-color: #318a5e;
  background: #24744873;
  color: #bdf1d2;
}
.timeline-mask.historical {
  z-index: 1;
}
.timeline-mask.current {
  z-index: 2;
  background: #69737c38;
}
.timeline-mask.selected {
  z-index: 3;
  box-shadow:
    0 0 0 2px #dceeff,
    0 0 12px #62a9ff80;
}
.keypoint-dot {
  position: absolute;
  z-index: 4;
  top: 56px;
  width: 15px;
  height: 15px;
  min-height: 0;
  padding: 0;
  transform: translate(-50%, -50%);
  border: 2px solid #f4f7fa;
  border-radius: 50%;
  background: var(--point-color, #62a9ff);
  box-shadow: 0 0 7px color-mix(in srgb, var(--point-color, #62a9ff) 48%, transparent);
}
.keypoint-dot.terminal {
  border-radius: 2px;
  transform: translate(-50%, -50%) rotate(45deg);
}
.keypoint-dot.editable {
  cursor: grab;
}
.keypoint-dot.point-dragging {
  z-index: 6;
  cursor: grabbing;
}
.keypoint-dot.selected {
  z-index: 5;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--point-color, #62a9ff) 35%, transparent),
    0 0 12px var(--point-color, #62a9ff);
}
.keypoint-dot.soft-locked {
  z-index: 5;
  border-color: #f3c2ff;
  box-shadow:
    0 0 0 4px #cf77e64d,
    0 0 14px #cf77e6;
}
.keypoint-dot.locked {
  opacity: 0.62;
}
.playhead {
  position: absolute;
  z-index: 8;
  top: 0;
  bottom: 0;
  width: 24px;
  margin-left: -12px;
  pointer-events: auto;
  cursor: col-resize;
  touch-action: none;
}
.playhead::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: #ff6b72;
  content: '';
}
.playhead span {
  position: absolute;
  left: 50%;
  top: 0;
  width: 13px;
  height: 13px;
  transform: translateX(-50%);
  background: #ff6b72;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  filter: drop-shadow(0 1px 3px #000);
}
.playhead.dragging {
  cursor: grabbing;
}
.live-edge,
.source-edge {
  position: absolute;
  z-index: 7;
  top: 0;
  bottom: 0;
  width: 1px;
  pointer-events: none;
}
.live-edge {
  background: #6d947d;
}
.source-edge {
  background: #71717a;
}
.source-edge.progressive {
  background: #a47c35;
}
.live-edge span,
.source-edge span {
  position: absolute;
  top: 2px;
  right: 4px;
  padding: 2px 4px;
  border-radius: 4px;
  background: #181a1e;
  color: #c9d0d6;
  font:
    800 0.5rem 'Cascadia Mono',
    Consolas,
    monospace;
  white-space: nowrap;
}
.source-edge.progressive span {
  color: #d7b873;
}
.timeline-surface button:focus,
.timeline-surface [role='slider']:focus {
  outline: none;
}
.timeline-mask.idle,
.timeline-mask.current.idle {
  border-color: #69737c;
  background: #838e9854;
  color: #e5eaee;
}
.timeline-mask.current.processing {
  border-color: #aa7c22;
  background: #8c651c73;
  color: #ffe3a1;
}
.timeline-mask.failed,
.timeline-mask.current.failed {
  border-color: #b94d56;
  background: #7e303873;
  color: #ffd0d4;
}
.timeline-mask.current.analyzed {
  border-color: #327fb8;
  background: #246fa573;
  color: #c0e3fc;
}
.timeline-mask.current.mapped {
  border-color: #318a5e;
  background: #24744873;
  color: #bdf1d2;
}
.keypoint-dot.pending {
  border-style: dashed;
  opacity: 0.82;
}
</style>
<style scoped>
.playhead output {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 5px);
  padding: 4px 7px;
  transform: translateX(-50%);
  border: 1px solid #3f3f46;
  border-radius: 6px;
  background: #09090b;
  color: #fafafa;
  font:
    700 0.6rem 'Cascadia Mono',
    Consolas,
    monospace;
  white-space: nowrap;
}
.buffer-status {
  height: 7px;
  cursor: col-resize;
}
.timeline-mask {
  height: 84px;
  padding: 8px 10px 44px;
}
.timeline-mask > span,
.timeline-mask small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-mask small {
  position: absolute;
  right: 7px;
  bottom: 6px;
  max-width: 38%;
  color: currentColor;
  font-size: 0.55rem;
  font-weight: 650;
  opacity: 0.76;
}
.mask-outcome {
  position: absolute;
  left: 8px;
  bottom: 6px;
  max-width: 58%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  color: #f4f7fa;
  font-size: 0.58rem;
  font-weight: 750;
  white-space: nowrap;
}
.mask-outcome > svg {
  width: 15px;
  height: 15px;
  flex: none;
  color: #f4c95d;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 60%));
}
.outcome-side {
  width: 13px;
  height: 13px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 3px;
  background: rgb(8 11 14 / 48%);
  color: #e6eaf0;
  font-size: 0.42rem;
  font-weight: 800;
  line-height: 1;
}
.outcome-side.left {
  border-color: #63b3ff66;
  background: rgb(21 52 78 / 72%);
  color: #dceeff;
}
.outcome-side.right {
  border-color: #a78bfa66;
  background: rgb(48 38 75 / 72%);
  color: #eee6ff;
}
.outcome-team {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.58rem;
  font-weight: 750;
  letter-spacing: 0.01em;
}
.mask-outcome.unknown {
  color: #d4d9de;
}
.mask-outcome.unknown > svg {
  color: #aeb6bf;
}
.outcome-side.unknown {
  border-style: dashed;
  color: #c5ccd3;
}
.analysis-rail {
  box-sizing: border-box;
  position: absolute;
  z-index: 3;
  top: 150px;
  height: 20px;
  min-width: 0;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px;
  overflow: hidden;
  border: 1px solid #444b52;
  border-radius: 4px;
  background: #15191d;
  color: #aeb8c2;
  font:
    650 0.54rem 'Cascadia Mono',
    Consolas,
    monospace;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.selected-point-editor-anchor {
  position: absolute;
  z-index: 20;
  top: 100px;
  transform: translateX(-50%);
  pointer-events: auto;
}
.analysis-rail:hover {
  border-color: #71808d;
  background: #1c2228;
  color: #e2e8ed;
}
.analysis-rail:focus-visible {
  outline: 2px solid #9bd0f6;
  outline-offset: 1px;
}
.playhead {
  pointer-events: none;
}
.playhead::before {
  display: block;
  pointer-events: none;
}
.playhead-handle {
  position: absolute;
  top: 0;
  left: 50%;
  width: 20px;
  height: 34px;
  min-height: 0;
  padding: 0;
  transform: translateX(-50%);
  border: 0;
  background: transparent;
  pointer-events: auto;
  cursor: col-resize;
  touch-action: none;
}
.playhead-handle > * {
  pointer-events: none;
}
.playhead-handle i {
  position: absolute;
  inset: 0 auto auto 50%;
  width: 2px;
  height: 34px;
  transform: translateX(-50%);
  background: #ff6b72;
}
.playhead-handle span {
  top: 0;
}
.playhead.dragging .playhead-handle {
  cursor: grabbing;
}
.timeline-mask span,
.timeline-mask small,
.mask-outcome,
.keypoint-dot,
.analysis-rail {
  transition: opacity 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.timeline-mask.density-compact .mask-outcome {
  max-width: 36px;
  gap: 2px;
}
.timeline-mask.density-compact .outcome-team {
  display: none;
}
.timeline-mask.density-micro {
  padding-inline: 0;
  border-radius: 3px;
}
.timeline-mask.density-micro span,
.timeline-mask.density-micro small,
.timeline-mask.density-micro .mask-outcome {
  opacity: 0;
  pointer-events: none;
}
.analysis-rail.density-compact svg:not(:first-child) {
  display: none;
}
.analysis-rail.density-micro {
  min-width: 0;
  padding: 0;
  justify-content: center;
}
.analysis-rail.density-micro > * {
  display: none;
}
.keypoint-dot.density-compact:not(.selected) {
  width: 10px;
  height: 10px;
  opacity: 0.82;
}
.keypoint-dot.density-micro:not(.selected) {
  width: 7px;
  height: 7px;
  border-width: 1px;
  opacity: 0.88;
  /* At full-match scale these hit targets overlap and the last DOM node wins.
     Let the mask receive the first click and zoom without moving the playhead;
     the individual points become interactive once they have physical space. */
  pointer-events: none;
}
</style>
