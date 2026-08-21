<script setup lang="ts">
import {
  MapPinned as MapPinnedIcon,
  Route as RouteIcon,
  Target as TargetIcon,
} from 'lucide-vue-next'
import { computed, ref, useId } from 'vue'
import { actionColor, type CoachPlayerActionEvent } from '~/utils/coachPlayerActions'

type DisplayMode = 'routes' | 'landings'
type TeamTone = 'blue' | 'red'

export interface CoachRouteMapSideLabel {
  teamShortName: string
  teamName?: string
  tone?: TeamTone
}

type CoachRouteMapSideLabels = {
  left: CoachRouteMapSideLabel
  right: CoachRouteMapSideLabel
}

const DEFAULT_SIDE_LABELS: CoachRouteMapSideLabels = {
  left: { teamShortName: '左側' },
  right: { teamShortName: '右側' },
}

const props = defineProps<{
  events: CoachPlayerActionEvent[]
  label: string
  sideLabels?: CoachRouteMapSideLabels
  subjectLabel?: string
  subjectSide?: 'left' | 'right' | null
  selectedEventId?: string | null
}>()
const emit = defineEmits<{
  select: [event: CoachPlayerActionEvent]
  focus: [event: CoachPlayerActionEvent | null]
}>()

const displayMode = ref<DisplayMode>('routes')
const hoveredEventId = ref<string | null>(null)
const mapId = useId()
const courtClipId = `${mapId}-court-clip`
const landingHeatId = `${mapId}-landing-heat`
const routeShadowId = `${mapId}-route-shadow`
const routeArrowId = `${mapId}-route-arrow`
const courtClipPath = `url(#${courtClipId})`
const routeArrowUrl = `url(#${routeArrowId})`
const landingHeatUrl = `url(#${landingHeatId})`
const sideLabels = computed(() => props.sideLabels ?? DEFAULT_SIDE_LABELS)
const routeEvents = computed(() =>
  props.events.filter(event => event.routeStart !== null && event.routeEnd !== null),
)
const landingEvents = computed(() => props.events.filter(event => event.routeEnd !== null))
// A press/hover is a transient focus over the list selection. When it ends,
// the explicit list selection becomes active again.
const activeEventId = computed(() => hoveredEventId.value ?? props.selectedEventId)

const landingHeatSpots = computed(() => {
  const groups = new Map<string, { x: number; y: number; weight: number; eventIds: string[] }>()
  for (const event of landingEvents.value) {
    const x = courtX(event.routeEnd!.x)
    const y = courtY(event.routeEnd!.y)
    const bucketX = Math.round(x / 7) * 7
    const bucketY = Math.round(y / 7) * 7
    const key = `${bucketX}:${bucketY}`
    const group = groups.get(key)
    if (group) {
      group.weight += 1
      group.eventIds.push(event.id)
    } else {
      groups.set(key, { x, y, weight: 1, eventIds: [event.id] })
    }
  }
  return [...groups.values()].map((spot, index) => ({
    ...spot,
    id: `${mapId}-heat-${index}`,
    radius: Math.min(24, 10 + Math.sqrt(spot.weight) * 4),
  }))
})

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

function setHoveredEvent(event: CoachPlayerActionEvent | null) {
  hoveredEventId.value = event?.id ?? null
  emit('focus', event)
}

function isActive(eventId: string) {
  return !activeEventId.value || activeEventId.value === eventId
}

function isHeatSpotActive(eventIds: string[]) {
  return !activeEventId.value || eventIds.includes(activeEventId.value)
}

function outcomeLabel(event: CoachPlayerActionEvent) {
  return event.outcome === 'won' ? '成功' : event.outcome === 'lost' ? '失敗' : '未判定'
}

function outcomeMarkPath(event: CoachPlayerActionEvent) {
  if (!event.routeEnd) return ''
  const x = courtX(event.routeEnd.x)
  const y = courtY(event.routeEnd.y)
  if (event.outcome === 'lost')
    return `M ${x - 1.35} ${y - 1.35} L ${x + 1.35} ${y + 1.35} M ${x + 1.35} ${y - 1.35} L ${x - 1.35} ${y + 1.35}`
  if (event.outcome === 'won')
    return `M ${x - 1.6} ${y} L ${x - 0.45} ${y + 1.2} L ${x + 1.8} ${y - 1.45}`
  return ''
}
</script>

