<script setup lang="ts">
import { createMediaClient } from '~/lib/mediaClient'
import { useAuthoritativeDvrWindow } from '~/composables/useAuthoritativeDvrWindow'
import type { PlaybackWindowDescriptor, ResolvedMediaAnchor, CanonicalFrameAnchor } from '~/lib/mediaModel'
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
const cursorStatus = ref<'ready' | 'stale' | 'seeking' | 'gap'>('stale')
const state = ref<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED'>('IDLE')
const currentLastKeyPointId = ref<string | null>(null)
const canMark = computed(() => cursorStatus.value === 'ready')
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')

const controls = computed(() => ANNOTATION_COMMANDS.map(command => ({
  ...command,
  key: formatBindingForDisplay(bindings.value[command.action]),
  enabled: command.action === 'service' ? state.value === 'IDLE' && canMark.value : command.action === 'contact' ? state.value === 'OPEN' && canMark.value : command.action === 'submit' ? state.value === 'READY' : state.value === 'OPEN' && Boolean(currentLastKeyPointId.value),
})))

const scoreLabel = computed(() => state.value === 'IDLE' ? '等待發球' : state.value === 'OPEN' ? '回合進行中' : state.value === 'READY' ? '可提交' : '已提交')

async function loadMatch() {
  try {
    match.value = await createCoreDomainClient(createGraphQLTransport('/graphql')).match(matchId)
    if (!match.value) loadError.value = '找不到此場次，請返回賽事列表。'
  } catch (error) { loadError.value = error instanceof Error ? error.message : '場次資料載入失敗' }
}
async function handleCursor(cursor: PlaybackCursorInput) {
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
  } catch (error) { mediaError.value = error instanceof Error ? error.message : '播放視窗建立失敗' }
  finally { mediaError.value = dvr.error.value instanceof Error ? dvr.error.value.message : mediaError.value }
}

function dispatchAnnotationAction(action: AnnotationAction) {
  const control = controls.value.find(item => item.action === action); if (!control?.enabled) return
  const closesRally = action === 'close_left' || action === 'close_right' || action === 'close_unknown'
  console.info('annotation command scaffold', { action, kind: closesRally ? 'CLOSE_RALLY' : undefined, target_key_point_id: closesRally ? currentLastKeyPointId.value : undefined })
}
type PlayerAction = MediaAction | 'play_pause' | 'mute'
function dispatchMediaAction(action: PlayerAction) {
  const el = video.value; if (!el) return
  if (action === 'play_pause') void (el.paused ? el.play() : el.pause())
  if (action === 'mute') el.muted = !el.muted
  if (action === 'frame_previous' || action === 'frame_next') void frameStep(action === 'frame_next' ? 'next' : 'previous')
}
async function frameStep(direction: 'previous' | 'next') {
  if (!authoritativeAnchor.value || !descriptor.value) return
  try {
    const anchor = await dvr.step(direction, target => ({ schema_version: '1.0.0', capture_session_id: descriptor.value!.capture_session_id, mode: 'archive', target_capture_time_us: target }))
    if (!anchor) return
    const localUs = BigInt(anchor.player_media_time_us)
    if (localUs < 0n || localUs > 86_400_000_000n) throw new RangeError('frame-step returned an unbounded player time')
    if (video.value) video.value.currentTime = Number(localUs) / 1_000_000
  } catch (error) { mediaError.value = error instanceof Error ? error.message : '逐幀請求失敗' }
}
function dispatchHotkeyCommand(action: HotkeyCommand) { action.startsWith('frame_') ? dispatchMediaAction(action as MediaAction) : dispatchAnnotationAction(action as AnnotationAction) }
function commandEnabled(action: HotkeyCommand) { return action.startsWith('frame_') ? Boolean(descriptor.value && authoritativeAnchor.value && canMark.value && !dvr.busy.value) : controls.value.some(control => control.action === action && control.enabled) }
useAnnotationHotkeyRuntime({ target: annotationScope, dispatch: dispatchHotkeyCommand, commandEnabled })
onMounted(() => { annotationScope.value?.focus({ preventScroll: true }); void loadMatch() })
</script>

