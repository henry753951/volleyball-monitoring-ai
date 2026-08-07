<script setup lang="ts">
import { createMediaClient } from '~/lib/mediaClient'
import { useAuthoritativeDvrWindow, seekVideoToCanonicalFrame, authoritativeControlsEnabled } from '~/composables/useAuthoritativeDvrWindow'
import type { PlaybackWindowDescriptor, ResolvedMediaAnchor } from '~/lib/mediaModel'
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
const captureTarget = ref('')
const mediaError = ref<string | null>(null)
const authoritativeAnchor = computed(() => dvr.anchor.value)
const observedCursor = shallowRef<PlaybackCursorInput | null>(null)
const cursorStatus = ref<'ready' | 'stale' | 'seeking' | 'gap'>('stale')
const annotation = useAnnotationRoom()
const state = annotation.state
const currentLastKeyPointId = computed(() => annotation.lastKeyPoint.value?.key_point_id ?? null)
const canMark = computed(() => authoritativeControlsEnabled({ cursorReady: cursorStatus.value === 'ready', status: dvr.status.value, busy: dvr.busy.value, descriptor: descriptor.value, anchor: authoritativeAnchor.value }))
const commandReady = computed(() => annotation.connection.value === 'ready' && !annotation.busy.value)
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')

const controls = computed(() => ANNOTATION_COMMANDS.map(command => ({
  ...command,
  key: formatBindingForDisplay(bindings.value[command.action]),
  enabled: commandReady.value && (command.action === 'service'
    ? ['IDLE', 'SUBMITTED'].includes(state.value) && canMark.value
    : command.action === 'contact'
      ? state.value === 'OPEN' && canMark.value
      : command.action === 'submit'
        ? state.value === 'READY'
        : state.value === 'OPEN' && Boolean(currentLastKeyPointId.value)),
})))

async function loadMatch() {
  try {
    match.value = await createCoreDomainClient(createGraphQLTransport('/graphql')).match(matchId)
    if (!match.value) loadError.value = '找不到此場次，請返回賽事列表。'
  }
  catch (error) {
    loadError.value = error instanceof Error ? error.message : '場次資料載入失敗'
  }
}

async function handleCursor(cursor: PlaybackCursorInput) {
  observedCursor.value = cursor
  cursorStatus.value = cursor.cursor_status
  if (cursor.cursor_status !== 'ready') return
  try { await dvr.resolve(cursor) }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '游標解析失敗' }
}

const selectedCapture = computed<CaptureSession | null>(() => {
  const sessions = (match.value?.captureSessions ?? []).filter(session => session.timeline?.availableRanges.length)
  return sessions.slice().sort((a, b) => (Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '')) || a.id.localeCompare(b.id))[0] ?? null
})
const timeline = computed(() => selectedCapture.value?.timeline ?? null)
const liveTarget = computed(() => timeline.value?.liveEdgeCaptureTimeUs ?? timeline.value?.availableRanges.at(-1)?.endUs ?? null)

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

type PlayerAction = MediaAction | 'play_pause' | 'mute'
function dispatchMediaAction(action: PlayerAction) {
  const element = video.value
  if (!element) return
  if (action === 'play_pause') void (element.paused ? element.play() : element.pause())
  if (action === 'mute') element.muted = !element.muted
  if (action === 'frame_previous' || action === 'frame_next') void frameStep(action === 'frame_next' ? 'next' : 'previous')
}

async function frameStep(direction: 'previous' | 'next') {
  if (!authoritativeAnchor.value || !descriptor.value) return
  try {
    const anchor = await dvr.step(direction, target => ({ schema_version: '1.0.0', capture_session_id: descriptor.value!.capture_session_id, mode: descriptor.value!.mode, target_capture_time_us: target }))
    if (!anchor) return
    const localUs = BigInt(anchor.player_media_time_us)
    if (localUs < 0n || localUs > 86_400_000_000n) throw new RangeError('frame-step returned an unbounded player time')
    if (video.value) seekVideoToCanonicalFrame(video.value, anchor)
  }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '逐幀請求失敗' }
}

function dispatchHotkeyCommand(action: HotkeyCommand) { action.startsWith('frame_') ? dispatchMediaAction(action as MediaAction) : dispatchAnnotationAction(action as AnnotationAction) }
function commandEnabled(action: HotkeyCommand) { return action.startsWith('frame_') ? Boolean(descriptor.value && authoritativeAnchor.value && canMark.value && !dvr.busy.value) : controls.value.some(control => control.action === action && control.enabled) }
useAnnotationHotkeyRuntime({ target: annotationScope, dispatch: dispatchHotkeyCommand, commandEnabled })

watch(selectedCapture, (capture) => {
  if (capture) annotation.connect(`match:${matchId.toLowerCase()}:capture:${capture.id.toLowerCase()}`)
}, { immediate: true })
onMounted(() => { annotationScope.value?.focus({ preventScroll: true }); void loadMatch() })
</script>

