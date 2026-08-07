<script setup lang="ts">
import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import type { CaptureTimeline } from '~/lib/coreDomain'
import { timelineBounds, capturePercentBps, rulerTicks, pointerTarget, readyAt, gapRanges } from '~/lib/dvrTimeline'

const props = defineProps<{
  timeline: CaptureTimeline | null
  playhead: string | null
  annotation?: AnnotationRallySnapshot | null
}>()
const emit = defineEmits<{ seek: [target: string] }>()
const bounds = computed(() => timelineBounds(props.timeline?.availableRanges ?? []))
const ticks = computed(() => rulerTicks(bounds.value))
const gaps = computed(() => gapRanges(props.timeline?.availableRanges ?? []))
const annotationPoints = computed(() => props.annotation?.snapshot.key_points ?? [])
const maskStart = computed(() => annotationPoints.value[0]?.capture_time_us ?? null)
const maskEnd = computed(() => annotationPoints.value.at(-1)?.capture_time_us ?? null)
const zoom = ref(1)
const pan = ref(0)

function resetView() { zoom.value = 1; pan.value = 0 }
function wheel(event: WheelEvent) { if (event.shiftKey) pan.value = Math.max(-50, Math.min(50, pan.value + event.deltaY / 20)); else zoom.value = Math.max(1, Math.min(8, zoom.value + (event.deltaY < 0 ? 0.25 : -0.25))) }
function position(time: string) { return bounds.value ? capturePercentBps(time, bounds.value) / 100 : 0 }
function seek(event: MouseEvent) { if (!bounds.value || !props.timeline) return; const target = pointerTarget(event.clientX, (event.currentTarget as HTMLElement).getBoundingClientRect(), bounds.value); if (readyAt(target, props.timeline.availableRanges)) emit('seek', target) }
</script>

<template>
  <section class="timeline-dock" aria-label="DVR timeline" @wheel.prevent="wheel">
    <div class="timeline-dock__ruler"><span>Capture timeline</span><span v-if="timeline">{{ timeline.availableRanges.length }} ready ranges</span></div>
    <div class="timeline-dock__ruler-ticks"><span v-for="tick in ticks" :key="tick.value" :style="{ left: `${tick.percentBps / 100}%` }" :title="tick.value">{{ tick.label }}</span></div>
    <div class="timeline-dock__lane" role="slider" tabindex="0" @click="seek"><div v-for="range in timeline?.availableRanges ?? []" :key="`${range.startUs}-${range.endUs}`" class="timeline-dock__range" :style="{ left: `${position(range.startUs)}%`, width: `${Math.max(1, position(range.endUs) - position(range.startUs))}%` }" /></div>
    <div class="timeline-dock__gap-lane" aria-label="Gaps and discontinuities"><div v-for="gap in gaps" :key="`${gap.startUs}-${gap.endUs}`" class="timeline-dock__gap" :style="{ left: `${position(gap.startUs)}%`, width: `${Math.max(1, position(gap.endUs) - position(gap.startUs))}%` }" /></div>
    <div class="timeline-dock__annotation-lane" aria-label="Server annotation lane">
      <span v-if="!annotation">No active server Rally</span>
      <template v-else>
        <div v-if="maskStart && maskEnd" class="timeline-dock__rally-mask" :class="annotation.snapshot.active_submission_id ? 'timeline-dock__rally-mask--submitted' : 'timeline-dock__rally-mask--draft'" :style="{ left: `${position(maskStart)}%`, width: `${Math.max(.35, position(maskEnd) - position(maskStart))}%` }" />
        <i v-for="point in annotationPoints" :key="point.key_point_id" class="timeline-dock__key-point" :class="{ 'timeline-dock__key-point--terminal': point.is_terminal }" :style="{ left: `${position(point.capture_time_us)}%` }" :title="`${point.marker_kind} · frame ${point.capture_frame_index}`" />
        <span class="timeline-dock__annotation-label">Rally {{ annotation.snapshot.annotation_status }} · rev {{ annotation.revision }}</span>
      </template>
    </div>
    <span class="timeline-dock__viewport" aria-live="polite">{{ zoom.toFixed(2) }}x · pan {{ pan.toFixed(0) }}</span><button type="button" class="timeline-dock__reset" @click="resetView">Reset view</button>
    <div v-if="playhead" class="timeline-dock__playhead" :style="{ left: `${position(playhead)}%` }" aria-label="Authoritative playhead" />
    <div v-if="!timeline" class="timeline-dock__empty">No capture timeline available</div>
    <div class="timeline-dock__legend"><span><i class="ready" /> ready range</span><span><i class="gap" /> gap / discontinuity</span><span><i class="draft" /> editable draft</span><span><i class="submitted" /> immutable submission</span></div>
  </section>
</template>

<style scoped>
.timeline-dock{position:relative;border:1px solid #d8d0c5;border-radius:12px;background:#fff;padding:12px;min-height:130px}.timeline-dock__ruler,.timeline-dock__legend{display:flex;justify-content:space-between;font-size:12px;color:#766e65}.timeline-dock__ruler-ticks{position:relative;height:18px}.timeline-dock__ruler-ticks span{position:absolute;font-size:10px;transform:translateX(-50%)}.timeline-dock__lane,.timeline-dock__gap-lane{position:relative;height:16px;margin-top:3px;background:#f0ede8}.timeline-dock__range,.timeline-dock__gap{position:absolute;inset-block:2px;background:#6f9e98;border-radius:4px;cursor:pointer}.timeline-dock__gap{background:#c9c2b8}.timeline-dock__annotation-lane{position:relative;height:24px;margin-top:5px;background:#f7f5f2;font-size:11px;color:#766e65;overflow:hidden}.timeline-dock__rally-mask{position:absolute;top:4px;height:16px;border-radius:4px;opacity:.72}.timeline-dock__rally-mask--draft,.draft{background:#9ca3af}.timeline-dock__rally-mask--submitted,.submitted{background:#16835d}.timeline-dock__key-point{position:absolute;top:6px;width:3px;height:12px;background:#1f2937;z-index:2}.timeline-dock__key-point--terminal{background:#b42318;width:4px}.timeline-dock__annotation-label{position:absolute;right:6px;top:5px;z-index:3;background:#f7f5f2cc;padding-inline:3px}.timeline-dock__playhead{position:absolute;top:34px;height:72px;width:2px;background:#b42318}.timeline-dock__empty{padding:18px 0;color:#766e65}.timeline-dock__legend{margin-top:8px;gap:12px;justify-content:flex-start}.timeline-dock__legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}.ready{background:#6f9e98}.gap{background:#c9c2b8}
</style>
