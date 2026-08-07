<script setup lang="ts">
import type { CaptureTimeline } from '~/lib/coreDomain'
const props = defineProps<{ timeline: CaptureTimeline | null; playhead: string | null }>()
const emit = defineEmits<{ seek: [target: string] }>()
const bounds = computed(() => {
  const ranges = props.timeline?.availableRanges ?? []
  if (!ranges.length) return null
  const first = ranges[0]; const last = ranges[ranges.length - 1]; if (!first || !last) return null
  return { start: BigInt(first.startUs), end: BigInt(last.endUs) }
})
function position(time: string) { if (!bounds.value) return 0; const span = bounds.value.end - bounds.value.start; if (span <= 0n) return 0; const ratio = Number(BigInt(time) - bounds.value.start) / Number(span); return Math.max(0, Math.min(100, ratio * 100)) }
</script>
<template>
  <section class="timeline-dock" aria-label="DVR timeline">
    <div class="timeline-dock__ruler"><span>Capture timeline</span><span v-if="timeline">{{ timeline.availableRanges.length }} ready ranges</span></div>
    <div v-for="range in timeline?.availableRanges ?? []" :key="`${range.startUs}-${range.endUs}`" class="timeline-dock__range" :style="{ left: `${position(range.startUs)}%`, width: `${Math.max(1, position(range.endUs) - position(range.startUs))}%` }" @click="emit('seek', range.startUs)" />
    <div v-if="playhead" class="timeline-dock__playhead" :style="{ left: `${position(playhead)}%` }" aria-label="Authoritative playhead" />
    <div v-if="!timeline" class="timeline-dock__empty">No capture timeline available</div>
    <div class="timeline-dock__legend"><span><i class="ready" /> ready range</span><span><i class="gap" /> gap / discontinuity</span><span>Annotation lane reserved for Phase 3</span></div>
  </section>
</template>
<style scoped>
.timeline-dock{position:relative;border:1px solid #d8d0c5;border-radius:12px;background:#fff;padding:12px;min-height:88px}.timeline-dock__ruler,.timeline-dock__legend{display:flex;justify-content:space-between;font-size:12px;color:#766e65}.timeline-dock__range{position:absolute;top:42px;height:14px;background:#6f9e98;border-radius:4px;cursor:pointer}.timeline-dock__playhead{position:absolute;top:34px;height:30px;width:2px;background:#b42318}.timeline-dock__empty{padding:18px 0;color:#766e65}.timeline-dock__legend{margin-top:30px;gap:12px;justify-content:flex-start}.timeline-dock__legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}.ready{background:#6f9e98}.gap{background:#c9c2b8}
</style>
