<script setup lang="ts">
import { ArrowLeft, History, RadioTower, Settings } from 'lucide-vue-next'
import { createMediaClient } from '~/lib/mediaClient'
import { useAuthoritativeDvrWindow, seekVideoToCanonicalFrame, authoritativeControlsEnabled } from '~/composables/useAuthoritativeDvrWindow'
import { createCoreDomainClient, createGraphQLTransport, type Match, type CaptureSession } from '~/lib/coreDomain'
import { ANNOTATION_COMMANDS, formatBindingForDisplay, type AnnotationAction, type HotkeyCommand, type MediaAction } from '~/utils/annotationHotkeys'
import type { PlaybackCursorInput } from '~/lib/mediaModel'

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
const state = annotation.state
const currentLastKeyPointId = computed(() => annotation.lastKeyPoint.value?.key_point_id ?? null)
const selectedKeyPointId = ref<string | null>(null)
const selectedKeyPoint = computed(() => annotation.snapshot.value?.snapshot.key_points.find(point => point.key_point_id === selectedKeyPointId.value) ?? null)
const fineTuneMode = ref(false)
const pendingFrameMove = shallowRef<{ keyPointId: string; targetFrameIndex: string } | null>(null)
const canMark = computed(() => authoritativeControlsEnabled({ cursorReady: cursorStatus.value === 'ready', status: dvr.status.value, busy: dvr.busy.value, descriptor: descriptor.value, anchor: authoritativeAnchor.value }))
const commandReady = computed(() => !annotation.busy.value && annotation.pendingCount.value === 0)
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')
const settingsOpen = ref(false)
const captureDialogOpen = ref(false)
const inspectorTab = ref<'keypoints' | 'authority'>('keypoints')
let matchRefreshTimer: ReturnType<typeof setInterval> | null = null
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

async function handleCursor(cursor: PlaybackCursorInput) {
  observedCursor.value = cursor
  cursorStatus.value = cursor.cursor_status
  if (cursor.cursor_status !== 'ready') return
  try {
    const resolved = await dvr.resolve(cursor)
    const pending = pendingFrameMove.value
    if (!resolved || !pending || resolved.capture_frame_index !== pending.targetFrameIndex) return
    pendingFrameMove.value = null
    if (!fineTuneMode.value || state.value !== 'OPEN' || selectedKeyPointId.value !== pending.keyPointId || !commandReady.value) return
    await annotation.edit('MOVE_KEY_POINT', { keyPointId: pending.keyPointId, cursor })
  }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '游標解析失敗' }
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
  void annotation.edit(kind, { keyPointId: selectedKeyPointId.value, cursor: observedCursor.value }).then(() => {
    if (kind === 'DELETE_KEY_POINT') selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
  }).catch(() => undefined)
}

function selectTimelineKeyPoint(keyPointId: string) {
  selectedKeyPointId.value = keyPointId
}

function toggleFineTuneMode() {
  if (state.value !== 'OPEN' || !selectedKeyPoint.value || !commandReady.value) return
  pendingFrameMove.value = null
  fineTuneMode.value = !fineTuneMode.value
}

function reopenRally() {
  if (state.value !== 'READY' || !commandReady.value) return
  void annotation.edit('REOPEN_RALLY').catch(() => undefined)
}

function voidRally() {
  if (!['OPEN', 'READY'].includes(state.value) || !commandReady.value) return
  if (!window.confirm('確定作廢此未提交 Rally？此操作不可在原 Rally 上復原。')) return
  void annotation.edit('VOID_RALLY', { reason: 'operator_voided_from_workstation' }).catch(() => undefined)
}

function startCorrection() {
  const submissionId = annotation.snapshot.value?.snapshot.active_submission_id
  if (!submissionId || state.value !== 'SUBMITTED' || !commandReady.value) return
  if (!window.confirm('建立修正草稿？既有 submission 仍會保留，只有再次按 Enter 後才會由新 submission 取代。')) return
  void annotation.createCorrection().then(() => {
    selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
  }).catch(() => undefined)
}

type PlayerAction = MediaAction | 'play_pause' | 'mute'
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

function dispatchHotkeyCommand(action: HotkeyCommand) { action.startsWith('frame_') ? dispatchMediaAction(action as MediaAction) : dispatchAnnotationAction(action as AnnotationAction) }
function commandEnabled(action: HotkeyCommand) { return action.startsWith('frame_') ? Boolean(descriptor.value && authoritativeAnchor.value && canMark.value && !dvr.busy.value && !pendingFrameMove.value) : controls.value.some(control => control.action === action && control.enabled) }
useAnnotationHotkeyRuntime({ target: annotationScope, dispatch: dispatchHotkeyCommand, commandEnabled })

