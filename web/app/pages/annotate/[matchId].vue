<script setup lang="ts">
import { CircleDot, Crosshair, Home, Pause, Play, RadioTower, RotateCcw, Settings, Trash2, UsersRound, Volume2, VolumeX, Wifi } from 'lucide-vue-next'
import { createMediaClient } from '~/lib/mediaClient'
import { useAuthoritativeDvrWindow, seekVideoToCanonicalFrame, authoritativeControlsEnabled } from '~/composables/useAuthoritativeDvrWindow'
import { createCoreDomainClient, createGraphQLTransport, type Match, type CaptureSession } from '~/lib/coreDomain'
import { ANNOTATION_COMMANDS, formatBindingForDisplay, type AnnotationAction, type HotkeyCommand, type MediaAction } from '~/utils/annotationHotkeys'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import type { CoachRally } from '~/lib/coachDomain'

definePageMeta({ layout: 'annotation' })
const route = useRoute()
const matchId = String(route.params.matchId)
const match = ref<Match | null>(null)
const loadError = ref<string | null>(null)
const media = createMediaClient()
const dvr = useAuthoritativeDvrWindow(media)
const descriptor = computed(() => dvr.current.value)
const video = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const muted = ref(false)
const captureTarget = ref('')
const mediaError = ref<string | null>(null)
const authoritativeAnchor = computed(() => dvr.anchor.value)
const observedCursor = shallowRef<PlaybackCursorInput | null>(null)
const cursorStatus = ref<'ready' | 'stale' | 'seeking' | 'gap'>('stale')
const annotation = useAnnotationRoom()
const coach = useCoachMatchState(matchId)
const state = annotation.state
const currentLastKeyPointId = computed(() => annotation.lastKeyPoint.value?.key_point_id ?? null)
const selectedKeyPointId = ref<string | null>(null)
const selectedTimelineItem = ref<'mask' | 'point' | 'segment' | null>(null)
const selectedKeyPoint = computed(() => annotation.snapshot.value?.snapshot.key_points.find(point => point.key_point_id === selectedKeyPointId.value) ?? null)
const fineTuneMode = ref(false)
const pendingFrameMove = shallowRef<{ keyPointId: string; targetFrameIndex: string } | null>(null)
const pendingTimelineMove = shallowRef<{ keyPointId: string; playbackWindowId: string | null } | null>(null)
const canMark = computed(() => authoritativeControlsEnabled({ cursorReady: cursorStatus.value === 'ready', status: dvr.status.value, busy: dvr.busy.value, descriptor: descriptor.value, anchor: authoritativeAnchor.value }))
const commandReady = computed(() => !annotation.busy.value && annotation.pendingCount.value === 0 && !pendingTimelineMove.value)
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')
const settingsOpen = ref(false)
const captureDialogOpen = ref(false)
const inspectorTab = ref<'match' | 'mapping'>('match')
const selectedRallyId = ref<string | null>(null)
let matchRefreshTimer: ReturnType<typeof setInterval> | null = null
let timelineMoveTimeout: ReturnType<typeof setTimeout> | null = null
let cursorResolveTimer: ReturnType<typeof setTimeout> | null = null
let cursorResolveInFlight = false
let pendingCursorResolve: PlaybackCursorInput | null = null
let matchRefreshInFlight = false

const controls = computed(() => ANNOTATION_COMMANDS.map(command => ({
  ...command,
  key: formatBindingForDisplay(bindings.value[command.action]),
  enabled: commandReady.value && (command.action === 'service'
    ? ['IDLE', 'SUBMITTED', 'VOIDED'].includes(state.value) && canMark.value
    : command.action === 'contact'
      ? state.value === 'OPEN' && canMark.value
      : command.action === 'submit'
        ? state.value === 'READY'
        : state.value === 'OPEN' && Boolean(currentLastKeyPointId.value)),
})))

const selectedCapture = computed<CaptureSession | null>(() => {
  const sessions = (match.value?.captureSessions ?? []).filter(session => session.timeline?.availableRanges.length)
  return sessions.slice().sort((a, b) => (Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '')) || a.id.localeCompare(b.id))[0] ?? null
})
const submittedRallies = computed(() => coach.data.value?.match.rallies ?? [])
const completedRallies = computed(() => submittedRallies.value.filter(rally => rally.submission.analysis?.status === 'completed'))
const selectedSubmittedRally = computed(() => submittedRallies.value.find(rally => rally.id === selectedRallyId.value) ?? null)
const selectedRally = computed(() => completedRallies.value.find(rally => rally.id === selectedRallyId.value) ?? completedRallies.value[0] ?? null)
const selectedAnalysisRunId = computed(() => selectedRally.value?.submission.analysis?.id ?? null)
const timelineSegments = computed(() => submittedRallies.value.flatMap((rally) => {
  const clip = rally.submission.clip
  if (!clip || rally.id === annotation.snapshot.value?.rally_id) return []
  const analysis = rally.submission.analysis
  return [{
    id: rally.id,
    label: `第 ${rally.set_number} 局 · 回合 ${rally.ordinal}`,
    startCaptureTimeUs: clip.start_capture_time_us,
    endCaptureTimeUs: clip.end_capture_time_us,
    status: analysis?.status === 'completed'
      ? analysis.identity_mapping_completed ? 'mapped' as const : 'analyzed' as const
      : 'processing' as const,
  }]
}))
const currentSet = computed(() => coach.data.value?.match.sets.find(set => set.status === 'live') ?? coach.data.value?.match.sets.at(-1) ?? null)
const leftTeamId = computed(() => currentSet.value?.side_assignment?.left_team_id ?? coach.data.value?.match.teams[0]?.id ?? null)
const rightTeamId = computed(() => currentSet.value?.side_assignment?.right_team_id ?? coach.data.value?.match.teams[1]?.id ?? null)
const leftTeam = computed(() => coach.data.value?.match.teams.find(team => team.id === leftTeamId.value) ?? coach.data.value?.match.teams[0] ?? null)
const rightTeam = computed(() => coach.data.value?.match.teams.find(team => team.id === rightTeamId.value) ?? coach.data.value?.match.teams[1] ?? null)
const timeline = computed(() => selectedCapture.value?.timeline ?? null)
const selectedCaptureId = computed(() => selectedCapture.value?.id ?? null)
const liveTarget = computed(() => timeline.value?.liveEdgeCaptureTimeUs ?? timeline.value?.availableRanges.at(-1)?.endUs ?? null)
const syncLabel = computed(() => annotation.outboxNeedsConfirmation.value
  ? '待送出操作需要確認'
  : annotation.pendingCount.value
    ? `${annotation.pendingCount.value} 個標註待送出`
    : annotation.busy.value
      ? '同步標註…'
      : annotation.error.value
        ? '同步異常'
        : annotation.connection.value === 'ready'
          ? '標註已更新'
          : '離線 · 可保留一個待送出操作')
