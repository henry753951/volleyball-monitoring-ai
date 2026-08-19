<script setup lang="ts">
import {
  Activity,
  CheckCircle2,
  Clock3,
  ClipboardCopy,
  Film,
  Gauge,
  HardDrive,
  Layers3,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  RotateCw,
  Trash2,
  TriangleAlert,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  mediaAverageProcessingRate,
  mediaDiagnostics,
  mediaHeartbeat,
  mediaPlayableProgress,
  mediaPreparationProgress,
  mediaWorkStage,
} from '~/lib/mediaOperationsDiagnostics'
import type { MatchMediaSnapshot, StreamSnapshot } from '~/lib/operationsMonitor'
import { createMediaSourceClient, type YoutubeSourceAuthMetadata } from '~/lib/mediaSourceClient'

const props = defineProps<{
  matchTitle: string
  media: MatchMediaSnapshot | null
  generatedAt: string | null
  open: boolean
  refreshPending: boolean
  streams: readonly StreamSnapshot[]
}>()

const emit = defineEmits<{ close: []; refresh: [] }>()

const currentStream = computed(() => props.streams[0] ?? null)
const currentStage = computed(() =>
  currentStream.value ? mediaWorkStage(currentStream.value) : null,
)
const currentPlayableProgress = computed(() =>
  currentStream.value ? mediaPlayableProgress(currentStream.value) : null,
)
const mediaSources = createMediaSourceClient()
const reloadingId = ref<string | null>(null)
const clearingId = ref<string | null>(null)
const youtubeAuth = ref<YoutubeSourceAuthMetadata | null>(null)

function sourceName(stream: StreamSnapshot) {
  return stream.sourceLabel?.trim() || stream.sourceKind.replaceAll('_', ' ')
}
function formatBytes(value: string | number) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1)
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
function formatDuration(value: string | undefined) {
  if (!value) return '0:00'
  const total = Number(BigInt(value) / 1_000_000n)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}
function fps(stream: StreamSnapshot) {
  const program = stream.program
  if (!program || !program.fps.denominator) return '—'
  return `${(program.fps.numerator / program.fps.denominator).toFixed(2)} fps`
}
function rateLabel(stream: StreamSnapshot) {
  const rate = mediaAverageProcessingRate(stream)?.value
  return rate == null ? '計算中' : `${rate.toFixed(rate >= 10 ? 1 : 2)}×`
}
function rateDetail(stream: StreamSnapshot) {
  const rate = mediaAverageProcessingRate(stream)
  if (!rate) return '第一個片段發布後計算'
  const basis = rate.basis === 'prepared' ? '來源準備' : '可播放索引'
  return rate.value < 1 ? `${basis}平均；低於即時速度` : `${basis}平均；高於即時速度`
}
function percentLabel(value: number | null) {
  return value === null ? '計算中' : `${value.toFixed(value >= 10 ? 1 : 2)}%`
}
function preparationDetail(stream: StreamSnapshot) {
  const progress = mediaPreparationProgress(stream)
  if (progress === 100 && stream.sourceWork?.status === 'DRAINING') {
    return '下載與切片完成；仍在建立可播放索引'
  }
  return progress === null ? '等待來源時長與第一個片段' : '依已發布片段的時間範圍計算'
}
function heartbeat(stream: StreamSnapshot) {
  return mediaHeartbeat(stream, props.generatedAt ?? new Date().toISOString())
}
function updatedAt(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
function statusLabel(stream: StreamSnapshot) {
  if (stream.status === 'LIVE') return '運行中'
  if (stream.status === 'FAILED') return '處理失敗'
  if (stream.program?.status === 'READY') return '索引完成'
  return stream.status.toLowerCase() === 'finished' ? '已完成' : stream.status
}

function isYoutube(stream: StreamSnapshot) {
  return stream.sourceKind.trim().toLowerCase().startsWith('youtube')
}

const youtubeAttempts = computed(() => {
  if (!youtubeAuth.value?.auth) return []
  const history = youtubeAuth.value.auth.resolutionHistory ?? []
  return history.filter(attempt => attempt.preflight || attempt.failureCode)
})

function rangeOffsetLabel(offsetBytes: number) {
  if (offsetBytes === 0) return 'Range 0'
  return `Range ${Math.round(offsetBytes / 1024 / 1024)} MiB`
}

function finalTime(stream: StreamSnapshot) {
  return formatDuration(stream.program?.indexedDurationUs ?? stream.sourceDurationUs ?? undefined)
}

function extentContinuity(stream: StreamSnapshot) {
  const count = stream.sourceWork?.resumeSegmentIndex ?? 0
  if (!count) return '尚無已提交 extent'
  return stream.program?.gapSegmentCount ? `1 → ${count}，有 gap` : `1 → ${count}，連續`
}

async function loadYoutubeDiagnostics() {
  const stream = currentStream.value
  if (!props.open || !stream || !isYoutube(stream)) {
    youtubeAuth.value = null
    return
  }
  try {
    youtubeAuth.value = await mediaSources.youtubeSourceAuth(stream.captureSessionId)
  } catch {
    youtubeAuth.value = null
  }
}

watch(
  () => [props.open, props.generatedAt, props.streams[0]?.captureSessionId] as const,
  () => void loadYoutubeDiagnostics(),
  { immediate: true },
)

function canReload(stream: StreamSnapshot) {
  return (
    stream.status === 'FAILED' &&
    Boolean(stream.sourceWork) &&
    !reloadingId.value &&
    !clearingId.value
  )
}

async function forceReload(stream: StreamSnapshot) {
  if (!canReload(stream)) return
  reloadingId.value = stream.captureSessionId
  try {
    const result = await mediaSources.retryMediaSource(stream.captureSessionId, stream.sourceKind)
    emit('refresh')
    toast.success(
      isYoutube(stream)
        ? `已強制重新載入，將使用最新 Cookie 重新解析（第 ${result.attempt} 次）`
        : `已重新排入媒體處理（第 ${result.attempt} 次）`,
    )
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : '媒體重新載入失敗')
  } finally {
    reloadingId.value = null
  }
}