<template>
  <section ref="annotationScope" tabindex="-1" class="workstation" @pointerdown.capture="annotationScope?.focus({ preventScroll: true })">
    <header class="workstation__header"><div><p class="eyebrow">ANNOTATION / DVR</p><h1>{{ match?.title ?? '標註工作台' }}</h1><p>整場 DVR 由伺服器保存；命令與 revision 以伺服器 ACK / snapshot 為準。</p></div><div class="status-row"><span class="status-chip" :class="canMark ? 'status-chip--ready' : ''">Cursor {{ cursorStatus }}</span><span class="status-chip" :class="commandReady ? 'status-chip--ready' : ''">WS {{ annotation.connection.value }}</span><span class="status-chip">{{ state }}</span></div></header>
    <p v-if="loadError" class="state state--error">{{ loadError }} <button type="button" @click="loadMatch">重試</button></p>
    <div class="workstation__grid">
      <main class="stage"><VideoOverlayPlayer :descriptor="descriptor" @cursor="handleCursor" @ready="video = $event" @error="mediaError = $event.message" /><div v-if="!descriptor" class="stage__empty"><strong>{{ selectedCapture ? '選擇時間軸上的 ready range' : '此場次沒有可播放 capture' }}</strong><span v-if="selectedCapture">{{ selectedCapture.sourceLabel ?? selectedCapture.id }} · {{ timeline?.availableRanges.length }} 個可用區段</span><span v-else>錄影尚未就緒或你沒有存取權限。</span><button v-if="liveTarget" type="button" @click="createWindow(liveTarget)">返回 live</button></div><p v-if="mediaError" class="state state--error">{{ mediaError }} <button type="button" @click="createWindow(liveTarget ?? undefined)">重試</button></p></main>
      <div class="inspector-stack"><DvrAuthorityInspector :match="match" :capture="selectedCapture" :descriptor="descriptor" :anchor="authoritativeAnchor" :status="dvr.status.value" /><aside class="annotation-inspector"><h2>Server Rally</h2><p v-if="!annotation.snapshot.value">沒有 OPEN / READY Rally</p><template v-else><dl><dt>Rally</dt><dd>{{ annotation.snapshot.value.rally_id }}</dd><dt>Revision</dt><dd>{{ annotation.snapshot.value.revision }}</dd><dt>Outcome</dt><dd>{{ annotation.snapshot.value.snapshot.score_resolution }} {{ annotation.snapshot.value.snapshot.scoring_court_side ?? '' }}</dd><dt>Processing</dt><dd>{{ annotation.snapshot.value.snapshot.processing_status }}</dd></dl><ol><li v-for="point in annotation.snapshot.value.snapshot.key_points" :key="point.key_point_id"><strong>{{ point.sequence_index }} · {{ point.marker_kind }}</strong><span>frame {{ point.capture_frame_index }} · {{ point.timing_precision }}</span></li></ol></template></aside></div>
    </div>
    <p v-if="annotation.error.value" class="state state--error">{{ annotation.error.value }} <button type="button" @click="annotation.refreshActive">重新同步</button></p>
    <section class="deck"><DvrTimelineDock :timeline="timeline" :playhead="authoritativeAnchor?.capture_time_us ?? null" :annotation="annotation.snapshot.value" @seek="createWindow" /><div class="deck__controls"><button type="button" @click="dispatchMediaAction('play_pause')">播放 / 暫停</button><button type="button" @click="dispatchMediaAction('frame_previous')">上一幀</button><button type="button" @click="dispatchMediaAction('frame_next')">下一幀</button><button type="button" @click="dispatchMediaAction('mute')">靜音</button><button type="button" @click="createWindow(liveTarget ?? undefined)" :disabled="!liveTarget">返回 live</button></div></section>
    <AnnotationCommandStrip :bindings="bindings" :state="state" :can-mark="canMark" :last-key-point="Boolean(currentLastKeyPointId)" :command-ready="commandReady" @action="dispatchAnnotationAction" />
  </section>
</template>

<style scoped>
.workstation{color:#292521;max-width:1500px;margin:auto;padding:24px}.workstation__header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #d8d0c5;padding-bottom:18px}.workstation h1{font-size:28px;margin:4px 0}.workstation p{color:#665f57}.status-row{display:flex;gap:7px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}.status-chip{border:1px solid #bdb5ab;border-radius:999px;padding:8px 12px;height:max-content}.status-chip--ready{border-color:#0f766e;color:#0f766e}.workstation__grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;margin-top:18px}.stage{position:relative;background:#171514;border-radius:14px;min-height:420px;padding:8px}.stage__empty{position:absolute;inset:0;display:grid;place-content:center;gap:8px;text-align:center;color:#eee}.stage__empty form{display:flex;gap:8px}.stage__empty input{padding:10px;border-radius:8px;border:1px solid #81776b}.stage button,.deck button{border:1px solid #bdb5ab;border-radius:8px;padding:9px 12px;background:#faf9f7}.inspector-stack{display:grid;gap:12px;align-content:start}.annotation-inspector{border:1px solid #d8d0c5;border-radius:12px;background:#fff;padding:14px;min-width:0}.annotation-inspector h2{font-size:14px;margin:0 0 10px}.annotation-inspector dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:5px;font-size:11px}.annotation-inspector dt{color:#766e65}.annotation-inspector dd{margin:0;overflow-wrap:anywhere}.annotation-inspector ol{padding-left:22px;max-height:220px;overflow:auto}.annotation-inspector li{padding:5px 0}.annotation-inspector li span{display:block;color:#766e65;font-size:10px}.deck{border:1px solid #d8d0c5;border-radius:14px;background:#fff;padding:18px;margin-top:16px}.deck__controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.state{padding:10px;border-radius:8px}.state--error{background:#fdf0ed;color:#9b2c20}.state--error button{margin-left:8px;text-decoration:underline}@media(max-width:900px){.workstation__grid{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
