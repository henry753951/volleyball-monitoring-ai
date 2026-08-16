<script setup lang="ts">
import { ANALYSIS_PLAYER_FLAG, type AnalysisFrameChunk } from '@volleyball-monitoring/contracts'
import { computed } from 'vue'
import type { ReplayContactEvent, ReplayPath } from '~/lib/coachDomain'
import type { RosterPosition } from '~/lib/coreDomain'
import { actionColor, coachBallType } from '~/utils/coachPlayerActions'

interface CourtTrack {
  trackId: number
  courtSide?: string | null
  label?: string | null
  jerseyNumber?: string | null
  position?: RosterPosition | null
}

interface CurveLine {
  path: ReplayPath
  pathIndex: number
  lineIndex: number
  start: NonNullable<ReplayPath['start_court_positions'][number]>
  end: NonNullable<ReplayPath['end_court_positions'][number]>
}

const props = withDefaults(
  defineProps<{
    paths: ReplayPath[]
    events?: ReplayContactEvent[]
    tracks?: CourtTrack[]
    chunk?: AnalysisFrameChunk | null
    leftTeam?: string
    rightTeam?: string
    activeFrame?: number
    playing?: boolean
    showOtherPlayers?: boolean
    playerLabelMode?: 'hitters' | 'all'
    showLegend?: boolean
    fps?: { num: number; den: number } | null
  }>(),
  {
    events: () => [],
    tracks: () => [],
    chunk: null,
    leftTeam: '左隊',
    rightTeam: '右隊',
    activeFrame: -1,
    playing: false,
    showOtherPlayers: true,
    playerLabelMode: 'hitters',
    showLegend: true,
    fps: null,
  },
)
const emit = defineEmits<{ seek: [frame: string | null] }>()

const focusedPathIndex = computed(() => {
  if (!props.paths.length) return -1
  const activeIndex = props.paths.findIndex(path => {
    if (props.activeFrame < 0 || path.start_frame_index === null || path.end_frame_index === null)
      return false
    return (
      props.activeFrame >= Number(path.start_frame_index) &&
      props.activeFrame <= Number(path.end_frame_index)
    )
  })
  if (activeIndex >= 0) return activeIndex
  if (props.activeFrame < 0) return 0
  let nearestIndex = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  props.paths.forEach((path, index) => {
    const start = path.start_frame_index === null ? 0 : Number(path.start_frame_index)
    const end = path.end_frame_index === null ? start : Number(path.end_frame_index)
    const distance =
      props.activeFrame < start
        ? start - props.activeFrame
        : props.activeFrame > end
          ? props.activeFrame - end
          : 0
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestIndex = index
    }
  })
  return nearestIndex
})

const visiblePaths = computed(() => {
  if (props.paths.length <= 7) return props.paths.map((path, index) => ({ path, index }))
  const start = Math.max(0, Math.min(props.paths.length - 7, focusedPathIndex.value - 3))
  return props.paths
    .slice(start, start + 7)
    .map((path, offset) => ({ path, index: start + offset }))
})

const lines = computed<CurveLine[]>(() =>
  visiblePaths.value.flatMap(({ path, index: pathIndex }) => {
    const count = Math.max(path.start_court_positions.length, path.end_court_positions.length)
    return Array.from({ length: count }, (_, index) => ({
      path,
      pathIndex,
      lineIndex: index,
      start: path.start_court_positions[index] ?? path.start_court_positions[0],
      end: path.end_court_positions[index] ?? path.end_court_positions[0],
    })).filter((line): line is CurveLine => Boolean(line.start && line.end))
  }),
)

const focusedLine = computed(
  () =>
    lines.value.find(line => line.pathIndex === focusedPathIndex.value && line.lineIndex === 0) ??
    null,
)
const focusedPath = computed(() => focusedLine.value?.path ?? null)
const trackMetadata = computed(() => new Map(props.tracks.map(track => [track.trackId, track])))
const focusedEvent = computed(() => {
  const path = focusedPath.value
  return path
    ? (props.events.find(event => event.key_point_id === path.start_key_point_id) ?? null)
    : null
})
const focusedTrackId = computed(
  () =>
    focusedEvent.value?.ball_event?.actor?.track_id ??
    focusedEvent.value?.actors[0]?.track_id ??
    null,
)