watch(selectedCaptureId, (captureId) => {
  if (captureId) annotation.connect(`match:${matchId.toLowerCase()}:capture:${captureId.toLowerCase()}`)
}, { immediate: true })
watch([selectedCaptureId, liveTarget], ([captureId, target]) => {
  if (!captureId || !target || dvr.busy.value || descriptor.value?.capture_session_id === captureId) return
  void createWindow(target)
}, { immediate: true })
watch(() => annotation.snapshot.value?.rally_id, () => { selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null })
watch([state, selectedKeyPointId], ([nextState]) => {
  pendingFrameMove.value = null
  if (nextState !== 'OPEN') fineTuneMode.value = false
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
  detachVideoState(video.value)
})
</script>

<template>
  <section ref="annotationScope" tabindex="-1" class="editor-shell" @pointerdown.capture="annotationScope?.focus({ preventScroll: true })">
    <header class="app-bar">
      <div class="brand-block"><h1>Volleyball Monitoring AI</h1><p>Server DVR · Keypoint Editor · Immutable Submission</p></div>
      <div class="session-status"><i class="status-dot" :class="{ busy: annotation.busy.value || annotation.pendingCount.value > 0 || annotation.connection.value !== 'ready', error: annotation.error.value || annotation.outboxNeedsConfirmation.value }" /><span>{{ syncLabel }}</span><span v-if="annotation.presence.value.length" class="presence-count" :title="annotation.presence.value.map(member => member.display_name).join('、')">{{ annotation.presence.value.length }} 人在線</span></div>
      <div class="app-actions"><span class="media-name">{{ match?.title ?? matchId }} · {{ selectedCapture?.sourceLabel ?? selectedCapture?.id ?? '等待 capture' }}</span><NuxtLink to="/" aria-label="返回場次"><ArrowLeft :size="17" /></NuxtLink><NuxtLink :to="`/matches/${matchId}/history`" aria-label="查看紀錄"><History :size="17" /></NuxtLink><button type="button" aria-label="串流來源" title="串流來源" @click="captureDialogOpen = true"><RadioTower :size="18" /></button><button type="button" aria-label="Annotation 設定" title="Annotation 設定" @click="settingsOpen = true"><Settings :size="18" /></button></div>
    </header>

    <div class="editor-body">
      <main class="viewer-panel">
        <div class="video-stage">
          <VideoOverlayPlayer :descriptor="descriptor" :controls="false" toggle-on-click @cursor="handleCursor" @ready="handleVideoReady" @toggle="dispatchMediaAction('play_pause')" @error="mediaError = $event.message" />
          <div v-if="annotation.snapshot.value" class="stage-mask" :class="annotation.snapshot.value.snapshot.annotation_status === 'submitted' ? 'submitted' : 'draft'" />
          <div class="viewer-badges"><span v-if="descriptor">{{ descriptor.mode.toUpperCase() }}</span><span>frame {{ authoritativeAnchor?.capture_frame_index ?? '—' }}</span></div>
          <div v-if="!descriptor" class="stage-empty"><strong>{{ selectedCapture ? '選擇時間軸上的 ready range' : '此場次沒有可播放 capture' }}</strong><span>{{ selectedCapture ? `${timeline?.availableRanges.length ?? 0} 個可用串流區段` : '錄影尚未就緒或你沒有存取權限。' }}</span><button v-if="liveTarget" type="button" @click="createWindow(liveTarget)">返回 live</button></div>
          <p v-if="mediaError" class="stage-error">{{ mediaError }} <button type="button" @click="createWindow(liveTarget ?? undefined)">重試</button></p>
        </div>
      </main>

      <aside class="inspector">
        <div class="mode-switch"><button type="button" :class="{ active: inspectorTab === 'keypoints' }" @click="inspectorTab = 'keypoints'">片段 Keypoint</button><button type="button" :class="{ active: inspectorTab === 'authority' }" @click="inspectorTab = 'authority'">DVR Authority</button></div>
        <template v-if="inspectorTab === 'authority'"><DvrAuthorityInspector :match="match" :capture="selectedCapture" :descriptor="descriptor" :anchor="authoritativeAnchor" :status="dvr.status.value" /></template>
        <template v-else>
          <div class="inspector-heading"><div><strong>{{ state.toLowerCase() }}</strong><span>revision {{ annotation.snapshot.value?.revision ?? '0' }}</span></div><span>{{ annotation.snapshot.value?.snapshot.score_resolution ?? 'pending' }}<template v-if="annotation.snapshot.value?.snapshot.scoring_court_side"> / {{ annotation.snapshot.value.snapshot.scoring_court_side }}</template></span></div>
          <div class="section-title"><span>目前 Rally keypoints</span><b>{{ annotation.snapshot.value?.snapshot.key_points.length ?? 0 }}</b></div>
          <p v-if="!annotation.snapshot.value" class="empty-row">尚未建立 Rally；按 Z 標記 service。</p>
          <ul v-else class="keypoint-list">
            <li v-for="point in annotation.snapshot.value.snapshot.key_points" :key="point.key_point_id" :class="{ selected: selectedKeyPointId === point.key_point_id }" @click="selectedKeyPointId = point.key_point_id">
              <i class="point-kind" :class="{ contact: point.marker_kind === 'contact' }">{{ point.marker_kind === 'service' ? 'Z' : '•' }}</i><span>{{ point.marker_kind }}<em v-if="point.is_terminal"> · terminal</em></span><code>{{ formatTimecode(point.capture_time_us) }}</code>
            </li>
          </ul>
          <div class="stack-actions"><button type="button" :class="{ active: fineTuneMode }" :disabled="state !== 'OPEN' || !selectedKeyPoint || !commandReady" @click="toggleFineTuneMode">逐幀微調：{{ fineTuneMode ? '開啟' : '關閉' }}</button><button type="button" :disabled="state !== 'OPEN' || !selectedKeyPoint || !canMark || !commandReady" @click="editKeyPoint('MOVE_KEY_POINT')">將所選點移到目前畫格</button><button type="button" :disabled="state !== 'OPEN' || !selectedKeyPoint || selectedKeyPoint.marker_kind === 'service' || !commandReady" @click="editKeyPoint('DELETE_KEY_POINT')">刪除所選 contact</button><button type="button" :disabled="state !== 'READY' || !commandReady" @click="reopenRally">重新開啟 Rally</button><button type="button" class="danger" :disabled="!['OPEN', 'READY'].includes(state) || !commandReady" @click="voidRally">作廢未提交 Rally</button></div>
          <div class="section-title"><span>不可變提交</span><b>{{ annotation.snapshot.value?.snapshot.active_submission_id ? 1 : 0 }}</b></div>
          <p class="empty-row">{{ annotation.snapshot.value?.snapshot.active_submission_id ? annotation.snapshot.value.snapshot.active_submission_id : '尚無 immutable submission' }}</p>
          <button v-if="state === 'SUBMITTED' && annotation.snapshot.value?.snapshot.active_submission_id" type="button" class="correction-button" :disabled="!commandReady" @click="startCorrection">建立修正草稿</button>
          <p v-else-if="annotation.snapshot.value?.snapshot.active_submission_id && ['OPEN', 'READY'].includes(state)" class="correction-note">目前是灰色 correction draft；完成修改後按 Enter 建立新的 immutable submission。</p>
        </template>
      </aside>
    </div>

    <footer class="timeline-footer">
      <div class="transport-bar"><button type="button" class="transport-button" :aria-label="playing ? '暫停' : '播放'" :disabled="!descriptor" @click="dispatchMediaAction('play_pause')">{{ playing ? 'Ⅱ' : '▶' }}</button><button type="button" class="transport-button" aria-label="前一幀" :disabled="!authoritativeAnchor || dvr.busy.value || Boolean(pendingFrameMove)" @click="dispatchMediaAction('frame_previous')">←</button><button type="button" class="transport-button" aria-label="後一幀" :disabled="!authoritativeAnchor || dvr.busy.value || Boolean(pendingFrameMove)" @click="dispatchMediaAction('frame_next')">→</button><code class="timecode">{{ displayTimecode }}</code><span class="transport-help">{{ fineTuneMode ? '微調模式：← / → 逐幀並移動所選 marker' : 'Space 接觸點 · 滾輪平移 · Shift + 滾輪縮放 · ← / → 逐幀播放' }}</span><button type="button" :disabled="!descriptor" @click="dispatchMediaAction('mute')">{{ muted ? '開啟聲音' : '靜音' }}</button><button type="button" :disabled="!liveTarget" @click="createWindow(liveTarget ?? undefined)">返回 LIVE</button><span class="mode-indicator">{{ fineTuneMode ? 'FINE-TUNE' : 'KEYPOINT MODE' }}</span></div>
      <DvrTimelineDock :timeline="timeline" :playhead="authoritativeAnchor?.capture_time_us ?? null" :annotation="annotation.snapshot.value" :editable="state === 'OPEN'" :selected-key-point-id="selectedKeyPointId" @seek="createWindow" @select="selectTimelineKeyPoint" />
      <AnnotationCommandStrip :bindings="bindings" :state="state" :can-mark="canMark" :last-key-point="Boolean(currentLastKeyPointId)" :command-ready="commandReady" :pending-command="annotation.pendingCount.value > 0" @action="dispatchAnnotationAction" />
    </footer>

    <p v-if="loadError || annotation.error.value" class="global-error">{{ loadError ?? annotation.error.value }} <button type="button" @click="loadError ? loadMatch() : annotation.refreshActive()">重試</button></p>
    <p v-if="annotation.pendingCount.value" class="outbox-banner" :class="{ confirm: annotation.outboxNeedsConfirmation.value }"><span>{{ annotation.outboxNeedsConfirmation.value ? '伺服器狀態已變更；請捨棄後在目前畫格重新操作。' : '操作已保存在本機，恢復連線後會以相同 command ID 送出。' }}</span><button type="button" @click="annotation.discardPending">捨棄並同步</button></p>
    <AnnotationSettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
    <CaptureControlDialog :open="captureDialogOpen" :match-id="matchId" :captures="match?.captureSessions ?? []" @close="captureDialogOpen = false" @changed="loadMatch" />
  </section>
