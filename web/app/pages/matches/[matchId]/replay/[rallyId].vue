<script setup lang="ts">
import {
  Gauge,
  ListTree,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-vue-next'
import {
  createCoachDomainClient,
  type CoachRallyReplay,
  type ReplayContactEvent,
} from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'
import { replayStartSeconds } from '~/utils/coachPlayerActions'
import { coachIdentityLabel, coachRallyNeighbours } from '~/utils/coachPresentation'
import { resolveFrameFromRate, resolveFrameFromTimeline } from '~/utils/overlayFrameTimeline'
import { replayBallEventLabel } from '~/utils/replayBallEventPresentation'
import { readOverlayPreferences, writeOverlayPreferences } from '~/utils/overlayPreferences'
import { resolveVideoContentRect } from '~/utils/volleyballOverlayRenderer'

type OverlayMode = 'off' | 'tracking' | 'coach' | 'tactical'
type TeamTone = 'blue' | 'red'
type SafariVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const rallyId = computed(() => String(route.params.rallyId))
const replay = shallowRef<CoachRallyReplay | null>(null)
const pending = ref(true)
const error = shallowRef<Error | null>(null)
const video = useTemplateRef<HTMLVideoElement>('video')
const replayMedia = useTemplateRef<HTMLElement>('replayMedia')
const replayExperience = useTemplateRef<HTMLElement>('replayExperience')
const playing = ref(false)
const muted = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const currentFrame = ref(0)
const videoWidth = ref(0)
const videoHeight = ref(0)
const displaySettingsOpen = ref(false)
const playbackMenuOpen = ref(false)
const playbackRate = ref(1)
const isFullscreen = ref(false)
const savedOverlayPreferences = readOverlayPreferences()
const overlayMode = ref<OverlayMode>(savedOverlayPreferences.enabled ? 'coach' : 'off')
const courtLabelMode = ref<'hitters' | 'all'>('hitters')
const showOtherPlayers = ref(true)
const showCourtLegend = ref(true)
const timelineDetailsOpen = useState('coach-replay-timeline-details-open', () => false)
const rallyStatus = useCoachRallyStatus()
const matchState = useCoachMatchState(matchId, { refreshIntervalMs: 0 })
const mediaSize = reactive({ width: 0, height: 0 })
const overlayEnabled = computed(() => overlayMode.value !== 'off')
const overlayLayers = reactive({
  ...savedOverlayPreferences.layers,
})
const overlay = useAnalysisFrameChunks(
  computed(() => replay.value?.analysis?.id ?? null),
  currentFrame,
  computed(() => Boolean(replay.value?.analysis)),
)
const overlayModes = [
  { id: 'off', label: '關閉' },
  { id: 'coach', label: '教練' },
  { id: 'tracking', label: '追蹤' },
  { id: 'tactical', label: '戰術' },
] as const
const overlayLayerOptions = [
  ['bbox', '球員框'],
  ['playerLabel', '球員名條'],
  ['trackId', 'Local TID（無背號時顯示）'],
  ['action', '動作'],
  ['ball', '球'],
  ['trail', '影像球軌跡'],
  ['nextHit', '下一擊提示'],
  ['court', '場地指示器'],
  ['footprint', '腳點'],
  ['confidence', '信心值'],
] as const
const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

const clipDurationUs = computed(() =>
  replay.value?.clip?.duration_us ? BigInt(replay.value.clip.duration_us) : 0n,
)
const totalClipFrames = computed(() => {
  const fps = replay.value?.clip?.fps
  if (!fps?.num || clipDurationUs.value <= 0n) return '1'
  return String(
    Math.max(1, Math.ceil(((Number(clipDurationUs.value) / 1_000_000) * fps.num) / fps.den)),
  )
})
const timelineEvents = computed(() => replay.value?.analysis?.contact_events ?? [])
const adjacentRallies = computed(() =>
  coachRallyNeighbours(matchState.data.value?.match.rallies ?? [], rallyId.value),
)
const leftTeamLabel = computed(
  () => replay.value?.rally.left_team.shortName || replay.value?.rally.left_team.name || '左隊',
)
const rightTeamLabel = computed(
  () => replay.value?.rally.right_team.shortName || replay.value?.rally.right_team.name || '右隊',
)
const replayTeamTones = computed<{ left: TeamTone | null; right: TeamTone | null }>(() => {
  const teams = matchState.data.value?.match.teams ?? []
  const toneForTeam = (teamId: string | undefined): TeamTone | null => {
    const index = teams.findIndex(team => team.id === teamId)
    return index === 0 ? 'blue' : index === 1 ? 'red' : null
  }
  return {
    left: toneForTeam(replay.value?.rally.left_team.id),
    right: toneForTeam(replay.value?.rally.right_team.id),
  }
})
const overlayTracks = computed(
  () =>
    replay.value?.analysis?.tracks.map(track => ({
      trackId: track.track_id,
      courtSide: track.court_side,
      label: track.identity
        ? coachIdentityLabel(
            track.identity.name,
            track.identity.jersey_number,
            `ID ${track.track_id}`,
          )
        : null,
      gidLabel: track.global_identity?.label ?? null,
      jerseyNumber: track.identity?.jersey_number ?? null,
      position: track.identity?.position ?? null,
    })) ?? [],
)
const overlayIdentityLabels = computed(() =>
  Object.fromEntries(
    overlayTracks.value.flatMap(track => (track.label ? [[track.trackId, track.label]] : [])),
  ),
)
const terminalEvent = computed(
  () =>
    timelineEvents.value.find(event => event.is_terminal) ?? timelineEvents.value.at(-1) ?? null,
)
const scoringTeam = computed(() => {
  const outcome = replay.value?.rally.outcome
  if (!outcome) return null
  if (outcome.scoring_team) return outcome.scoring_team
  return outcome.scoring_court_side === 'left'
    ? replay.value?.rally.left_team
    : outcome.scoring_court_side === 'right'
      ? replay.value?.rally.right_team
      : null
})
const scoreConfirmed = computed(
  () => replay.value?.rally.outcome.score_resolution === 'resolved' && Boolean(scoringTeam.value),
)
const scoringPlayerNames = computed(() => {
  const analysis = replay.value?.analysis
  const event = terminalEvent.value
  if (!analysis || !event) return []
  const actorIds = new Set(
    (event.actors.length ? event.actors : event.candidates).map(actor => actor.track_id),
  )
  const side = replay.value?.rally.outcome.scoring_court_side
  return analysis.tracks
    .filter(track => actorIds.has(track.track_id) && (!side || track.court_side === side))
    .map(track =>
      coachIdentityLabel(
        track.identity?.name,
        track.identity?.jersey_number,
        `ID ${track.track_id}`,
      ),
    )
    .filter((name, index, names) => names.indexOf(name) === index)
})
const scoringPlayerLabel = computed(() =>
  scoringPlayerNames.value.length
    ? scoringPlayerNames.value.join('、')
    : terminalEvent.value
      ? eventActorLabel(terminalEvent.value)
      : '尚無終點事件',
)
const timelineDuration = computed(() => {
  const clipSeconds = Number(clipDurationUs.value) / 1_000_000
  return clipSeconds > 0 ? clipSeconds : duration.value
})
const timelineProgress = computed(() =>
  timelineDuration.value > 0
    ? Math.max(0, Math.min(100, (currentTime.value / timelineDuration.value) * 100))
    : 0,
)
const timelineStyle = computed(() => ({ '--timeline-progress': `${timelineProgress.value}%` }))
const activePathIndex = computed(() => {
  const paths = replay.value?.analysis?.paths ?? []
  const index = paths.findIndex(
    path =>
      path.start_frame_index !== null &&
      path.end_frame_index !== null &&
      currentFrame.value >= Number(path.start_frame_index) &&
      currentFrame.value <= Number(path.end_frame_index),
  )
  return index >= 0 ? index + 1 : null
})
const videoPresentationStyle = computed(() => {
  const mediaElement = replayMedia.value
  const mediaRect = mediaElement?.getBoundingClientRect()
  const viewport =
    mediaSize.width > 0 && mediaSize.height > 0
      ? { x: 0, y: 0, width: mediaSize.width, height: mediaSize.height }
      : {
          x: 0,
          y: 0,
          width: mediaRect?.width ?? 0,
          height: mediaRect?.height ?? 0,
        }
  const rect = resolveVideoContentRect(viewport, videoWidth.value, videoHeight.value)
  return {
    top: `${rect.y}px`,
    left: `${rect.x}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
})
let videoFrameCallbackId: number | null = null
let mediaObserver: ResizeObserver | null = null
let initialEventSeekApplied = false
let replayLoadGeneration = 0

function syncMediaSize() {
  const element = replayMedia.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  mediaSize.width = rect.width
  mediaSize.height = rect.height
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('keydown', handleReplayKeydown)
  mediaObserver = new ResizeObserver(() => syncMediaSize())
  syncMediaSize()
})

async function loadReplay() {
  const currentLoadGeneration = ++replayLoadGeneration
  pending.value = true
  error.value = null
  replay.value = null
  initialEventSeekApplied = false
  displaySettingsOpen.value = false
  playbackMenuOpen.value = false
  playing.value = false
  currentTime.value = 0
  duration.value = 0
  currentFrame.value = 0
  videoWidth.value = 0
  videoHeight.value = 0
  mediaSize.width = 0
  mediaSize.height = 0
  try {
    const nextReplay = await createCoachDomainClient(
      createGraphQLTransport('/graphql'),
    ).rallyReplay(rallyId.value)
    if (currentLoadGeneration !== replayLoadGeneration) return
    replay.value = nextReplay
  } catch (cause) {
    if (currentLoadGeneration !== replayLoadGeneration) return
    error.value = cause instanceof Error ? cause : new Error('無法載入回合')
  } finally {
    if (currentLoadGeneration === replayLoadGeneration) pending.value = false
  }
}

watch(rallyId, () => void loadReplay(), { immediate: true })

function updateVideoState(presentedMediaTime?: number | Event) {
  const element = video.value
  const fps = replay.value?.clip?.fps
  if (!element) return
  syncMediaSize()
  playing.value = !element.paused
  muted.value = element.muted
  currentTime.value = element.currentTime || 0
  duration.value = Number.isFinite(element.duration)
    ? element.duration
    : Number(clipDurationUs.value) / 1_000_000
  videoWidth.value = element.videoWidth
  videoHeight.value = element.videoHeight
  const mediaTimeUs = String(
    Math.round(
      (typeof presentedMediaTime === 'number' ? presentedMediaTime : currentTime.value) * 1_000_000,
    ),
  )
  const timing = overlay.manifest.value?.frame_timing
  if (timing)
    currentFrame.value = resolveFrameFromTimeline(
      mediaTimeUs,
      timing.clip_time_us,
      timing.clip_end_time_us,
    )
  else if (fps) currentFrame.value = resolveFrameFromRate(mediaTimeUs, fps, totalClipFrames.value)
}

function handleLoadedMetadata() {
  updateVideoState()
  if (initialEventSeekApplied) return
  const eventUs = Array.isArray(route.query.event_us)
    ? route.query.event_us[0]
    : route.query.event_us
  if (typeof eventUs !== 'string' || !/^\d+$/.test(eventUs)) return
  initialEventSeekApplied = true
  seekSeconds(replayStartSeconds(eventUs, 3))
}

function scheduleVideoFrameCallback(element: HTMLVideoElement) {
  if (typeof element.requestVideoFrameCallback !== 'function') return
  videoFrameCallbackId = element.requestVideoFrameCallback((_now, metadata) => {
    updateVideoState(metadata.mediaTime)
    scheduleVideoFrameCallback(element)
  })
}

function togglePlayback() {
  const element = video.value
  if (!element) return
  if (element.paused) void element.play()
  else element.pause()
}

function handleReplayKeydown(event: KeyboardEvent) {
  if (event.code !== 'Space' || event.repeat) return
  const target = event.target
  if (
    target instanceof Element &&
    (target.matches(
      'a, button, input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="slider"], [role="menuitem"], [role="tab"]',
    ) ||
      target.closest(
        'a, button, input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="slider"], [role="menuitem"], [role="tab"]',
      ))
  )
    return
  event.preventDefault()
  togglePlayback()
}

function seekSeconds(value: number) {
  if (!video.value || !Number.isFinite(value)) return
  video.value.currentTime = Math.max(0, Math.min(duration.value || value, value))
  updateVideoState()
}

function handleSeekInput(event: Event) {
  seekSeconds(Number((event.target as HTMLInputElement).value))
}

function seekTimeUs(value: string) {
  seekSeconds(Number(BigInt(value)) / 1_000_000)
}

function seekFrame(value: string | null) {
  const timing = overlay.manifest.value?.frame_timing
  if (value && timing) {
    const frame = BigInt(value)
    if (frame >= 0n && frame < BigInt(timing.clip_time_us.length))
      seekTimeUs(timing.clip_time_us[Number(frame)]!)
    return
  }
  const fps = replay.value?.clip?.fps
  if (!value || !fps) return
  seekSeconds(Number(BigInt(value) * BigInt(fps.den)) / fps.num)
}

function pointPercent(event: ReplayContactEvent) {
  if (timelineDuration.value <= 0) return 0
  return Math.max(
    0,
    Math.min(
      100,
      (Number(BigInt(event.anchor_time_us)) / (timelineDuration.value * 1_000_000)) * 100,
    ),
  )
}

function formatClock(value: number) {
  if (!Number.isFinite(value)) return '0:00'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function eventLabel(event: ReplayContactEvent) {
  return replayBallEventLabel(timelineEvents.value, event)
}

function eventTeamLabel(event: ReplayContactEvent) {
  const trackId =
    event.ball_event?.actor?.track_id ?? event.actors[0]?.track_id ?? event.candidates[0]?.track_id
  const side = overlayTracks.value.find(track => track.trackId === trackId)?.courtSide
  return side === 'left'
    ? leftTeamLabel.value
    : side === 'right'
      ? rightTeamLabel.value
      : '隊伍待辨識'
}

function seekEvent(event: ReplayContactEvent) {
  seekSeconds(replayStartSeconds(event.anchor_time_us, 3))
  if (video.value) void video.value.play()
}

function eventActorLabel(event: ReplayContactEvent) {
  if (event.ball_event?.actor)
    return `#${event.ball_event.actor.jersey_number} ${event.ball_event.actor.name}`
  const actorIds = (event.actors.length ? event.actors : event.candidates).map(
    actor => actor.track_id,
  )
  if (!actorIds.length) return event.is_terminal ? '落點' : '球員待辨識'
  return actorIds.map(trackId => overlayIdentityLabels.value[trackId] ?? `ID ${trackId}`).join('、')
}

function selectOverlayMode(mode: OverlayMode) {
  overlayMode.value = mode
  if (mode === 'off') return
  Object.assign(
    overlayLayers,
    mode === 'tracking'
      ? {
          bbox: true,
          trackId: true,
          playerLabel: true,
          action: false,
          ball: true,
          trail: true,
          footprint: false,
          confidence: false,
          court: false,
          nextHit: false,
        }
      : mode === 'tactical'
        ? {
            bbox: false,
            trackId: false,
            playerLabel: true,
            action: false,
            ball: true,
            trail: true,
            footprint: true,
            confidence: false,
            court: true,
            nextHit: true,
          }
        : {
            bbox: true,
            trackId: true,
            playerLabel: true,
            action: true,
            ball: true,
            trail: true,
            footprint: false,
            confidence: false,
            court: true,
            nextHit: true,
          },
  )
}

watch(
  overlayLayers,
  layers =>
    writeOverlayPreferences({
      enabled: overlayMode.value !== 'off',
      layers: { ...layers },
    }),
  { deep: true },
)
watch(overlayMode, mode => {
  writeOverlayPreferences({
    enabled: mode !== 'off',
    layers: { ...overlayLayers },
  })
})

function toggleMute() {
  if (!video.value) return
  video.value.muted = !video.value.muted
  updateVideoState()
}

function setPlaybackRate(rate: number) {
  playbackRate.value = rate
  if (video.value) video.value.playbackRate = rate
  playbackMenuOpen.value = false
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen()
    return
  }
  if (replayExperience.value?.requestFullscreen) {
    await replayExperience.value.requestFullscreen()
    return
  }
  ;(video.value as SafariVideo | null)?.webkitEnterFullscreen?.()
}

function handleFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === replayExperience.value
}

watch(video, (element, previous) => {
  if (
    previous &&
    videoFrameCallbackId !== null &&
    typeof previous.cancelVideoFrameCallback === 'function'
  )
    previous.cancelVideoFrameCallback(videoFrameCallbackId)
  videoFrameCallbackId = null
  if (element) {
    element.playbackRate = playbackRate.value
    scheduleVideoFrameCallback(element)
  }
})
watch(replayMedia, (element, previous) => {
  if (previous) mediaObserver?.unobserve(previous)
  if (!element) return
  mediaObserver?.observe(element)
  syncMediaSize()
})
watch(
  () => overlay.manifest.value,
  () => updateVideoState(),
)
watchEffect(() => {
  const value = replay.value
  if (!value) {
    rallyStatus.value = null
    return
  }
  const tracks = value.analysis?.tracks ?? []
  rallyStatus.value = {
    setNumber: value.rally.set.number,
    rallyOrdinal: value.rally.ordinal,
    currentTime: formatClock(currentTime.value),
    duration: formatClock(duration.value),
    contactCount: timelineEvents.value.length,
    activePath: activePathIndex.value,
    pathCount: value.analysis?.paths.length ?? 0,
    analysisState:
      tracks.length > 0 && tracks.every(track => Boolean(track.identity)) ? 'mapped' : 'ready',
    previousRallyId: adjacentRallies.value.previous,
    nextRallyId: adjacentRallies.value.next,
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  document.removeEventListener('keydown', handleReplayKeydown)
  mediaObserver?.disconnect()
  rallyStatus.value = null
  if (
    video.value &&
    videoFrameCallbackId !== null &&
    typeof video.value.cancelVideoFrameCallback === 'function'
  )
    video.value.cancelVideoFrameCallback(videoFrameCallbackId)
  videoFrameCallbackId = null
})
</script>

<template>
  <section class="replay-workspace" aria-keyshortcuts="Space">
    <div v-if="pending" class="replay-loading" aria-busy="true" />
    <div v-else-if="error" class="replay-state" role="alert">
      <strong>回合載入失敗</strong><span>{{ error.message }}</span>
    </div>
    <div v-else-if="!replay" class="replay-state">找不到回合。</div>
    <template v-else>
      <header class="replay-header">
        <div class="replay-header__identity">
          <span>第 {{ replay.rally.set.number }} 局</span
          ><strong>回合 {{ replay.rally.ordinal }}</strong>
        </div>
        <div class="replay-header__outcome">
          <div>
            <span>得分</span
            ><strong>{{
              scoreConfirmed
                ? scoringTeam?.shortName || scoringTeam?.name
                : replay.rally.outcome.score_resolution === 'unknown'
                  ? '結果未知'
                  : '待確認'
            }}</strong>
          </div>
          <div>
            <span>最後觸球</span><strong>{{ scoringPlayerLabel }}</strong>
          </div>
        </div>
        <dl class="replay-header__metrics">
          <div>
            <dt>時間</dt>
            <dd>{{ formatClock(duration) }}</dd>
          </div>
          <div>
            <dt>擊球</dt>
            <dd>{{ timelineEvents.length }}</dd>
          </div>
          <div>
            <dt>球員</dt>
            <dd>{{ replay.analysis?.tracks.length ?? 0 }}</dd>
          </div>
          <div>
            <dt>球路</dt>
            <dd>{{ replay.analysis?.paths.length ?? 0 }}</dd>
          </div>
        </dl>
      </header>

      <section ref="replayExperience" class="replay-experience">
        <div class="replay-grid">
          <section class="replay-player">
            <div v-if="replay.clip" ref="replayMedia" class="replay-player__media">
              <video
                ref="video"
                :key="rallyId"
                :src="replay.clip.url"
                playsinline
                preload="metadata"
                @click="togglePlayback"
                @loadedmetadata="handleLoadedMetadata"
                @timeupdate="updateVideoState"
                @play="updateVideoState"
                @pause="updateVideoState"
                @volumechange="updateVideoState"
              />
              <div
                v-if="replay.analysis && overlayEnabled"
                class="replay-player__overlay-plane"
                :style="videoPresentationStyle"
              >
                <VolleyballOverlayCanvas
                  :key="rallyId"
                  :events="replay.analysis.contact_events"
                  :frame="currentFrame"
                  :video-width="videoWidth"
                  :video-height="videoHeight"
                  :chunk="overlay.currentChunk.value"
                  :action-labels="overlay.actionLabels.value"
                  :mode="overlayMode"
                  :layers="overlayLayers"
                  :tracks="overlayTracks"
                  :team-labels="{ left: leftTeamLabel, right: rightTeamLabel }"
                  :identity-labels="overlayIdentityLabels"
                />
              </div>
              <div
                v-if="
                  replay.analysis &&
                  overlayEnabled &&
                  (overlay.pending.value || overlay.error.value || !overlay.currentChunk.value)
                "
                class="replay-player__overlay-state"
                :data-tone="overlay.error.value ? 'error' : 'muted'"
              >
                {{
                  overlay.error.value
                    ? '疊圖資料載入失敗'
                    : overlay.pending.value
                      ? '疊圖資料載入中'
                      : '這個時間點沒有疊圖資料'
                }}
              </div>
              <button
                v-if="!playing"
                type="button"
                class="replay-player__center"
                aria-label="播放"
                @click.stop="togglePlayback"
              >
                <Play :size="29" fill="currentColor" />
              </button>
            </div>
            <div v-else class="replay-player__empty">影片處理中</div>

            <div class="replay-transport" aria-label="播放控制">
              <UiTooltip content="倒退 5 秒"
                ><button type="button" aria-label="倒退 5 秒" @click="seekSeconds(currentTime - 5)">
                  <RotateCcw :size="18" /></button
              ></UiTooltip>
              <button
                type="button"
                class="replay-transport__primary"
                :aria-label="playing ? '暫停' : '播放'"
                @click="togglePlayback"
              >
                <Pause v-if="playing" :size="20" fill="currentColor" /><Play
                  v-else
                  :size="20"
                  fill="currentColor"
                />
              </button>
              <UiTooltip content="前進 5 秒"
                ><button type="button" aria-label="前進 5 秒" @click="seekSeconds(currentTime + 5)">
                  <RotateCw :size="18" /></button
              ></UiTooltip>
              <code
                >{{ formatClock(currentTime) }} <span>/ {{ formatClock(duration) }}</span></code
              >
              <div class="replay-transport__spacer" />
              <UiTooltip :content="muted ? '開啟聲音' : '靜音'"
                ><button
                  type="button"
                  :aria-label="muted ? '開啟聲音' : '靜音'"
                  @click="toggleMute"
                >
                  <VolumeX v-if="muted" :size="19" /><Volume2 v-else :size="19" /></button
              ></UiTooltip>
              <UiPopover v-model:open="playbackMenuOpen" side="top" align="end">
                <template #trigger
                  ><button type="button" aria-label="播放速度" :aria-expanded="playbackMenuOpen">
                    <Gauge :size="19" /><span class="transport-rate">{{ playbackRate }}×</span>
                  </button></template
                >
                <div class="playback-menu" role="menu" aria-label="播放速度">
                  <button
                    v-for="rate in playbackRates"
                    :key="rate"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="playbackRate === rate"
                    :class="{ active: playbackRate === rate }"
                    @click="setPlaybackRate(rate)"
                  >
                    {{ rate }}×
                  </button>
                </div>
              </UiPopover>
              <UiPopover
                v-model:open="displaySettingsOpen"
                side="top"
                align="end"
                content-class="replay-display-popover"
              >
                <template #trigger>
                  <button type="button" aria-label="顯示設定" :aria-expanded="displaySettingsOpen">
                    <SlidersHorizontal :size="19" />
                  </button>
                </template>
                <div class="replay-display-settings grid gap-4 p-1" aria-label="顯示設定">
                  <section class="settings-section">
                    <header><strong>顯示模式</strong><span>切換影像與球路資訊密度</span></header>
                    <div class="settings-modes">
                      <button
                        v-for="mode in overlayModes"
                        :key="mode.id"
                        type="button"
                        :class="{ active: overlayMode === mode.id }"
                        @click="selectOverlayMode(mode.id)"
                      >
                        {{ mode.label }}
                      </button>
                    </div>
                  </section>
                  <section class="settings-section">
                    <header><strong>影像疊圖</strong><span>不改寫分析資料</span></header>
                    <div class="settings-list">
                      <label v-for="option in overlayLayerOptions" :key="option[0]"
                        ><span>{{ option[1] }}</span
                        ><UiSwitch
                          v-model="overlayLayers[option[0]]"
                          :disabled="overlayMode === 'off'"
                          :aria-label="option[1]"
                      /></label>
                    </div>
                  </section>
                  <section class="settings-section">
                    <header><strong>虛擬球場</strong><span>只高亮有效擊球者</span></header>
                    <div class="settings-list">
                      <label
                        ><span>其他球員站位</span
                        ><UiSwitch v-model="showOtherPlayers" aria-label="顯示其他球員站位"
                      /></label>
                      <label
                        ><span>球路圖例</span
                        ><UiSwitch v-model="showCourtLegend" aria-label="顯示球路圖例"
                      /></label>
                    </div>
                    <div class="settings-segmented" role="group" aria-label="球員名條">
                      <span>球員名條</span>
                      <div>
                        <button
                          type="button"
                          :class="{ active: courtLabelMode === 'hitters' }"
                          @click="courtLabelMode = 'hitters'"
                        >
                          僅擊球者</button
                        ><button
                          type="button"
                          :class="{ active: courtLabelMode === 'all' }"
                          @click="courtLabelMode = 'all'"
                        >
                          全部
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              </UiPopover>
              <UiTooltip :content="isFullscreen ? '退出全螢幕' : '進入全螢幕'"
                ><button
                  type="button"
                  :aria-label="isFullscreen ? '退出全螢幕' : '進入全螢幕'"
                  @click="toggleFullscreen"
                >
                  <Minimize2 v-if="isFullscreen" :size="19" /><Maximize2
                    v-else
                    :size="19"
                  /></button
              ></UiTooltip>
            </div>
          </section>

          <CourtPathView
            :key="rallyId"
            class="replay-court"
            :paths="replay.analysis?.paths ?? []"
            :events="timelineEvents"
            :tracks="overlayTracks"
            :chunk="overlay.currentChunk.value"
            :left-team="leftTeamLabel"
            :right-team="rightTeamLabel"
            :team-tones="replayTeamTones"
            :active-frame="currentFrame"
            :playing="playing"
            :show-other-players="showOtherPlayers"
            :show-player-labels="overlayLayers.playerLabel"
            :player-label-mode="courtLabelMode"
            :show-legend="showCourtLegend"
            :fps="replay.clip?.fps ?? null"
            @seek="seekFrame"
          />
        </div>

        <section class="replay-timeline" aria-label="擊球時間線">
          <header class="replay-timeline__labels">
            <span><ListTree :size="17" /><strong>擊球時間線</strong></span>
            <small>{{ formatClock(currentTime) }} / {{ formatClock(timelineDuration) }}</small>
          </header>
          <div class="replay-track" :style="timelineStyle">
            <input
              type="range"
              min="0"
              :max="Math.max(timelineDuration, 0.001)"
              step=".001"
              :value="Math.min(currentTime, timelineDuration)"
              aria-label="影片進度"
              @input="handleSeekInput"
            />
            <button
              v-for="event in timelineEvents"
              :key="event.key_point_id"
              type="button"
              class="replay-point"
              :class="{
                service: event.ball_event?.kind === 'serve',
                receive: event.ball_event?.kind === 'receive',
                spike: event.ball_event?.kind === 'spike',
              }"
              :style="{
                left: `${pointPercent(event)}%`,
              }"
              :aria-label="`${eventLabel(event)} · ${eventActorLabel(event)}`"
              @click="seekEvent(event)"
            />
          </div>
        </section>

        <UiSheet
          v-model:open="timelineDetailsOpen"
          title="詳細擊球紀錄"
          :description="`${timelineEvents.length} 次擊球 · 點擊紀錄可跳轉播放`"
        >
          <div class="replay-events replay-events-sheet">
            <button
              v-for="event in timelineEvents"
              :key="`detail:${event.key_point_id}`"
              type="button"
              @click="seekEvent(event)"
            >
              <span class="replay-events__ordinal">{{ event.sequence_index + 1 }}</span>
              <span class="replay-events__copy"
                ><strong>{{ eventLabel(event) }}</strong
                ><small>{{ eventTeamLabel(event) }} · {{ eventActorLabel(event) }}</small></span
              >
              <time>{{ formatClock(Number(BigInt(event.anchor_time_us)) / 1_000_000) }}</time>
            </button>
          </div>
        </UiSheet>
      </section>
    </template>
  </section>