<template>
  <article class="route-map">
    <header class="route-map__header">
      <div class="route-map__title">
        <span class="route-map__icon"><MapPinnedIcon :size="17" /></span>
        <span class="route-map__title-copy">
          <strong>{{ label }}</strong>
          <small>{{ routeEvents.length }} 條完整球路 · {{ landingEvents.length }} 個落點</small>
          <span v-if="subjectLabel" class="route-map__subject">
            <span class="route-map__subject-dot" aria-hidden="true" />
            <span class="route-map__subject-value">分析對象：{{ subjectLabel }}</span>
            <b v-if="subjectSide"> · {{ subjectSide === 'left' ? '左側' : '右側' }}</b>
          </span>
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
      <div
        class="court-stage"
        role="group"
        :aria-label="`場上隊伍：${sideLabels.left.teamShortName} 對 ${sideLabels.right.teamShortName}`"
      >
        <svg viewBox="-18 -14 216 118" role="img" :aria-label="`${label}球路與落點熱區`">
          <defs>
            <clipPath :id="courtClipId">
              <rect x="0" y="0" width="180" height="90" rx="3" />
            </clipPath>
            <radialGradient :id="landingHeatId" cx="50%" cy="50%" r="50%">
              <stop offset="0" stop-color="#ff4d2e" stop-opacity=".86" />
              <stop offset=".42" stop-color="#ff8a36" stop-opacity=".42" />
              <stop offset="1" stop-color="#ffbf69" stop-opacity="0" />
            </radialGradient>
            <filter :id="routeShadowId" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow
                dx="0"
                dy="1.2"
                stdDeviation="1.3"
                flood-color="#02070b"
                flood-opacity=".6"
              />
            </filter>
            <marker
              :id="routeArrowId"
              viewBox="0 0 7 7"
              ref-x="6.2"
              ref-y="3.5"
              marker-width="5.5"
              marker-height="5.5"
              orient="auto-start-reverse"
              marker-units="userSpaceOnUse"
            >
              <path class="route-arrow" d="M 0 0 L 7 3.5 L 0 7 Z" />
            </marker>
          </defs>

          <g class="court-side-names" aria-hidden="true">
            <text
              x="1"
              y="-10"
              :title="sideLabels.left.teamName || sideLabels.left.teamShortName"
              :class="[
                'court-side-name',
                'court-side-name--left',
                sideLabels.left.tone ? `team-tone-${sideLabels.left.tone}` : null,
              ]"
            >
              {{ sideLabels.left.teamShortName }}
            </text>
            <text
              x="179"
              y="-10"
              :title="sideLabels.right.teamName || sideLabels.right.teamShortName"
              :class="[
                'court-side-name',
                'court-side-name--right',
                sideLabels.right.tone ? `team-tone-${sideLabels.right.tone}` : null,
              ]"
            >
              {{ sideLabels.right.teamShortName }}
            </text>
          </g>
          <rect class="court-apron" x="-12" y="-8" width="204" height="106" rx="8" />
          <rect class="court-floor" x="0" y="0" width="180" height="90" rx="3" />
          <g class="court-lines">
            <rect x="1" y="1" width="178" height="88" rx="2" />
            <line x1="90" y1="1" x2="90" y2="89" class="court-net" />
            <line x1="60" y1="1" x2="60" y2="89" />
            <line x1="120" y1="1" x2="120" y2="89" />
          </g>
          <g v-if="displayMode === 'routes'" class="route-layer" :clip-path="courtClipPath">
            <g
              v-for="(event, index) in routeEvents"
              :key="event.id"
              :class="[
                'route-line',
                `route-outcome-${event.outcome}`,
                {
                  selected: isActive(event.id),
                  faded: !isActive(event.id),
                },
              ]"
              :style="{ '--route-color': actionColor(event.actionKey) }"
              @pointerenter="setHoveredEvent(event)"
              @pointerleave="setHoveredEvent(null)"
              @pointerdown="setHoveredEvent(event)"
              @pointerup="setHoveredEvent(null)"
              @pointercancel="setHoveredEvent(null)"
            >
              <path
                class="route-path-flow"
                :d="routeCurve(event, index)"
                :marker-end="routeArrowUrl"
                @click="openEvent(event)"
              />
              <path
                class="route-hit-target"
                :d="routeCurve(event, index)"
                role="button"
                tabindex="0"
                :aria-label="`總回合 ${event.rallyOrdinal} ${event.actionLabel}，${outcomeLabel(event)}，開啟短回放`"
                @click="openEvent(event)"
                @focus="setHoveredEvent(event)"
                @blur="setHoveredEvent(null)"
                @keydown.enter.space.prevent="openEvent(event)"
              />
            </g>
          </g>
          <g v-if="displayMode === 'routes'" class="route-marker-layer" aria-hidden="true">
            <g
              v-for="event in routeEvents"
              :key="`markers:${event.id}`"
              :class="[
                'route-marker',
                `route-outcome-${event.outcome}`,
                {
                  selected: isActive(event.id),
                  faded: !isActive(event.id),
                },
              ]"
            >
              <g v-if="event.routeStart" class="route-start-marker">
                <circle
                  class="route-start"
                  :cx="courtX(event.routeStart.x)"
                  :cy="courtY(event.routeStart.y)"
                  r="4.8"
                />
                <circle
                  class="route-start-core"
                  :cx="courtX(event.routeStart.x)"
                  :cy="courtY(event.routeStart.y)"
                  r="2.1"
                />
                <text
                  v-if="activeEventId && isActive(event.id)"
                  class="route-marker-label"
                  :x="courtX(event.routeStart.x)"
                  :y="courtY(event.routeStart.y) - 6"
                >
                  起
                </text>
              </g>
              <g v-if="event.routeEnd" class="route-end-marker">
                <circle
                  class="route-end-ring"
                  :cx="courtX(event.routeEnd.x)"
                  :cy="courtY(event.routeEnd.y)"
                  r="5"
                />
                <circle
                  class="route-end"
                  :cx="courtX(event.routeEnd.x)"
                  :cy="courtY(event.routeEnd.y)"
                  r="2.2"
                />
                <text
                  v-if="activeEventId && isActive(event.id)"
                  class="route-marker-label route-marker-label--end"
                  :x="courtX(event.routeEnd.x)"
                  :y="courtY(event.routeEnd.y) + 9"
                >
                  落
                </text>
                <path
                  v-if="event.outcome === 'won' || event.outcome === 'lost'"
                  class="route-outcome-glyph"
                  :d="outcomeMarkPath(event)"
                />
                <circle
                  v-else
                  class="route-outcome-dot"
                  :cx="courtX(event.routeEnd.x)"
                  :cy="courtY(event.routeEnd.y)"
                  r="0.8"
                />
              </g>
            </g>
          </g>

          <g v-else class="landing-layer" :clip-path="courtClipPath">
            <circle
              v-for="spot in landingHeatSpots"
              :key="spot.id"
              :class="['landing-heat', { faded: !isHeatSpotActive(spot.eventIds) }]"
              :cx="spot.x"
              :cy="spot.y"
              :r="spot.radius"
              :style="{ fill: landingHeatUrl }"
            />
            <circle
              v-for="event in landingEvents"
              :key="`point:${event.id}`"
              :class="[
                'landing-point',
                {
                  selected: isActive(event.id),
                  faded: !isActive(event.id),
                },
              ]"
              role="button"
              tabindex="0"
              :aria-label="`總回合 ${event.rallyOrdinal} ${event.actionLabel}落點，${outcomeLabel(event)}，開啟短回放`"
              :style="{ '--route-color': actionColor(event.actionKey) }"
              :cx="courtX(event.routeEnd!.x)"
              :cy="courtY(event.routeEnd!.y)"
              r="2.3"
              @pointerenter="setHoveredEvent(event)"
              @pointerleave="setHoveredEvent(null)"
              @pointerdown="setHoveredEvent(event)"
              @pointerup="setHoveredEvent(null)"
              @pointercancel="setHoveredEvent(null)"
              @click="openEvent(event)"
              @focus="setHoveredEvent(event)"
              @blur="setHoveredEvent(null)"
              @keydown.enter.space.prevent="openEvent(event)"
            />
          </g>
        </svg>
      </div>

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
      <span><i class="legend-status legend-status--won">✓</i>成功</span>
      <span><i class="legend-status legend-status--lost">×</i>失敗</span>
      <span><i class="legend-status legend-status--unknown">·</i>未判定</span>
      <span>虛線由起點前往箭頭；箭頭方向就是球路方向。</span>
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
.route-map__title-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
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
.route-map__subject {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  color: #b8c7d3;
  font-size: 0.57rem;
  line-height: 1.2;
}
.route-map__subject-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #72b7ff;
}
.route-map__subject-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.route-map__subject b {
  flex: 0 0 auto;
  color: #ecf4f9;
  font-weight: 720;
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
.route-hit-target:focus-visible,
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
  overflow: hidden;
  filter: drop-shadow(0 1.2px 1.3px rgb(2 7 11 / 60%));
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
.court-stage {
  width: 100%;
  display: block;
  overflow: hidden;
}
.court-side-names {
  fill: #a8c0ca;
  font-size: 4.8px;
  font-weight: 780;
  letter-spacing: 0.45px;
  opacity: 0.9;
  paint-order: stroke;
  stroke: #0d151c;
  stroke-linejoin: round;
  stroke-width: 1.4px;
}
.court-side-name--left {
  text-anchor: start;
}
.court-side-name--right {
  text-anchor: end;
}
.court-side-name.team-tone-blue {
  fill: #4da3ff;
}
.court-side-name.team-tone-red {
  fill: #ff7180;
}
.route-line,
.landing-point {
  cursor: pointer;
  outline: none;
}
.route-marker-layer {
  pointer-events: none;
}
.route-marker {
  opacity: 1;
  transition: opacity 160ms ease-out;
}
.route-marker.faded {
  opacity: 0.18;
}
.route-start,
.route-start-core,
.route-end-ring,
.route-end {
  vector-effect: non-scaling-stroke;
}
.route-start {
  fill: #0d151c;
  stroke: #72b7ff;
  stroke-width: 1.25;
}
.route-start-core {
  fill: #f7fafc;
  stroke: #72b7ff;
  stroke-width: 0.55;
}
.route-end-ring {
  fill: #0d151c;
  stroke: var(--outcome-color, #ffb454);
  stroke-width: 1.45;
}
.route-end {
  fill: var(--outcome-color, #ffb454);
  stroke: #fff;
  stroke-width: 0.5;
}
.route-outcome-won {
  --outcome-color: #42d98a;
}
.route-outcome-lost {
  --outcome-color: #ff6f70;
}
.route-outcome-unknown {
  --outcome-color: #ffb454;
}
.route-outcome-glyph {
  fill: none;
  stroke: #fff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 0.9;
  vector-effect: non-scaling-stroke;
}
.route-outcome-dot {
  fill: #fff;
  opacity: 0.92;
}
.route-marker-label {
  fill: #f7fafc;
  font-size: 3.4px;
  font-weight: 800;
  paint-order: stroke;
  stroke: #0d151c;
  stroke-linejoin: round;
  stroke-width: 1.15px;
  text-anchor: middle;
}
.route-marker-label--end {
  fill: #ffb4ab;
}
.route-hit-target {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
}
.route-line .route-path-flow {
  fill: none;
  stroke: var(--route-color);
  stroke-linecap: round;
  stroke-width: 1.35;
  stroke-dasharray: 1.4 10;
  opacity: 0.92;
  transition:
    opacity 160ms ease-out,
    stroke-width 160ms ease-out;
  animation: route-direction-flow 900ms linear infinite;
  pointer-events: none;
}
.route-line.faded,
.landing-point.faded,
.landing-heat.faded {
  opacity: 0.12;
  filter: grayscale(0.8);
  transition:
    opacity 160ms ease-out,
    filter 160ms ease-out;
}
.route-line.selected .route-path-flow {
  stroke-width: 2.2;
  opacity: 1;
}
.landing-point.selected {
  stroke-width: 1.4;
  r: 3.1;
}
.route-line circle {
  pointer-events: none;
}
.route-line:hover .route-path-flow,
.route-line:focus-within .route-path-flow {
  stroke-width: 2.2;
  opacity: 1;
}
.route-arrow {
  fill: #f7fafc;
}
.route-line circle {
  fill: var(--route-color);
  stroke: #0d151c;
  stroke-width: 1;
}
.landing-heat {
  mix-blend-mode: screen;
  opacity: 0.56;
  transition:
    opacity 160ms ease-out,
    filter 160ms ease-out;
}
.landing-point {
  fill: var(--route-color);
  stroke: transparent;
  stroke-width: 0;
  opacity: 0.62;
  transition:
    opacity 160ms ease-out,
    r 160ms ease-out;
}
.landing-point.selected {
  opacity: 1;
  stroke: #fff;
  stroke-width: 0.7;
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
.route-map__legend .legend-status {
  width: 14px;
  height: 14px;
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  font-size: 0.7rem;
  font-style: normal;
  font-weight: 800;
  line-height: 1;
}
.legend-status--won {
  background: #d9f8e7;
  color: #168554;
}
.legend-status--lost {
  background: #ffe1e1;
  color: #c63f47;
}
.legend-status--unknown {
  background: #fff0d5;
  color: #a46716;
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
@keyframes route-direction-flow {
  to {
    stroke-dashoffset: -22.8;
  }
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
  .route-line .route-path-flow {
    transition: none;
    animation: none;
    stroke-dasharray: 3 7;
  }
}
</style>
