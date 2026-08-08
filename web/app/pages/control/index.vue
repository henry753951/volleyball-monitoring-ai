<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  Archive,
  Braces,
  CheckCircle2,
  CircleDot,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  ListFilter,
  MemoryStick,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  Server,
  SquarePen,
  UsersRound,
  Wifi,
  Workflow,
  XCircle,
} from 'lucide-vue-next'
import type { Match } from '~/lib/coreDomain'
import type { CreateMatchWithMediaInput } from '~/lib/mediaSourceClient'
import { createMediaSourceClient } from '~/lib/mediaSourceClient'
import { visibleStreamsForMatches, type MetricGroup, type StreamSnapshot } from '~/lib/operationsMonitor'

definePageMeta({ layout: 'control' })

type ControlView = 'overview' | 'matches' | 'systems' | 'media' | 'ai'
type Tone = 'good' | 'warning' | 'danger' | 'neutral' | 'info'

const route = useRoute()
const router = useRouter()
const matchesState = useMatches()
type MatchListItem = (typeof matchesState.matches.value)[number]
const setup = useCreateMatchSetup()
const core = useCoreDomain()
const monitor = useOperationsMonitor()
const mediaSources = createMediaSourceClient()
const search = ref('')
const createOpen = ref(false)
const createError = shallowRef<Error | null>(null)
const createdMatchId = ref<string | null>(null)
const sourceMatch = shallowRef<Match | null>(null)
const rosterMatch = shallowRef<Match | null>(null)
const sourceDialogOpen = ref(false)
const rosterDialogOpen = ref(false)

const view = computed<ControlView>(() => {
  const requested = typeof route.query.view === 'string' ? route.query.view : 'overview'
  return ['matches', 'systems', 'media', 'ai'].includes(requested) ? requested as ControlView : 'overview'
})
const viewMeta: Record<ControlView, { title: string; detail: string }> = {
  overview: { title: '運行總覽', detail: '所有核心服務與即時工作負載' },
  matches: { title: '場次管理', detail: '場次、隊伍、名單與輸入來源' },
  systems: { title: '系統狀態', detail: '服務相依性、同步與主機資源' },
  media: { title: '媒體與串流', detail: '輸入健康、DVR 索引與解碼資訊' },
  ai: { title: 'AI 作業', detail: '片段佇列、分析回呼與輸出資產' },
}
const filteredMatches = computed(() => {
  const value = search.value.trim().toLocaleLowerCase()
  if (!value) return matchesState.matches.value
  return matchesState.matches.value.filter(match => [match.title, match.venue, ...match.teams.flatMap(team => [team.name, team.shortName])].some(item => item?.toLocaleLowerCase().includes(value)))
})
const database = computed(() => monitor.snapshot.value?.operations.database)
const visibleMatchIds = computed(() => new Set(matchesState.matches.value.map(match => match.id)))
const streams = computed(() => visibleStreamsForMatches(
  monitor.snapshot.value?.operations.streams ?? [],
  visibleMatchIds.value,
))
const generatedAt = computed(() => monitor.snapshot.value?.operations.generatedAt ?? null)