const displayTimecode = computed(() => formatTimecode(observedCursor.value?.player_media_time_us))
const remoteEditorsFor = (keyPointId: string) => annotation.remoteEditorsByKeyPoint.value[keyPointId] ?? []

function formatTimecode(value?: string | null) {
  if (!value) return '00:00.000'
  const milliseconds = Number(BigInt(value) / 1_000n)
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const ms = milliseconds % 1_000
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

async function loadMatch(options: { silent?: boolean } = {}) {
  if (matchRefreshInFlight) return
  matchRefreshInFlight = true
  try {
    const nextMatch = await createCoreDomainClient(createGraphQLTransport('/graphql')).match(matchId)
    if (!nextMatch) {
      if (!options.silent) loadError.value = '找不到此場次，請返回賽事列表。'
      return
    }
    match.value = nextMatch
    loadError.value = null
  }
  catch (error) {
    if (!options.silent) loadError.value = error instanceof Error ? error.message : '場次資料載入失敗'
  }
  finally { matchRefreshInFlight = false }
}

async function resolveLatestCursor() {
  cursorResolveTimer = null
  if (cursorResolveInFlight || !pendingCursorResolve) return
  const cursor = pendingCursorResolve
  pendingCursorResolve = null
  cursorResolveInFlight = true
  try {
    const resolved = await dvr.resolve(cursor)
    const timelineMove = pendingTimelineMove.value
    if (resolved && timelineMove && timelineMove.playbackWindowId === cursor.playback_window_id) {
      pendingTimelineMove.value = null
      if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout)
      timelineMoveTimeout = null
      try {
        if (state.value === 'OPEN' && selectedKeyPointId.value === timelineMove.keyPointId && commandReady.value) {
          await annotation.edit('MOVE_KEY_POINT', { keyPointId: timelineMove.keyPointId, cursor })
        }
      }
      finally { releaseEditingIntent() }
      return
    }
    const pending = pendingFrameMove.value
    if (!resolved || !pending || resolved.capture_frame_index !== pending.targetFrameIndex) return
    pendingFrameMove.value = null
    if (!fineTuneMode.value || state.value !== 'OPEN' || selectedKeyPointId.value !== pending.keyPointId || !commandReady.value) return
    await annotation.edit('MOVE_KEY_POINT', { keyPointId: pending.keyPointId, cursor })
  }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '游標解析失敗' }
  finally {
    cursorResolveInFlight = false
    if (pendingCursorResolve && !cursorResolveTimer) cursorResolveTimer = setTimeout(resolveLatestCursor, 50)
  }
}

function handleCursor(cursor: PlaybackCursorInput) {
  observedCursor.value = cursor
  cursorStatus.value = cursor.cursor_status
  if (cursor.cursor_status !== 'ready') {
    pendingCursorResolve = null
    return
  }
  pendingCursorResolve = cursor
  if (!cursorResolveInFlight && !cursorResolveTimer) cursorResolveTimer = setTimeout(resolveLatestCursor, 50)
}

async function createWindow(target = captureTarget.value || undefined) {
  mediaError.value = null
  try {
    const session = selectedCapture.value
    if (!session || !target) throw new Error('目前沒有可播放的 capture range')
    await dvr.create({ schema_version: '1.0.0', capture_session_id: session.id, mode: target === liveTarget.value ? 'live' : 'archive', target_capture_time_us: target })
  }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '播放視窗建立失敗' }
  finally { mediaError.value = dvr.error.value instanceof Error ? dvr.error.value.message : mediaError.value }
}

function dispatchAnnotationAction(action: AnnotationAction) {
  const control = controls.value.find(item => item.action === action)
  if (!control?.enabled) return
  void annotation.dispatch(action, observedCursor.value).catch(() => undefined)
}

function editKeyPoint(kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT') {
  if (!selectedKeyPointId.value || state.value !== 'OPEN' || !commandReady.value) return
  if (kind === 'MOVE_KEY_POINT' && !canMark.value) return
  if (kind === 'MOVE_KEY_POINT') annotation.setEditingKeyPoint(selectedKeyPointId.value)
  void annotation.edit(kind, { keyPointId: selectedKeyPointId.value, cursor: observedCursor.value }).then(() => {
    if (kind === 'DELETE_KEY_POINT') selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
  }).catch(() => undefined).finally(() => { if (kind === 'MOVE_KEY_POINT') releaseEditingIntent() })
}

