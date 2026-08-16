<script setup lang="ts">
import {
  MapPinned as MapPinnedIcon,
  Route as RouteIcon,
  Target as TargetIcon,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { actionColor, type CoachPlayerActionEvent } from '~/utils/coachPlayerActions'

type DisplayMode = 'routes' | 'landings'

const props = defineProps<{
  events: CoachPlayerActionEvent[]
  label: string
}>()
const emit = defineEmits<{ select: [event: CoachPlayerActionEvent] }>()

const displayMode = ref<DisplayMode>('routes')
const routeEvents = computed(() =>
  props.events.filter(event => event.routeStart !== null && event.routeEnd !== null),
)
const landingEvents = computed(() => props.events.filter(event => event.routeEnd !== null))

const courtX = (value: number) => value * 180
const courtY = (value: number) => (1 - value) * 90

function routeCurve(event: CoachPlayerActionEvent, index: number) {
  if (!event.routeStart || !event.routeEnd) return ''
  const startX = courtX(event.routeStart.x)
  const startY = courtY(event.routeStart.y)
  const endX = courtX(event.routeEnd.x)
  const endY = courtY(event.routeEnd.y)
  const distance = Math.max(1, Math.hypot(endX - startX, endY - startY))
  const bend = Math.min(12, Math.max(3, distance * 0.12)) * (index % 2 ? -1 : 1)
  const controlX = (startX + endX) / 2 - ((endY - startY) / distance) * bend
  const controlY = (startY + endY) / 2 + ((endX - startX) / distance) * bend
  return `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`
}

function openEvent(event: CoachPlayerActionEvent) {
  emit('select', event)
}
</script>

<template>
  <article class="route-map">
    <header class="route-map__header">
      <div>
        <span class="route-map__icon"><MapPinnedIcon :size="17" /></span>
        <span>
          <strong>{{ label }}</strong>
          <small>{{ routeEvents.length }} 條完整球路 · {{ landingEvents.length }} 個落點</small>
        </span>
      </div>
      <div class="route-map__modes" aria-label="球路顯示模式">
        <button
          type="button"
          :class="{ active: displayMode === 'routes' }"
          @click="displayMode = 'routes'"
        >
          <RouteIcon :size="15" />球路
        </button>
        <button
          type="button"
          :class="{ active: displayMode === 'landings' }"
          @click="displayMode = 'landings'"
        >
          <TargetIcon :size="15" />落點熱區
        </button>
      </div>
    </header>

    <div class="route-map__canvas" :data-mode="displayMode">
      <svg viewBox="-18 -14 216 118" role="img" :aria-label="`${label}球路與落點熱區`">
        <defs>
          <radialGradient id="landing-heat" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="#ff4d2e" stop-opacity=".86" />
            <stop offset=".42" stop-color="#ff8a36" stop-opacity=".42" />
            <stop offset="1" stop-color="#ffbf69" stop-opacity="0" />
          </radialGradient>
          <filter id="route-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow
              dx="0"
              dy="1.2"
              stdDeviation="1.3"
              flood-color="#02070b"
              flood-opacity=".6"
            />
          </filter>
        </defs>

        <rect class="court-apron" x="-12" y="-8" width="204" height="106" rx="8" />
        <rect class="court-floor" x="0" y="0" width="180" height="90" rx="3" />
        <g class="court-lines">
          <rect x="1" y="1" width="178" height="88" rx="2" />
          <line x1="90" y1="1" x2="90" y2="89" class="court-net" />
          <line x1="60" y1="1" x2="60" y2="89" />
          <line x1="120" y1="1" x2="120" y2="89" />
        </g>
        <text x="45" y="84" class="court-team-label">左側</text>
        <text x="135" y="84" class="court-team-label">右側</text>

        <g v-if="displayMode === 'routes'" class="route-layer">
          <g
            v-for="(event, index) in routeEvents"
            :key="event.id"
            class="route-line"
            role="link"
            tabindex="0"
            :aria-label="`第 ${event.setNumber} 局回合 ${event.rallyOrdinal} ${event.actionLabel}，前往回放`"
            :style="{ '--route-color': actionColor(event.actionKey) }"
            @click="openEvent(event)"
            @keydown.enter.space.prevent="openEvent(event)"
          >
            <path :d="routeCurve(event, index)" />
            <circle
              v-if="event.routeStart"
              class="route-start"
              :cx="courtX(event.routeStart.x)"
              :cy="courtY(event.routeStart.y)"
              r="2.8"
            />
            <circle
              v-if="event.routeEnd"
              class="route-end-ring"
              :cx="courtX(event.routeEnd.x)"
              :cy="courtY(event.routeEnd.y)"
              r="4.2"
            />
            <circle
              v-if="event.routeEnd"
              class="route-end"
              :cx="courtX(event.routeEnd.x)"
              :cy="courtY(event.routeEnd.y)"
              r="2.2"
            />
          </g>
        </g>

        <g v-else class="landing-layer">
          <circle
            v-for="event in landingEvents"
            :key="`heat:${event.id}`"
            class="landing-heat"
            :cx="courtX(event.routeEnd!.x)"
            :cy="courtY(event.routeEnd!.y)"
            r="17"
          />
          <circle
            v-for="event in landingEvents"
            :key="`point:${event.id}`"
            class="landing-point"
            role="link"
            tabindex="0"
            :aria-label="`第 ${event.setNumber} 局回合 ${event.rallyOrdinal} ${event.actionLabel}落點，前往回放`"
            :style="{ '--route-color': actionColor(event.actionKey) }"
            :cx="courtX(event.routeEnd!.x)"
            :cy="courtY(event.routeEnd!.y)"
            r="2.3"
            @click="openEvent(event)"
            @keydown.enter.space.prevent="openEvent(event)"
          />
        </g>
      </svg>

      <div v-if="displayMode === 'routes' && !routeEvents.length" class="route-map__empty">
        <RouteIcon :size="22" />
        <strong>尚未建立球路</strong>
        <span>完成擊球標記與分析後，這裡會顯示起點、終點與方向。</span>
      </div>
      <div v-else-if="displayMode === 'landings' && !landingEvents.length" class="route-map__empty">
        <TargetIcon :size="22" />
        <strong>尚未建立落點熱區</strong>
        <span>產生有效落點後，這裡會顯示落點分布與密度。</span>
      </div>
    </div>

    <footer class="route-map__legend">
      <span><i class="legend-start" />起點</span>
      <span><i class="legend-end" />終點／落點</span>
      <span>虛線表示球的移動方向；場外座標會保留。</span>
    </footer>
  </article>
</template>

<style scoped>
.route-map {
  min-width: 0;
  overflow: hidden;
  border-radius: 16px;
  background: #111a22;
  color: #edf3f7;
}
.route-map__header {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 10px 8px 16px;
  border-bottom: 1px solid #ffffff12;
}
.route-map__header > div:first-child {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.route-map__header > div:first-child > span:last-child {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.route-map__header strong {
  overflow: hidden;
  color: #f7fafc;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.route-map__header small {
  color: #8e9ba6;
  font-size: 0.59rem;
  font-variant-numeric: tabular-nums;
}
.route-map__icon {
  width: 34px;
  height: 34px;
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  background: #ffffff0d;
  color: #ffca72;
}
.route-map__modes {
  min-width: max-content;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 11px;
  background: #070c11;
}
.route-map__modes button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #8f9aa5;
  font-size: 0.62rem;
  font-weight: 720;
}
.route-map__modes button:hover {
  color: #dce4ea;
}
.route-map__modes button.active {
  background: #26333f;
  color: #fff;
}
.route-map__modes button:focus-visible,
.route-line:focus-visible,
.landing-point:focus-visible {
  outline: 2px solid #72b7ff;
  outline-offset: 2px;
}
.route-map__canvas {
  position: relative;
  min-height: 300px;
  display: grid;
  place-items: center;
  padding: 12px 18px;
  background: #0d151c;
}
.route-map__canvas svg {
  width: 100%;
  max-height: 390px;
  overflow: visible;
  filter: url(#route-shadow);
}
.court-apron {
  fill: #17232c;
}
.court-floor {
  fill: #315a69;
}
.court-lines {
  fill: none;
  stroke: #d9edf2;
  stroke-width: 0.8;
  opacity: 0.66;
}
.court-net {
  stroke: #fff;
  stroke-width: 1.8;
  opacity: 0.9;
}
.court-team-label {
  fill: #dce9ed;
  font-size: 4.5px;
  font-weight: 720;
  letter-spacing: 0.35px;
  opacity: 0.52;
  text-anchor: middle;
}
.route-line,
.landing-point {
  cursor: pointer;
  outline: none;
}
.route-line path {
  fill: none;
  stroke: var(--route-color);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 5 4;
  opacity: 0.5;
  transition:
    opacity 160ms ease-out,
    stroke-width 160ms ease-out;
}
.route-line:hover path,
.route-line:focus-visible path {
  stroke-width: 2.8;
  opacity: 1;
}
.route-line circle {
  fill: var(--route-color);
  stroke: #0d151c;
  stroke-width: 1;
}
.route-line .route-start {
  fill: #f7fafc;
  stroke: var(--route-color);
  stroke-width: 1.4;
}
.route-line .route-end-ring {
  fill: none;
  stroke: var(--route-color);
  stroke-width: 1.25;
  opacity: 0.9;
}
.landing-heat {
  fill: url(#landing-heat);
  mix-blend-mode: screen;
}
.landing-point {
  fill: var(--route-color);
  stroke: #fff;
  stroke-width: 0.8;
}
.route-map__empty {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(320px, calc(100% - 40px));
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 15px 18px;
  transform: translate(-50%, -50%);
  border: 1px solid #ffffff12;
  border-radius: 13px;
  background: #101922f2;
  box-shadow: 0 12px 28px rgb(0 0 0 / 24%);
  color: #98a5af;
  text-align: center;
}
.route-map__empty svg {
  color: #f3c36b;
}
.route-map__empty strong {
  color: #dce4ea;
  font-size: 0.82rem;
}
.route-map__empty span {
  max-width: 36ch;
  font-size: 0.66rem;
  line-height: 1.5;
}
.route-map__legend {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  border-top: 1px solid #ffffff12;
  color: #83909b;
  font-size: 0.56rem;
}
.route-map__legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.route-map__legend span:last-child {
  margin-left: auto;
}
.route-map__legend i {
  width: 8px;
  height: 8px;
  display: inline-block;
  border-radius: 50%;
}
.legend-start {
  border: 2px solid #69b7ff;
  background: #fff;
}
.legend-end {
  border: 2px solid #ff7b72;
  background: transparent;
  box-shadow: inset 0 0 0 1px #0d151c;
}
@media (max-width: 820px) {
  .route-map__header {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }
  .route-map__modes {
    width: 100%;
  }
  .route-map__modes button {
    flex: 1;
    justify-content: center;
  }
  .route-map__canvas {
    min-height: 240px;
    padding-inline: 8px;
  }
  .route-map__legend span:last-child {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .route-line path {
    transition: none;
  }
}
</style>
