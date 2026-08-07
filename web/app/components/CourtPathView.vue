<script setup lang="ts">
import type { ReplayPath } from '~/lib/coachDomain'

const props = defineProps<{ paths: ReplayPath[] }>()
const emit = defineEmits<{ seek: [frame: string | null] }>()
const lines = computed(() => props.paths.flatMap(path => {
  const count = Math.max(path.start_court_positions.length, path.end_court_positions.length)
  return Array.from({ length: count }, (_, index) => ({ path, start: path.start_court_positions[index] ?? path.start_court_positions[0], end: path.end_court_positions[index] ?? path.end_court_positions[0] })).filter(line => line.start && line.end)
}))
</script>

<template>
  <div class="relative aspect-[2/1] overflow-hidden rounded-2xl bg-amber-50">
    <svg viewBox="-12 -12 124 124" class="size-full" role="img" aria-label="AI court positions and A/B paths">
      <rect x="0" y="0" width="100" height="100" fill="#fef3c7" stroke="#92400e" stroke-width="1.5" />
      <line x1="50" y1="0" x2="50" y2="100" stroke="#92400e" stroke-width="1.5" />
      <line x1="33.33" y1="0" x2="33.33" y2="100" stroke="#d97706" stroke-dasharray="2 2" />
      <line x1="66.67" y1="0" x2="66.67" y2="100" stroke="#d97706" stroke-dasharray="2 2" />
      <g v-for="(line, index) in lines" :key="`${line.path.id}:${index}`" class="cursor-pointer" tabindex="0" role="button" @click="emit('seek', line.path.start_frame_index)" @keydown.enter="emit('seek', line.path.start_frame_index)">
        <line :x1="line.start!.court_pos.x * 100" :y1="line.start!.court_pos.y * 100" :x2="line.end!.court_pos.x * 100" :y2="line.end!.court_pos.y * 100" stroke="#0f766e" stroke-width="2.5" stroke-linecap="round" />
        <circle :cx="line.start!.court_pos.x * 100" :cy="line.start!.court_pos.y * 100" r="3" fill="#0f766e" />
        <circle :cx="line.end!.court_pos.x * 100" :cy="line.end!.court_pos.y * 100" r="3.5" fill="#f97316" />
      </g>
    </svg>
    <p v-if="!lines.length" class="absolute inset-0 grid place-items-center px-6 text-center text-sm text-amber-950/70">這個分析沒有可畫的 court_pos；系統不會以 (0,0) 補值。</p>
  </div>
</template>
