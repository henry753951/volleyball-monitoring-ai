<script setup lang="ts">
import type { ReplayPath } from '~/lib/coachDomain'

const props = withDefaults(defineProps<{
  paths: ReplayPath[]
  leftTeam?: string
  rightTeam?: string
  activeFrame?: number
}>(), { leftTeam: '左隊', rightTeam: '右隊', activeFrame: -1 })
const emit = defineEmits<{ seek: [frame: string | null] }>()
const lines = computed(() => props.paths.flatMap(path => {
  const count = Math.max(path.start_court_positions.length, path.end_court_positions.length)
  return Array.from({ length: count }, (_, index) => ({
    path,
    start: path.start_court_positions[index] ?? path.start_court_positions[0],
    end: path.end_court_positions[index] ?? path.end_court_positions[0],
  })).filter(line => line.start && line.end)
}))
const x = (value: number) => value * 100
const y = (value: number) => (1 - value) * 200
const active = (path: ReplayPath) => {
  if (props.activeFrame < 0 || !path.start_frame_index || !path.end_frame_index) return false
  return props.activeFrame >= Number(path.start_frame_index) && props.activeFrame <= Number(path.end_frame_index)
}
</script>

<template>
  <div class="court-view">
    <span class="court-team court-team--far">{{ rightTeam }}</span>
    <svg viewBox="-16 -18 132 236" role="img" aria-label="2D 球場路徑">
      <defs>
        <linearGradient id="court-floor" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e28b54" /><stop offset="1" stop-color="#c9653d" /></linearGradient>
        <filter id="active-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <marker id="path-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0 5 2.5 0 5Z" fill="context-stroke" /></marker>
      </defs>
      <rect x="0" y="0" width="100" height="200" rx="3" fill="url(#court-floor)" />
      <g fill="none" stroke="#fff" stroke-width="1.4" opacity=".86">
        <rect x="2" y="2" width="96" height="196" />
        <line x1="2" y1="100" x2="98" y2="100" stroke-width="2.2" />
        <line x1="2" y1="66.67" x2="98" y2="66.67" opacity=".72" />
        <line x1="2" y1="133.33" x2="98" y2="133.33" opacity=".72" />
      </g>
      <g v-for="(line, index) in lines" :key="`${line.path.id}:${index}`" class="court-path" :class="{ active: active(line.path) }" tabindex="0" role="button" @click="emit('seek', line.path.start_frame_index)" @keydown.enter="emit('seek', line.path.start_frame_index)">
        <line :x1="x(line.start!.court_pos.y)" :y1="y(line.start!.court_pos.x)" :x2="x(line.end!.court_pos.y)" :y2="y(line.end!.court_pos.x)" marker-end="url(#path-arrow)" />
        <circle :cx="x(line.start!.court_pos.y)" :cy="y(line.start!.court_pos.x)" r="2.7" />
        <circle class="court-path__end" :cx="x(line.end!.court_pos.y)" :cy="y(line.end!.court_pos.x)" r="3.3" />
      </g>
    </svg>
    <span class="court-team court-team--near">{{ leftTeam }}</span>
    <p v-if="!lines.length">尚無球路資料</p>
  </div>
</template>

<style scoped>
.court-view{position:relative;min-height:0;display:grid;grid-template-rows:22px minmax(0,1fr) 22px;justify-items:center;overflow:hidden;border-radius:16px;background:#192129;color:#e6ebef}.court-view::before{position:absolute;inset:0;background:radial-gradient(circle at 50% 35%,#ffffff0d,transparent 56%);content:"";pointer-events:none}.court-view svg{height:100%;max-width:100%;min-height:0;filter:drop-shadow(0 12px 14px #05070a55)}.court-team{z-index:1;align-self:center;max-width:90%;overflow:hidden;color:#c9d0d8;font-size:.65rem;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.court-team--far{color:#a9cfff}.court-team--near{color:#ffc5a0}.court-path{cursor:pointer;outline:none}.court-path line{stroke:#96d6ff;stroke-width:2;stroke-linecap:round;opacity:.72;transition:opacity 160ms ease,stroke-width 160ms ease}.court-path circle{fill:#d9f1ff;stroke:#17212a;stroke-width:1}.court-path__end{fill:#ffdf75!important}.court-path:hover line,.court-path:focus-visible line,.court-path.active line{stroke:#6bd4ff;stroke-width:3;opacity:1;filter:url(#active-glow)}.court-path.active .court-path__end{transform-box:fill-box;transform-origin:center;animation:court-pulse 1.2s ease-in-out infinite}.court-view>p{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:#98a3ad;font-size:.72rem}@keyframes court-pulse{50%{transform:scale(1.45)}}@media(prefers-reduced-motion:reduce){.court-path.active .court-path__end{animation:none}.court-path line{transition:none}}
</style>