function sum(groups: readonly MetricGroup[] | undefined, labels: Record<string, string | string[]> = {}) {
  if (!groups) return 0
  return groups.filter(group => Object.entries(labels).every(([key, expected]) => {
    const values = Array.isArray(expected) ? expected : [expected]
    return values.includes(group.labels[key] ?? '')
  })).reduce((total, group) => total + group.count, 0)
}
function all(groups: readonly MetricGroup[] | undefined) { return groups?.reduce((total, group) => total + group.count, 0) ?? 0 }
function currentSet(match: MatchListItem) { return match.sets.find(set => set.status.toLowerCase() === 'live') ?? match.sets.at(-1) }
function statusLabel(value: string) {
  const labels: Record<string, string> = {
    COMPLETED: '已完成', FAILED: '失敗', HEALTHY: '正常', LIVE: '運行中', OFFLINE: '離線',
    PENDING: '等待中', PROCESSING: '處理中', QUEUED: '排程中', READY: '就緒', RUNNING: '執行中',
    STARTING: '啟動中', STOPPING: '停止中', FINISHED: '已結束', DEGRADED: '降級', DELIVERED: '已送達',
  }
  return labels[value] ?? value
}
function statusTone(value: string): Tone {
  if (['HEALTHY', 'LIVE', 'READY', 'COMPLETED', 'DELIVERED', 'ok'].includes(value)) return 'good'
  if (['FAILED', 'OFFLINE', 'failed'].includes(value)) return 'danger'
  if (['STARTING', 'STOPPING', 'DEGRADED', 'PENDING', 'PROCESSING', 'QUEUED', 'RUNNING'].includes(value)) return 'warning'
  return 'neutral'
}
function sourceLabel(value: string) {
  const normalized = value.toUpperCase()
  const labels: Record<string, string> = { FILE: 'MP4 檔案', LOCAL_MP4: 'MP4 檔案', MP4: 'MP4 檔案', YOUTUBE: 'YouTube', YOUTUBE_LIVE: 'YouTube Live', RTMP: 'RTMP', HLS: 'HLS' }
  return labels[normalized] ?? value
}
function displaySourceLabel(stream: StreamSnapshot) {
  const label = stream.sourceLabel?.trim()
  if (!label) return sourceLabel(stream.sourceKind)
  if (/contract lab/i.test(label)) return '本機賽事影片'
  if (/docker smoke camera/i.test(label)) return `RTMP 輸入${/2$/.test(label) ? ' 02' : ' 01'}`
  return label
}
function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return '—'
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  return hours ? `${hours} 小時 ${minutes} 分` : `${minutes} 分`
}
function formatMicroseconds(value: string | undefined) {
  if (!value) return '—'
  const seconds = Number(BigInt(value) / 1_000_000n)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`
}
function formatTime(value: string | null) {
  if (!value) return '尚未同步'
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}
function fps(stream: StreamSnapshot) {
  if (!stream.program || stream.program.fps.denominator === 0) return '—'
  return `${(stream.program.fps.numerator / stream.program.fps.denominator).toFixed(2)} fps`
}
function readiness(name: string) { return monitor.snapshot.value?.readiness.checks[name] ?? null }

const liveStreams = computed(() => streams.value.filter(stream => stream.status === 'LIVE').length)
const unhealthyStreams = computed(() => streams.value.filter(stream => ['DEGRADED', 'OFFLINE'].includes(stream.health) || stream.status === 'FAILED').length)
const aiActive = computed(() => sum(database.value?.aiJobs, { status: ['PENDING', 'QUEUED', 'RUNNING', 'PROCESSING'] }))
const aiFailed = computed(() => sum(database.value?.aiJobs, { status: 'FAILED' }))
const systemRows = computed(() => [
  { name: '控制介面', detail: '管理工作站', value: monitor.error.value ? '無法連線' : monitor.snapshot.value ? '已連線' : '連線中', tone: monitor.error.value ? 'danger' : monitor.snapshot.value ? 'good' : 'warning', icon: Braces },
  { name: '核心 API', detail: `程序運行 ${formatSeconds(monitor.snapshot.value?.operations.process.uptimeSeconds ?? 0)}`, value: monitor.snapshot.value?.readiness.status === 'ready' ? '服務正常' : '服務降級', tone: monitor.snapshot.value?.readiness.status === 'ready' ? 'good' : 'danger', icon: Server },
  { name: 'PostgreSQL', detail: `${all(database.value?.rallies)} 個回合 · ${database.value?.annotationOperations.total ?? 0} 次標註操作`, value: readiness('postgres') === 'ok' ? '正常' : '異常', tone: readiness('postgres') === 'ok' ? 'good' : 'danger', icon: Database },
  { name: 'Redis / 即時同步', detail: `${all(database.value?.outboxEvents)} 筆事件 · ${sum(database.value?.outboxEvents, { status: 'PENDING' })} 筆待送`, value: readiness('redis') === 'ok' ? '正常' : '異常', tone: readiness('redis') === 'ok' ? 'good' : 'danger', icon: Wifi },
  { name: 'S3 物件儲存', detail: `${all(database.value?.mediaAssets)} 個媒體資產 · ${sum(database.value?.mediaAssets, { state: 'READY' })} 個可用`, value: readiness('minio') === 'ok' ? '正常' : '異常', tone: readiness('minio') === 'ok' ? 'good' : 'danger', icon: HardDrive },
  { name: 'OvenMediaEngine', detail: `${liveStreams.value} 路運行 · ${unhealthyStreams.value} 路需處理`, value: readiness('ovenmediaengine') === 'ok' ? (liveStreams.value ? '串流中' : '待命') : '異常', tone: readiness('ovenmediaengine') === 'ok' ? (unhealthyStreams.value ? 'warning' : 'good') : 'danger', icon: RadioTower },
] as Array<{ name: string; detail: string; value: string; tone: Tone; icon: typeof Server }>)

async function openSource(matchId: string) {
  sourceMatch.value = await core.match(matchId)
  sourceDialogOpen.value = true
}
async function openRoster(matchId: string) {
  rosterMatch.value = await core.match(matchId)
  rosterDialogOpen.value = true
}
function closeRoster() {
  rosterDialogOpen.value = false
  if (route.query.match) void router.replace({ path: '/control', query: view.value === 'overview' ? {} : { view: view.value } })
}
function closeCreate() {
  createOpen.value = false
  createError.value = null
  createdMatchId.value = null
}
async function submit(input: CreateMatchWithMediaInput) {
  try {
    if (!createdMatchId.value) createdMatchId.value = (await setup.create(input.match)).id
    await mediaSources.create(createdMatchId.value, input.media)
    closeCreate()
    await matchesState.refresh()
  }
  catch (error) {
    createError.value = error instanceof Error ? error : new Error('場次建立失敗')
  }
}
onMounted(async () => {
  await matchesState.refresh()
  const requestedMatch = typeof route.query.match === 'string' ? route.query.match : null
  if (requestedMatch) await openRoster(requestedMatch)
})
</script>

<template>
  <section class="control-page">
    <header class="page-header">
      <div>
        <h1>{{ viewMeta[view].title }}</h1>
        <p>{{ viewMeta[view].detail }}</p>
      </div>
      <div class="page-header__sync">
        <span><i :class="{ danger: monitor.error.value }" />{{ monitor.error.value ? '同步中斷' : `更新於 ${formatTime(generatedAt)}` }}</span>
        <button type="button" :disabled="monitor.pending.value" aria-label="立即重新整理" title="立即重新整理" @click="monitor.refresh">
          <RefreshCw :size="15" :class="{ spinning: monitor.pending.value }" />
        </button>
      </div>
    </header>

    <div v-if="monitor.error.value" class="monitor-error" role="alert">
      <AlertTriangle :size="17" />
      <span><strong>監控資料暫時無法更新</strong>{{ monitor.error.value.message }}</span>
      <button type="button" @click="monitor.refresh">重新連線</button>
    </div>

    <div v-if="view === 'overview'" class="view-panel overview-view">
      <div class="status-strip">
        <div>
          <span>系統</span><strong>{{ monitor.snapshot.value?.readiness.status === 'ready' ? '正常運行' : '服務降級' }}</strong>
          <small :class="monitor.snapshot.value?.readiness.status === 'ready' ? 'good' : 'danger'"><i />{{ monitor.snapshot.value?.readiness.status === 'ready' ? '全部相依服務就緒' : '有相依服務異常' }}</small>
        </div>
        <div>
          <span>即時輸入</span><strong>{{ liveStreams }} <em>/ {{ streams.length }}</em></strong>
          <small :class="unhealthyStreams ? 'danger' : 'good'"><i />{{ unhealthyStreams ? `${unhealthyStreams} 路需要處理` : '來源健康' }}</small>
        </div>
        <div>
          <span>AI 工作負載</span><strong>{{ aiActive }}</strong>
          <small :class="aiFailed ? 'danger' : 'neutral'"><i />{{ aiFailed ? `${aiFailed} 件失敗` : '沒有失敗作業' }}</small>
        </div>
        <div>
          <span>S3 媒體資產</span><strong>{{ sum(database?.mediaAssets, { state: 'READY' }) }}</strong>
          <small :class="readiness('minio') === 'ok' ? 'good' : 'danger'"><i />{{ readiness('minio') === 'ok' ? '物件儲存正常' : '物件儲存異常' }}</small>
        </div>
      </div>

      <div class="overview-grid">
        <section class="workspace-section stream-overview">
          <div class="section-heading"><div><h2>即時輸入</h2><span>媒體來源與 DVR 進度</span></div><NuxtLink :to="{ path: '/control', query: { view: 'media' } }">查看全部</NuxtLink></div>
          <div v-if="!streams.length" class="empty-state"><RadioTower :size="22" /><span>目前沒有媒體輸入</span></div>
          <div v-else class="compact-stream-list">
            <article v-for="stream in streams.slice(0, 5)" :key="stream.captureSessionId">
              <span class="source-icon"><RadioTower :size="16" /></span>
              <div><strong>{{ stream.matchTitle }}</strong><small>{{ displaySourceLabel(stream) }}</small></div>
              <div class="stream-progress"><span><i :style="{ width: `${stream.program?.segmentCount ? (stream.program.readySegmentCount / stream.program.segmentCount) * 100 : 0}%` }" /></span><small>{{ stream.program?.readySegmentCount ?? 0 }} / {{ stream.program?.segmentCount ?? 0 }} segments</small></div>
              <span class="state-tag" :class="statusTone(stream.health)"><i />{{ statusLabel(stream.health) }}</span>
            </article>
          </div>
        </section>

        <section class="workspace-section workload-overview">
          <div class="section-heading"><div><h2>作業佇列</h2><span>片段、分析與事件傳遞</span></div><NuxtLink :to="{ path: '/control', query: { view: 'ai' } }">AI 作業</NuxtLink></div>
          <dl class="workload-list">
            <div><dt><Archive :size="15" />片段建立</dt><dd><strong>{{ sum(database?.clipJobs, { status: ['PENDING', 'QUEUED', 'PROCESSING', 'RUNNING'] }) }}</strong><small>進行中</small></dd></div>
            <div><dt><Cpu :size="15" />AI 分析</dt><dd><strong>{{ aiActive }}</strong><small>執行中</small></dd></div>
            <div><dt><Workflow :size="15" />事件傳遞</dt><dd><strong>{{ sum(database?.outboxEvents, { status: 'PENDING' }) }}</strong><small>待送出</small></dd></div>
            <div><dt><XCircle :size="15" />失敗作業</dt><dd :class="{ danger: aiFailed + sum(database?.clipJobs, { status: 'FAILED' }) > 0 }"><strong>{{ aiFailed + sum(database?.clipJobs, { status: 'FAILED' }) }}</strong><small>需要處理</small></dd></div>
          </dl>
        </section>
      </div>

      <section class="workspace-section service-overview">
        <div class="section-heading"><div><h2>核心服務</h2><span>最近一次完整健康檢查</span></div><span class="section-heading__time">{{ formatTime(generatedAt) }}</span></div>
        <div class="service-line">
          <div v-for="service in systemRows.slice(1, 5)" :key="service.name"><component :is="service.icon" :size="16" /><span>{{ service.name }}</span><small :class="service.tone"><i />{{ service.value }}</small></div>
        </div>
      </section>
    </div>

    <div v-else-if="view === 'matches'" class="view-panel matches-view">
      <div class="control-actions">
        <label><Search :size="16" /><input v-model="search" placeholder="搜尋場次或隊伍" /></label>
        <button type="button" class="primary-action" @click="createOpen = true"><Plus :size="16" />新增場次</button>
      </div>
      <div class="match-table">
        <div class="match-table__head"><span>場次</span><span>隊伍</span><span>比分</span><span>狀態</span><span /></div>
        <div v-if="matchesState.pending.value" class="table-loading" />
        <div v-else-if="!filteredMatches.length" class="empty-state"><ListFilter :size="21" /><span>沒有符合的場次</span></div>
        <article v-for="match in filteredMatches" :key="match.id">
          <div><NuxtLink :to="`/annotate/${match.id}`"><strong>{{ match.title }}</strong></NuxtLink><span>{{ match.venue || '未設定場地' }}</span></div>
          <div class="match-table__teams"><span>{{ match.teams[0]?.shortName || match.teams[0]?.name }}</span><i>vs</i><span>{{ match.teams[1]?.shortName || match.teams[1]?.name }}</span></div>
          <div class="match-table__score"><b>{{ currentSet(match)?.leftScore ?? 0 }}</b><i>:</i><b>{{ currentSet(match)?.rightScore ?? 0 }}</b></div>
          <span class="state-tag" :class="match.status.toLowerCase() === 'live' ? 'good' : 'neutral'"><i />{{ match.status.toLowerCase() === 'live' ? '進行中' : match.status.toLowerCase() === 'finished' ? '已結束' : '待開始' }}</span>
          <div class="match-table__buttons">
            <button type="button" title="影音來源" aria-label="影音來源" @click="openSource(match.id)"><RadioTower :size="16" /></button>
            <button type="button" title="球員名單" aria-label="球員名單" @click="openRoster(match.id)"><UsersRound :size="16" /></button>
            <NuxtLink :to="`/annotate/${match.id}`" title="開啟標記工作站"><SquarePen :size="16" /><span>標記</span></NuxtLink>
          </div>
        </article>
      </div>
    </div>

    <div v-else-if="view === 'systems'" class="view-panel systems-view">
      <section class="workspace-section system-list-section">
        <div class="section-heading"><div><h2>服務拓樸</h2><span>控制介面至基礎設施的即時狀態</span></div><span class="state-tag" :class="monitor.snapshot.value?.readiness.status === 'ready' ? 'good' : 'danger'"><i />{{ monitor.snapshot.value?.readiness.status === 'ready' ? '所有服務就緒' : '服務降級' }}</span></div>
        <div class="system-list">
          <article v-for="service in systemRows" :key="service.name">
            <span class="system-list__icon"><component :is="service.icon" :size="17" /></span>
            <div><strong>{{ service.name }}</strong><small>{{ service.detail }}</small></div>
            <span class="state-tag" :class="service.tone"><i />{{ service.value }}</span>
          </article>
        </div>
      </section>
      <section class="workspace-section runtime-section">
        <div class="section-heading"><div><h2>API 程序資源</h2><span>目前 Fastify 服務程序</span></div></div>
        <dl class="runtime-metrics">
          <div><dt><MemoryStick :size="15" />常駐記憶體</dt><dd>{{ formatBytes(monitor.snapshot.value?.operations.process.residentBytes ?? 0) }}</dd></div>
          <div><dt><Activity :size="15" />JavaScript Heap</dt><dd>{{ formatBytes(monitor.snapshot.value?.operations.process.heapUsedBytes ?? 0) }}</dd></div>
          <div><dt><Clock3 :size="15" />程序運行時間</dt><dd>{{ formatSeconds(monitor.snapshot.value?.operations.process.uptimeSeconds ?? 0) }}</dd></div>
          <div><dt><CircleDot :size="15" />標註命令</dt><dd>{{ all(database?.annotationReceipts) }}</dd></div>
        </dl>
      </section>
    </div>

    <div v-else-if="view === 'media'" class="view-panel media-view">
      <section class="workspace-section media-section">
        <div class="section-heading"><div><h2>串流與解碼</h2><span>{{ streams.length }} 路輸入 · {{ liveStreams }} 路運行</span></div><span v-if="unhealthyStreams" class="state-tag danger"><i />{{ unhealthyStreams }} 路異常</span></div>
        <div v-if="!streams.length" class="empty-state large"><RadioTower :size="24" /><strong>目前沒有媒體輸入</strong><span>在場次管理中新增直播或影片來源</span></div>
        <div v-else class="media-table">
          <div class="media-table__head"><span>輸入來源</span><span>串流</span><span>DVR 索引</span><span>解碼</span><span>狀態</span></div>
          <article v-for="stream in streams" :key="stream.captureSessionId">
            <div><strong>{{ stream.matchTitle }}</strong><small>{{ displaySourceLabel(stream) }}</small></div>
            <div><strong>{{ sourceLabel(stream.sourceKind) }}</strong><small>更新於 {{ formatTime(stream.updatedAt) }}</small></div>
            <div class="media-table__index"><strong>{{ stream.program?.readySegmentCount ?? 0 }} / {{ stream.program?.segmentCount ?? 0 }}</strong><small>rev {{ stream.program?.playlistRevision ?? '—' }} · {{ stream.program?.gapSegmentCount ?? 0 }} gaps</small><span><i :style="{ width: `${stream.program?.segmentCount ? (stream.program.readySegmentCount / stream.program.segmentCount) * 100 : 0}%` }" /></span></div>
            <div><strong>{{ fps(stream) }}</strong><small>{{ stream.program ? `${stream.program.timeBase.numerator}/${stream.program.timeBase.denominator} timebase` : '等待節目資訊' }}</small></div>
            <div><span class="state-tag" :class="statusTone(stream.health)"><i />{{ statusLabel(stream.health) }}</span><small>{{ formatMicroseconds(stream.program?.indexedDurationUs) }} 已索引</small></div>
          </article>
        </div>
      </section>
      <div class="media-summary">
        <div><span>已就緒片段</span><strong>{{ streams.reduce((total, stream) => total + (stream.program?.readySegmentCount ?? 0), 0) }}</strong></div>
        <div><span>索引影格</span><strong>{{ streams.reduce((total, stream) => total + BigInt(stream.program?.frameCount ?? '0'), 0n).toLocaleString() }}</strong></div>
        <div><span>時間軸中斷</span><strong :class="{ danger: streams.some(stream => (stream.program?.gapSegmentCount ?? 0) > 0) }">{{ streams.reduce((total, stream) => total + (stream.program?.gapSegmentCount ?? 0), 0) }}</strong></div>
        <div><span>媒體資產</span><strong>{{ all(database?.mediaAssets) }}</strong></div>
      </div>
    </div>

    <div v-else class="view-panel ai-view">
      <div class="ai-summary">
        <div><Cpu :size="18" /><span>進行中</span><strong>{{ aiActive }}</strong></div>
        <div><CheckCircle2 :size="18" /><span>已完成</span><strong>{{ sum(database?.aiJobs, { status: 'COMPLETED' }) }}</strong></div>
        <div><XCircle :size="18" /><span>失敗</span><strong :class="{ danger: aiFailed }">{{ aiFailed }}</strong></div>
        <div><Archive :size="18" /><span>分析資產</span><strong>{{ sum(database?.mediaAssets, { kind: ['ANALYSIS_JSON', 'OVERLAY_SEQUENCE', 'OVERLAY_CHUNK'] }) }}</strong></div>
      </div>
      <div class="ai-grid">
        <section class="workspace-section metric-groups">
          <div class="section-heading"><div><h2>AI 分析作業</h2><span>依持久化狀態彙整</span></div></div>
          <div class="group-list">
            <article v-for="group in database?.aiJobs ?? []" :key="group.labels.status"><span class="state-tag" :class="statusTone(group.labels.status || '')"><i />{{ statusLabel(group.labels.status || '') }}</span><strong>{{ group.count }}</strong></article>
            <div v-if="!database?.aiJobs.length" class="empty-state"><Cpu :size="20" /><span>目前沒有 AI 作業</span></div>
          </div>
        </section>
        <section class="workspace-section metric-groups">
          <div class="section-heading"><div><h2>片段工作</h2><span>提交後的媒體處理</span></div></div>
          <div class="group-list">
            <article v-for="group in database?.clipJobs ?? []" :key="group.labels.status"><span class="state-tag" :class="statusTone(group.labels.status || '')"><i />{{ statusLabel(group.labels.status || '') }}</span><strong>{{ group.count }}</strong></article>
            <div v-if="!database?.clipJobs.length" class="empty-state"><Archive :size="20" /><span>目前沒有片段工作</span></div>
          </div>
        </section>
      </div>
      <section class="workspace-section callback-section">
        <div class="section-heading"><div><h2>回呼與輸出</h2><span>外部 AI 系統回傳與分析媒體</span></div></div>
        <div class="callback-line">
          <div><span>回呼收據</span><strong>{{ all(database?.aiCallbacks) }}</strong><small>{{ database?.aiCallbacks.map(item => `${statusLabel(item.labels.kind || '')} ${item.count}`).join(' · ') || '尚無回呼' }}</small></div>
          <div><span>JSON 分析</span><strong>{{ sum(database?.mediaAssets, { kind: 'ANALYSIS_JSON', state: 'READY' }) }}</strong><small>可讀取資產</small></div>
          <div><span>Overlay 分段</span><strong>{{ sum(database?.mediaAssets, { kind: 'OVERLAY_CHUNK', state: 'READY' }) }}</strong><small>可串流資產</small></div>
          <div><span>事件待送</span><strong>{{ sum(database?.outboxEvents, { status: 'PENDING' }) }}</strong><small>Outbox</small></div>
        </div>
      </section>
    </div>

    <UiAnimatedModal :open="createOpen" title="新增場次" description="設定隊伍、名單與影音來源" width="wide" @close="closeCreate">
      <UiScrollArea class="create-scroll"><div class="create-content"><MatchSetupForm :pending="setup.pending.value" :error="createError ?? setup.error.value" compact @submit="submit" @cancel="closeCreate" /></div></UiScrollArea>
    </UiAnimatedModal>
    <LazyCaptureControlDialog v-if="sourceMatch" :open="sourceDialogOpen" :match-id="sourceMatch.id" :captures="sourceMatch.captureSessions ?? []" @close="sourceDialogOpen = false" @changed="matchesState.refresh" />
    <LazyRosterEditorDialog v-if="rosterMatch" :open="rosterDialogOpen" :match="rosterMatch" @close="closeRoster" @changed="matchesState.refresh" />
  </section>
</template>

<style scoped>
.control-page{width:100%;min-height:100dvh}.page-header{height:66px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 28px;border-bottom:1px solid #24272b;background:#0d0f12}.page-header h1{margin:0;color:#f1f3f5;font-size:.9rem;font-weight:750;letter-spacing:-.01em}.page-header p{margin:3px 0 0;color:#737980;font-size:.62rem}.page-header__sync{display:flex;align-items:center;gap:8px}.page-header__sync>span{display:flex;align-items:center;gap:7px;color:#858b92;font-size:.62rem}.page-header__sync i,.state-tag i,.status-strip small i,.service-line small i{width:6px;height:6px;display:inline-block;border-radius:50%;background:#46c88a}.page-header__sync i.danger{background:#ef6a67}.page-header__sync button{width:32px;height:32px;display:grid;place-items:center;border:1px solid #30343a;border-radius:8px;background:#171a1e;color:#abb0b6}.page-header__sync button:hover{border-color:#4b5057;color:#fff}.page-header__sync button:disabled{cursor:wait;opacity:.58}.spinning{animation:spin .8s linear infinite}.view-panel{padding:22px 28px 36px;animation:panel-in 260ms cubic-bezier(.16,1,.3,1)}.monitor-error{display:flex;align-items:center;gap:10px;margin:16px 28px 0;padding:11px 13px;border:1px solid #613333;border-radius:10px;background:#211314;color:#f2adab;font-size:.68rem}.monitor-error span{display:grid;gap:2px}.monitor-error span strong{color:#ffe0df}.monitor-error button{margin-left:auto;border:1px solid #71403f;border-radius:7px;background:#321b1c;color:#ffd1cf;padding:6px 10px;font-size:.65rem}.workspace-section{border:1px solid #262a2f;border-radius:13px;background:#101216;box-shadow:0 16px 35px #0004}.section-heading{min-height:55px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-bottom:1px solid #25292e}.section-heading>div{display:grid;gap:3px}.section-heading h2{margin:0;font-size:.76rem;letter-spacing:-.01em}.section-heading span{color:#727980;font-size:.6rem}.section-heading>a{color:#aeb4ba;font-size:.62rem;text-decoration:none}.section-heading>a:hover{color:#fff}.section-heading__time{font-variant-numeric:tabular-nums}.status-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow:hidden;margin-bottom:18px;border:1px solid #292d32;border-radius:13px;background:#111317;box-shadow:0 18px 45px #0004}.status-strip>div{min-height:112px;display:grid;align-content:center;gap:6px;padding:16px 18px;border-left:1px solid #292d32}.status-strip>div:first-child{border-left:0}.status-strip span{color:#7d848b;font-size:.62rem}.status-strip strong{font-size:1.45rem;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.035em}.status-strip strong em{color:#646a71;font-size:.72rem;font-style:normal;font-weight:600}.status-strip small{display:flex;align-items:center;gap:6px;color:#818890;font-size:.58rem}.status-strip small.good,.state-tag.good,.service-line small.good{color:#65d49a}.status-strip small.warning,.state-tag.warning,.service-line small.warning{color:#e6b75d}.status-strip small.danger,.state-tag.danger,.service-line small.danger,.danger{color:#ef7673!important}.status-strip small.neutral,.state-tag.neutral,.service-line small.neutral{color:#858c93}.status-strip small.info,.state-tag.info{color:#78b8e8}.status-strip small.warning i,.state-tag.warning i,.service-line small.warning i{background:#dca84d}.status-strip small.danger i,.state-tag.danger i,.service-line small.danger i{background:#ef6a67}.status-strip small.neutral i,.state-tag.neutral i,.service-line small.neutral i{background:#717880}.overview-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.7fr);gap:18px}.compact-stream-list article{min-height:62px;display:grid;grid-template-columns:34px minmax(150px,1fr) minmax(150px,.8fr) auto;align-items:center;gap:11px;padding:0 15px;border-top:1px solid #22262a}.compact-stream-list article:first-child{border-top:0}.source-icon,.system-list__icon{width:31px;height:31px;display:grid;place-items:center;border-radius:8px;background:#1c2025;color:#bfc4c9}.compact-stream-list article>div:nth-child(2),.media-table article>div,.system-list article>div{min-width:0;display:grid;gap:3px}.compact-stream-list strong,.media-table strong,.system-list strong{overflow:hidden;font-size:.68rem;text-overflow:ellipsis;white-space:nowrap}.compact-stream-list small,.media-table small,.system-list small{color:#747b82;font-size:.56rem}.stream-progress{display:grid!important;gap:5px!important}.stream-progress>span,.media-table__index>span{height:3px;overflow:hidden;border-radius:2px;background:#282d32}.stream-progress>span i,.media-table__index>span i{height:100%;display:block;background:#64c997}.state-tag{display:inline-flex;width:max-content;align-items:center;gap:6px;color:#858c93;font-size:.6rem;white-space:nowrap}.workload-list{margin:0}.workload-list>div{min-height:62px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 16px;border-top:1px solid #22262a}.workload-list>div:first-child{border-top:0}.workload-list dt{display:flex;align-items:center;gap:8px;color:#a6acb2;font-size:.65rem}.workload-list dd{display:flex;align-items:baseline;gap:7px;margin:0}.workload-list dd strong{font-size:1.02rem;font-variant-numeric:tabular-nums}.workload-list dd small{color:#6f767d;font-size:.55rem}.service-overview{margin-top:18px}.service-line{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.service-line>div{min-height:63px;display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:8px;padding:0 15px;border-left:1px solid #24282d}.service-line>div:first-child{border-left:0}.service-line>div>svg{color:#888f96}.service-line>div>span{font-size:.64rem}.service-line small{display:flex;align-items:center;gap:5px;font-size:.57rem}.control-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.control-actions label{width:min(370px,50vw);min-height:38px;display:flex;align-items:center;gap:8px;padding:0 11px;border:1px solid #30343a;border-radius:9px;background:#121519;color:#7f868d}.control-actions input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:#eff1f3;font-size:.69rem}.primary-action{min-height:38px;display:inline-flex;align-items:center;gap:7px;padding:0 13px;border:1px solid #dedfe1;border-radius:9px;background:#eff0f1;color:#121416;font-size:.68rem;font-weight:750}.primary-action:hover{background:#fff}.match-table{overflow:hidden;border:1px solid #292d32;border-radius:13px;background:#101216;box-shadow:0 18px 45px #0004}.match-table__head,.match-table article{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(190px,.8fr) 130px 100px 200px;align-items:center;gap:14px;padding:0 16px}.match-table__head{height:38px;background:#15181c;color:#747b82;font-size:.6rem;font-weight:700}.match-table article{min-height:68px;border-top:1px solid #25292e}.match-table article:hover{background:#15181c}.match-table article>div:first-child{min-width:0;display:grid;gap:3px}.match-table article>div:first-child>a{min-width:0;color:inherit;text-decoration:none}.match-table article>div:first-child strong{display:block;overflow:hidden;font-size:.72rem;text-overflow:ellipsis;white-space:nowrap}.match-table article>div:first-child span{color:#777e85;font-size:.59rem}.match-table__teams{display:flex;align-items:center;gap:8px;font-size:.68rem;font-weight:650}.match-table__teams i,.match-table__score i{color:#686f76;font-size:.58rem;font-style:normal}.match-table__score{display:flex;align-items:center;gap:7px;font-variant-numeric:tabular-nums}.match-table__score b{font-size:1.1rem}.match-table__buttons{display:flex;justify-content:flex-end;gap:6px}.match-table__buttons button,.match-table__buttons a{min-height:33px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;border:1px solid #343940;border-radius:8px;background:#181b20;color:#c1c6cb;font-size:.62rem;font-weight:700;text-decoration:none}.match-table__buttons button{width:33px;padding:0}.match-table__buttons button:hover,.match-table__buttons a:hover{border-color:#555b63;background:#20242a;color:#fff}.table-loading{height:320px;background:linear-gradient(100deg,#111317 20%,#1d2126 40%,#111317 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.empty-state{min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:#737a81;font-size:.64rem}.empty-state.large{min-height:280px}.empty-state strong{color:#b8bdc2;font-size:.72rem}.system-list-section{overflow:hidden}.system-list article{min-height:68px;display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:11px;padding:0 16px;border-top:1px solid #22262a}.system-list article:first-child{border-top:0}.runtime-section{margin-top:18px}.runtime-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0}.runtime-metrics>div{min-height:78px;display:grid;align-content:center;gap:8px;padding:0 16px;border-left:1px solid #24282d}.runtime-metrics>div:first-child{border-left:0}.runtime-metrics dt{display:flex;align-items:center;gap:7px;color:#7d848b;font-size:.59rem}.runtime-metrics dd{margin:0;font-size:.93rem;font-weight:700;font-variant-numeric:tabular-nums}.media-section{overflow:hidden}.media-table__head,.media-table article{display:grid;grid-template-columns:minmax(190px,1.2fr) minmax(120px,.65fr) minmax(180px,1fr) minmax(135px,.7fr) minmax(110px,.55fr);align-items:center;gap:16px;padding:0 16px}.media-table__head{height:38px;background:#15181c;color:#737a81;font-size:.59rem;font-weight:700}.media-table article{min-height:76px;border-top:1px solid #24282d}.media-table article:hover{background:#14171b}.media-table article>div:last-child{align-items:start}.media-table__index span{margin-top:3px}.media-summary,.ai-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:18px;overflow:hidden;border:1px solid #292d32;border-radius:13px;background:#101216}.media-summary>div{min-height:84px;display:grid;align-content:center;gap:6px;padding:0 16px;border-left:1px solid #292d32}.media-summary>div:first-child{border-left:0}.media-summary span{color:#747b82;font-size:.59rem}.media-summary strong{font-size:1.1rem;font-variant-numeric:tabular-nums}.ai-summary{margin-top:0}.ai-summary>div{min-height:92px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:7px;padding:0 17px;border-left:1px solid #292d32}.ai-summary>div:first-child{border-left:0}.ai-summary svg{color:#858c93}.ai-summary span{color:#7d848b;font-size:.62rem}.ai-summary strong{font-size:1.35rem;font-variant-numeric:tabular-nums}.ai-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.group-list article{min-height:53px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-top:1px solid #24282d}.group-list article:first-child{border-top:0}.group-list article strong{font-size:.84rem;font-variant-numeric:tabular-nums}.callback-section{margin-top:18px}.callback-line{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.callback-line>div{min-height:88px;display:grid;align-content:center;gap:5px;padding:0 16px;border-left:1px solid #24282d}.callback-line>div:first-child{border-left:0}.callback-line span{color:#777e85;font-size:.59rem}.callback-line strong{font-size:1rem}.callback-line small{overflow:hidden;color:#686f76;font-size:.55rem;text-overflow:ellipsis;white-space:nowrap}.create-scroll{height:min(720px,calc(86dvh - 52px))}.create-content{padding:14px}@keyframes spin{to{transform:rotate(360deg)}}@keyframes shimmer{to{background-position:-200% 0}}@keyframes panel-in{from{opacity:.72;transform:translateY(5px);filter:blur(2px)}to{opacity:1;transform:none;filter:none}}
@media(max-width:1120px){.status-strip{grid-template-columns:repeat(2,1fr)}.status-strip>div:nth-child(3){border-left:0;border-top:1px solid #292d32}.status-strip>div:nth-child(4){border-top:1px solid #292d32}.overview-grid{grid-template-columns:1fr}.service-line,.runtime-metrics,.callback-line{grid-template-columns:repeat(2,1fr)}.service-line>div:nth-child(3),.runtime-metrics>div:nth-child(3),.callback-line>div:nth-child(3){border-left:0;border-top:1px solid #24282d}.service-line>div:nth-child(4),.runtime-metrics>div:nth-child(4),.callback-line>div:nth-child(4){border-top:1px solid #24282d}.media-table__head{display:none}.media-table article{grid-template-columns:1.2fr .7fr 1fr}.media-table article>div:nth-child(4),.media-table article>div:nth-child(5){grid-row:2}.media-table article>div:nth-child(5){grid-column:3}.media-table article{padding-block:12px}.match-table__head{display:none}.match-table article{grid-template-columns:minmax(0,1fr) auto auto;gap:10px;padding:12px 14px}.match-table__teams{grid-column:1}.match-table__score{grid-column:2}.match-table__buttons{grid-column:1/-1;justify-content:flex-start}}
@media(max-width:760px){.page-header{padding-inline:16px}.page-header p{display:none}.view-panel{padding:16px}.monitor-error{margin-inline:16px}.status-strip,.media-summary,.ai-summary,.ai-grid{grid-template-columns:1fr}.status-strip>div,.status-strip>div:nth-child(n),.media-summary>div,.ai-summary>div{border-left:0;border-top:1px solid #292d32}.status-strip>div:first-child,.media-summary>div:first-child,.ai-summary>div:first-child{border-top:0}.compact-stream-list article{grid-template-columns:34px 1fr auto}.stream-progress{grid-column:2/-1}.service-line,.runtime-metrics,.callback-line{grid-template-columns:1fr}.service-line>div,.runtime-metrics>div,.callback-line>div,.service-line>div:nth-child(n),.runtime-metrics>div:nth-child(n),.callback-line>div:nth-child(n){border-left:0;border-top:1px solid #24282d}.service-line>div:first-child,.runtime-metrics>div:first-child,.callback-line>div:first-child{border-top:0}.media-table article{grid-template-columns:1fr 1fr}.media-table article>div:nth-child(n){grid-row:auto;grid-column:auto}.control-actions label{width:100%}.primary-action span{display:none}}
@media(prefers-reduced-motion:reduce){.view-panel,.spinning,.table-loading{animation:none}}
</style>
