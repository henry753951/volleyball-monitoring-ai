<script setup lang="ts">
import {
  Gauge,
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
import { resolveFrameFromRate, resolveFrameFromTimeline } from '~/utils/overlayFrameTimeline'
import { resolveVideoContentRect } from '~/utils/volleyballOverlayRenderer'

type OverlayMode = 'off' | 'tracking' | 'coach' | 'tactical'
type SafariVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

const route = useRoute()
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
const overlayMode = ref<OverlayMode>('coach')
const courtLabelMode = ref<'hitters' | 'all'>('hitters')
const showOtherPlayers = ref(true)
const showCourtLegend = ref(true)
const rallyStatus = useCoachRallyStatus()
const mediaSize = reactive({ width: 0, height: 0 })
const overlayEnabled = computed(() => overlayMode.value !== 'off')
const overlayLayers = reactive({
  bbox: true,
  trackId: true,
  action: true,
  ball: true,
  trail: true,
  footprint: false,
  confidence: false,
  court: true,
  nextHit: true,
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
  ['trackId', 'Track ID'],
  ['action', '動作'],
  ['ball', '球'],
  ['trail', '影像球軌跡'],
  ['nextHit', '下一擊提示'],
  ['court', '場地指示器'],
  ['footprint', '腳點'],
  ['confidence', '信心值'],
] as const
const playbackRates = [.5, .75, 1, 1.25, 1.5, 2] as const

const clipDurationUs = computed(() => replay.value?.clip?.duration_us ? BigInt(replay.value.clip.duration_us) : 0n)
const totalClipFrames = computed(() => {
  const fps = replay.value?.clip?.fps
  if (!fps?.num || clipDurationUs.value <= 0n) return '1'
  return String(Math.max(1, Math.ceil(Number(clipDurationUs.value) / 1_000_000 * fps.num / fps.den)))
})
const timelineEvents = computed(() => replay.value?.analysis?.contact_events ?? [])
const leftTeamLabel = computed(() => replay.value?.rally.left_team.shortName || replay.value?.rally.left_team.name || '左隊')
const rightTeamLabel = computed(() => replay.value?.rally.right_team.shortName || replay.value?.rally.right_team.name || '右隊')
const overlayTracks = computed(() => replay.value?.analysis?.tracks.map(track => ({
  trackId: track.track_id,
  courtSide: track.court_side,
  label: track.identity?.name ?? null,
  jerseyNumber: track.identity?.jersey_number ?? null,
  position: track.identity?.position ?? null,
})) ?? [])
const overlayIdentityLabels = computed(() => Object.fromEntries(
  overlayTracks.value.flatMap(track => track.label ? [[track.trackId, track.label]] : []),
))
const terminalEvent = computed(() => timelineEvents.value.find(event => event.is_terminal) ?? timelineEvents.value.at(-1) ?? null)
const scoringTeam = computed(() => {
  const outcome = replay.value?.rally.outcome
  if (!outcome) return null
  if (outcome.scoring_team) return outcome.scoring_team
  return outcome.scoring_court_side === 'left'
    ? replay.value?.rally.left_team
    : outcome.scoring_court_side === 'right' ? replay.value?.rally.right_team : null
})
const scoreConfirmed = computed(() => replay.value?.rally.outcome.score_resolution === 'resolved' && Boolean(scoringTeam.value))
const scoringPlayerNames = computed(() => {
  const analysis = replay.value?.analysis
  const event = terminalEvent.value
  if (!analysis || !event) return []
  const actorIds = new Set((event.actors.length ? event.actors : event.candidates).map(actor => actor.track_id))
  const side = replay.value?.rally.outcome.scoring_court_side
  return analysis.tracks
    .filter(track => actorIds.has(track.track_id) && (!side || track.court_side === side))
    .map(track => track.identity?.name ?? `ID ${track.track_id}`)
    .filter((name, index, names) => names.indexOf(name) === index)
})
const scoringPlayerLabel = computed(() => scoringPlayerNames.value.length ? scoringPlayerNames.value.join('、') : terminalEvent.value ? eventActorLabel(terminalEvent.value) : '尚無終點事件')
const timelineProgress = computed(() => duration.value > 0 ? Math.max(0, Math.min(100, currentTime.value / duration.value * 100)) : 0)
const timelineStyle = computed(() => ({ '--timeline-progress': `${timelineProgress.value}%` }))
const activePathIndex = computed(() => {
  const paths = replay.value?.analysis?.paths ?? []
  const index = paths.findIndex(path => path.start_frame_index !== null && path.end_frame_index !== null && currentFrame.value >= Number(path.start_frame_index) && currentFrame.value <= Number(path.end_frame_index))
  return index >= 0 ? index + 1 : null
})
const videoPresentationStyle = computed(() => {
  const rect = resolveVideoContentRect(
    { x: 0, y: 0, width: mediaSize.width, height: mediaSize.height },
    videoWidth.value,
    videoHeight.value,
  )
  return {
    top: `${rect.y}px`,
    left: `${rect.x}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
})
let videoFrameCallbackId: number | null = null
let mediaObserver: ResizeObserver | null = null

onMounted(async () => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  mediaObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (!rect) return
    mediaSize.width = rect.width
    mediaSize.height = rect.height
  })
  try {
    replay.value = await createCoachDomainClient(createGraphQLTransport('/graphql')).rallyReplay(rallyId.value)
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause : new Error('無法載入回合')
  }
  finally {
    pending.value = false
  }
})

function updateVideoState(presentedMediaTime?: number | Event) {
  const element = video.value
  const fps = replay.value?.clip?.fps
  if (!element) return
  playing.value = !element.paused
  muted.value = element.muted
  currentTime.value = element.currentTime || 0
  duration.value = Number.isFinite(element.duration) ? element.duration : Number(clipDurationUs.value) / 1_000_000
  videoWidth.value = element.videoWidth
  videoHeight.value = element.videoHeight
  const mediaTimeUs = String(Math.round((typeof presentedMediaTime === 'number' ? presentedMediaTime : currentTime.value) * 1_000_000))
  const timing = overlay.manifest.value?.frame_timing
  if (timing) currentFrame.value = resolveFrameFromTimeline(mediaTimeUs, timing.clip_time_us, timing.clip_end_time_us)
  else if (fps) currentFrame.value = resolveFrameFromRate(mediaTimeUs, fps, totalClipFrames.value)
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
    if (frame >= 0n && frame < BigInt(timing.clip_time_us.length)) seekTimeUs(timing.clip_time_us[Number(frame)]!)
    return
  }
  const fps = replay.value?.clip?.fps
  if (!value || !fps) return
  seekSeconds(Number(BigInt(value) * BigInt(fps.den)) / fps.num)
}

function pointPercent(event: ReplayContactEvent) {
  if (clipDurationUs.value <= 0n) return 0
  return Math.max(0, Math.min(100, Number(BigInt(event.anchor_time_us) * 10_000n / clipDurationUs.value) / 100))
}

function formatClock(value: number) {
  if (!Number.isFinite(value)) return '0:00'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function eventLabel(event: ReplayContactEvent) {
  if (event.marker_kind === 'service') return '發球'
  return event.is_terminal ? '最後觸球' : `第 ${event.sequence_index + 1} 次擊球`
}

function eventActorLabel(event: ReplayContactEvent) {
  const actorIds = (event.actors.length ? event.actors : event.candidates).map(actor => actor.track_id)
  if (!actorIds.length) return event.is_terminal ? '落點' : '球員待辨識'
  return actorIds.map(trackId => overlayIdentityLabels.value[trackId] ?? `ID ${trackId}`).join('、')
}

function selectOverlayMode(mode: OverlayMode) {
  overlayMode.value = mode
  Object.assign(overlayLayers,
    mode === 'off'
      ? { bbox: false, trackId: false, action: false, ball: false, trail: false, footprint: false, confidence: false, court: false, nextHit: false }
      : mode === 'tracking'
        ? { bbox: true, trackId: true, action: false, ball: true, trail: true, footprint: false, confidence: false, court: false, nextHit: false }
        : mode === 'tactical'
          ? { bbox: false, trackId: false, action: false, ball: true, trail: true, footprint: true, confidence: false, court: true, nextHit: true }
          : { bbox: true, trackId: true, action: true, ball: true, trail: true, footprint: false, confidence: false, court: true, nextHit: true },
  )
}

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
  if (previous && videoFrameCallbackId !== null && typeof previous.cancelVideoFrameCallback === 'function') previous.cancelVideoFrameCallback(videoFrameCallbackId)
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
  const rect = element.getBoundingClientRect()
  mediaSize.width = rect.width
  mediaSize.height = rect.height
})
watch(() => overlay.manifest.value, () => updateVideoState())
watchEffect(() => {
  const value = replay.value
  if (!value) { rallyStatus.value = null; return }
  const tracks = value.analysis?.tracks ?? []
  rallyStatus.value = {
    setNumber: value.rally.set.number,
    rallyOrdinal: value.rally.ordinal,
    currentTime: formatClock(currentTime.value),
    duration: formatClock(duration.value),
    contactCount: timelineEvents.value.length,
    activePath: activePathIndex.value,
    pathCount: value.analysis?.paths.length ?? 0,
    analysisState: tracks.length > 0 && tracks.every(track => Boolean(track.identity)) ? 'mapped' : 'ready',
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  mediaObserver?.disconnect()
  rallyStatus.value = null
  if (video.value && videoFrameCallbackId !== null && typeof video.value.cancelVideoFrameCallback === 'function') video.value.cancelVideoFrameCallback(videoFrameCallbackId)
})
</script>

<template>
  <section class="replay-workspace">
    <div v-if="pending" class="replay-loading" aria-busy="true" />
    <div v-else-if="error" class="replay-state" role="alert"><strong>回合載入失敗</strong><span>{{ error.message }}</span></div>
    <div v-else-if="!replay" class="replay-state">找不到回合。</div>
    <template v-else>
      <header class="replay-header">
        <div class="replay-header__identity"><span>第 {{ replay.rally.set.number }} 局</span><strong>回合 {{ replay.rally.ordinal }}</strong></div>
        <div class="replay-header__outcome">
          <div><span>得分</span><strong>{{ scoreConfirmed ? scoringTeam?.shortName || scoringTeam?.name : replay.rally.outcome.score_resolution === 'unknown' ? '結果未知' : '待確認' }}</strong></div>
          <div><span>最後觸球</span><strong>{{ scoringPlayerLabel }}</strong></div>
        </div>
        <dl class="replay-header__metrics">
          <div><dt>時間</dt><dd>{{ formatClock(duration) }}</dd></div>
          <div><dt>擊球</dt><dd>{{ timelineEvents.length }}</dd></div>
          <div><dt>球員</dt><dd>{{ replay.analysis?.tracks.length ?? 0 }}</dd></div>
          <div><dt>球路</dt><dd>{{ replay.analysis?.paths.length ?? 0 }}</dd></div>
        </dl>
      </header>

      <section ref="replayExperience" class="replay-experience">
        <div class="replay-grid">
          <section class="replay-player">
            <div v-if="replay.clip" ref="replayMedia" class="replay-player__media">
              <video
                ref="video"
                :src="replay.clip.url"
                playsinline
                preload="metadata"
                @click="togglePlayback"
                @loadedmetadata="updateVideoState"
                @timeupdate="updateVideoState"
                @play="updateVideoState"
                @pause="updateVideoState"
                @volumechange="updateVideoState"
              />
              <div v-if="replay.analysis && overlayEnabled" class="replay-player__overlay-plane" :style="videoPresentationStyle">
                <VolleyballOverlayCanvas
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
              <button v-if="!playing" type="button" class="replay-player__center" aria-label="播放" @click.stop="togglePlayback"><Play :size="29" fill="currentColor" /></button>
            </div>
            <div v-else class="replay-player__empty">影片處理中</div>

            <div class="replay-transport" aria-label="播放控制">
              <UiTooltip content="倒退 5 秒"><button type="button" aria-label="倒退 5 秒" @click="seekSeconds(currentTime - 5)"><RotateCcw :size="18" /></button></UiTooltip>
              <button type="button" class="replay-transport__primary" :aria-label="playing ? '暫停' : '播放'" @click="togglePlayback"><Pause v-if="playing" :size="20" fill="currentColor" /><Play v-else :size="20" fill="currentColor" /></button>
              <UiTooltip content="前進 5 秒"><button type="button" aria-label="前進 5 秒" @click="seekSeconds(currentTime + 5)"><RotateCw :size="18" /></button></UiTooltip>
              <code>{{ formatClock(currentTime) }} <span>/ {{ formatClock(duration) }}</span></code>
              <div class="replay-transport__spacer" />
              <UiTooltip :content="muted ? '開啟聲音' : '靜音'"><button type="button" :aria-label="muted ? '開啟聲音' : '靜音'" @click="toggleMute"><VolumeX v-if="muted" :size="19" /><Volume2 v-else :size="19" /></button></UiTooltip>
              <UiPopover v-model:open="playbackMenuOpen" side="top" align="end">
                <template #trigger><button type="button" aria-label="播放速度" :aria-expanded="playbackMenuOpen"><Gauge :size="19" /><span class="transport-rate">{{ playbackRate }}×</span></button></template>
                <div class="playback-menu" role="menu" aria-label="播放速度">
                  <button v-for="rate in playbackRates" :key="rate" type="button" role="menuitemradio" :aria-checked="playbackRate === rate" :class="{ active: playbackRate === rate }" @click="setPlaybackRate(rate)">{{ rate }}×</button>
                </div>
              </UiPopover>
              <UiTooltip content="顯示設定"><button type="button" aria-label="顯示設定" @click="displaySettingsOpen = true"><SlidersHorizontal :size="19" /></button></UiTooltip>
              <UiTooltip :content="isFullscreen ? '退出全螢幕' : '進入全螢幕'"><button type="button" :aria-label="isFullscreen ? '退出全螢幕' : '進入全螢幕'" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="19" /><Maximize2 v-else :size="19" /></button></UiTooltip>
            </div>
          </section>

          <CourtPathView
            class="replay-court"
            :paths="replay.analysis?.paths ?? []"
            :events="timelineEvents"
            :tracks="overlayTracks"
            :chunk="overlay.currentChunk.value"
            :left-team="leftTeamLabel"
            :right-team="rightTeamLabel"
            :active-frame="currentFrame"
            :playing="playing"
            :show-other-players="showOtherPlayers"
            :player-label-mode="courtLabelMode"
            :show-legend="showCourtLegend"
            :fps="replay.clip?.fps ?? null"
            @seek="seekFrame"
          />
        </div>

        <section class="replay-timeline" aria-label="回合時間軸">
          <div class="replay-timeline__labels"><strong>回合時間軸</strong><span>{{ formatClock(currentTime) }} / {{ formatClock(duration) }}</span></div>
          <div class="replay-track" :style="timelineStyle">
            <input type="range" min="0" :max="Math.max(duration, .001)" step=".001" :value="currentTime" aria-label="影片進度" @input="handleSeekInput">
            <button
              v-for="event in timelineEvents"
              :key="event.key_point_id"
              type="button"
              class="replay-point"
              :class="{ service: event.marker_kind === 'service', terminal: event.is_terminal }"
              :style="{ left: `${pointPercent(event)}%` }"
              :aria-label="`${eventLabel(event)} · ${eventActorLabel(event)}`"
              :title="`${eventLabel(event)} · ${eventActorLabel(event)}`"
              @click="seekTimeUs(event.anchor_time_us)"
            />
          </div>
        </section>
      </section>

      <UiSheet v-model:open="displaySettingsOpen" title="顯示設定" description="影像疊圖與虛擬球場各自控制，不會改寫分析資料。">
        <section class="settings-section">
          <header><strong>影像疊圖模式</strong><span>選擇適合目前判讀的資訊密度</span></header>
          <div class="settings-modes">
            <button v-for="mode in overlayModes" :key="mode.id" type="button" :class="{ active: overlayMode === mode.id }" @click="selectOverlayMode(mode.id)">{{ mode.label }}</button>
          </div>
        </section>
        <section class="settings-section">
          <header><strong>影像顯示項目</strong><span>以同一份 frame overlay 顯示</span></header>
          <div class="settings-list">
            <label v-for="option in overlayLayerOptions" :key="option[0]"><span>{{ option[1] }}</span><UiSwitch v-model="overlayLayers[option[0]]" :disabled="overlayMode === 'off'" :aria-label="option[1]" /></label>
          </div>
        </section>
        <section class="settings-section">
          <header><strong>虛擬球場</strong><span>擊球者永遠高亮，其他站位保持半透明</span></header>
          <div class="settings-list">
            <label><span>顯示其他球員站位</span><UiSwitch v-model="showOtherPlayers" aria-label="顯示其他球員站位" /></label>
            <label><span>顯示球路圖例</span><UiSwitch v-model="showCourtLegend" aria-label="顯示球路圖例" /></label>
          </div>
          <div class="settings-segmented" role="group" aria-label="球員名條"><span>球員名條</span><div><button type="button" :class="{ active: courtLabelMode === 'hitters' }" @click="courtLabelMode = 'hitters'">僅擊球者</button><button type="button" :class="{ active: courtLabelMode === 'all' }" @click="courtLabelMode = 'all'">全部</button></div></div>
        </section>
      </UiSheet>
    </template>
  </section>
</template>

<style scoped>
.replay-workspace{height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:9px;overflow:hidden}.replay-header{min-height:48px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:18px;padding:0 4px 8px;border-bottom:1px solid #dce2e8}.replay-header__identity{display:flex;align-items:baseline;gap:8px;white-space:nowrap}.replay-header__identity span,.replay-header__outcome span,.replay-header__metrics dt{color:#78818c;font-size:.64rem}.replay-header__identity strong{font-size:.95rem;letter-spacing:-.015em}.replay-header__outcome{min-width:0;display:flex;align-items:center;gap:24px}.replay-header__outcome>div{min-width:0;display:grid;gap:2px}.replay-header__outcome strong{overflow:hidden;color:#252a30;font-size:.78rem;text-overflow:ellipsis;white-space:nowrap}.replay-header__outcome>div:first-child strong{color:#bd6d2e}.replay-header__metrics{display:flex;align-items:center;gap:16px;margin:0}.replay-header__metrics>div{display:flex;align-items:baseline;gap:5px}.replay-header__metrics dd{margin:0;font-size:.78rem;font-weight:750;font-variant-numeric:tabular-nums}.replay-experience{min-height:0;display:grid;grid-template-rows:minmax(0,1fr) 68px;gap:9px;overflow:hidden}.replay-grid{min-height:0;display:grid;grid-template-columns:minmax(0,1.72fr) minmax(245px,.58fr);gap:9px}.replay-player{position:relative;min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) 52px;overflow:hidden;border-radius:16px;background:#05080c;color:#fff;box-shadow:0 16px 42px #0f172a21}.replay-player__media{position:relative;min-height:0;display:grid;place-items:center;overflow:hidden}.replay-player video{width:100%;height:100%;object-fit:contain}.replay-player__center{position:absolute;left:50%;top:50%;width:60px;height:60px;display:grid;place-items:center;transform:translate(-50%,-50%);border:1px solid #ffffff24;border-radius:50%;background:#080a0dc9;color:#fff;box-shadow:0 8px 28px #0006;backdrop-filter:blur(16px)}.replay-player__center:active{transform:translate(-50%,-50%) scale(.95)}.replay-player__center:focus-visible{box-shadow:0 8px 28px #0006,0 0 0 3px #ffffff45}.replay-player__empty{display:grid;place-items:center;color:#9ba3ad;font-size:.78rem}.replay-transport{display:flex;align-items:center;gap:3px;padding:0 9px;border-top:1px solid #ffffff0d;background:rgba(17,21,27,.92);backdrop-filter:blur(18px) saturate(145%)}.replay-transport button{min-width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0;border:0;border-radius:11px;background:transparent;color:#dfe5eb}.replay-transport button:hover{background:#ffffff0d}.replay-transport button:active{background:#ffffff16;transform:scale(.95)}.replay-transport button:focus-visible{box-shadow:0 0 0 3px #71aef047}.replay-transport__primary{color:#fff!important}.replay-transport code{margin-left:5px;color:#edf1f5;font-size:.69rem;font-variant-numeric:tabular-nums}.replay-transport code span{color:#7f8995}.replay-transport__spacer{flex:1}.transport-rate{font-size:.58rem;font-weight:750}.playback-menu{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.playback-menu button{min-height:38px;border:0;border-radius:8px;background:transparent;color:#b9c2cc;font-size:.7rem;font-weight:700}.playback-menu button:hover,.playback-menu button.active{background:#ffffff14;color:#fff}.replay-timeline{min-height:0;display:grid;grid-template-columns:108px minmax(0,1fr);align-items:center;gap:14px;padding:10px 16px;border:1px solid #dfe4e9;border-radius:14px;background:#fff;box-shadow:0 8px 24px #1822300a}.replay-timeline__labels{display:grid;gap:3px}.replay-timeline__labels strong{font-size:.72rem}.replay-timeline__labels span{color:#7c8590;font-size:.62rem;font-variant-numeric:tabular-nums}.replay-track{position:relative;height:28px}.replay-track::before{position:absolute;left:0;right:0;top:12px;height:4px;border-radius:999px;background:linear-gradient(90deg,#1266c4 var(--timeline-progress),#dfe5eb var(--timeline-progress));content:""}.replay-track input{position:absolute;z-index:2;inset:0;width:100%;height:28px;margin:0;opacity:.001;cursor:pointer}.replay-point{position:absolute;z-index:3;top:7px;width:14px;height:14px;padding:0;transform:translateX(-50%);border:2px solid #fff;border-radius:50%;background:#69b7ff;box-shadow:0 1px 5px #1018204d}.replay-point::before{position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%);content:""}.replay-point.service{background:#f4c66a}.replay-point.terminal{border-radius:4px;transform:translateX(-50%) rotate(45deg);background:#ff7b72}.replay-point:focus-visible{box-shadow:0 0 0 4px #1266c43d}.replay-loading,.replay-state{height:100%;min-height:0;grid-row:1/-1;border-radius:18px}.replay-loading{background:linear-gradient(100deg,#f1f3f5 20%,#e7ebef 40%,#f1f3f5 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.replay-state{display:grid;place-content:center;justify-items:center;gap:6px;background:#fff;color:#707782}.replay-state span{font-size:.72rem}.replay-experience:fullscreen{height:100dvh;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));box-sizing:border-box;background:#06090d}.settings-section{display:grid;gap:10px}.settings-section>header{display:grid;gap:3px}.settings-section>header strong{font-size:.8rem}.settings-section>header span{color:#747d88;font-size:.66rem;line-height:1.4}.settings-modes{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;padding:4px;border-radius:12px;background:#e5eaf0}.settings-modes button{min-height:38px;border:0;border-radius:9px;background:transparent;color:#66707b;font-size:.68rem;font-weight:720}.settings-modes button.active{background:#fff;color:#1266c4;box-shadow:0 2px 7px #11182716}.settings-list{overflow:hidden;border:1px solid #e1e5ea;border-radius:13px;background:#fff}.settings-list label{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px;color:#39414a;font-size:.72rem}.settings-list label+label{border-top:1px solid #edf0f3}.settings-segmented{display:grid;gap:7px}.settings-segmented>span{color:#555f6a;font-size:.7rem;font-weight:700}.settings-segmented>div{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:12px;background:#e5eaf0}.settings-segmented button{min-height:38px;border:0;border-radius:9px;background:transparent;color:#66707b;font-size:.68rem;font-weight:720}.settings-segmented button.active{background:#fff;color:#1266c4;box-shadow:0 2px 7px #11182716}@keyframes shimmer{to{background-position:-200% 0}}@media(max-width:900px){.replay-grid{grid-template-columns:minmax(0,1.5fr) minmax(210px,.55fr)}.replay-header__metrics{gap:9px}.replay-header__metrics dt{display:none}.replay-header__outcome{gap:12px}.replay-transport code{display:none}}@media(max-width:700px){.replay-header{grid-template-columns:auto minmax(0,1fr)}.replay-header__metrics{display:none}.replay-header__outcome{justify-content:flex-end}.replay-grid{grid-template-columns:minmax(0,1fr) 180px}.replay-timeline{grid-template-columns:84px minmax(0,1fr);padding-inline:10px}.replay-transport{padding-inline:4px}.replay-transport button{min-width:40px}.transport-rate{display:none}}@media(max-height:700px){.replay-workspace{gap:6px}.replay-header{min-height:38px;padding-bottom:5px}.replay-experience{grid-template-rows:minmax(0,1fr) 58px;gap:6px}.replay-player{grid-template-rows:minmax(0,1fr) 46px}.replay-transport button{height:40px}.replay-timeline{padding-block:6px}}@media(prefers-reduced-motion:reduce){.replay-loading{animation:none}.replay-player__center,.replay-transport button{transition:none}}@media(prefers-reduced-transparency:reduce){.replay-transport{background:#11151b;backdrop-filter:none}}
</style>

<style scoped>
.replay-workspace{gap:0;background:#f4f6f8}.replay-header{min-height:56px;gap:22px;padding:0 18px;border-bottom:1px solid #dbe1e6;background:#f7f9fa}.replay-header__identity strong{font-size:.9rem}.replay-header__outcome{gap:28px}.replay-header__metrics{gap:20px}.replay-experience{grid-template-rows:minmax(0,1fr) 64px;gap:0}.replay-grid{grid-template-columns:minmax(0,1.8fr) minmax(246px,.55fr);gap:0;border-bottom:1px solid #242a31}.replay-player{grid-template-rows:minmax(0,1fr) 50px;border-radius:0;box-shadow:none}.replay-player__media{isolation:isolate}.replay-player video{display:block;min-width:0;min-height:0}.replay-player__overlay-plane{position:absolute;z-index:2;overflow:hidden;pointer-events:none}.replay-player__center{z-index:4}.replay-transport{position:relative;z-index:5;border-top:1px solid #ffffff12}.replay-court{min-width:0;border-radius:0!important;border-left:1px solid #29313a;box-shadow:none!important}.replay-timeline{grid-template-columns:116px minmax(0,1fr);gap:16px;padding:9px 18px;border:0;border-radius:0;background:#f8fafb;box-shadow:none}.replay-track::before{height:3px;background:linear-gradient(90deg,#0670df var(--timeline-progress),#dce2e8 var(--timeline-progress))}.replay-point{width:13px;height:13px;background:#55aaf7}.replay-loading,.replay-state{border-radius:0}.replay-experience:fullscreen{gap:0}.replay-experience:fullscreen .replay-grid{border:0}.replay-experience:fullscreen .replay-timeline{background:#11161c;color:#fff}.replay-experience:fullscreen .replay-timeline__labels span{color:#8e99a5}@media(max-width:900px){.replay-grid{grid-template-columns:minmax(0,1.55fr) minmax(220px,.55fr)}}@media(max-width:700px){.replay-header{padding-inline:12px}.replay-grid{grid-template-columns:minmax(0,1fr) 190px}.replay-timeline{grid-template-columns:88px minmax(0,1fr);padding-inline:12px}}
</style>