const x = (value: number) => value * 100
const y = (value: number) => (1 - value) * 200
const isFocused = (pathIndex: number) => pathIndex === focusedPathIndex.value
const pathOpacity = (pathIndex: number) =>
  isFocused(pathIndex)
    ? 1
    : Math.max(0.16, 0.58 - Math.abs(pathIndex - focusedPathIndex.value) * 0.1)

function curve(line: CurveLine) {
  const startX = x(line.start.court_pos.y)
  const startY = y(line.start.court_pos.x)
  const endX = x(line.end.court_pos.y)
  const endY = y(line.end.court_pos.x)
  const dx = endX - startX
  const dy = endY - startY
  const length = Math.max(1, Math.hypot(dx, dy))
  const bend = Math.min(13, Math.max(4.5, length * 0.09)) * (line.lineIndex % 2 ? -1 : 1)
  return {
    startX,
    startY,
    controlX: (startX + endX) / 2 - (dy / length) * bend,
    controlY: (startY + endY) / 2 + (dx / length) * bend,
    endX,
    endY,
  }
}

function curvePath(line: CurveLine) {
  const value = curve(line)
  return `M ${value.startX} ${value.startY} Q ${value.controlX} ${value.controlY} ${value.endX} ${value.endY}`
}

function pathProgress(path: ReplayPath) {
  if (path.start_frame_index === null || path.end_frame_index === null) return 0
  const start = Number(path.start_frame_index)
  const end = Number(path.end_frame_index)
  if (end <= start) return 1
  return Math.max(0, Math.min(1, (props.activeFrame - start) / (end - start)))
}

function pointOnCurve(line: CurveLine, progress: number) {
  const value = curve(line)
  const inverse = 1 - progress
  return {
    x:
      inverse * inverse * value.startX +
      2 * inverse * progress * value.controlX +
      progress * progress * value.endX,
    y:
      inverse * inverse * value.startY +
      2 * inverse * progress * value.controlY +
      progress * progress * value.endY,
  }
}

const ballTrail = computed(() => {
  const line = focusedLine.value
  if (!line) return []
  const progress = pathProgress(line.path)
  return [0.09, 0.045, 0].map((offset, index) => ({
    ...pointOnCurve(line, Math.max(0, progress - offset)),
    index,
  }))
})

const currentPlayers = computed(() => {
  const chunk = props.chunk
  if (!chunk || props.activeFrame < 0) return []
  const localFrame = props.activeFrame - Number(chunk.startFrameIndex)
  if (localFrame < 0 || localFrame >= chunk.frameCount) return []
  const start = chunk.frameOffsets[localFrame] ?? 0
  const end = chunk.frameOffsets[localFrame + 1] ?? start
  const players = [] as Array<{ trackId: number; x: number; y: number; hitter: boolean }>
  for (let index = start; index < end; index += 1) {
    if (!((chunk.playerFlags[index] ?? 0) & ANALYSIS_PLAYER_FLAG.courtPosition)) continue
    const position = chunk.courtPositions[index]
    const trackId = chunk.trackIds[index]
    if (
      !position ||
      trackId === undefined ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    )
      continue
    const hitter = focusedTrackId.value === trackId
    if (!props.showOtherPlayers && !hitter) continue
    players.push({ trackId, x: x(position.y), y: y(position.x), hitter })
  }
  return players
})

function trackLabel(trackId: number | null) {
  if (trackId === null) return '落點'
  const track = trackMetadata.value.get(trackId)
  if (!track?.jerseyNumber) return `ID ${trackId}`
  return `#${track.jerseyNumber} ${track.label ?? `ID ${trackId}`}`
}

function labelWidth(label: string) {
  return Math.max(24, Math.min(54, label.length * 4 + 9))
}