function selectTimelineKeyPoint(keyPointId: string) {
  selectedKeyPointId.value = keyPointId
  selectedTimelineItem.value = 'point'
}

function selectTimelineMask() {
  selectedTimelineItem.value = 'mask'
  selectedKeyPointId.value = null
}

function selectHistoricalSegment(segmentId: string, targetCaptureTimeUs: string) {
  selectedRallyId.value = segmentId
  selectedTimelineItem.value = 'segment'
  selectedKeyPointId.value = null
  void createWindow(targetCaptureTimeUs)
}

function selectRally(rally: CoachRally) {
  selectedRallyId.value = rally.id
  selectedTimelineItem.value = 'segment'
  selectedKeyPointId.value = null
  if (rally.submission.clip) void createWindow(rally.submission.clip.start_capture_time_us)
}

function openMapping() {
  if (!completedRallies.value.some(rally => rally.id === selectedRallyId.value)) selectedRallyId.value = completedRallies.value[0]?.id ?? null
  inspectorTab.value = 'mapping'
}

function releaseEditingIntent() {
  annotation.setEditingKeyPoint(state.value === 'OPEN' && fineTuneMode.value ? selectedKeyPointId.value : null)
}

function beginTimelineKeyPointEdit(keyPointId: string) {
  if (state.value !== 'OPEN' || !commandReady.value) return
  selectedKeyPointId.value = keyPointId
  annotation.setEditingKeyPoint(keyPointId)
}

function cancelTimelineKeyPointEdit(keyPointId: string) {
  if (pendingTimelineMove.value?.keyPointId === keyPointId) return
  releaseEditingIntent()
}

async function moveTimelineKeyPoint(keyPointId: string, targetCaptureTimeUs: string) {
  if (state.value !== 'OPEN' || !commandReady.value || !selectedCapture.value) {
    releaseEditingIntent()
    return
  }
  selectedKeyPointId.value = keyPointId
  annotation.setEditingKeyPoint(keyPointId)
  pendingTimelineMove.value = { keyPointId, playbackWindowId: null }
  try {
    const created = await dvr.create({
      schema_version: '1.0.0',
      capture_session_id: selectedCapture.value.id,
      mode: 'archive',
      target_capture_time_us: targetCaptureTimeUs,
    })
    if (!created || pendingTimelineMove.value?.keyPointId !== keyPointId) throw new Error('拖曳播放視窗已被較新的操作取代')
    pendingTimelineMove.value = { keyPointId, playbackWindowId: created.playback_window_id }
    timelineMoveTimeout = setTimeout(() => {
      if (pendingTimelineMove.value?.keyPointId !== keyPointId) return
      pendingTimelineMove.value = null
      timelineMoveTimeout = null
      mediaError.value = '拖曳目標尚未產生可解析的瀏覽器畫格；marker 未變更'
      releaseEditingIntent()
    }, 8_000)
  }
  catch (error) {
    pendingTimelineMove.value = null
    if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout)
    timelineMoveTimeout = null
    mediaError.value = error instanceof Error ? error.message : '拖曳 marker 失敗'
    releaseEditingIntent()
  }
}

function toggleFineTuneMode() {
  if (state.value !== 'OPEN' || !selectedKeyPoint.value || !commandReady.value) return
  pendingFrameMove.value = null
  fineTuneMode.value = !fineTuneMode.value
  releaseEditingIntent()
}

function reopenRally() {
  if (state.value !== 'READY' || !commandReady.value) return
  void annotation.edit('REOPEN_RALLY').catch(() => undefined)
}

function voidRally() {
  if (!['OPEN', 'READY'].includes(state.value) || !commandReady.value) return
  if (!window.confirm('確定刪除此未送出的片段？')) return
  void annotation.edit('VOID_RALLY', { reason: 'operator_voided_from_workstation' }).catch(() => undefined)
}

function deleteSelection() {
  if (selectedTimelineItem.value === 'point' && selectedKeyPoint.value?.marker_kind !== 'service') editKeyPoint('DELETE_KEY_POINT')
  else if (selectedTimelineItem.value === 'mask') voidRally()
}

function startCorrection() {
  const submissionId = selectedTimelineItem.value === 'segment'
    ? selectedSubmittedRally.value?.submission.id
    : annotation.snapshot.value?.snapshot.active_submission_id
  if (!submissionId || ['OPEN', 'READY'].includes(state.value) || !commandReady.value) return
  if (!window.confirm('建立此片段的新修正版？按 Enter 送出後會取代目前版本。')) return
  void annotation.createCorrection(submissionId).then(() => {
    selectedRallyId.value = annotation.snapshot.value?.rally_id ?? null
    selectedTimelineItem.value = null
    selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
  }).catch(() => undefined)
}

