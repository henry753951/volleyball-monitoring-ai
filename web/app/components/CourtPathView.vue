<script setup lang="ts">
import type { ReplayPath } from '~/lib/coachDomain'

const props = withDefaults(defineProps<{
  paths: ReplayPath[]
  leftTeam?: string
  rightTeam?: string
  activeFrame?: number
}>(), { leftTeam: '左隊', rightTeam: '右隊', activeFrame: -1 })
const emit = defineEmits<{ seek: [frame: string | null] }>()

const focusedPathIndex = computed(() => {
  if (!props.paths.length) return -1
  const activeIndex = props.paths.findIndex(path => {
    if (props.activeFrame < 0 || !path.start_frame_index || !path.end_frame_index) return false
    return props.activeFrame >= Number(path.start_frame_index) && props.activeFrame <= Number(path.end_frame_index)
  })
  if (activeIndex >= 0) return activeIndex
  if (props.activeFrame < 0) return props.paths.length - 1
  let nearestIndex = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  props.paths.forEach((path, index) => {
    const start = path.start_frame_index ? Number(path.start_frame_index) : 0
    const end = path.end_frame_index ? Number(path.end_frame_index) : start
    const distance = props.activeFrame < start ? start - props.activeFrame : props.activeFrame > end ? props.activeFrame - end : 0
    if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index }
  })
  return nearestIndex
})

const visiblePaths = computed(() => {
  if (props.paths.length <= 5) return props.paths.map((path, index) => ({ path, index }))
  const start = Math.max(0, Math.min(props.paths.length - 5, focusedPathIndex.value - 2))
  return props.paths.slice(start, start + 5).map((path, offset) => ({ path, index: start + offset }))
})

const lines = computed(() => visiblePaths.value.flatMap(({ path, index: pathIndex }) => {
  const count = Math.max(path.start_court_positions.length, path.end_court_positions.length)
  return Array.from({ length: count }, (_, index) => ({
    path,
    pathIndex,
    lineIndex: index,
    start: path.start_court_positions[index] ?? path.start_court_positions[0],
    end: path.end_court_positions[index] ?? path.end_court_positions[0],
  })).filter(line => line.start && line.end)
}))

const x = (value: number) => value * 100
const y = (value: number) => (1 - value) * 200
const isFocused = (pathIndex: number) => pathIndex === focusedPathIndex.value
const pathOpacity = (pathIndex: number) => isFocused(pathIndex) ? 1 : Math.max(.22, 1 - Math.abs(pathIndex - focusedPathIndex.value) * .18)
</script>

<template>
  <div class="court-view">
    <div class="court-heading"><span>球路焦點</span><small>{{ paths.length ? `${Math.max(1, focusedPathIndex + 1)} / ${paths.length}` : '—' }}</small></div>
    <span class="court-team court-team--far">{{ rightTeam }}</span>
    <svg viewBox="-16 -18 132 236" role="img" aria-label="2D 球場路徑">
      <defs>
        <linearGradient id="court-floor" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#272b31" /><stop offset="1" stop-color="#14171b" /></linearGradient>
        <linearGradient id="court-glow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1c98a" /><stop offset="1" stop-color="#ef8b62" /></linearGradient>
        <filter id="active-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <marker id="path-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0 5 2.5 0 5Z" fill="#f1c98a" /></marker>
      </defs>
      <rect x="0" y="0" width="100" height="200" rx="3" fill="url(#court-floor)" />
      <g fill="none" stroke="#e7edf2" stroke-width="1.25" opacity=".72">
        <rect x="2" y="2" width="96" height="196" />
        <line x1="2" y1="100" x2="98" y2="100" stroke="#fff" stroke-width="2.8" />
        <line x1="2" y1="66.67" x2="98" y2="66.67" opacity=".42" />
        <line x1="2" y1="133.33" x2="98" y2="133.33" opacity=".42" />
      </g>
      <text x="50" y="96" text-anchor="middle" fill="#ffffff80" font-size="4" letter-spacing=".8">NET</text>
      <g v-for="line in lines" :key="`${line.path.id}:${line.lineIndex}`" class="court-path" :class="{ focused: isFocused(line.pathIndex), terminal: line.path.is_terminal_segment }" :style="{ opacity: pathOpacity(line.pathIndex) }" role="button" :aria-label="`球路 ${line.path.sequence_index + 1}`" @click="emit('seek', line.path.start_frame_index)">
        <line :x1="x(line.start!.court_pos.y)" :y1="y(line.start!.court_pos.x)" :x2="x(line.end!.court_pos.y)" :y2="y(line.end!.court_pos.x)" :marker-end="isFocused(line.pathIndex) && line.lineIndex === 0 ? 'url(#path-arrow)' : undefined" />
        <circle :cx="x(line.start!.court_pos.y)" :cy="y(line.start!.court_pos.x)" r="2.3" />
        <circle class="court-path__end" :cx="x(line.end!.court_pos.y)" :cy="y(line.end!.court_pos.x)" r="3.2" />
        <circle v-if="isFocused(line.pathIndex) && line.lineIndex === 0" class="court-path__pulse" :cx="x(line.end!.court_pos.y)" :cy="y(line.end!.court_pos.x)" r="5" />
      </g>
    </svg>
    <span class="court-team court-team--near">{{ leftTeam }}</span>
    <p v-if="!lines.length">尚無球路資料</p>
  </div>
</template>

<style scoped>
.court-view{position:relative;min-height:0;display:grid;grid-template-rows:26px 18px minmax(0,1fr) 18px;justify-items:center;overflow:hidden;border:1px solid #252a31;border-radius:16px;background:#101317;color:#e6ebef;box-shadow:0 16px 36px #0b0d1022}.court-view::before{position:absolute;inset:0;background:radial-gradient(circle at 50% 35%,#ffffff0b,transparent 56%);content:"";pointer-events:none}.court-heading{z-index:1;width:100%;display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:#aeb7c1;font-size:.67rem;font-weight:700;letter-spacing:.02em}.court-heading small{color:#68727e;font-size:.61rem;font-variant-numeric:tabular-nums}.court-view svg{height:100%;max-width:100%;min-height:0;filter:drop-shadow(0 12px 14px #05070a55)}.court-team{z-index:1;align-self:center;max-width:90%;overflow:hidden;color:#c9d0d8;font-size:.65rem;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.court-team--far{color:#d7dde4}.court-team--near{color:#f1c98a}.court-path{cursor:pointer;outline:none;transition:opacity 260ms ease}.court-path line{stroke:#d9e4ee;stroke-width:1.55;stroke-linecap:round;opacity:.56;transition:stroke .22s ease,opacity .22s ease}.court-path circle{fill:#d9e4ee;stroke:#101317;stroke-width:1}.court-path__end{fill:#a9b6c4!important}.court-path.focused line,.court-path:hover line{stroke:#f1c98a;stroke-width:2.5;opacity:1;filter:url(#active-glow)}.court-path.focused circle{fill:#f1c98a}.court-path.terminal .court-path__end{fill:#ef8b62!important}.court-path__pulse{fill:none!important;stroke:#f1c98a!important;stroke-width:1!important;opacity:0;animation:court-pulse 1.6s ease-out infinite}.court-view>p{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:#98a3ad;font-size:.72rem}@keyframes court-pulse{0%{opacity:.7;transform:scale(.65)}100%{opacity:0;transform:scale(1.75)}}@media(prefers-reduced-motion:reduce){.court-path,.court-path line{transition:none}.court-path__pulse{animation:none;opacity:.35} }
</style>
