<script setup lang="ts">
import { AlertTriangle, ArrowUpRight, CircleDot, RefreshCw } from 'lucide-vue-next'
import { activeAiWorkForDashboard, activeProviderWorkForDashboard } from '~/lib/operationsMonitor'

definePageMeta({ layout: 'control' })

const monitor = useOperationsMonitor()
const jobs = computed(() => monitor.snapshot.value?.operations.aiWork ?? [])
const providerWork = computed(() => monitor.snapshot.value?.operations.providerWork ?? [])
const activeCount = computed(() => activeAiWorkForDashboard(jobs.value).length)
const activeProviderCount = computed(
  () => activeProviderWorkForDashboard(providerWork.value).length,
)
const generatedAt = computed(() => monitor.snapshot.value?.operations.generatedAt ?? null)

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    CANCELLED: '已取消',
    COMPLETED: '已完成',
    FAILED: '失敗',
    QUEUED: '等待 Worker',
    RUNNING: '處理中',
    SUPERSEDED: '已被取代',
  }
  return labels[value.toUpperCase()] ?? value
}

function stageLabel(value: string | null) {
  if (!value) return '尚未開始'
  const labels: Record<string, string> = {
    building_artifacts: '建立分析資產',
    callback: '回傳分析結果',
    completed: '分析完成',
    court_projection: '場地轉換',
    downloading_clip: '下載片段',
    geometry_reused: '沿用既有場地幾何',
    hit_association: '擊球者關聯',
    loading_reference_data: '載入追蹤資料',
    player_tracking: '人物追蹤',
    reidentification: '身份合併',
  }
  return labels[value] ?? value.replaceAll('_', ' ')
}

function workKindLabel(value: string) {
  const labels: Record<string, string> = {
    ANALYSIS: '分析推論',
    IDENTITY_PREVIEW_GENERATION: '身份預覽',
    REID_ASSOCIATION: 'ReID 關聯',
    REID_FEATURE_EXTRACTION: 'ReID 特徵',
  }
  return labels[value.toUpperCase()] ?? value.replaceAll('_', ' ')
}