type PlayerAction = MediaAction | 'mute'
function updatePlaybackState() {
  playing.value = Boolean(video.value && !video.value.paused)
  muted.value = Boolean(video.value?.muted)
}
function detachVideoState(element: HTMLVideoElement | null) {
  element?.removeEventListener('play', updatePlaybackState)
  element?.removeEventListener('pause', updatePlaybackState)
  element?.removeEventListener('volumechange', updatePlaybackState)
}
function handleVideoReady(element: HTMLVideoElement) {
  if (video.value !== element) {
    detachVideoState(video.value)
    video.value = element
    element.addEventListener('play', updatePlaybackState)
    element.addEventListener('pause', updatePlaybackState)
    element.addEventListener('volumechange', updatePlaybackState)
  }
  updatePlaybackState()
}
function dispatchMediaAction(action: PlayerAction) {
  const element = video.value
  if (!element) return
  if (action === 'play_pause') {
    if (element.paused) void element.play().catch((error) => { mediaError.value = error instanceof Error ? error.message : '播放器無法開始播放' })
    else element.pause()
  }
  if (action === 'mute') element.muted = !element.muted
  if (action === 'frame_previous' || action === 'frame_next') void frameStep(action === 'frame_next' ? 'next' : 'previous')
}

async function frameStep(direction: 'previous' | 'next') {
  if (!authoritativeAnchor.value || !descriptor.value || pendingFrameMove.value) return
  try {
    const anchor = await dvr.step(direction, target => ({ schema_version: '1.0.0', capture_session_id: descriptor.value!.capture_session_id, mode: descriptor.value!.mode, target_capture_time_us: target }))
    if (!anchor) return
    const localUs = BigInt(anchor.player_media_time_us)
    if (localUs < 0n || localUs > 86_400_000_000n) throw new RangeError('frame-step returned an unbounded player time')
    if (fineTuneMode.value && state.value === 'OPEN' && selectedKeyPointId.value && commandReady.value) {
      pendingFrameMove.value = { keyPointId: selectedKeyPointId.value, targetFrameIndex: anchor.capture_frame_index }
    }
    if (video.value) seekVideoToCanonicalFrame(video.value, anchor)
  }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '逐幀請求失敗' }
}

function dispatchHotkeyCommand(action: HotkeyCommand) { action === 'play_pause' || action.startsWith('frame_') ? dispatchMediaAction(action as MediaAction) : dispatchAnnotationAction(action as AnnotationAction) }
function commandEnabled(action: HotkeyCommand) {
  if (action === 'play_pause') return Boolean(descriptor.value)
  return action.startsWith('frame_')
    ? Boolean(descriptor.value && authoritativeAnchor.value && canMark.value && !dvr.busy.value && !pendingFrameMove.value)
    : controls.value.some(control => control.action === action && control.enabled)
}
useAnnotationHotkeyRuntime({ target: annotationScope, dispatch: dispatchHotkeyCommand, commandEnabled })

watch(selectedCaptureId, (captureId) => {
  if (captureId) annotation.connect(`match:${matchId.toLowerCase()}:capture:${captureId.toLowerCase()}`)
}, { immediate: true })
watch([selectedCaptureId, liveTarget], ([captureId, target]) => {
  if (!captureId || !target || dvr.busy.value || descriptor.value?.capture_session_id === captureId) return
  void createWindow(target)
}, { immediate: true })
watch(() => annotation.snapshot.value?.rally_id, () => {
  selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
  selectedTimelineItem.value = selectedKeyPointId.value ? 'point' : null
})
watch(completedRallies, (rallies) => {
  if (!selectedRallyId.value || !rallies.some(rally => rally.id === selectedRallyId.value)) selectedRallyId.value = rallies[0]?.id ?? null
}, { immediate: true })
watch([state, selectedKeyPointId], ([nextState]) => {
  pendingFrameMove.value = null
  if (nextState !== 'OPEN') fineTuneMode.value = false
  releaseEditingIntent()
})
onMounted(() => {
  annotationScope.value?.focus({ preventScroll: true })
  void loadMatch()
  matchRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void loadMatch({ silent: true })
  }, 2_500)
})
onBeforeUnmount(() => {
  if (matchRefreshTimer) clearInterval(matchRefreshTimer)
  if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout)
  if (cursorResolveTimer) clearTimeout(cursorResolveTimer)
  annotation.setEditingKeyPoint(null)
  detachVideoState(video.value)
})
</script>