function showPlayerLabel(trackId: number, hitter: boolean) {
  return hitter || props.playerLabelMode === 'all'
}

const pathEvent = (path: ReplayPath) =>
  props.events.find(event => event.key_point_id === path.start_key_point_id)

function pathColor(path: ReplayPath) {
  const event = pathEvent(path)
  return actionColor(event ? coachBallType(props.events, event).key : 'hit')
}

const actionLegend = computed(() => {
  const values = new Map<string, { key: string; label: string }>()
  for (const { path } of visiblePaths.value) {
    const event = pathEvent(path)
    const ballType = event ? coachBallType(props.events, event) : { key: 'hit', label: 'HIT' }
    values.set(ballType.key, ballType)
  }
  return [...values.values()].slice(0, 4)
})

const focusedDuration = computed(() => {
  const path = focusedPath.value
  if (!path?.start_frame_index || !path.end_frame_index || !props.fps?.num) return null
  const frames = Math.max(0, Number(path.end_frame_index) - Number(path.start_frame_index))
  return (frames * props.fps.den) / props.fps.num
})
</script>

<template>
  <div class="court-view">
    <div class="court-heading">
      <div>
        <span>同步球路</span
        ><small
          >{{ paths.length ? `${Math.max(1, focusedPathIndex + 1)} / ${paths.length}` : '—'
          }}<template v-if="focusedDuration !== null">
            · {{ focusedDuration.toFixed(2) }} 秒</template
          ></small
        >
      </div>
      <div v-if="showLegend" class="court-legend" aria-label="球路顏色">
        <template v-if="actionLegend.length"
          ><span
            v-for="item in actionLegend"
            :key="item.key"
            :style="{ color: actionColor(item.key) }"
            >{{ item.label }}</span
          ></template
        >
        <template v-else
          ><span class="service">發球</span><span class="rally">一般</span
          ><span class="terminal">終結</span></template
        >
      </div>
    </div>
    <span class="court-team court-team--far">{{ rightTeam }}</span>
    <svg viewBox="-18 -20 136 240" role="img" aria-label="2D 球場同步球路">
      <defs>
        <linearGradient id="court-floor" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#26313a" />
          <stop offset="1" stop-color="#111820" />
        </linearGradient>
        <radialGradient id="flight-ball">
          <stop offset="0" stop-color="#fff8cf" />
          <stop offset=".55" stop-color="#ffd84d" />
          <stop offset="1" stop-color="#dd8d13" />
        </radialGradient>
        <filter id="ball-shadow" x="-200%" y="-200%" width="400%" height="400%">
          <feDropShadow dx="0" dy="1.3" stdDeviation="1.4" flood-color="#000" flood-opacity=".6" />
        </filter>
      </defs>
      <rect x="0" y="0" width="100" height="200" rx="4" fill="url(#court-floor)" />
      <g fill="none" stroke="#e7edf2" stroke-width="1.15" opacity=".66">
        <rect x="2" y="2" width="96" height="196" />
        <line x1="2" y1="100" x2="98" y2="100" stroke="#fff" stroke-width="2.6" />
        <line x1="2" y1="66.67" x2="98" y2="66.67" opacity=".42" />
        <line x1="2" y1="133.33" x2="98" y2="133.33" opacity=".42" />
      </g>
      <text x="50" y="96" text-anchor="middle" fill="#ffffff70" font-size="4" letter-spacing=".7">
        NET
      </text>

      <g class="court-players" aria-label="球員站位">
        <g
          v-for="player in currentPlayers"
          :key="player.trackId"
          class="court-player"
          :class="{ hitter: player.hitter }"
          :transform="`translate(${player.x} ${player.y})`"
        >
          <circle r="3.3" />
          <circle v-if="player.hitter" class="court-player__ring" r="5.6" />
          <g
            v-if="showPlayerLabel(player.trackId, player.hitter)"
            class="court-nameplate"
            transform="translate(0 -8)"
          >
            <rect
              :x="-labelWidth(trackLabel(player.trackId)) / 2"
              y="-5.5"
              :width="labelWidth(trackLabel(player.trackId))"
              height="8"
              rx="2.5"
            />
            <text y="0" text-anchor="middle">{{ trackLabel(player.trackId) }}</text>
          </g>
        </g>
      </g>

      <g
        v-for="line in lines"
        :key="`${line.path.id}:${line.lineIndex}`"
        class="court-path"
        :class="{
          focused: isFocused(line.pathIndex),
          playing: playing && isFocused(line.pathIndex),
          terminal: line.path.is_terminal_segment,
        }"
        :style="{ opacity: pathOpacity(line.pathIndex), '--path-color': pathColor(line.path) }"
        role="button"
        tabindex="0"
        :aria-label="`球路 ${line.path.sequence_index + 1}`"
        @click="emit('seek', line.path.start_frame_index)"
        @keydown.enter.space.prevent="emit('seek', line.path.start_frame_index)"
      >
        <path class="court-path__curve" :d="curvePath(line)" />
        <circle
          class="court-path__start"
          :cx="x(line.start.court_pos.y)"
          :cy="y(line.start.court_pos.x)"
          r="2.5"
        />
        <circle
          class="court-path__end"
          :cx="x(line.end.court_pos.y)"
          :cy="y(line.end.court_pos.x)"
          r="3"
        />
        <g v-if="isFocused(line.pathIndex) && line.lineIndex === 0" class="court-endpoint-labels">
          <g
            :transform="`translate(${x(line.start.court_pos.y)} ${y(line.start.court_pos.x) - 8})`"
          >
            <rect
              :x="-labelWidth(trackLabel(line.start.track_id)) / 2"
              y="-5.5"
              :width="labelWidth(trackLabel(line.start.track_id))"
              height="8"
              rx="2.5"
            />
            <text y="0" text-anchor="middle">{{ trackLabel(line.start.track_id) }}</text>
          </g>
          <g :transform="`translate(${x(line.end.court_pos.y)} ${y(line.end.court_pos.x) + 12})`">
            <rect
              :x="-labelWidth(trackLabel(line.end.track_id)) / 2"
              y="-5.5"
              :width="labelWidth(trackLabel(line.end.track_id))"
              height="8"
              rx="2.5"
            />
            <text y="0" text-anchor="middle">{{ trackLabel(line.end.track_id) }}</text>
          </g>
        </g>
      </g>

      <g v-if="focusedLine && ballTrail.length" class="flight-ball" aria-label="模擬球位置">
        <circle
          v-for="point in ballTrail"
          :key="point.index"
          :cx="point.x"
          :cy="point.y"
          :r="point.index === 2 ? 3.3 : 2.2 - point.index * 0.2"
          :opacity="point.index === 2 ? 1 : 0.16 + point.index * 0.16"
        />
      </g>
    </svg>
    <span class="court-team court-team--near">{{ leftTeam }}</span>
    <p v-if="!lines.length">尚無可顯示的球路資料</p>
  </div>