</template>

<style scoped>
:global(html),:global(body),:global(#__nuxt){width:100%;height:100%;margin:0;overflow:hidden}:global(body){background:#0b0d0f}.editor-shell{--surface-0:#0b0d0f;--surface-1:#121519;--line:#30363d;--line-strong:#4a535d;--muted:#98a2ad;--green:#49d88a;--amber:#f5b84b;--blue:#62a9ff;--red:#ff6b72;width:100vw;height:100dvh;display:grid;grid-template-rows:54px minmax(0,1fr) 238px;overflow:hidden;background:var(--surface-0);color:#edf1f4;font-family:"Segoe UI Variable Text",Aptos,"Segoe UI",sans-serif}.editor-shell button,.editor-shell a{min-height:34px;padding:7px 11px;border:1px solid var(--line-strong);border-radius:6px;background:#20252b;color:inherit;cursor:pointer;text-decoration:none}.editor-shell button:not(:disabled):hover,.editor-shell a:hover{border-color:#6b7681;background:#282e35}.editor-shell button:focus-visible,.editor-shell a:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.editor-shell button:disabled{opacity:.35;cursor:not-allowed}.app-bar{min-width:0;display:grid;grid-template-columns:minmax(280px,auto) minmax(220px,1fr) minmax(300px,auto);align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:#101317}.brand-block{min-width:0}.brand-block h1{margin:0;font-size:.98rem;font-weight:720}.brand-block p{margin:2px 0 0;color:var(--muted);font-size:.69rem}.session-status{min-width:0;display:flex;justify-content:center;align-items:center;gap:8px;color:#c4ccd4;font-size:.78rem}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}.status-dot.busy{background:var(--amber)}.status-dot.error{background:var(--red)}.app-actions{min-width:0;display:flex;justify-content:flex-end;align-items:center;gap:7px}.app-actions>a,.app-actions>button{width:34px;padding:0;display:grid;place-items:center}.media-name{max-width:340px;overflow:hidden;color:var(--muted);font-size:.73rem;text-overflow:ellipsis;white-space:nowrap}.editor-body{min-height:0;display:grid;grid-template-columns:minmax(0,1fr) clamp(288px,24vw,350px);overflow:hidden}.viewer-panel{min-width:0;min-height:0;display:grid;place-items:center;padding:10px;overflow:hidden;background:#050607}.video-stage{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden;background:#000;box-shadow:0 12px 38px #0006}.video-stage :deep(>div){width:100%;height:100%;border-radius:0}.video-stage :deep(video){width:100%;height:100%;object-fit:contain;cursor:pointer}.stage-mask{position:absolute;inset:0;pointer-events:none}.stage-mask.draft{background:#9ba4ae1a}.stage-mask.submitted{background:#2dcd7b14}.viewer-badges{position:absolute;top:8px;right:8px;display:flex;gap:5px;pointer-events:none}.viewer-badges span{padding:3px 6px;border:1px solid #ffffff2b;border-radius:4px;background:#050709c2;color:#d9e0e6;font:600 .66rem "Cascadia Mono",Consolas,monospace}.stage-empty{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:9px;color:#edf1f4;text-align:center}.stage-empty span{color:var(--muted);font-size:.75rem}.stage-error,.global-error,.outbox-banner{position:absolute;z-index:8;padding:9px;border-radius:5px;font-size:.72rem}.stage-error,.global-error{border:1px solid #8e4146;background:#351a1cee;color:#ffb7bb}.stage-error{left:12px;bottom:12px}.global-error{left:12px;top:64px}.outbox-banner{left:50%;top:64px;display:flex;align-items:center;gap:10px;transform:translateX(-50%);border:1px solid #856424;background:#302611ee;color:#ffd987}.outbox-banner.confirm{border-color:#8e4146;background:#351a1cee;color:#ffb7bb}.outbox-banner button{min-height:28px;padding:4px 7px}.inspector{min-height:0;padding:12px;overflow-y:auto;border-left:1px solid var(--line);background:var(--surface-1);font-size:.77rem;scrollbar-width:none}.mode-switch{display:grid;grid-template-columns:1fr 1fr;margin-bottom:12px;border:1px solid var(--line);border-radius:7px;overflow:hidden}.mode-switch button{min-height:34px;border:0;border-radius:0;background:transparent;color:var(--muted)}.mode-switch button+button{border-left:1px solid var(--line)}.mode-switch button.active{background:#273039;color:#fff}.inspector-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--line)}.inspector-heading div{display:grid;gap:2px}.inspector-heading strong{font-size:.88rem}.inspector-heading span{color:var(--muted);font-size:.69rem}.section-title{display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;color:#cdd4db;font-size:.7rem}.section-title b{min-width:22px;padding:2px 5px;border-radius:10px;background:#292f36;text-align:center}.keypoint-list{max-height:170px;margin:0;padding:0;overflow:auto;list-style:none}.keypoint-list li{min-height:34px;display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid #262c32;cursor:pointer}.keypoint-list li:hover,.keypoint-list li.selected{background:#20262c}.keypoint-list code{color:var(--muted);font-size:.66rem}.point-kind{display:grid;width:20px;height:20px;place-items:center;border-radius:50%;color:#0b0d0f;font-size:.62rem;font-weight:800;background:var(--amber)}.point-kind.contact{background:var(--blue)}.keypoint-list em{color:var(--green);font-style:normal}.empty-row{display:block;margin:0;padding:9px 5px;color:var(--muted);font-size:.7rem;overflow-wrap:anywhere}.stack-actions{display:grid;gap:6px;margin-top:8px}.stack-actions button{min-height:31px;font-size:.7rem}.stack-actions button.active{border-color:#4d8fc7;background:#15324a;color:#a9d8ff}.stack-actions .danger{color:#ff9ca1}.timeline-footer{min-height:0;display:grid;grid-template-rows:43px minmax(0,1fr) 54px;border-top:1px solid var(--line);background:#111419}.transport-bar{min-width:0;display:flex;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid #292f35}.transport-button{width:34px;min-height:31px!important;padding:0!important}.timecode{min-width:96px;margin-left:4px;color:#fff;font:700 .78rem "Cascadia Mono",Consolas,monospace}.transport-help{min-width:0;overflow:hidden;color:var(--muted);font-size:.68rem;text-overflow:ellipsis;white-space:nowrap;margin-right:auto}.mode-indicator{flex:none;padding:4px 7px;border:1px solid #43515e;border-radius:4px;color:#9fc7eb;font:700 .63rem "Cascadia Mono",Consolas,monospace}@media(max-width:1050px){.app-bar{grid-template-columns:240px 1fr 230px}.media-name{display:none}.editor-body{grid-template-columns:minmax(0,1fr) 288px}.mode-indicator{display:none}}@media(max-height:760px){.editor-shell{grid-template-rows:48px minmax(0,1fr) 210px}.brand-block p{display:none}.timeline-footer{grid-template-rows:39px minmax(0,1fr) 50px}.inspector{padding:9px}.keypoint-list{max-height:110px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.presence-count{padding:2px 6px;border:1px solid #34404a;border-radius:4px;color:#9fc7eb;font-size:.65rem}
.correction-button{width:100%;border-color:#8c6d2e!important;background:#302711!important;color:#ffe0a0!important}.correction-note{margin:4px 0 0;padding:8px;border:1px solid #64512d;border-radius:5px;background:#2a2314;color:#f0ce88;font-size:.68rem;line-height:1.45}
</style>