<template>
  <section ref="annotationScope" tabindex="-1" class="editor-shell" @keydown.delete.prevent="deleteSelection" @pointerdown.capture="annotationScope?.focus({ preventScroll: true })">
    <header class="app-bar">
      <div class="window-title"><CircleDot :size="14" /><strong>{{ match?.title ?? matchId }}</strong></div>
      <nav class="window-menu" aria-label="場次工具">
        <button type="button" @click="captureDialogOpen = true"><RadioTower :size="13" />媒體資訊</button>
        <button type="button" :title="`${annotation.connection.value} · ${selectedCapture?.health ?? 'unknown'}`"><Wifi :size="13" />連線資訊</button>
        <NuxtLink :to="`/control?match=${matchId}`" target="_blank"><UsersRound :size="13" />球員編輯</NuxtLink>
      </nav>
      <div class="session-status"><i class="status-dot" :class="{ busy: annotation.busy.value || annotation.pendingCount.value > 0 || annotation.connection.value !== 'ready', error: annotation.error.value || annotation.outboxNeedsConfirmation.value }" /><span>{{ syncLabel }}</span><span v-if="annotation.presence.value.length" class="presence-count">{{ annotation.presence.value.length }}</span></div>
      <div class="app-actions">
        <span class="media-name">{{ selectedCapture?.sourceLabel ?? '等待媒體' }}</span>
        <NuxtLink to="/" aria-label="首頁" title="首頁"><Home :size="16" /></NuxtLink>
        <button type="button" aria-label="按鍵設定" title="按鍵設定" @click="settingsOpen = true"><Settings :size="16" /></button>
      </div>
    </header>

    <div class="editor-body">
      <main class="viewer-panel">
        <div class="video-stage">
          <VideoOverlayPlayer :descriptor="descriptor" :controls="false" toggle-on-click @cursor="handleCursor" @ready="handleVideoReady" @toggle="dispatchMediaAction('play_pause')" @error="mediaError = $event.message" />
          <div v-if="annotation.snapshot.value" class="stage-mask" :class="annotation.snapshot.value.snapshot.annotation_status === 'submitted' ? 'submitted' : 'draft'" />
          <div class="viewer-badges"><span v-if="descriptor">{{ descriptor.mode.toUpperCase() }}</span><span>{{ authoritativeAnchor?.capture_frame_index ?? '—' }}</span></div>
          <div v-if="!descriptor" class="stage-empty"><strong>{{ selectedCapture ? '媒體緩衝中' : '尚未加入媒體' }}</strong><button v-if="liveTarget" type="button" @click="createWindow(liveTarget)">LIVE</button></div>
          <p v-if="mediaError" class="stage-error">{{ mediaError }} <button type="button" @click="createWindow(liveTarget ?? undefined)">重試</button></p>
        </div>
      </main>

      <aside class="inspector">
        <div class="mode-switch"><button type="button" :class="{ active: inspectorTab === 'match' }" @click="inspectorTab = 'match'">場次資訊</button><button type="button" :class="{ active: inspectorTab === 'mapping' }" @click="openMapping">球員指派</button></div>
        <template v-if="inspectorTab === 'match'">
          <div class="score-board">
            <span>{{ leftTeam?.shortName || leftTeam?.name || '左隊' }}</span><b>{{ currentSet?.left_score ?? 0 }}</b><i>:</i><b>{{ currentSet?.right_score ?? 0 }}</b><span>{{ rightTeam?.shortName || rightTeam?.name || '右隊' }}</span>
          </div>
          <div class="current-segment">
            <div><span>目前片段</span><strong>{{ annotation.snapshot.value ? `#${annotation.snapshot.value.rally_id.slice(0, 6)}` : '—' }}</strong></div>
            <span class="segment-state" :class="state.toLowerCase()">{{ state === 'OPEN' ? '標記中' : state === 'READY' ? '待送出' : state === 'SUBMITTED' ? '已送出' : '待命' }}</span>
          </div>
          <dl class="segment-stats"><div><dt>擊球點</dt><dd>{{ annotation.snapshot.value?.snapshot.key_points.length ?? 0 }}</dd></div><div><dt>第幾局</dt><dd>{{ currentSet?.set_number ?? '—' }}</dd></div><div><dt>線上</dt><dd>{{ annotation.presence.value.length }}</dd></div></dl>
          <button v-if="(selectedTimelineItem === 'segment' && selectedSubmittedRally) || (state === 'SUBMITTED' && annotation.snapshot.value?.snapshot.active_submission_id)" type="button" class="correction-button" :disabled="!commandReady" @click="startCorrection"><RotateCcw :size="14" />編輯此片段</button>
          <div class="segment-list-title"><span>已送出片段</span><b>{{ submittedRallies.length }}</b></div>
          <button v-for="rally in submittedRallies" :key="rally.id" type="button" class="segment-row" :class="{ active: selectedRallyId === rally.id }" @click="selectRally(rally)">
            <span>第 {{ rally.set_number }} 局 · 回合 {{ rally.ordinal }}</span><i :class="{ processing: rally.submission.analysis?.status !== 'completed', mapped: rally.submission.analysis?.identity_mapping_completed }" />
          </button>
        </template>
        <template v-else>
          <label class="segment-picker"><span>片段</span><select v-model="selectedRallyId"><option v-for="rally in completedRallies" :key="rally.id" :value="rally.id">第 {{ rally.set_number }} 局 · 回合 {{ rally.ordinal }}</option></select></label>
          <AnnotationIdentityPanel :match-id="matchId" :analysis-run-id="selectedAnalysisRunId" :left-team-id="leftTeamId" :right-team-id="rightTeamId" :teams="coach.data.value?.match.teams ?? []" :mapping-completed="Boolean(selectedRally?.submission.analysis?.identity_mapping_completed)" @changed="coach.refresh" />
        </template>
      </aside>
    </div>

    <footer class="timeline-footer">
      <div class="transport-bar">
        <button type="button" class="transport-button" :aria-label="playing ? '暫停' : '播放'" :disabled="!descriptor" @click="dispatchMediaAction('play_pause')"><Pause v-if="playing" :size="16" fill="currentColor" /><Play v-else :size="16" fill="currentColor" /></button>
        <button type="button" class="transport-button" aria-label="前一幀" :disabled="!authoritativeAnchor || dvr.busy.value || Boolean(pendingFrameMove) || Boolean(pendingTimelineMove)" @click="dispatchMediaAction('frame_previous')">←</button>
        <button type="button" class="transport-button" aria-label="後一幀" :disabled="!authoritativeAnchor || dvr.busy.value || Boolean(pendingFrameMove) || Boolean(pendingTimelineMove)" @click="dispatchMediaAction('frame_next')">→</button>
        <code class="timecode">{{ displayTimecode }}</code>
        <button type="button" class="live-badge" :class="{ active: descriptor?.mode === 'live' }" :disabled="!liveTarget" @click="createWindow(liveTarget ?? undefined)">LIVE</button>
        <i class="transport-separator" />
        <button type="button" class="tool-button" :class="{ active: fineTuneMode }" :disabled="state !== 'OPEN' || !selectedKeyPoint || !commandReady" title="逐幀移動所選點" @click="toggleFineTuneMode"><Crosshair :size="14" />微調</button>
        <button type="button" class="tool-button" :disabled="state !== 'OPEN' || !selectedKeyPoint || !canMark || !commandReady" title="移到目前畫格" @click="editKeyPoint('MOVE_KEY_POINT')"><CircleDot :size="14" />移到游標</button>
        <button type="button" class="tool-button danger" :disabled="!selectedTimelineItem || selectedTimelineItem === 'segment' || !['OPEN', 'READY'].includes(state) || !commandReady" title="Delete" @click="deleteSelection"><Trash2 :size="14" />刪除所選</button>
        <div class="transport-spacer" />
        <button type="button" class="transport-button" :aria-label="muted ? '開啟聲音' : '靜音'" :disabled="!descriptor" @click="dispatchMediaAction('mute')"><VolumeX v-if="muted" :size="16" /><Volume2 v-else :size="16" /></button>
      </div>
      <DvrTimelineDock :timeline="timeline" :playhead="authoritativeAnchor?.capture_time_us ?? null" :annotation="annotation.snapshot.value" :editable="state === 'OPEN' && !pendingTimelineMove" :selected-key-point-id="selectedKeyPointId" :mask-selected="selectedTimelineItem === 'mask'" :segments="timelineSegments" :selected-segment-id="selectedTimelineItem === 'segment' ? selectedRallyId : null" :soft-locks="annotation.remoteEditorsByKeyPoint.value" @seek="createWindow" @select="selectTimelineKeyPoint" @select-mask="selectTimelineMask" @select-segment="selectHistoricalSegment" @edit-start="beginTimelineKeyPointEdit" @edit-cancel="cancelTimelineKeyPointEdit" @move="moveTimelineKeyPoint" />
      <AnnotationCommandStrip :bindings="bindings" :state="state" :can-mark="canMark" :last-key-point="Boolean(currentLastKeyPointId)" :command-ready="commandReady" :pending-command="annotation.pendingCount.value > 0" @action="dispatchAnnotationAction" @settings="settingsOpen = true" />
    </footer>

    <p v-if="loadError || annotation.error.value" class="global-error">{{ loadError ?? annotation.error.value }} <button type="button" @click="loadError ? loadMatch() : annotation.refreshActive()">重試</button></p>
    <p v-if="annotation.pendingCount.value" class="outbox-banner" :class="{ confirm: annotation.outboxNeedsConfirmation.value }"><span>{{ annotation.outboxNeedsConfirmation.value ? '狀態已更新，請重新操作。' : '等待同步' }}</span><button type="button" @click="annotation.discardPending">重新同步</button></p>
    <LazyAnnotationSettingsDialog v-if="settingsOpen" :open="settingsOpen" @close="settingsOpen = false" />
    <LazyCaptureControlDialog v-if="captureDialogOpen" :open="captureDialogOpen" :match-id="matchId" :captures="match?.captureSessions ?? []" @close="captureDialogOpen = false" @changed="loadMatch" />
  </section>
