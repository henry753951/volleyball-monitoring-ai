<script setup lang="ts">
import { CircleAlert, LoaderCircle, Square, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import UiButton from '~/components/ui/Button.vue'
import YoutubeAuthCard from '~/components/YoutubeAuthCard.vue'
import type { CaptureSession } from '~/lib/coreDomain'
import { createCoreDomainClient, createGraphQLTransport } from '~/lib/coreDomain'
import {
  createMediaSourceClient,
  type MatchMediaSourceDraft,
  type RtmpSourceCredentials,
} from '~/lib/mediaSourceClient'

const props = defineProps<{ open: boolean; matchId: string; captures: CaptureSession[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const domain = createCoreDomainClient(createGraphQLTransport('/graphql'))
const mediaSources = createMediaSourceClient()
const source = ref<MatchMediaSourceDraft>({ kind: 'youtube', label: '', url: '' })
const pending = ref(false)
const stoppingId = ref<string | null>(null)
const captureToStop = shallowRef<CaptureSession | null>(null)
const error = ref<string | null>(null)
const rtmpCredentials = shallowRef<RtmpSourceCredentials | null>(null)
const retryingId = ref<string | null>(null)
const clearingId = ref<string | null>(null)

const activeCapture = computed(
  () =>
    props.captures.find(capture =>
      ['STARTING', 'LIVE', 'STOPPING'].includes(capture.status.toUpperCase()),
    ) ?? null,
)
const failedCaptures = computed(() =>
  props.captures.filter(capture => capture.status.toUpperCase() === 'FAILED'),
)
const captureToStopName = computed(() =>
  captureToStop.value ? sourceName(captureToStop.value) : '目前來源',
)
const canSubmit = computed(() => {
  if (pending.value || activeCapture.value) return false
  if (source.value.kind === 'youtube') return Boolean(source.value.url.trim())
  if (source.value.kind === 'local_mp4') return Boolean(source.value.file?.name)
  if (source.value.kind === 'rtmp') return true
  return false
})

function statusLabel(status: string) {
  if (status.toUpperCase() === 'LIVE') return '已連線'
  if (status.toUpperCase() === 'STARTING') return '連線中'
  if (status.toUpperCase() === 'STOPPING') return '停止中'
  return '已停止'
}

function healthLabel(health: string) {
  if (health.toUpperCase() === 'HEALTHY') return '訊號正常'
  if (health.toUpperCase() === 'DEGRADED') return '訊號不穩'
  if (health.toUpperCase() === 'STARTING') return '偵測中'
  return '無訊號'
}

function sourceName(capture: CaptureSession) {
  return capture.sourceLabel?.trim() || '影音來源'
}

function resetSource() {
  source.value = { kind: 'youtube', label: '', url: '' }
  rtmpCredentials.value = null
}

function validateSource() {
  if (source.value.kind === 'youtube') {
    try {
      const url = new URL(source.value.url.trim())
      if (
        !['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(
          url.hostname.toLowerCase(),
        )
      )
        throw new Error()
    } catch {
      return '請輸入有效的 YouTube 影片或直播網址。'
    }
  }
  if (source.value.kind === 'local_mp4' && !source.value.file.name)
    return '請選擇要上傳的 MP4 檔案。'
  return null
}

async function loadRtmpCredentials(capture: CaptureSession | null) {
  if (capture?.sourceKind.trim().toLowerCase() !== 'rtmp') return
  try {
    rtmpCredentials.value = await mediaSources.rtmpCredentials(capture.id)
  } catch {
    rtmpCredentials.value = null
  }
}

watch(
  () => props.open,
  open => {
    if (!open) return
    error.value = null
    resetSource()
    void loadRtmpCredentials(activeCapture.value)
  },
)

async function copy(value: string) {
  await navigator.clipboard.writeText(value)
  toast.success('已複製')
}

async function start() {
  if (!canSubmit.value) return
  const validationError = validateSource()
  if (validationError) {
    error.value = validationError
    return
  }
  pending.value = true
  error.value = null
  try {
    const result = await mediaSources.create(props.matchId, source.value)
    emit('changed')
    if (source.value.kind === 'rtmp' && result?.rtmp) {
      rtmpCredentials.value = result.rtmp
      toast.success('RTMP 來源已建立，請先複製連結與 Key')
      return
    }
    resetSource()
    emit('close')
    toast.success('影音來源已加入')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '無法加入影音來源'
    toast.error(error.value)
  } finally {
    pending.value = false
  }
}

function stop(capture: CaptureSession) {
  if (!stoppingId.value) captureToStop.value = capture
}

async function confirmStop() {
  const capture = captureToStop.value
  captureToStop.value = null
  if (!capture || stoppingId.value) return
  stoppingId.value = capture.id
  error.value = null
  try {
    await domain.stopCapture(capture.id)
    emit('changed')
    toast.success('影音來源已停止')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '無法停止影音來源'
    toast.error(error.value)
  } finally {
    stoppingId.value = null
  }
}

function isYoutube(capture: CaptureSession) {
  return capture.sourceKind.trim().toLowerCase().startsWith('youtube')
}

async function retrySource(capture: CaptureSession) {
  if (retryingId.value) return
  retryingId.value = capture.id
  try {
    const result = await mediaSources.retryMediaSource(capture.id, capture.sourceKind)
    emit('changed')
    toast.success(
      isYoutube(capture)
        ? `已強制重新載入 YouTube（使用最新 Cookie，第 ${result.attempt} 次嘗試）`
        : `已重新排入媒體處理（第 ${result.attempt} 次嘗試）`,
    )
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : '媒體來源重新處理失敗')
  } finally {
    retryingId.value = null
  }
}

async function clearSource(capture: CaptureSession) {
  if (clearingId.value) return
  if (!window.confirm('只清除這個失敗的媒體任務？已有媒體或標註資料時系統會拒絕刪除。')) return
  clearingId.value = capture.id
  try {
    await mediaSources.clearMediaSource(capture.id)
    emit('changed')
    toast.success('失敗媒體任務已清除')
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : '媒體任務清除失敗')
  } finally {
    clearingId.value = null
  }
}
</script>

<template>
  <UiAnimatedModal
    :open="open"
    title="影音來源"
    description="管理此場次的影片、直播與本機檔案"
    width="wide"
    height="tall"
    @close="emit('close')"
  >
    <UiScrollArea class="capture-scroll">
      <div class="capture-dialog">
        <section class="source-list" aria-labelledby="active-source-title">
          <div class="section-heading">
            <div>
              <span class="eyebrow">單一來源</span>
              <h2 id="active-source-title">目前影音來源</h2>
            </div>
          </div>
          <p v-if="!activeCapture" class="empty">目前沒有進行中的影音來源。</p>
          <article v-else class="source-row">
            <div class="source-copy">
              <div class="source-name">
                <span
                  class="status-dot"
                  :class="{ healthy: activeCapture.health.toUpperCase() === 'HEALTHY' }"
                />{{ sourceName(activeCapture) }}
              </div>
              <span class="source-status"
                >{{ statusLabel(activeCapture.status) }} <span aria-hidden="true">·</span>
                {{ healthLabel(activeCapture.health) }}</span
              >
            </div>
            <UiButton
              variant="ghost"
              size="sm"
              :disabled="Boolean(stoppingId) || activeCapture.status.toUpperCase() === 'STOPPING'"
              @click="stop(activeCapture)"
            >
              <LoaderCircle v-if="stoppingId === activeCapture.id" class="spin" :size="13" />
              <Square v-else :size="12" />
              {{ stoppingId === activeCapture.id ? '停止中…' : '停止' }}
            </UiButton>
          </article>
          <div v-if="rtmpCredentials" class="rtmp-credentials">
            <div class="rtmp-credentials__heading">
              <strong>RTMP 推流設定</strong
              ><small>請將以下資料貼到 OBS 或攝影機；Key 只會給這個場次使用。</small>
            </div>
            <label
              ><span>伺服器 URL</span>
              <div>
                <code>{{ rtmpCredentials.rtmp_url }}</code
                ><UiButton variant="ghost" size="sm" @click="copy(rtmpCredentials.rtmp_url)"
                  >複製</UiButton
                >
              </div></label
            >
            <label
              ><span>串流 Key</span>
              <div>
                <code>{{ rtmpCredentials.stream_key }}</code
                ><UiButton variant="ghost" size="sm" @click="copy(rtmpCredentials.stream_key)"
                  >複製</UiButton
                >
              </div></label
            >
          </div>
          <div
            v-for="capture in failedCaptures"
            :key="capture.id"
            class="source-row source-row--failed"
          >
            <div class="source-copy">
              <div class="source-name"><CircleAlert :size="14" />{{ sourceName(capture) }}</div>
              <span class="source-status">
                {{
                  isYoutube(capture)
                    ? 'YouTube 來源失敗，可使用目前 Browser session 重新解析'
                    : '來源處理失敗，可重新排入處理或清除任務'
                }}
              </span>
            </div>
            <UiButton
              variant="ghost"
              size="sm"
              :disabled="Boolean(retryingId) || Boolean(clearingId)"
              @click="retrySource(capture)"
            >
              <LoaderCircle v-if="retryingId === capture.id" class="spin" :size="13" />
              {{
                retryingId === capture.id
                  ? '重新處理中…'
                  : isYoutube(capture)
                    ? '強制重新載入'
                    : '重新處理'
              }}
            </UiButton>
            <UiButton
              variant="ghost"
              size="sm"
              :disabled="Boolean(retryingId) || Boolean(clearingId)"
              @click="clearSource(capture)"
            >
              <LoaderCircle v-if="clearingId === capture.id" class="spin" :size="13" />
              <Trash2 v-else :size="13" />
              {{ clearingId === capture.id ? '清除中…' : '清除任務' }}
            </UiButton>
          </div>
        </section>

        <YoutubeAuthCard compact tone="dark" />

        <section
          v-if="!activeCapture && !rtmpCredentials"
          class="add-source"
          aria-labelledby="add-source-title"
        >
          <div class="section-heading">
            <div>
              <span class="eyebrow">設定來源</span>
              <h2 id="add-source-title">連接影音</h2>
            </div>
          </div>
          <p class="section-description">
            貼上 YouTube 影片或直播網址、上傳 MP4，或建立 RTMP 推流來源。
          </p>
          <MediaSourcePicker v-model="source" />
          <div v-if="error" class="error" role="alert" aria-live="polite">
            <CircleAlert :size="15" /><span>{{ error }}</span>
          </div>
        </section>
        <p v-else-if="activeCapture" class="replace-note">停止目前來源後即可更換影片或直播。</p>
        <p v-else class="replace-note">RTMP 來源已建立；複製上方設定後即可開始推流。</p>
      </div>
    </UiScrollArea>
    <template #footer>
      <UiButton variant="ghost" :disabled="pending" @click="emit('close')">關閉</UiButton>
      <UiButton v-if="!activeCapture && !rtmpCredentials" :disabled="!canSubmit" @click="start">
        <LoaderCircle v-if="pending" class="spin" :size="14" />
        {{ pending ? '加入中…' : '加入影音來源' }}
      </UiButton>
    </template>
  </UiAnimatedModal>
  <ConfirmActionDialog
    :open="Boolean(captureToStop)"
    title="停止影音來源"
    :message="`停止「${captureToStopName}」的擷取？`"
    confirm-label="停止來源"
    danger
    @close="captureToStop = null"
    @confirm="confirmStop"
  />
</template>

<style scoped>
.capture-scroll {
  height: 100%;
  min-height: 0;
}
.capture-dialog {
  display: grid;
  gap: 0;
  min-height: 100%;
  background: #09090b;
  color: #fafafa;
}
.source-list,
.add-source {
  padding: 22px 24px;
}
.source-list {
  border-bottom: 1px solid #27272a;
}
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 15px;
}
.section-heading h2 {
  margin: 4px 0 0;
  font-size: 0.9rem;
  font-weight: 720;
  letter-spacing: -0.015em;
}
.eyebrow {
  color: #8d959d;
  font-size: 0.59rem;
  font-weight: 780;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}