<template>
  <section ref="annotationScope" tabindex="-1" class="workstation" @pointerdown.capture="annotationScope?.focus({ preventScroll: true })">
    <header class="workstation__header"><div><p class="eyebrow">ANNOTATION / DVR</p><h1>{{ match?.title ?? '標註工作台' }}</h1><p>整場 DVR 由伺服器保存；瀏覽器只載入目前 bounded playback window。</p></div><span class="status-chip" :class="canMark ? 'status-chip--ready' : ''">Cursor {{ cursorStatus }}</span></header>
    <p v-if="loadError" class="state state--error">{{ loadError }} <button type="button" @click="loadMatch">重試</button></p>
    <div class="workstation__grid">
      <main class="stage"><VideoOverlayPlayer :descriptor="descriptor" @cursor="handleCursor" @ready="video = $event" @error="mediaError = $event.message" /><div v-if="!descriptor" class="stage__empty"><strong>{{ selectedCapture ? '選擇時間軸上的 ready range' : '此場次沒有可播放 capture' }}</strong><span v-if="selectedCapture">{{ selectedCapture.sourceLabel ?? selectedCapture.id }} · {{ timeline?.availableRanges.length }} 個可用區段</span><span v-else>錄影尚未就緒或你沒有存取權限。</span><button v-if="liveTarget" type="button" @click="createWindow(liveTarget)">返回 live</button></div><p v-if="mediaError" class="state state--error">{{ mediaError }} <button type="button" @click="createWindow(liveTarget ?? undefined)">重試</button></p></main>
      <aside class="rail"><h2>操作狀態</h2><dl><dt>Rally</dt><dd>{{ state }}</dd><dt>狀態</dt><dd>{{ scoreLabel }}</dd><dt>Last key point</dt><dd>{{ currentLastKeyPointId ?? '—' }}</dd></dl><p class="rail__hint">只有 server-confirmed cursor ready 時可建立 marker。</p></aside>
    </div>
    <section class="deck"><div class="timeline" aria-label="DVR availability"><div v-for="range in timeline?.availableRanges ?? []" :key="`${range.startUs}-${range.endUs}`" class="timeline__lane"><span>{{ range.startUs }}–{{ range.endUs }} <small>gap {{ range.discontinuity }}</small></span><button type="button" @click="createWindow(range.startUs)">載入</button></div><p v-if="!timeline" class="timeline__empty">等待 capture timeline</p></div><div class="deck__controls"><button type="button" @click="dispatchMediaAction('play_pause')">播放 / 暫停</button><button type="button" @click="dispatchMediaAction('frame_previous')">上一幀</button><button type="button" @click="dispatchMediaAction('frame_next')">下一幀</button><button type="button" @click="dispatchMediaAction('mute')">靜音</button><button type="button" @click="createWindow(liveTarget ?? undefined)" :disabled="!liveTarget">返回 live</button></div></section>
    <div class="annotation-actions"><button v-for="control in controls" :key="control.action" type="button" :disabled="!control.enabled" @click="dispatchAnnotationAction(control.action)"><strong>{{ control.key }} {{ control.label }}</strong><small>{{ control.enabled ? '可用' : '目前不可用' }}</small></button></div>
  </section>
</template>

<style scoped>
.workstation{color:#292521;max-width:1500px;margin:auto;padding:24px}.workstation__header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #d8d0c5;padding-bottom:18px}.eyebrow{font-size:11px;letter-spacing:.14em;color:#0f766e}.workstation h1{font-size:28px;margin:4px 0}.workstation p{color:#665f57}.status-chip{border:1px solid #bdb5ab;border-radius:999px;padding:8px 12px;height:max-content}.status-chip--ready{border-color:#0f766e;color:#0f766e}.workstation__grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:16px;margin-top:18px}.stage{position:relative;background:#171514;border-radius:14px;min-height:420px;padding:8px}.stage__empty{position:absolute;inset:0;display:grid;place-content:center;gap:8px;text-align:center;color:#eee}.stage__empty form{display:flex;gap:8px}.stage__empty input{padding:10px;border-radius:8px;border:1px solid #81776b}.stage button,.deck button,.annotation-actions button{border:1px solid #bdb5ab;border-radius:8px;padding:9px 12px;background:#faf9f7}.rail,.deck{border:1px solid #d8d0c5;border-radius:14px;background:#fff;padding:18px}.rail dl{display:grid;grid-template-columns:1fr 1fr;gap:10px}.rail dt{color:#766e65}.rail__hint{font-size:13px;margin-top:25px}.deck{margin-top:16px}.timeline{display:grid;gap:10px}.timeline__lane{display:grid;grid-template-columns:180px 1fr;align-items:center;gap:12px;font-size:12px}.timeline__lane i{height:12px;background:#5d8e88;border-radius:5px}.timeline__lane--draft i{background:#bdb5ab}.deck__controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.annotation-actions{display:grid;grid-template-columns:repeat(6,minmax(100px,1fr));gap:8px;margin-top:12px}.annotation-actions button{text-align:left;min-height:56px}.annotation-actions button:disabled{opacity:.4}.annotation-actions small{display:block;color:#766e65;margin-top:4px}.state{padding:10px;border-radius:8px}.state--error{background:#fdf0ed;color:#9b2c20}.state--error button{margin-left:8px;text-decoration:underline}@media(max-width:900px){.workstation__grid{grid-template-columns:1fr}.annotation-actions{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
