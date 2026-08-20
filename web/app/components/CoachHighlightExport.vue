<script setup lang="ts">
import { Clapperboard, Download, RotateCcw } from 'lucide-vue-next'
import {
  coachHighlightFingerprint,
  coachHighlightFingerprintSource,
} from '~/utils/coachHighlightFingerprint'
import type { CoachPlayerActionEvent } from '~/utils/coachPlayerActions'

const props = defineProps<{
  matchId: string
  events: CoachPlayerActionEvent[]
  replays: ReadonlyMap<
    string,
    {
      readonly clip: {
        readonly id: string
        readonly duration_us: string
      } | null
    } | null
  >
  subjectLabel: string
  filterLabel: string
  loading?: boolean
}>()

type ExportJob = {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  total_events: number
  error: { code: string; message: string } | null
  download_url: string | null
  download_filename: string
  source_fingerprint: string | null
  created_at: string
}

const job = shallowRef<ExportJob | null>(null)
const error = ref('')
const restoring = ref(false)
const fingerprint = ref('')
let controller: AbortController | null = null
let generation = 0

const entries = computed(() =>
  props.events.flatMap(event => {
    const clip = props.replays.get(event.rallyId)?.clip
    return clip
      ? [
          {
            event_id: event.id,
            rally_id: event.rallyId,
            clip_job_id: clip.id,
            clip_duration_us: clip.duration_us,
            anchor_time_us: event.anchorTimeUs,
            set_number: event.setNumber,
            rally_ordinal: event.rallyOrdinal,
            action_key: event.actionKey,
            action_label: event.actionLabel,
          },
        ]
      : []
  }),
)
const unavailableCount = computed(() => Math.max(0, props.events.length - entries.value.length))
const requestSignature = computed(() =>
  coachHighlightFingerprintSource({
    subjectLabel: props.subjectLabel,
    filterLabel: props.filterLabel,
    events: entries.value,
  }),
)
const running = computed(() => job.value?.status === 'queued' || job.value?.status === 'running')
const failed = computed(() => Boolean(error.value) || job.value?.status === 'failed')
const primaryLabel = computed(() => {
  if (failed.value) return '重新輸出精采回放'
  if (running.value) return '正在製作精采回放'
  return '輸出精采回放'
})
function friendlyExportError(value: { code?: string; message?: string } | null | undefined) {
  if (value?.code === 'CLIP_SOURCE_MISSING' || value?.code === 'HIGHLIGHT_SOURCE_MISSING')
    return '部分回放來源已不存在，請先重新產生片段後再輸出。'
  if (value?.code === 'CLIP_UNAVAILABLE') return '部分片段已更新，請重新整理後再輸出。'
  return value?.message || '影片輸出失敗，請再試一次。'
}
const supportingCopy = computed(() => {
  if (failed.value) return error.value || friendlyExportError(job.value?.error)
  if (props.loading) return '正在確認回放片段'
  if (restoring.value) return '正在尋找已輸出的資料版本'
  if (!props.events.length) return '目前篩選沒有球種事件'
  if (!entries.value.length) return '目前事件尚無可播放影片'
  if (running.value)
    return job.value?.status === 'queued'
      ? `${entries.value.length} 段 · 等待後端處理`
      : `${entries.value.length} 段 · 已完成 ${job.value?.progress ?? 0}%`
  const missing = unavailableCount.value ? ` · ${unavailableCount.value} 段尚無影片` : ''
  return `${entries.value.length} 段回放${missing}`
})

onBeforeUnmount(() => {
  generation += 1
  controller?.abort()
})
onMounted(() => void restoreExisting())
watch([requestSignature, () => props.loading], () => void restoreExisting())

async function readResponse(response: Response) {
  const body = (await response.json().catch(() => null)) as
    | ExportJob
    | { code?: string; message?: string }
    | null
  if (!response.ok) throw new Error(friendlyExportError(body && 'code' in body ? body : null))
  return body as ExportJob
}

async function poll(jobId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    await new Promise<void>(resolve => window.setTimeout(resolve, 1_000))
    if (signal.aborted) return
    const response = await fetch(
      `/api/v1/matches/${encodeURIComponent(props.matchId)}/highlight-exports/${encodeURIComponent(jobId)}`,
      { signal },
    )
    job.value = await readResponse(response)
    if (job.value.status === 'completed' || job.value.status === 'failed') return
  }
}

async function restoreExisting() {
  const currentGeneration = ++generation
  controller?.abort()
  controller = null
  job.value = null
  error.value = ''
  fingerprint.value = ''
  restoring.value = false
  if (props.loading || !entries.value.length) return
  const currentController = new AbortController()
  controller = currentController
  restoring.value = true
  try {
    const currentFingerprint = await coachHighlightFingerprint({
      subjectLabel: props.subjectLabel,
      filterLabel: props.filterLabel,
      events: entries.value,
    })
    if (currentGeneration !== generation) return
    fingerprint.value = currentFingerprint
    const response = await fetch(
      `/api/v1/matches/${encodeURIComponent(props.matchId)}/highlight-exports?source_fingerprint=${currentFingerprint}`,
      { signal: currentController.signal },
    )
    if (response.status === 204) return
    job.value = await readResponse(response)
    if (running.value) await poll(job.value.id, currentController.signal)
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError'))
      error.value = '無法確認既有影片版本，仍可重新輸出。'
  } finally {
    if (currentGeneration === generation) {
      restoring.value = false
      controller = null
    }
  }
}

