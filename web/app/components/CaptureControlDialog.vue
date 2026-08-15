<script setup lang="ts">
import { CircleAlert, LoaderCircle, Square } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import UiButton from '~/components/ui/Button.vue'
import type { CaptureSession } from '~/lib/coreDomain'
import { createCoreDomainClient, createGraphQLTransport } from '~/lib/coreDomain'
import { createMediaSourceClient, type MatchMediaSourceDraft } from '~/lib/mediaSourceClient'

const props = defineProps<{ open: boolean; matchId: string; captures: CaptureSession[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const domain = createCoreDomainClient(createGraphQLTransport('/graphql'))
const mediaSources = createMediaSourceClient()
const source = ref<MatchMediaSourceDraft>({ kind: 'youtube', label: '', url: '' })
const pending = ref(false)
const stoppingId = ref<string | null>(null)
const captureToStop = shallowRef<CaptureSession | null>(null)
const error = ref<string | null>(null)

const activeCapture = computed(
  () =>
    props.captures.find(capture =>
      ['STARTING', 'LIVE', 'STOPPING'].includes(capture.status.toUpperCase()),
    ) ?? null,
)
const captureToStopName = computed(() =>
  captureToStop.value ? sourceName(captureToStop.value) : '目前來源',
)
const canSubmit = computed(() => {
  if (pending.value || activeCapture.value) return false
  if (source.value.kind === 'youtube') return Boolean(source.value.url.trim())
  if (source.value.kind === 'local_mp4') return Boolean(source.value.file?.name)
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

watch(
  () => props.open,
  open => {
    if (!open) return
    error.value = null
    resetSource()
  },
)

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
    await mediaSources.create(props.matchId, source.value)
    emit('changed')
    toast.success('影音來源已加入')
    resetSource()
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
        </section>

        <section v-if="!activeCapture" class="add-source" aria-labelledby="add-source-title">
          <div class="section-heading">
            <div>
              <span class="eyebrow">設定來源</span>
              <h2 id="add-source-title">連接影音</h2>
            </div>
          </div>
          <p class="section-description">貼上 YouTube 影片或直播網址，或上傳 MP4。</p>
          <MediaSourcePicker v-model="source" />
          <div v-if="error" class="error" role="alert" aria-live="polite">
            <CircleAlert :size="15" /><span>{{ error }}</span>
          </div>
        </section>
        <p v-else class="replace-note">停止目前來源後即可更換影片或直播。</p>
      </div>
    </UiScrollArea>
    <template #footer>
      <UiButton variant="ghost" :disabled="pending" @click="emit('close')">關閉</UiButton>
      <UiButton v-if="!activeCapture" :disabled="!canSubmit" @click="start">
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.add-source :deep(.source-tabs button:nth-child(3)) {
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
</style>