async function clearTask(stream: StreamSnapshot) {
  if (stream.status !== 'FAILED' || !stream.sourceWork || clearingId.value) return
  if (!window.confirm('只清除這個失敗的媒體任務？已有媒體或標註資料時系統會拒絕刪除。')) return
  clearingId.value = stream.captureSessionId
  try {
    await mediaSources.clearMediaSource(stream.captureSessionId)
    emit('refresh')
    toast.success('失敗媒體任務已清除')
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : '媒體任務清除失敗')
  } finally {
    clearingId.value = null
  }
}

async function copyDiagnostics(stream: StreamSnapshot) {
  const generatedAt = props.generatedAt ?? new Date().toISOString()
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(mediaDiagnostics(stream, generatedAt), null, 2),
    )
    toast.success('已複製媒體診斷資訊')
  } catch {
    toast.error('無法複製診斷資訊，請確認瀏覽器剪貼簿權限')
  }
}
</script>

<template>
  <UiAnimatedModal
    :open="open"
    title="媒體與 DVR 監控"
    :description="matchTitle"
    width="wide"
    @close="$emit('close')"
  >
    <UiScrollArea class="monitor-scroll">
      <div class="media-monitor">
        <section class="summary-strip">
          <div>
            <Film :size="16" /><span
              ><small>採集紀錄</small><strong>{{ streams.length }}</strong></span
            >
          </div>
          <div>
            <RadioTower :size="16" /><span
              ><small>運行中</small><strong>{{ media?.activeCaptureCount ?? 0 }}</strong></span
            >
          </div>
          <div>
            <Activity :size="16" /><span
              ><small>可播放片段</small
              ><strong
                >{{ media?.readySegmentCount ?? 0 }} /
                {{ currentStream?.completionExpectedSegments ?? media?.segmentCount ?? 0 }}</strong
              ></span
            >
          </div>
          <div>
            <HardDrive :size="16" /><span
              ><small>媒體用量</small
              ><strong>{{ formatBytes(media?.storedBytes ?? '0') }}</strong></span
            >
          </div>
          <div :class="{ danger: media?.gapSegmentCount }">
            <TriangleAlert :size="16" /><span
              ><small>時間軸中斷</small><strong>{{ media?.gapSegmentCount ?? 0 }}</strong></span
            >
          </div>
        </section>

        <section v-if="currentStream && currentStage" class="current-progress">
          <header>
            <div>
              <span class="eyebrow">目前媒體工作</span>
              <h3>{{ currentStage.label }}</h3>
              <p>{{ currentStage.detail }}</p>
            </div>
            <button type="button" :disabled="refreshPending" @click="emit('refresh')">
              <RefreshCw :size="14" :class="{ spinning: refreshPending }" />
              {{ refreshPending ? '更新中' : '重新整理' }}
            </button>
          </header>
          <div class="index-progress" aria-label="目前來源可播放進度">
            <span :class="{ indeterminate: currentPlayableProgress === null }">
              <i
                :style="{
                  width:
                    currentPlayableProgress === null ? undefined : `${currentPlayableProgress}%`,
                }"
              />
            </span>
            <strong>{{ percentLabel(currentPlayableProgress) }}</strong>
          </div>
          <footer>
            <span>可播放進度＝已驗證索引時長 ÷ 完整來源時長</span>
            <span>只有來源與全部索引完成後才會顯示 100%</span>
          </footer>
        </section>

        <section
          v-if="currentStream && isYoutube(currentStream) && youtubeAttempts.length"
          class="youtube-diagnostics"
          aria-labelledby="youtube-diagnostics-title"
        >
          <header>
            <div>
              <span class="eyebrow">YouTube HTTP diagnostics</span>
              <h3 id="youtube-diagnostics-title">解析與 bounded Range</h3>
            </div>
            <span>不顯示 signed URL 或 Cookie</span>
          </header>
          <div class="youtube-attempts">
            <article
              v-for="(attempt, index) in youtubeAttempts"
              :key="`${index}-${attempt.resolverFinishedAt}`"
            >
              <div class="youtube-attempt__heading">
                <strong>{{ attempt.playerClient ?? 'unknown client' }}</strong>
                <span :class="attempt.preflight?.result === 'passed' ? 'pass' : 'fail'">
                  {{
                    attempt.preflight?.result === 'passed'
                      ? 'Range passed'
                      : (attempt.failureCode ?? 'rejected')
                  }}
                </span>
              </div>
              <div class="youtube-ranges">
                <span
                  v-for="probe in attempt.preflight?.ranges ?? []"
                  :key="`${probe.kind}-${probe.offsetBytes}`"
                >
                  {{ probe.kind }} · {{ rangeOffsetLabel(probe.offsetBytes) }}
                  <b :class="probe.status === 206 ? 'pass' : 'fail'">{{ probe.status ?? 'ERR' }}</b>
                </span>
                <span v-if="!attempt.preflight?.ranges.length" class="muted">尚無 Range 回應</span>
              </div>
              <small>
                chunk
                {{
                  attempt.httpChunkSize
                    ? `${Math.round(attempt.httpChunkSize / 1024 / 1024)} MiB`
                    : '—'
                }}
                · formats {{ attempt.selectedFormatIds.join('+') || '—' }}
              </small>
            </article>
          </div>
          <dl v-if="currentStream" class="youtube-runtime-checks">
            <div>
              <dt>FFmpeg / ingest</dt>
              <dd>{{ currentStream.sourceWork?.status ?? '—' }}</dd>
            </div>
            <div>
              <dt>Extents</dt>
              <dd>{{ extentContinuity(currentStream) }}</dd>
            </div>
            <div>
              <dt>Final time</dt>
              <dd>
                {{ finalTime(currentStream) }} /
                {{ formatDuration(currentStream.sourceDurationUs ?? undefined) }}
              </dd>
            </div>
            <div>
              <dt>Job</dt>
              <dd>{{ statusLabel(currentStream) }}</dd>
            </div>
          </dl>
        </section>

        <section class="stream-section">
          <header>
            <div>
              <h3>來源歷程</h3>
              <p>每場同時只使用一個來源；這裡保留更換與重新啟動的採集紀錄</p>
            </div>
            <span v-if="generatedAt">伺服器快照 {{ updatedAt(generatedAt) }}</span>
            <span v-else>等待伺服器快照</span>
          </header>
          <div v-if="streams.length" class="stream-list">
            <article v-for="stream in streams" :key="stream.captureSessionId">
              <div class="stream-title">
                <span class="source-icon"><RadioTower :size="16" /></span>
                <div>
                  <strong>{{ sourceName(stream) }}</strong
                  ><small
                    >{{ stream.sourceKind.replaceAll('_', ' ') }} · {{ statusLabel(stream) }}</small
                  >
                </div>
                <span class="health" :class="stream.health.toLowerCase()"
                  ><i />{{ stream.health === 'HEALTHY' ? '正常' : stream.health }}</span
                >
              </div>
              <div v-if="stream.status === 'FAILED' && stream.sourceWork" class="stream-actions">
                <button type="button" :disabled="!canReload(stream)" @click="forceReload(stream)">
                  <LoaderCircle
                    v-if="reloadingId === stream.captureSessionId"
                    :size="13"
                    class="spinning"
                  /><RotateCw v-else :size="13" />
                  {{
                    reloadingId === stream.captureSessionId
                      ? '重新處理中…'
                      : isYoutube(stream)
                        ? '強制重新載入'
                        : '重新處理'
                  }}
                </button>
                <button
                  type="button"
                  class="danger-action"
                  :disabled="Boolean(clearingId)"
                  @click="clearTask(stream)"
                >
                  <LoaderCircle
                    v-if="clearingId === stream.captureSessionId"
                    :size="13"
                    class="spinning"
                  /><Trash2 v-else :size="13" />
                  {{ clearingId === stream.captureSessionId ? '清除中…' : '清除任務' }}
                </button>
              </div>
              <div class="work-stage" :class="mediaWorkStage(stream).tone">
                <span>
                  <CheckCircle2 v-if="mediaWorkStage(stream).key === 'completed'" :size="15" />
                  <TriangleAlert v-else-if="mediaWorkStage(stream).key === 'failed'" :size="15" />
                  <Layers3 v-else :size="15" />
                </span>
                <div>
                  <strong>{{ mediaWorkStage(stream).label }}</strong>
                  <small>{{ mediaWorkStage(stream).detail }}</small>
                </div>
                <button type="button" title="複製診斷資訊" @click="copyDiagnostics(stream)">
                  <ClipboardCopy :size="14" />複製診斷
                </button>
              </div>
              <dl>
                <div>
                  <dt><Gauge :size="13" />端到端平均倍率</dt>
                  <dd>{{ rateLabel(stream) }}</dd>
                  <small>{{ rateDetail(stream) }}</small>
                </div>
                <div>
                  <dt><Layers3 :size="13" />來源切片進度</dt>
                  <dd>{{ percentLabel(mediaPreparationProgress(stream)) }}</dd>
                  <small>{{ preparationDetail(stream) }}</small>
                </div>
                <div>
                  <dt><Activity :size="13" />可播放進度</dt>
                  <dd>{{ percentLabel(mediaPlayableProgress(stream)) }}</dd>
                  <small>{{ formatDuration(stream.program?.indexedDurationUs) }} 已索引</small>
                </div>
                <div :class="{ stalled: heartbeat(stream).stalled }">
                  <dt><Clock3 :size="13" />Worker 活動</dt>
                  <dd>{{ heartbeat(stream).stalled ? '可能停滯' : '有回應' }}</dd>
                  <small>{{ heartbeat(stream).label }}</small>
                </div>
              </dl>
              <div class="stream-detail">
                <span
                  >工作 <b>{{ stream.sourceWork?.status ?? '尚未建立' }}</b></span
                >
                <span
                  >嘗試 <b>{{ stream.sourceWork?.attempts ?? 0 }}</b></span
                >
                <span
                  >來源時長 <b>{{ formatDuration(stream.sourceDurationUs ?? undefined) }}</b></span
                >
                <span
                  >已發布片段 <b>{{ stream.sourceWork?.resumeSegmentIndex ?? 0 }}</b></span
                >
                <span
                  >索引驗證
                  <b
                    >{{ stream.program?.readySegmentCount ?? 0 }} /
                    {{ stream.program?.segmentCount ?? 0 }} 已建立</b
                  ></span
                >
                <span
                  >Gap
                  <b :class="{ danger: stream.program?.gapSegmentCount }">{{
                    stream.program?.gapSegmentCount ?? 0
                  }}</b></span
                >
                <span
                  >Playlist rev <b>{{ stream.program?.playlistRevision ?? '—' }}</b></span
                >
                <span
                  >Time base
                  <b>{{
                    stream.program
                      ? `${stream.program.timeBase.numerator}/${stream.program.timeBase.denominator}`
                      : '—'
                  }}</b></span
                >
                <span
                  >影格率 <b>{{ fps(stream) }}</b></span
                >
                <span
                  >Epoch <b>{{ stream.epochCount }}</b></span
                >
                <span
                  >最後更新 <b>{{ updatedAt(stream.updatedAt) }}</b></span
                >
                <span v-if="stream.sourceWork?.lastErrorCode" class="error-code"
                  >最近錯誤 <b>{{ stream.sourceWork.lastErrorCode }}</b></span
                >
              </div>
            </article>
          </div>
          <div v-else class="empty-monitor">
            <Film :size="20" /><strong>尚未設定影音來源</strong
            ><span>請先從場次操作加入 YouTube、直播或本機影片</span>
          </div>
        </section>
      </div>
    </UiScrollArea>
  </UiAnimatedModal>