.count {
  min-width: 24px;
  padding: 4px 8px;
  border-radius: 999px;
  background: #27272a;
  color: #d4d4d8;
  font-size: 0.65rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.empty {
  margin: 0;
  color: #8d959d;
  font-size: 0.7rem;
}
.source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 0;
  border-top: 1px solid #202124;
}
.source-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.source-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  font-weight: 680;
}
.status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #d6a33b;
}
.status-dot.healthy {
  background: #63bd8a;
}
.source-status {
  color: #8d959d;
  font-size: 0.65rem;
}
.source-row :deep(button) {
  color: #e6a4a8;
}
.add-source {
  display: grid;
  gap: 7px;
}
.section-description {
  margin: 0 0 9px;
  max-width: 68ch;
  color: #8d959d;
  font-size: 0.68rem;
  line-height: 1.55;
}
.add-source :deep(.source-tabs) {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.add-source :deep(.source-tabs button:nth-child(4)) {
  display: none;
}
.add-source :deep(.source-fields) {
  margin-top: 1px;
}
.error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 5px;
  padding: 10px 11px;
  border: 1px solid #6f3038;
  border-radius: 9px;
  background: #2b1114;
  color: #f0b1b5;
  font-size: 0.68rem;
  line-height: 1.4;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 620px) {
  .source-list,
  .add-source {
    padding: 17px;
  }
  .source-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .source-row :deep(button) {
    align-self: flex-end;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
.replace-note {
  margin: 0;
  padding: 22px 24px;
  color: #8d959d;
  font-size: 0.7rem;
}
.rtmp-credentials {
  display: grid;
  gap: 11px;
  margin-top: 14px;
  padding: 14px;
  border: 1px solid #315e57;
  border-radius: 11px;
  background: #0e211f;
}
.rtmp-credentials__heading {
  display: grid;
  gap: 4px;
}
.rtmp-credentials__heading strong {
  color: #d5fff5;
  font-size: 0.75rem;
}
.rtmp-credentials__heading small {
  color: #91bcb3;
  font-size: 0.63rem;
}
.rtmp-credentials label {
  display: grid;
  gap: 5px;
  color: #91bcb3;
  font-size: 0.62rem;
  font-weight: 700;
}
.rtmp-credentials label > div {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rtmp-credentials code {
  min-width: 0;
  flex: 1;
  overflow: auto;
  padding: 9px 10px;
  border: 1px solid #28514b;
  border-radius: 8px;
  background: #091816;
  color: #e7fff9;
  font-size: 0.67rem;
  white-space: nowrap;
}
</style>