</template>

<style scoped>
:global(html),:global(body),:global(#__nuxt){width:100%;height:100%;margin:0;overflow:hidden}:global(body){background:#0b0d0f}.editor-shell{--surface-0:#0b0d0f;--surface-1:#121519;--line:#30363d;--line-strong:#4a535d;--muted:#98a2ad;--green:#49d88a;--amber:#f5b84b;--blue:#62a9ff;--red:#ff6b72;width:100vw;height:100dvh;display:grid;grid-template-rows:54px minmax(0,1fr) 238px;overflow:hidden;background:var(--surface-0);color:#edf1f4;font-family:"Segoe UI Variable Text",Aptos,"Segoe UI",sans-serif}.editor-shell button,.editor-shell a{min-height:34px;padding:7px 11px;border:1px solid var(--line-strong);border-radius:6px;background:#20252b;color:inherit;cursor:pointer;text-decoration:none}.editor-shell button:not(:disabled):hover,.editor-shell a:hover{border-color:#6b7681;background:#282e35}.editor-shell button:focus-visible,.editor-shell a:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.editor-shell button:disabled{opacity:.35;cursor:not-allowed}.app-bar{min-width:0;display:grid;grid-template-columns:minmax(280px,auto) minmax(220px,1fr) minmax(300px,auto);align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:#101317}.brand-block{min-width:0}.brand-block h1{margin:0;font-size:.98rem;font-weight:720}.brand-block p{margin:2px 0 0;color:var(--muted);font-size:.69rem}.session-status{min-width:0;display:flex;justify-content:center;align-items:center;gap:8px;color:#c4ccd4;font-size:.78rem}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}.status-dot.busy{background:var(--amber)}.status-dot.error{background:var(--red)}.app-actions{min-width:0;display:flex;justify-content:flex-end;align-items:center;gap:7px}.app-actions>a,.app-actions>button{width:34px;padding:0;display:grid;place-items:center}.media-name{max-width:340px;overflow:hidden;color:var(--muted);font-size:.73rem;text-overflow:ellipsis;white-space:nowrap}.editor-body{min-height:0;display:grid;grid-template-columns:minmax(0,1fr) clamp(288px,24vw,350px);overflow:hidden}.viewer-panel{min-width:0;min-height:0;display:grid;place-items:center;padding:10px;overflow:hidden;background:#050607}.video-stage{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden;background:#000;box-shadow:0 12px 38px #0006}.video-stage :deep(>div){width:100%;height:100%;border-radius:0}.video-stage :deep(video){width:100%;height:100%;object-fit:contain;cursor:pointer}.stage-mask{position:absolute;inset:0;pointer-events:none}.stage-mask.draft{background:#9ba4ae1a}.stage-mask.submitted{background:#2dcd7b14}.viewer-badges{position:absolute;top:8px;right:8px;display:flex;gap:5px;pointer-events:none}.viewer-badges span{padding:3px 6px;border:1px solid #ffffff2b;border-radius:4px;background:#050709c2;color:#d9e0e6;font:600 .66rem "Cascadia Mono",Consolas,monospace}.stage-empty{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:9px;color:#edf1f4;text-align:center}.stage-empty span{color:var(--muted);font-size:.75rem}.stage-error,.global-error,.outbox-banner{position:absolute;z-index:8;padding:9px;border-radius:5px;font-size:.72rem}.stage-error,.global-error{border:1px solid #8e4146;background:#351a1cee;color:#ffb7bb}.stage-error{left:12px;bottom:12px}.global-error{left:12px;top:64px}.outbox-banner{left:50%;top:64px;display:flex;align-items:center;gap:10px;transform:translateX(-50%);border:1px solid #856424;background:#302611ee;color:#ffd987}.outbox-banner.confirm{border-color:#8e4146;background:#351a1cee;color:#ffb7bb}.outbox-banner button{min-height:28px;padding:4px 7px}.inspector{min-height:0;padding:12px;overflow-y:auto;border-left:1px solid var(--line);background:var(--surface-1);font-size:.77rem;scrollbar-width:none}.mode-switch{display:grid;grid-template-columns:1fr 1fr;margin-bottom:12px;border:1px solid var(--line);border-radius:7px;overflow:hidden}.mode-switch button{min-height:34px;border:0;border-radius:0;background:transparent;color:var(--muted)}.mode-switch button+button{border-left:1px solid var(--line)}.mode-switch button.active{background:#273039;color:#fff}.inspector-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--line)}.inspector-heading div{display:grid;gap:2px}.inspector-heading strong{font-size:.88rem}.inspector-heading span{color:var(--muted);font-size:.69rem}.section-title{display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;color:#cdd4db;font-size:.7rem}.section-title b{min-width:22px;padding:2px 5px;border-radius:10px;background:#292f36;text-align:center}.keypoint-list{max-height:170px;margin:0;padding:0;overflow:auto;list-style:none}.keypoint-list li{min-height:34px;display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid #262c32;cursor:pointer}.keypoint-list li:hover,.keypoint-list li.selected{background:#20262c}.keypoint-list code{color:var(--muted);font-size:.66rem}.point-kind{display:grid;width:20px;height:20px;place-items:center;border-radius:50%;color:#0b0d0f;font-size:.62rem;font-weight:800;background:var(--amber)}.point-kind.contact{background:var(--blue)}.keypoint-list em{color:var(--green);font-style:normal}.empty-row{display:block;margin:0;padding:9px 5px;color:var(--muted);font-size:.7rem;overflow-wrap:anywhere}.stack-actions{display:grid;gap:6px;margin-top:8px}.stack-actions button{min-height:31px;font-size:.7rem}.stack-actions button.active{border-color:#4d8fc7;background:#15324a;color:#a9d8ff}.stack-actions .danger{color:#ff9ca1}.timeline-footer{min-height:0;display:grid;grid-template-rows:43px minmax(0,1fr) 54px;border-top:1px solid var(--line);background:#111419}.transport-bar{min-width:0;display:flex;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid #292f35}.transport-button{width:34px;min-height:31px!important;padding:0!important}.timecode{min-width:96px;margin-left:4px;color:#fff;font:700 .78rem "Cascadia Mono",Consolas,monospace}.transport-help{min-width:0;overflow:hidden;color:var(--muted);font-size:.68rem;text-overflow:ellipsis;white-space:nowrap;margin-right:auto}.mode-indicator{flex:none;padding:4px 7px;border:1px solid #43515e;border-radius:4px;color:#9fc7eb;font:700 .63rem "Cascadia Mono",Consolas,monospace}@media(max-width:1050px){.app-bar{grid-template-columns:240px 1fr 230px}.media-name{display:none}.editor-body{grid-template-columns:minmax(0,1fr) 288px}.mode-indicator{display:none}}@media(max-height:760px){.editor-shell{grid-template-rows:48px minmax(0,1fr) 210px}.brand-block p{display:none}.timeline-footer{grid-template-rows:39px minmax(0,1fr) 50px}.inspector{padding:9px}.keypoint-list{max-height:110px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.presence-count{padding:2px 6px;border:1px solid #34404a;border-radius:4px;color:#9fc7eb;font-size:.65rem}
.correction-button{width:100%;border-color:#8c6d2e!important;background:#302711!important;color:#ffe0a0!important}.correction-note{margin:4px 0 0;padding:8px;border:1px solid #64512d;border-radius:5px;background:#2a2314;color:#f0ce88;font-size:.68rem;line-height:1.45}
.keypoint-list li.remote-editing{box-shadow:inset 2px 0 #cf77e6;background:#241b2a}.keypoint-list small{color:#e3a9f2;font-size:.62rem}
</style>

<style scoped>
.editor-shell{grid-template-rows:44px minmax(0,1fr) 230px}.app-bar{grid-template-columns:auto minmax(280px,1fr) auto minmax(220px,auto);gap:12px;padding:0 10px;background:#0e1114}.window-title{min-width:0;display:flex;align-items:center;gap:7px}.window-title svg{color:#62a9ff}.window-title strong{max-width:260px;overflow:hidden;font-size:.75rem;text-overflow:ellipsis;white-space:nowrap}.window-menu{display:flex;align-items:center;gap:2px}.window-menu button,.window-menu a{width:auto!important;min-height:27px!important;display:flex!important;align-items:center;gap:5px;padding:0 8px!important;border-color:transparent!important;background:transparent!important;color:#9da6af;font-size:.65rem}.window-menu button:hover,.window-menu a:hover{background:#20262c!important;color:#eef2f5}.session-status{justify-content:flex-start;font-size:.68rem}.app-actions>a,.app-actions>button{width:30px!important;min-height:30px!important;border-color:transparent!important;border-radius:7px!important;background:transparent!important}.media-name{max-width:220px;font-size:.65rem}.editor-body{grid-template-columns:minmax(0,1fr) clamp(280px,22vw,330px)}.viewer-panel{padding:0;background:#030405}.video-stage{box-shadow:none}.viewer-badges span{border-radius:6px;font-size:.59rem}.inspector{padding:10px}.mode-switch{margin-bottom:10px;border-radius:8px}.mode-switch button{min-height:32px;font-size:.68rem}.score-board{min-height:62px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto minmax(0,1fr);align-items:center;gap:7px;padding:0 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}.score-board span{overflow:hidden;color:#aab2bb;font-size:.68rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.score-board span:last-child{text-align:right}.score-board b{font-size:1.55rem}.score-board i{color:#69737d;font-style:normal}.current-segment{min-height:52px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #282e34}.current-segment>div{display:grid;gap:2px}.current-segment span{color:#8d97a1;font-size:.62rem}.current-segment strong{font-size:.72rem}.segment-state{padding:3px 7px;border-radius:999px;background:#353c44!important;color:#c3c9d0!important;font-weight:700}.segment-state.open{background:#32373d!important}.segment-state.ready{background:#5b4519!important;color:#ffd987!important}.segment-state.submitted{background:#173f5f!important;color:#a9d7ff!important}.segment-stats{display:grid;grid-template-columns:repeat(3,1fr);margin:0;border-bottom:1px solid #282e34}.segment-stats div{min-height:53px;display:grid;place-content:center;justify-items:center;gap:2px}.segment-stats div+div{border-left:1px solid #282e34}.segment-stats dt{color:#7e8892;font-size:.6rem}.segment-stats dd{margin:0;font-size:.8rem;font-weight:700}.correction-button{min-height:34px!important;display:flex;align-items:center;justify-content:center;gap:7px;margin-top:10px}.segment-list-title{height:35px;display:flex;align-items:center;justify-content:space-between;color:#aab2bb;font-size:.65rem;font-weight:700}.segment-list-title b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;font-size:.6rem;text-align:center}.segment-row{width:100%;min-height:37px!important;display:flex;align-items:center;justify-content:space-between!important;padding:0 9px!important;border:0!important;border-bottom:1px solid #242a30!important;border-radius:0!important;background:transparent!important;font-size:.66rem}.segment-row.active{background:#202830!important}.segment-row i{width:8px;height:8px;border-radius:50%;background:#4295d8}.segment-row i.processing{background:#d5a331}.segment-row i.mapped{background:#36b878}.segment-picker{display:grid;grid-template-columns:42px 1fr;align-items:center;gap:6px;margin-bottom:10px}.segment-picker span{color:#87919b;font-size:.64rem}.segment-picker select{height:31px;padding:0 8px;border:1px solid #404951;border-radius:6px;outline:0;background:#191e23;color:#eef2f5;font-size:.67rem}.timeline-footer{grid-template-rows:42px minmax(0,1fr) 53px}.transport-bar{gap:4px;padding:4px 10px}.transport-button{display:grid;place-items:center;border-radius:7px!important}.timecode{min-width:82px;margin-left:3px;font-size:.7rem}.live-badge{min-height:22px!important;padding:2px 7px!important;border:1px solid #59636d!important;border-radius:999px!important;background:#22272d!important;color:#a9b1ba!important;font-size:.56rem!important;font-weight:800}.live-badge.active{border-color:#287a50!important;background:#173c29!important;color:#73dda2!important}.transport-separator{width:1px;height:23px;margin:0 3px;background:#30363d}.tool-button{min-height:30px!important;display:flex;align-items:center;gap:5px;padding:0 8px!important;border-color:transparent!important;background:transparent!important;color:#aab3bc!important;font-size:.63rem}.tool-button:hover:not(:disabled),.tool-button.active{background:#252c33!important;color:#fff!important}.tool-button.danger{color:#dba1a5!important}.transport-spacer{flex:1}.global-error,.outbox-banner{top:52px}.presence-count{display:grid;min-width:18px;height:18px;place-items:center;border-radius:999px}.stage-empty span{display:none}@media(max-width:1050px){.app-bar{grid-template-columns:auto 1fr auto}.window-menu{display:none}.editor-body{grid-template-columns:minmax(0,1fr) 280px}.media-name{display:none}}@media(max-height:760px){.editor-shell{grid-template-rows:42px minmax(0,1fr) 204px}.timeline-footer{grid-template-rows:39px minmax(0,1fr) 49px}.tool-button span{display:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