function formatTime(value: string | null) {
  if (!value) return '尚未同步'
  return new Intl.DateTimeFormat('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function progress(job: { progress: number | null; status: string }) {
  if (job.status === 'COMPLETED') return 100
  return Math.round((job.progress ?? 0) * 100)
}
</script>

<template>
  <section class="jobs-page">
    <header class="page-header">
      <div>
        <h1>AI 作業紀錄</h1>
        <p>已完成、取消、失敗與被取代的近期作業</p>
      </div>
      <div class="page-header__sync">
        <span
          ><i :class="{ danger: monitor.error.value }" />{{
            monitor.error.value ? '同步中斷' : `更新於 ${formatTime(generatedAt)}`
          }}</span
        >
        <button
          type="button"
          :disabled="monitor.pending.value"
          aria-label="立即重新整理"
          @click="monitor.refresh"
        >
          <RefreshCw :size="15" :class="{ spinning: monitor.pending.value }" />
        </button>
      </div>
    </header>

    <div v-if="monitor.error.value" class="monitor-error" role="alert">
      <AlertTriangle :size="17" />
      <span><strong>作業紀錄暫時無法更新</strong>{{ monitor.error.value.message }}</span>
      <button type="button" @click="monitor.refresh">重新連線</button>
    </div>

    <div class="jobs-content">
      <div class="jobs-summary">
        <div>
          <strong>Worker queue</strong><span>{{ providerWork.length }} 筆實際工作</span>
        </div>
        <div class="active-summary">
          <i />{{ activeProviderCount }} 筆處理中 · AI lifecycle {{ activeCount }} 筆
        </div>
      </div>

      <div class="job-history" role="table" aria-label="AI 作業紀錄">
        <div class="job-history__head" role="row">
          <span role="columnheader">場次與階段</span>
          <span role="columnheader">狀態</span>
          <span role="columnheader">Worker</span>
          <span role="columnheader">進度</span>
          <span role="columnheader">更新時間</span>
          <span aria-hidden="true" />
        </div>

        <div
          v-if="!providerWork.length && !jobs.length && !monitor.pending.value"
          class="job-history__empty"
        >
          <CircleDot :size="19" />
          <strong>目前沒有 Worker 作業</strong>
          <span>送出片段後，實際 provider queue 會出現在這裡。</span>
        </div>

        <div
          v-for="job in providerWork"
          :key="`provider:${job.id}`"
          class="job-row job-row--provider"
          role="row"
        >
          <div class="job-identity" role="cell">
            <strong>{{ job.matchTitle ?? '系統工作' }}</strong>
            <span
              >{{ workKindLabel(job.workKind) }} ·
              {{ job.rallyId ? `回合 ${job.rallyId.slice(0, 8)}` : '未綁定回合' }}</span
            >
          </div>
          <span class="job-state" :class="job.status.toLowerCase()" role="cell"
            ><i />{{ statusLabel(job.status) }}</span
          >
          <span class="job-worker" role="cell">{{ job.workerInstanceKey || '等待分配' }}</span>
          <div class="job-progress" role="cell">
            <span><i :style="{ width: `${progress(job)}%` }" /></span>
            <b>{{ progress(job) }}%</b>
          </div>
          <time :datetime="job.updatedAt" role="cell">{{ formatTime(job.updatedAt) }}</time>
          <NuxtLink
            v-if="job.matchId"
            :to="`/annotate/${job.matchId}`"
            :aria-label="`開啟 ${job.matchTitle ?? '場次'}`"
            role="cell"
            ><ArrowUpRight :size="15"
          /></NuxtLink>
          <span v-else aria-hidden="true" />
        </div>

        <div v-if="jobs.length" class="queue-subheading">AI lifecycle（提交與分析狀態）</div>

        <div v-for="job in jobs" :key="job.id" class="job-row" role="row">
          <div class="job-identity" role="cell">
            <strong>{{ job.matchTitle }}</strong>
            <span
              >{{ stageLabel(job.stage) }} · 回合 <code>{{ job.rallyId.slice(0, 8) }}</code></span
            >
          </div>
          <span class="job-state" :class="job.status.toLowerCase()" role="cell"
            ><i />{{ statusLabel(job.status) }}</span
          >
          <span class="job-worker" role="cell">{{ job.workerInstanceKey || '未分配' }}</span>
          <div class="job-progress" role="cell">
            <span><i :style="{ width: `${progress(job)}%` }" /></span>
            <b>{{ progress(job) }}%</b>
          </div>
          <time :datetime="job.updatedAt" role="cell">{{ formatTime(job.updatedAt) }}</time>
          <NuxtLink
            :to="`/annotate/${job.matchId}`"
            :aria-label="`開啟 ${job.matchTitle}`"
            role="cell"
            ><ArrowUpRight :size="15"
          /></NuxtLink>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.jobs-page {
  min-height: 100%;
  background: #181818;
  color: #f2f3f5;
}
.page-header {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid #2b2b2d;
  background: #1b1b1ced;
  backdrop-filter: blur(12px);
}
.page-header h1 {
  margin: 0;
  font-size: 0.85rem;
}
.page-header p {
  margin: 3px 0 0;
  color: #929296;
  font-size: 0.56rem;
}
.page-header__sync {
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-header__sync span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #8e8e92;
  font-size: 0.55rem;
}
.page-header__sync span i,
.active-summary i,
.job-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4bc28a;
}
.page-header__sync span i.danger {
  background: #df706d;
}
.page-header__sync button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid #3a3a3d;
  border-radius: 8px;
  background: #242426;
  color: #c3c3c7;
}
.page-header__sync button:focus-visible,
.job-row > a:focus-visible,
.monitor-error button:focus-visible {
  outline: 2px solid #f2f3f5;
  outline-offset: 2px;
}
.page-header__sync button:disabled {
  opacity: 0.45;
}
.spinning {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.monitor-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 24px 0;
  padding: 10px 12px;
  border: 1px solid #643b3b;
  border-radius: 9px;
  background: #2c1d1d;
  color: #e8a3a0;
  font-size: 0.6rem;
}
.monitor-error span {
  display: grid;
  gap: 2px;
}
.monitor-error button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #fff;
}
.jobs-content {
  width: min(100%, 1500px);
  margin: auto;
  padding: 24px 24px 40px;
}
.jobs-summary {
  min-height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #303033;
}
.jobs-summary > div:first-child {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.jobs-summary strong {
  font-size: 0.72rem;
}
.jobs-summary span,
.active-summary {
  color: #929296;
  font-size: 0.55rem;
}
.active-summary {
  display: flex;
  align-items: center;
  gap: 6px;
}
.job-history {
  border-bottom: 1px solid #303033;
}
.job-history__head,
.job-row {
  display: grid;
  grid-template-columns:
    minmax(240px, 1.5fr) 110px minmax(170px, 0.8fr)
    minmax(130px, 0.55fr) 140px 32px;
  align-items: center;
  gap: 14px;
}
.job-history__head {
  min-height: 38px;
  color: #858589;
  font-size: 0.52rem;
}
.queue-subheading {
  padding: 13px 0 8px;
  border-top: 1px solid #303033;
  color: #858589;
  font-size: 0.52rem;
  letter-spacing: 0.04em;
}
.job-row--provider {
  background: #191f1d;
}
.job-row {
  min-height: 68px;
  border-top: 1px solid #2b2b2e;
}
.job-row:hover {
  background: #1d1d1f;
}
.job-identity {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.job-identity strong {
  overflow: hidden;
  font-size: 0.62rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-identity span,
.job-worker,
.job-row time {
  overflow: hidden;
  color: #8b8b90;
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-identity code {
  color: #a9a9ae;
  font-size: 0.5rem;
}
.job-state {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #b7b7bb;
  font-size: 0.54rem;
}
.job-state.queued i {
  background: #d4a255;
}
.job-state.running i {
  background: #56c48a;
}
.job-state.completed i {
  background: #67b990;
}
.job-state.failed i {
  background: #da706d;
}
.job-state.cancelled i,
.job-state.superseded i {
  background: #747479;
}
.job-progress {
  display: grid;
  grid-template-columns: minmax(70px, 1fr) 32px;
  align-items: center;
  gap: 8px;
}
.job-progress > span {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #303033;
}
.job-progress > span i {
  display: block;
  height: 100%;
  background: #65bd8e;
}
.job-progress b {
  color: #9a9a9f;
  font-size: 0.5rem;
  font-variant-numeric: tabular-nums;
}
.job-row > a {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: #bdbdc1;
}
.job-row > a:hover {
  background: #2a2a2d;
  color: #fff;
}
.job-history__empty {
  min-height: 180px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: #858589;
}
.job-history__empty strong {
  font-size: 0.64rem;
}
.job-history__empty span {
  font-size: 0.53rem;
}
@media (max-width: 1100px) {
  .job-history__head {
    display: none;
  }
  .job-row {
    grid-template-columns:
      minmax(220px, 1.4fr) 110px minmax(150px, 0.8fr)
      120px 32px;
  }
  .job-progress {
    display: none;
  }
}
@media (max-width: 760px) {
  .page-header {
    padding-inline: 14px;
  }
  .jobs-content {
    padding: 18px 14px 30px;
  }
  .page-header p,
  .page-header__sync span {
    display: none;
  }
  .job-row {
    grid-template-columns: minmax(0, 1fr) auto 32px;
    gap: 10px;
    padding-block: 10px;
  }
  .job-worker,
  .job-row time {
    grid-column: 1;
  }
  .job-state {
    grid-column: 2;
    grid-row: 1;
  }
  .job-row > a {
    grid-column: 3;
    grid-row: 1;
  }
  .jobs-summary {
    align-items: flex-start;
    padding-bottom: 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
