<script setup lang="ts">
import {
  ChevronRight,
  CircleDot,
  Ellipsis,
  Film,
  Pencil,
  RadioTower,
  SquarePen,
  Trash2,
  UsersRound,
} from 'lucide-vue-next'
import type { DeepReadonly } from 'vue'
import type { Match } from '~/lib/coreDomain'
import type { AiWorkSnapshot, MatchMediaSnapshot, StreamSnapshot } from '~/lib/operationsMonitor'

const props = defineProps<{
  match: DeepReadonly<Match>
  media: MatchMediaSnapshot | null
  streams: readonly StreamSnapshot[]
  jobs: readonly AiWorkSnapshot[]
}>()

const emit = defineEmits<{
  media: []
  roster: []
  edit: []
  delete: []
  monitor: []
}>()

const currentSet = computed(() => props.match.sets.find(set => set.status.toLowerCase() === 'live') ?? props.match.sets.at(-1))
const leftSetWins = computed(() => props.match.sets.filter(set => set.winningTeamId === props.match.teams[0]?.id).length)
const rightSetWins = computed(() => props.match.sets.filter(set => set.winningTeamId === props.match.teams[1]?.id).length)
const currentSource = computed(() => props.streams.find(stream => ['LIVE', 'STARTING', 'STOPPING'].includes(stream.status)) ?? props.streams[0] ?? null)
const liveSource = computed(() => currentSource.value)
const latestJob = computed(() => props.jobs[0] ?? null)
const indexedPercent = computed(() => props.media?.segmentCount
  ? Math.min(100, props.media.readySegmentCount / props.media.segmentCount * 100)
  : 0)