async function startExport() {
  if (running.value || restoring.value || props.loading || !entries.value.length) return
  const currentGeneration = ++generation
  controller?.abort()
  controller = new AbortController()
  error.value = ''
  job.value = null
  try {
    const currentFingerprint =
      fingerprint.value ||
      (await coachHighlightFingerprint({
        subjectLabel: props.subjectLabel,
        filterLabel: props.filterLabel,
        events: entries.value,
      }))
    fingerprint.value = currentFingerprint
    const response = await fetch(
      `/api/v1/matches/${encodeURIComponent(props.matchId)}/highlight-exports`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema_version: '1.0.0',
          source_fingerprint: currentFingerprint,
          subject_label: props.subjectLabel,
          filter_label: props.filterLabel,
          events: entries.value,
        }),
        signal: controller.signal,
      },
    )
    job.value = await readResponse(response)
    if (job.value.status !== 'completed') await poll(job.value.id, controller.signal)
    if (job.value?.status === 'failed') error.value = friendlyExportError(job.value.error)
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError'))
      error.value = cause instanceof Error ? cause.message : '影片輸出失敗，請再試一次。'
  } finally {
    if (currentGeneration === generation) controller = null
  }
}
</script>

<template>
  <div
    class="highlight-export"
    :data-state="error ? 'failed' : (job?.status ?? 'idle')"
    aria-live="polite"
  >
    <a
      v-if="job?.status === 'completed' && job.download_url"
      class="highlight-export__primary"
      :href="job.download_url"
      :download="job.download_filename"
    >
      <Clapperboard :size="20" />
      <span>
        <strong>下載精采回放</strong>
        <small>{{ job.total_events }} 段 · MP4 已完成</small>
      </span>
      <Download :size="18" />
    </a>
    <button
      v-else
      type="button"
      class="highlight-export__primary"
      :disabled="loading || restoring || !entries.length || running"
      :data-tone="failed ? 'error' : undefined"
      :aria-busy="running"
      @click="startExport"
    >
      <RotateCcw v-if="failed" :size="20" />
      <Clapperboard v-else :size="20" />
      <span>
        <strong>{{ primaryLabel }}</strong>
        <small :role="failed ? 'alert' : undefined">{{ supportingCopy }}</small>
      </span>
      <b v-if="running" class="highlight-export__percent">{{ job?.progress ?? 0 }}%</b>
      <Download v-else :size="18" />
      <span
        v-if="running"
        class="highlight-export__progress"
        role="progressbar"
        :aria-valuenow="job?.progress ?? 0"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <i :style="{ transform: `scaleX(${(job?.progress ?? 0) / 100})` }" />
      </span>
    </button>
  </div>
</template>

<style scoped>
.highlight-export {
  min-width: 0;
  min-height: 64px;
}
.highlight-export__primary {
  position: relative;
  width: 100%;
  min-height: 64px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border: 0;
  border-radius: 12px;
  background: #172533;
  color: #f7fbff;
  text-align: left;
  text-decoration: none;
  overflow: hidden;
  transition:
    background 140ms ease,
    transform 100ms ease-out;
  touch-action: manipulation;
}
.highlight-export__primary:hover:not(:disabled) {
  background: #0f3f6e;
}
.highlight-export__primary:active:not(:disabled) {
  transform: scale(0.985);
}
.highlight-export__primary[data-tone='error'] {
  background: #3d252c;
}
.highlight-export__primary[data-tone='error']:hover:not(:disabled) {
  background: #512a34;
}
.highlight-export__primary:focus-visible,
.highlight-export__primary[data-tone='error']:focus-visible {
  outline: 3px solid rgb(8 117 221 / 26%);
  outline-offset: 2px;
}
.highlight-export__primary:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}
.highlight-export[data-state='queued'] .highlight-export__primary:disabled,
.highlight-export[data-state='running'] .highlight-export__primary:disabled {
  opacity: 1;
}
.highlight-export__primary > span {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.highlight-export__primary strong,
.highlight-export__primary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.highlight-export__primary strong {
  font-size: 0.69rem;
  font-weight: 760;
}
.highlight-export__primary small {
  color: #b7c8d8;
  font-size: 0.55rem;
  line-height: 1.25;
}
.highlight-export__primary[data-tone='error'] small {
  color: #f0bdc7;
}
.highlight-export__percent {
  color: #d5e9fb;
  font-size: 0.58rem;
  font-variant-numeric: tabular-nums;
}
.highlight-export__progress {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 4px;
  display: block;
  overflow: hidden;
  background: #32485c;
}
.highlight-export__progress i {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: inherit;
  background: #0875dd;
  transform-origin: left center;
  transition: transform 160ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .highlight-export__primary,
  .highlight-export__progress i {
    transition: none;
  }
}
</style>