</template>

<style scoped>
.court-view {
  position: relative;
  min-height: 0;
  display: grid;
  grid-template-rows: 34px 18px minmax(0, 1fr) 18px;
  justify-items: center;
  overflow: hidden;
  border: 1px solid #25303a;
  border-radius: 16px;
  background: #0f151c;
  color: #e6ebef;
  box-shadow: 0 16px 36px #0b0d1022;
}
.court-view::before {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 34%, #ffffff0c, transparent 58%);
  content: '';
  pointer-events: none;
}
.court-heading {
  z-index: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 0 11px;
  box-sizing: border-box;
  color: #d2d8df;
  font-size: 0.68rem;
  font-weight: 750;
}
.court-heading > div:first-child {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}
.court-heading > div:first-child > span {
  flex: 0 0 auto;
  white-space: nowrap;
}
.court-heading small {
  min-width: 0;
  overflow: hidden;
  color: #7f8a96;
  font-size: 0.6rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.court-legend {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  color: #89939e;
  font-size: 0.54rem;
  font-weight: 650;
  white-space: nowrap;
}
.court-legend span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.court-legend span::before {
  width: 9px;
  border-top: 2px dashed currentColor;
  content: '';
}
.court-legend .service {
  color: #f4c66a;
}
.court-legend .rally {
  color: #69b7ff;
}
.court-legend .terminal {
  color: #ff7b72;
}
.court-view svg {
  height: 100%;
  max-width: 100%;
  min-height: 0;
  overflow: visible;
  filter: drop-shadow(0 12px 14px #05070a55);
}
.court-team {
  z-index: 1;
  align-self: center;
  max-width: 90%;
  overflow: hidden;
  color: #c9d0d8;
  font-size: 0.64rem;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.court-team--far {
  color: #d7dde4;
}
.court-team--near {
  color: #f4c66a;
}
.court-path {
  cursor: pointer;
  outline: none;
  transition: opacity 220ms ease-out;
}
.court-path__curve {
  fill: none;
  stroke: var(--path-color);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-dasharray: 4 4;
  opacity: 0.55;
  transition: opacity 180ms ease-out;
}
.court-path circle {
  fill: var(--path-color);
  stroke: #111820;
  stroke-width: 1;
}
.court-path__end {
  opacity: 0.86;
}
.court-path.focused .court-path__curve,
.court-path:hover .court-path__curve,
.court-path:focus-visible .court-path__curve {
  stroke-width: 2.65;
  opacity: 1;
}
.court-path:focus-visible .court-path__curve {
  filter: drop-shadow(0 0 2px #fff);
}
.court-path.focused.playing .court-path__curve {
  animation: court-dash 0.72s linear infinite;
}
.court-player {
  opacity: 0.34;
}
.court-player circle:first-child {
  fill: #d7e0e8;
  stroke: #111820;
  stroke-width: 1;
}
.court-player.hitter {
  opacity: 1;
}
.court-player.hitter circle:first-child {
  fill: #fff2b3;
}
.court-player__ring {
  fill: none !important;
  stroke: #f4c66a !important;
  stroke-width: 1 !important;
  opacity: 0.8;
}
.court-nameplate rect,
.court-endpoint-labels rect {
  fill: #111820e8;
  stroke: #ffffff20;
  stroke-width: 0.5;
}
.court-nameplate text,
.court-endpoint-labels text {
  fill: #f5f7f9;
  font-size: 4px;
  font-weight: 700;
  paint-order: stroke;
  stroke: #111820;
  stroke-width: 0.7;
}
.court-endpoint-labels {
  pointer-events: none;
}
.flight-ball {
  pointer-events: none;
  filter: url(#ball-shadow);
}
.flight-ball circle {
  fill: url(#flight-ball);
  stroke: #fff4bd;
  stroke-width: 0.45;
}
.court-view > p {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: #98a3ad;
  font-size: 0.72rem;
}
@keyframes court-dash {
  to {
    stroke-dashoffset: -16;
  }
}
@media (prefers-reduced-motion: reduce) {
  .court-path,
  .court-path__curve {
    transition: none;
  }
  .court-path.focused.playing .court-path__curve {
    animation: none;
  }
}
@media (max-width: 900px) {
  .court-legend {
    display: none;
  }
  .court-heading > div:first-child {
    width: 100%;
    justify-content: space-between;
  }
}
</style>

<style scoped>
.court-view {
  border: 0;
  border-radius: 0;
  background: #0d1319;
  box-shadow: none;
}
.court-view::before {
  background: radial-gradient(circle at 50% 38%, #ffffff09, transparent 58%);
}
.court-heading {
  padding-inline: 13px;
}
.court-path__curve {
  stroke-dasharray: 3.5 4.5;
}
.court-nameplate rect,
.court-endpoint-labels rect {
  fill: #090e13f2;
  stroke: #ffffff2b;
}
.court-player:not(.hitter) {
  opacity: 0.25;
}
</style>