</template>

<style scoped>
.replay-workspace {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 9px;
  overflow: hidden;
}
.replay-header {
  min-height: 48px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 0 4px 8px;
  border-bottom: 1px solid #dce2e8;
}
.replay-header__identity {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}
.replay-header__identity span,
.replay-header__outcome span,
.replay-header__metrics dt {
  color: #78818c;
  font-size: 0.64rem;
}
.replay-header__identity strong {
  font-size: 0.95rem;
  letter-spacing: -0.015em;
}
.replay-header__outcome {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 24px;
}
.replay-header__outcome > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.replay-header__outcome strong {
  overflow: hidden;
  color: #252a30;
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.replay-header__outcome > div:first-child strong {
  color: #bd6d2e;
}
.replay-header__metrics {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 0;
}
.replay-header__metrics > div {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.replay-header__metrics dd {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}
.replay-experience {
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 9px;
  overflow: hidden;
}
.replay-grid {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.72fr) minmax(245px, 0.58fr);
  gap: 9px;
}
.replay-player {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 52px;
  overflow: hidden;
  border-radius: 16px;
  background: #05080c;
  color: #fff;
  box-shadow: 0 16px 42px #0f172a21;
}
.replay-player__media {
  position: relative;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.replay-player video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.replay-player__center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 60px;
  height: 60px;
  display: grid;
  place-items: center;
  transform: translate(-50%, -50%);
  border: 1px solid #ffffff24;
  border-radius: 50%;
  background: #080a0dc9;
  color: #fff;
  box-shadow: 0 8px 28px #0006;
  backdrop-filter: blur(16px);
}
.replay-player__center:active {
  transform: translate(-50%, -50%) scale(0.95);
}
.replay-player__center:focus-visible {
  box-shadow:
    0 8px 28px #0006,
    0 0 0 3px #ffffff45;
}
.replay-player__overlay-state {
  position: absolute;
  z-index: 3;
  top: 10px;
  left: 10px;
  padding: 5px 8px;
  border: 1px solid #ffffff1f;
  border-radius: 7px;
  background: #080b10c7;
  color: #d6dde5;
  font-size: 0.6rem;
  font-weight: 650;
  pointer-events: none;
  backdrop-filter: blur(12px);
}
.replay-player__overlay-state[data-tone='error'] {
  border-color: #ff8b8170;
  color: #ffb3ac;
}
.replay-player__empty {
  display: grid;
  place-items: center;
  color: #9ba3ad;
  font-size: 0.78rem;
}
.replay-transport {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 9px;
  border-top: 1px solid #ffffff0d;
  background: rgba(17, 21, 27, 0.92);
  backdrop-filter: blur(18px) saturate(145%);
}
.replay-transport button {
  min-width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: #dfe5eb;
}
.replay-transport button:hover {
  background: #ffffff0d;
}
.replay-transport button:active {
  background: #ffffff16;
  transform: scale(0.95);
}
.replay-transport button:focus-visible {
  box-shadow: 0 0 0 3px #71aef047;
}
.replay-transport__primary {
  color: #fff !important;
}
.replay-transport code {
  margin-left: 5px;
  color: #edf1f5;
  font-size: 0.69rem;
  font-variant-numeric: tabular-nums;
}
.replay-transport code span {
  color: #7f8995;
}
.replay-transport__spacer {
  flex: 1;
}
.transport-rate {
  font-size: 0.58rem;
  font-weight: 750;
}
.playback-menu {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.playback-menu button {
  min-height: 38px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #b9c2cc;
  font-size: 0.7rem;
  font-weight: 700;
}
.playback-menu button:hover,
.playback-menu button.active {
  background: #ffffff14;
  color: #fff;
}
.replay-timeline {
  min-height: 94px;
  display: grid;
  gap: 8px;
  padding: 10px 16px 12px;
  border: 1px solid #dfe4e9;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 8px 24px #1822300a;
}
.replay-timeline__labels {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.replay-timeline__labels > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.replay-timeline__labels strong {
  font-size: 0.72rem;
}
.replay-timeline__labels small {
  color: #7c8590;
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
}
.replay-track {
  position: relative;
  height: 44px;
  min-width: 0;
}
.replay-events {
  display: flex;
  gap: 7px;
  padding: 2px 12px 8px 0;
}
.replay-events-sheet {
  display: grid;
  gap: 8px;
  padding: 0;
}
.replay-events > button {
  width: 100%;
  min-width: 0;
  min-height: 62px;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e2e7ec;
  border-radius: 11px;
  background: #f8fafb;
  color: #242a31;
  text-align: left;
}
.replay-events > button:hover,
.replay-events > button:focus-visible {
  border-color: #9ec8f2;
  background: #f2f8fe;
  outline: none;
}
.replay-events__ordinal {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: #e8eef5;
  color: #526170;
  font-size: 0.68rem;
  font-weight: 760;
}
.replay-events__copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.replay-events__copy strong,
.replay-events__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.replay-events__copy strong {
  font-size: 0.68rem;
}
.replay-events__copy small,
.replay-events time {
  color: #737e89;
  font-size: 0.56rem;
}
.replay-events time {
  font-variant-numeric: tabular-nums;
}
.replay-track::before {
  position: absolute;
  left: 0;
  right: 0;
  top: 20px;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    #1266c4 var(--timeline-progress),
    #dfe5eb var(--timeline-progress)
  );
  content: '';
}
.replay-track input {
  position: absolute;
  z-index: 2;
  inset: 0;
  width: 100%;
  height: 44px;
  margin: 0;
  opacity: 0.001;
  cursor: pointer;
}
.replay-point {
  position: absolute;
  z-index: 3;
  top: 15px;
  width: 14px;
  height: 14px;
  padding: 0;
  transform: translateX(-50%);
  border: 2px solid #fff;
  border-radius: 50%;
  background: #69b7ff;
  box-shadow: 0 1px 5px #1018204d;
}
.replay-point::before {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 26px;
  height: 26px;
  transform: translate(-50%, -50%);
  content: '';
}
.replay-point.service {
  background: #f4c66a;
}
.replay-point.receive {
  background: #63d4c8;
}
.replay-point.spike {
  background: #ff7b72;
}
.replay-point.terminal {
  border-radius: 4px;
  transform: translateX(-50%) rotate(45deg);
  background: #ff7b72;
}
.replay-point:focus-visible {
  box-shadow: 0 0 0 4px #1266c43d;
}
.replay-loading,
.replay-state {
  height: 100%;
  min-height: 0;
  grid-row: 1/-1;
  border-radius: 18px;
}
.replay-loading {
  background: linear-gradient(100deg, #f1f3f5 20%, #e7ebef 40%, #f1f3f5 60%);
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}
.replay-state {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  background: #fff;
  color: #707782;
}
.replay-state span {
  font-size: 0.72rem;
}
.replay-experience:fullscreen {
  height: 100dvh;
  padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
    max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  box-sizing: border-box;
  background: #06090d;
}
.settings-section {
  display: grid;
  gap: 10px;
}
.settings-section > header {
  display: grid;
  gap: 3px;
}
.settings-section > header strong {
  font-size: 0.8rem;
}
.settings-section > header span {
  color: #747d88;
  font-size: 0.66rem;
  line-height: 1.4;
}
.settings-modes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  padding: 4px;
  border-radius: 12px;
  background: #e5eaf0;
}
.settings-modes button {
  min-height: 38px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #66707b;
  font-size: 0.68rem;
  font-weight: 720;
}
.settings-modes button.active {
  background: #fff;
  color: #1266c4;
  box-shadow: 0 2px 7px #11182716;
}
.settings-list {
  overflow: hidden;
  border: 1px solid #e1e5ea;
  border-radius: 13px;
  background: #fff;
}
.settings-list label {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  color: #39414a;
  font-size: 0.72rem;
}
.settings-list label + label {
  border-top: 1px solid #edf0f3;
}
.settings-segmented {
  display: grid;
  gap: 7px;
}
.settings-segmented > span {
  color: #555f6a;
  font-size: 0.7rem;
  font-weight: 700;
}
.settings-segmented > div {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: #e5eaf0;
}
.settings-segmented button {
  min-height: 38px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #66707b;
  font-size: 0.68rem;
  font-weight: 720;
}
.settings-segmented button.active {
  background: #fff;
  color: #1266c4;
  box-shadow: 0 2px 7px #11182716;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
@media (max-width: 900px) {
  .replay-grid {
    grid-template-columns: minmax(0, 1.5fr) minmax(210px, 0.55fr);
  }
  .replay-header__metrics {
    gap: 9px;
  }
  .replay-header__metrics dt {
    display: none;
  }
  .replay-header__outcome {
    gap: 12px;
  }
  .replay-transport code {
    display: none;
  }
}
@media (max-width: 700px) {
  .replay-header {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .replay-header__metrics {
    display: none;
  }
  .replay-header__outcome {
    justify-content: flex-end;
  }
  .replay-grid {
    grid-template-columns: minmax(0, 1fr) 180px;
  }
  .replay-timeline {
    padding-inline: 10px;
  }
  .replay-transport {
    padding-inline: 4px;
  }
  .replay-transport button {
    min-width: 40px;
  }
  .transport-rate {
    display: none;
  }
}
@media (max-height: 700px) {
  .replay-workspace {
    gap: 6px;
  }
  .replay-header {
    min-height: 38px;
    padding-bottom: 5px;
  }
  .replay-experience {
    grid-template-rows: minmax(0, 1fr) 58px;
    gap: 6px;
  }
  .replay-player {
    grid-template-rows: minmax(0, 1fr) 46px;
  }
  .replay-transport button {
    height: 40px;
  }
  .replay-timeline {
    padding-block: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .replay-loading {
    animation: none;
  }
  .replay-player__center,
  .replay-transport button {
    transition: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .replay-transport {
    background: #11151b;
    backdrop-filter: none;
  }
}
</style>

<style scoped>
.replay-workspace {
  gap: 0;
  background: #f4f6f8;
}
.replay-header {
  min-height: 56px;
  gap: 22px;
  padding: 0 18px;
  border-bottom: 1px solid #dbe1e6;
  background: #f7f9fa;
}
.replay-header__identity strong {
  font-size: 0.9rem;
}
.replay-header__outcome {
  gap: 28px;
}
.replay-header__metrics {
  gap: 20px;
}
.replay-experience {
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 0;
}
.replay-grid {
  grid-template-columns: minmax(0, 1.8fr) minmax(246px, 0.55fr);
  gap: 0;
  border-bottom: 1px solid #242a31;
}
.replay-player {
  grid-template-rows: minmax(0, 1fr) 50px;
  border-radius: 0;
  box-shadow: none;
}
.replay-player__media {
  isolation: isolate;
}
.replay-player video {
  display: block;
  min-width: 0;
  min-height: 0;
}
.replay-player__overlay-plane {
  position: absolute;
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
}
.replay-player__center {
  z-index: 4;
}
.replay-transport {
  position: relative;
  z-index: 5;
  border-top: 1px solid #ffffff12;
}
.replay-court {
  min-width: 0;
  border-radius: 0 !important;
  border-left: 1px solid #29313a;
  box-shadow: none !important;
}
.replay-timeline {
  padding: 9px 18px;
  border: 0;
  border-radius: 0;
  background: #f8fafb;
  box-shadow: none;
}
.replay-track::before {
  height: 3px;
  background: linear-gradient(
    90deg,
    #0670df var(--timeline-progress),
    #dce2e8 var(--timeline-progress)
  );
}
.replay-point {
  width: 13px;
  height: 13px;
  background: #55aaf7;
}
.replay-loading,
.replay-state {
  border-radius: 0;
}
.replay-experience:fullscreen {
  gap: 0;
}
.replay-experience:fullscreen .replay-grid {
  border: 0;
}
.replay-experience:fullscreen .replay-timeline {
  background: #11161c;
  color: #fff;
}
.replay-experience:fullscreen .replay-timeline__labels span {
  color: #8e99a5;
}
:global(.replay-display-popover) {
  box-sizing: border-box;
  width: min(440px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  max-height: calc(100dvh - 24px);
  max-height: min(
    calc(100dvh - 24px),
    var(--reka-popover-content-available-height, calc(100dvh - 24px))
  );
  overflow: hidden;
}
.replay-display-settings {
  width: 100%;
  min-width: 0;
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  max-height: min(
    calc(100dvh - 48px),
    calc(var(--reka-popover-content-available-height, 100dvh) - 18px)
  );
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
@media (max-width: 900px) {
  .replay-grid {
    grid-template-columns: minmax(0, 1.55fr) minmax(220px, 0.55fr);
  }
}
@media (max-width: 700px) {
  .replay-header {
    padding-inline: 12px;
  }
  .replay-grid {
    grid-template-columns: minmax(0, 1fr) 190px;
  }
  .replay-timeline {
    grid-template-columns: 88px minmax(0, 1fr);
    padding-inline: 12px;
  }
}
</style>