</template>

<style scoped>
.monitor-scroll {
  height: min(720px, calc(86dvh - 54px));
}
.media-monitor {
  display: grid;
  gap: 18px;
  padding: 18px;
}
.summary-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border-radius: 10px;
  background: #24262a;
}
.summary-strip > div {
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 13px;
  background: #131519;
  color: #8f9399;
}
.summary-strip span {
  display: grid;
  gap: 4px;
}
.summary-strip small {
  color: #74777d;
  font-size: 0.51rem;
}
.summary-strip strong {
  color: #f0f1f2;
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}
.summary-strip .danger svg,
.summary-strip .danger strong,
.stream-detail b.danger {
  color: #df7b77;
}
.current-progress {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid #292c31;
  border-radius: 12px;
  background: linear-gradient(135deg, #15181c, #111316);
}
.current-progress > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.current-progress .eyebrow {
  color: #62c89a;
  font-size: 0.47rem;
  font-weight: 750;
  letter-spacing: 0.08em;
}
.current-progress h3 {
  margin: 5px 0 0;
  font-size: 0.72rem;
}
.current-progress p {
  margin: 5px 0 0;
  color: #858991;
  font-size: 0.52rem;
  line-height: 1.5;
}
.current-progress button,
.work-stage button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid #34383f;
  border-radius: 7px;
  background: #1c1f24;
  color: #c7cbd0;
  font: inherit;
  font-size: 0.49rem;
  cursor: pointer;
}
.current-progress button:hover,
.work-stage button:hover {
  border-color: #4a5059;
  background: #24282e;
}
.current-progress button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.current-progress footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #686d74;
  font-size: 0.47rem;
}
.index-progress {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 62px;
  align-items: center;
  gap: 12px;
}
.index-progress > span {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: #292c31;
}
.index-progress i {
  display: block;
  height: 100%;
  background: #54c994;
}
.index-progress > span.indeterminate i {
  width: 34%;
  animation: indeterminate-progress 1.2s ease-in-out infinite;
}
.index-progress strong {
  color: #c8ccd1;
  font-size: 0.56rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.youtube-diagnostics {
  display: grid;
  gap: 12px;
  padding: 15px 16px;
  border: 1px solid #292c31;
  border-radius: 12px;
  background: #111316;
}
.youtube-diagnostics > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.youtube-diagnostics h3 {
  margin: 5px 0 0;
  font-size: 0.72rem;
}
.youtube-diagnostics > header > span {
  color: #70747a;
  font-size: 0.48rem;
}
.youtube-diagnostics .eyebrow {
  color: #7e8791;
  font-size: 0.47rem;
  letter-spacing: 0.08em;
}
.youtube-attempts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.youtube-attempts article {
  display: grid;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid #292c31;
  border-radius: 8px;
  background: #181a1e;
}
.youtube-attempt__heading,
.youtube-ranges,
.youtube-runtime-checks > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.youtube-attempt__heading strong {
  color: #e4e6e9;
  font-size: 0.58rem;
}
.youtube-attempt__heading span,
.youtube-ranges b {
  font-size: 0.48rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.youtube-attempt__heading .pass,
.youtube-ranges .pass {
  color: #55ca92;
}
.youtube-attempt__heading .fail,
.youtube-ranges .fail {
  color: #e07873;
}
.youtube-ranges {
  align-items: flex-start;
  flex-direction: column;
  color: #969ba2;
  font-size: 0.5rem;
}
.youtube-ranges span {
  display: flex;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}
.youtube-attempts small {
  color: #70757c;
  font-size: 0.46rem;
}
.youtube-runtime-checks {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}
.youtube-runtime-checks > div {
  align-items: flex-start;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid #292c31;
}
.youtube-runtime-checks dt {
  color: #74787e;
  font-size: 0.49rem;
}
.youtube-runtime-checks dd {
  margin: 0;
  color: #dfe1e4;
  font-size: 0.57rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.muted {
  color: #70757c;
}
.stream-section {
  overflow: hidden;
  border-radius: 12px;
  background: #101114;
}
.stream-section > header {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}
.stream-section h3 {
  margin: 0;
  font-size: 0.68rem;
}
.stream-section p {
  margin: 4px 0 0;
  color: #767a80;
  font-size: 0.52rem;
}
.stream-section > header > span {
  color: #70747a;
  font-size: 0.49rem;
}
.stream-list {
  display: grid;
}
.stream-list article {
  display: grid;
  gap: 13px;
  padding: 15px 16px;
  border-top: 1px solid #202226;
}
.stream-title {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}
.source-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #202227;
  color: #c9ccd0;
}
.stream-title > div {
  display: grid;
  gap: 3px;
}
.stream-title strong {
  font-size: 0.62rem;
}
.stream-title small {
  color: #767a80;
  font-size: 0.5rem;
}
.stream-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-left: 44px;
}
.stream-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 29px;
  padding: 0 9px;
  border: 1px solid #34383f;
  border-radius: 7px;
  background: #1c1f24;
  color: #c7cbd0;
  font: inherit;
  font-size: 0.49rem;
  cursor: pointer;
}
.stream-actions button:hover:not(:disabled) {
  border-color: #4a5059;
  background: #24282e;
}
.stream-actions button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.stream-actions .danger-action {
  border-color: #5a363a;
  color: #e2a09d;
}
.health {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9a9da3;
  font-size: 0.51rem;
}
.health i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4ac287;
}
.health.degraded i,
.health.offline i {
  background: #d4a255;
}
.health.failed i {
  background: #df706d;
}
.work-stage {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  margin-left: 44px;
  padding: 10px 11px;
  border: 1px solid #2c3036;
  border-radius: 9px;
  background: #171a1e;
}
.work-stage > span {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: #252930;
  color: #d3a85d;
}
.work-stage.good > span {
  color: #55ca92;
}
.work-stage.danger > span {
  color: #e07873;
}
.work-stage > div {
  display: grid;
  gap: 3px;
}
.work-stage strong {
  font-size: 0.56rem;
}
.work-stage small {
  color: #7c8188;
  font-size: 0.48rem;
  line-height: 1.45;
}
.stream-list dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  padding-left: 44px;
}
.stream-list dl > div {
  display: grid;
  gap: 5px;
}
.stream-list dt {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #74787e;
  font-size: 0.5rem;
}
.stream-list dd {
  margin: 0;
  color: #dfe1e4;
  font-size: 0.64rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stream-list dl small {
  margin-top: -2px;
  color: #656a72;
  font-size: 0.44rem;
  line-height: 1.4;
}
.stream-list dl .stalled dt,
.stream-list dl .stalled dd,
.stream-list dl .stalled small {
  color: #df7b77;
}
.stream-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 18px;
  padding-left: 44px;
  color: #71757b;
  font-size: 0.49rem;
}
.stream-detail b {
  color: #aeb1b6;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.stream-detail .error-code,
.stream-detail .error-code b {
  color: #df7b77;
}
.empty-monitor {
  min-height: 180px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: #73777d;
}
.empty-monitor strong {
  color: #aeb1b6;
  font-size: 0.62rem;
}
.empty-monitor span {
  font-size: 0.51rem;
}
@media (max-width: 760px) {
  .summary-strip {
    grid-template-columns: repeat(2, 1fr);
  }
  .summary-strip > div:last-child {
    grid-column: 1/-1;
  }
  .stream-list dl {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
  .stream-detail,
  .stream-list dl,
  .work-stage,
  .stream-actions {
    padding-left: 0;
    margin-left: 0;
  }
  .current-progress > header,
  .current-progress footer,
  .youtube-diagnostics > header {
    align-items: stretch;
    flex-direction: column;
  }
  .youtube-attempts,
  .youtube-runtime-checks {
    grid-template-columns: 1fr;
  }
}
@keyframes indeterminate-progress {
  0% {
    transform: translateX(-110%);
  }
  50% {
    transform: translateX(100%);
  }
  100% {
    transform: translateX(300%);
  }
}
.spinning {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