function sourceLabel(value: string) {
  const labels: Record<string, string> = {
    FILE: '本機影片', HLS: 'HLS', LOCAL_MP4: '本機影片', MP4: '本機影片', RTMP: 'RTMP',
    YOUTUBE: 'YouTube', YOUTUBE_LIVE: 'YouTube Live',
  }
  return labels[value.toUpperCase()] ?? value
}
function statusLabel(value: string) {
  const labels: Record<string, string> = {
    COMPLETED: '分析完成', FAILED: '處理失敗', LIVE: '直播中', OFFLINE: '離線', PENDING: '等待中',
    PROCESSING: '處理中', QUEUED: '等待 Worker', READY: '就緒', RUNNING: '分析中', STARTING: '啟動中',
  }
  return labels[value] ?? value
}
function stageLabel(value: string | null) {
  if (!value) return '等待 Worker'
  const labels: Record<string, string> = {
    building_artifacts: '建立分析資產', callback: '回傳分析結果', completed: '分析完成',
    court_projection: '場地轉換', downloading_clip: '下載片段', hit_association: '擊球者關聯',
    loading_reference_data: '載入追蹤資料', player_tracking: '人物追蹤', reidentification: '身份合併',
  }
  return labels[value] ?? value.replaceAll('_', ' ')
}
function duration(value: string | undefined) {
  if (!value) return '0:00'
  const seconds = Number(BigInt(value) / 1_000_000n)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function formatBytes(value: string | undefined) {
  const bytes = Number(value ?? 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
</script>

<template>
  <article class="match-workspace">
    <header class="match-workspace__header">
      <div class="match-identity">
        <span class="match-state" :class="match.status.toLowerCase()"><i />{{ match.status.toLowerCase() === 'live' ? '進行中' : match.status.toLowerCase() === 'finished' ? '已結束' : '待開始' }}</span>
        <h2>{{ match.title }}</h2>
        <p>{{ match.venue || '未設定場地' }}<span v-if="match.scheduledAt"> · {{ new Intl.DateTimeFormat('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(match.scheduledAt)) }}</span></p>
      </div>

      <div class="match-actions">
        <NuxtLink :to="`/annotate/${match.id}`" class="annotate-action"><SquarePen :size="15" />開啟標記</NuxtLink>
        <details class="match-menu">
          <summary aria-label="更多場次操作"><Ellipsis :size="18" /></summary>
          <div>
            <button type="button" @click="emit('media')"><RadioTower :size="15" />影音來源</button>
            <button type="button" @click="emit('roster')"><UsersRound :size="15" />球員名單</button>
            <button type="button" @click="emit('edit')"><Pencil :size="15" />編輯場次</button>
            <button type="button" class="danger" @click="emit('delete')"><Trash2 :size="15" />刪除場次</button>
          </div>
        </details>
      </div>
    </header>

    <section class="scoreboard" aria-label="目前比分">
      <div class="score-team left"><strong>{{ match.teams[0]?.shortName || match.teams[0]?.name || '左隊' }}</strong><span>{{ match.teams[0]?.name }}</span><small class="team-set-score" :aria-label="`左隊勝局 ${leftSetWins}`">{{ leftSetWins }}</small></div>
      <div class="point-score"><div><b>{{ currentSet?.leftScore ?? 0 }}</b><i>:</i><b>{{ currentSet?.rightScore ?? 0 }}</b></div><small>第 {{ currentSet?.setNumber ?? 1 }} 局</small></div>
      <div class="score-team right"><strong>{{ match.teams[1]?.shortName || match.teams[1]?.name || '右隊' }}</strong><span>{{ match.teams[1]?.name }}</span><small class="team-set-score" :aria-label="`右隊勝局 ${rightSetWins}`">{{ rightSetWins }}</small></div>
    </section>

    <div class="runtime-grid">
      <section class="runtime-rail media-rail">
        <div class="rail-heading">
          <span><Film :size="15" />媒體與 DVR</span>
          <div class="rail-heading-actions"><strong :class="{ danger: media?.failedCaptureCount }">{{ media?.activeCaptureCount ?? 0 }} 運行中</strong><button type="button" @click="emit('monitor')">詳細監控<ChevronRight :size="13" /></button></div>
        </div>
        <div v-if="currentSource" class="source-chips">
          <span :class="currentSource.status.toLowerCase()"><i />{{ sourceLabel(currentSource.sourceKind) }}<small>{{ statusLabel(currentSource.status) }}</small></span>
        </div>
        <div v-else class="rail-empty">尚未設定影音來源</div>
        <div class="rail-progress">
          <span><i :style="{ width: `${indexedPercent}%` }" /></span>
          <div><strong>{{ media?.readySegmentCount ?? 0 }} / {{ media?.segmentCount ?? 0 }} 段已索引</strong><small>{{ duration(media?.indexedDurationUs) }} · {{ formatBytes(media?.storedBytes) }}<template v-if="media?.gapSegmentCount"> · <em>{{ media.gapSegmentCount }} 中斷</em></template></small></div>
        </div>
        <p v-if="liveSource?.program">{{ liveSource.program.fps.denominator ? (liveSource.program.fps.numerator / liveSource.program.fps.denominator).toFixed(2) : '—' }} fps · rev {{ liveSource.program.playlistRevision }}</p>
      </section>

      <section class="runtime-rail ai-rail">
        <div class="rail-heading">
          <span><CircleDot :size="15" />AI Pipeline</span>
          <div class="rail-heading-actions"><strong>{{ jobs.length ? `${jobs.length} 處理中` : '閒置' }}</strong><NuxtLink to="/control/jobs">查看紀錄<ChevronRight :size="13" /></NuxtLink></div>
        </div>
        <div v-if="latestJob" class="latest-job">
          <div><strong>{{ stageLabel(latestJob.stage) }}</strong><span>{{ statusLabel(latestJob.status) }}</span></div>
          <p>{{ latestJob.workerInstanceKey || '尚未分配 Worker' }}</p>
          <span class="job-progress"><i :style="{ width: `${Math.min(100, (latestJob.progress ?? 0) * 100)}%` }" /></span>
          <small>{{ Math.round((latestJob.progress ?? 0) * 100) }}% · 最近更新 {{ new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(latestJob.updatedAt)) }}</small>
        </div>
        <div v-else class="rail-empty">目前沒有處理中的作業</div>
        <div v-if="jobs.length > 1" class="job-summary">
          <span v-for="job in jobs.slice(1, 4)" :key="job.id"><i :class="job.status.toLowerCase()" />{{ stageLabel(job.stage) }}<small>{{ statusLabel(job.status) }}</small></span>
        </div>
      </section>
    </div>

    <footer>
      <span>{{ match.rosterEntries.length }} 位球員</span>
      <button type="button" @click="emit('media')">管理場次工作區<ChevronRight :size="14" /></button>
    </footer>
  </article>
</template>

<style scoped>
.match-workspace{overflow:visible;border:1px solid #2a2c30;border-radius:14px;background:#101114;color:#f3f4f6;box-shadow:0 18px 40px #0003}.match-workspace__header{min-height:88px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:18px 18px 14px}.match-identity{min-width:0}.match-state{display:flex;align-items:center;gap:6px;color:#8f9298;font-size:.58rem;font-weight:750}.match-state i{width:6px;height:6px;border-radius:50%;background:#777a80}.match-state.live i{background:#46c487;box-shadow:0 0 0 3px #46c48718}.match-identity h2{margin:7px 0 3px;overflow:hidden;font-size:.9rem;letter-spacing:-.02em;text-overflow:ellipsis;white-space:nowrap}.match-identity p{margin:0;color:#7e8187;font-size:.59rem}.match-actions{display:flex;align-items:center;gap:7px}.annotate-action,.match-menu summary{height:34px;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid #383b40;border-radius:8px;background:#1a1c20;color:#f6f7f8;font-size:.64rem;font-weight:700;text-decoration:none}.annotate-action{padding:0 12px}.annotate-action:hover,.match-menu summary:hover{background:#24262b}.match-menu{position:relative}.match-menu summary{width:34px;cursor:pointer;list-style:none}.match-menu summary::-webkit-details-marker{display:none}.match-menu>div{position:absolute;right:0;top:40px;z-index:25;width:158px;padding:5px;border:1px solid #36383d;border-radius:9px;background:#18191d;box-shadow:0 16px 36px #0009}.match-menu button{width:100%;height:34px;display:flex;align-items:center;gap:9px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:#c5c8cd;font-size:.62rem;text-align:left}.match-menu button:hover{background:#27292e;color:#fff}.match-menu button.danger{color:#e09a97}.scoreboard{position:relative;min-height:88px;display:grid;grid-template-columns:minmax(90px,1fr) auto 12px auto minmax(90px,1fr);align-items:center;gap:12px;padding:12px 18px;border-block:1px solid #292b30;background:#0c0d10}.scoreboard>div{display:grid;gap:2px}.scoreboard>div:first-child{text-align:right}.scoreboard>div:nth-of-type(2){text-align:left}.scoreboard div strong{font-size:.7rem}.scoreboard div span{overflow:hidden;color:#73767c;font-size:.53rem;text-overflow:ellipsis;white-space:nowrap}.scoreboard>b{font-size:1.5rem;font-variant-numeric:tabular-nums}.scoreboard>i{color:#55585e;font-style:normal}.scoreboard>small{position:absolute;left:50%;bottom:7px;transform:translateX(-50%);color:#70737a;font-size:.5rem}.runtime-grid{display:grid;grid-template-columns:1fr 1fr}.runtime-rail{min-width:0;padding:15px 18px}.runtime-rail+section{border-left:1px solid #292b30}.rail-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.rail-heading>span{display:flex;align-items:center;gap:7px;color:#a9adb3;font-size:.61rem;font-weight:750}.rail-heading>strong{color:#8b8e94;font-size:.54rem}.rail-heading>strong.danger{color:#e28a87}.source-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:27px}.source-chips>span{display:flex;align-items:center;gap:5px;padding:5px 7px;border:1px solid #32353a;border-radius:6px;background:#17191d;color:#bec1c6;font-size:.54rem}.source-chips i{width:5px;height:5px;border-radius:50%;background:#73777d}.source-chips .live i{background:#48c487}.source-chips small{color:#6f7379}.rail-progress{display:grid;grid-template-columns:minmax(90px,.8fr) minmax(130px,1fr);align-items:center;gap:10px;margin-top:12px}.rail-progress>span,.job-progress{height:5px;overflow:hidden;border-radius:3px;background:#292c31}.rail-progress>span i,.job-progress i{display:block;height:100%;background:#54c994}.rail-progress>div{display:grid;gap:3px}.rail-progress strong,.latest-job strong{font-size:.58rem}.rail-progress small,.latest-job small{color:#74777d;font-size:.5rem}.rail-progress em{color:#e48d89;font-style:normal}.runtime-rail>p{margin:8px 0 0;color:#696d73;font-size:.5rem}.rail-empty{min-height:52px;display:grid;place-items:center;border:1px dashed #303237;border-radius:7px;color:#6f7278;font-size:.56rem}.latest-job{display:grid;gap:7px}.latest-job>div{display:flex;justify-content:space-between;gap:10px}.latest-job>div span{color:#8c8f96;font-size:.54rem}.latest-job p{margin:0;color:#777a80;font-size:.53rem}.job-summary{display:flex;gap:6px;margin-top:10px}.job-summary>span{min-width:0;display:flex;align-items:center;gap:5px;padding:5px 7px;border:1px solid #303238;border-radius:6px;color:#aaaeb3;font-size:.5rem}.job-summary i{width:5px;height:5px;border-radius:50%;background:#c99b53}.job-summary i.completed{background:#56bd88}.job-summary i.failed{background:#d46f6b}.job-summary small{color:#6c7076}.match-workspace footer{height:39px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-top:1px solid #292b30;color:#72757b;font-size:.53rem}.match-workspace footer button{display:flex;align-items:center;gap:4px;border:0;background:transparent;color:#aeb2b7;font-size:.56rem}.match-workspace footer button:hover{color:#fff}
@media(max-width:920px){.runtime-grid{grid-template-columns:1fr}.runtime-rail+section{border-left:0;border-top:1px solid #292b30}}
@media(max-width:620px){.match-workspace__header{align-items:center}.annotate-action{width:34px;padding:0}.annotate-action{font-size:0}.scoreboard{gap:8px}.runtime-rail{padding-inline:14px}}
.match-workspace{overflow:hidden;border:1px solid #303033;background:#202021;box-shadow:none}.annotate-action,.match-menu summary,.source-chips>span,.job-summary>span{border:1px solid #2b2b2e}.match-workspace__header{background:#202021}.scoreboard{border-block:1px solid #2c2c2f}.runtime-grid{background:#1d1d1e}.runtime-rail+section,.match-workspace footer{border-color:#303033}.rail-empty{border:1px solid #29292c;background:#181819}.match-menu>div{border-color:#353538;background:#242426}
.scoreboard{min-height:104px;grid-template-columns:minmax(110px,1fr) auto minmax(110px,1fr);gap:22px;padding:14px 22px;background:#171718}.scoreboard>.score-team{display:grid;align-content:center;gap:3px}.scoreboard>.score-team.left{text-align:right}.scoreboard>.score-team.right{text-align:left}.scoreboard>.score-team strong{font-size:.7rem}.scoreboard>.score-team span{color:#929296;font-size:.52rem}.team-set-score{width:24px;height:18px;display:grid;place-items:center;margin-top:3px;padding:0;border-radius:5px;background:#2b2b2e;color:#d0d0d4!important;font-size:.51rem!important;font-weight:700;font-variant-numeric:tabular-nums}.score-team.left .team-set-score{justify-self:end}.score-team.right .team-set-score{justify-self:start}.point-score{display:grid!important;place-items:center;align-content:center;gap:5px;text-align:center!important}.point-score>div{display:flex;align-items:center;gap:10px}.point-score b{font-size:1.55rem;font-variant-numeric:tabular-nums}.point-score i{color:#6d6d72;font-style:normal}.point-score small{color:#8c8c91;font-size:.5rem}
.rail-heading-actions{display:flex;align-items:center;gap:10px}.rail-heading-actions>strong{color:#9a9a9f;font-size:.54rem}.rail-heading-actions>strong.danger{color:#e28a87}.rail-heading-actions button,.rail-heading-actions a{display:flex;align-items:center;gap:3px;border:0;background:transparent;color:#a8a8ad;font-size:.52rem;text-decoration:none}.rail-heading-actions button:hover,.rail-heading-actions a:hover{color:#fff}.rail-heading-actions a:focus-visible{outline:2px solid #f2f3f5;outline-offset:2px}
</style>
