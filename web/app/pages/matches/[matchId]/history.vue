<script setup lang="ts">
import { Bookmark, ChevronRight, CircleAlert, Clock3, RefreshCw, Save } from 'lucide-vue-next'
import { createCoachDomainClient, type SavedAnalysisView } from '~/lib/coachDomain'
import { createCoreDomainClient, createGraphQLTransport, type Viewer } from '~/lib/coreDomain'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const coach = useCoachMatchState(matchId)
const match = computed(() => coach.data.value?.match ?? null)
const selectedSet = ref<number | 'all'>('all')
const rallies = computed(() => (match.value?.rallies ?? []).filter(rally => selectedSet.value === 'all' || rally.set_number === selectedSet.value))
const teamById = computed(() => new Map((match.value?.teams ?? []).map(team => [team.id, team])))
const domain = createCoachDomainClient(createGraphQLTransport('/graphql'))
const core = createCoreDomainClient(createGraphQLTransport('/graphql'))
const savedViews = shallowRef<SavedAnalysisView[]>([])
const viewer = shallowRef<Viewer | null>(null)
const viewName = ref('')
const savedPending = ref(false)
const savedError = ref<string | null>(null)
const retryingRallyId = ref<string | null>(null)
const retryError = ref<string | null>(null)
const canRetry = computed(() => ['ADMIN', 'OPERATOR'].includes(viewer.value?.role ?? ''))

function outcomeLabel(rally: (typeof rallies.value)[number]) {
  if (rally.submission.score_resolution === 'unknown') return '結果未知'
  return teamById.value.get(rally.submission.scoring_team_id ?? '')?.name ?? rally.submission.scoring_court_side ?? '未計分'
}
function processLabel(value: string) {
  return ({ idle: '等待處理', clip_queued: '片段排程', clipping: '建立片段', ai_queued: 'AI 排程', ai_processing: 'AI 分析', artifact_ingesting: '匯入結果', completed: '完成', failed: '失敗', superseded: '已取代' }[value] ?? value)
}
const submittedAt = (value: string) => new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
async function loadSavedViews() {
  try { savedViews.value = (await domain.savedAnalysisViews(matchId.value))?.views ?? [] }
  catch (cause) { savedError.value = cause instanceof Error ? cause.message : '無法載入保存視圖' }
}
async function saveCurrentView() {
  const name = viewName.value.trim()
  if (!name || savedPending.value) return
  savedPending.value = true; savedError.value = null
  try {
    await domain.saveAnalysisView({ matchId: matchId.value, name, filters: selectedSet.value === 'all' ? {} : { set_numbers: [selectedSet.value] }, layout: { route: 'history' } })
    viewName.value = ''
    await loadSavedViews()
  }
  catch (cause) { savedError.value = cause instanceof Error ? cause.message : '保存視圖失敗' }
  finally { savedPending.value = false }
}
async function openSavedView(view: SavedAnalysisView) {
  const sets = Array.isArray(view.filters.set_numbers) ? view.filters.set_numbers.filter(value => Number.isInteger(value)) as number[] : []
  selectedSet.value = sets.length === 1 ? sets[0]! : 'all'
  if (view.layout?.route && view.layout.route !== 'history') await navigateTo(`/matches/${matchId.value}/${view.layout.route}`)
}
async function retryRally(rallyId: string) {
  if (!canRetry.value || retryingRallyId.value) return
  retryingRallyId.value = rallyId; retryError.value = null
  try { await core.retryProcessing(rallyId); await coach.refresh() }
  catch (cause) { retryError.value = cause instanceof Error ? cause.message : '無法重新排程處理' }
  finally { retryingRallyId.value = null }
}
onMounted(async () => { await Promise.all([loadSavedViews(), core.viewer().then(value => { viewer.value = value })]) })
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div><p class="text-sm text-stone-500">{{ match?.title || `Match ${matchId}` }}</p><h1 class="text-2xl font-semibold tracking-tight">已提交 Rally</h1><p class="mt-1 text-sm text-stone-600">只列 immutable submissions；草稿不會出現在教練端。</p></div>
      <div class="flex items-center gap-2">
        <label class="sr-only" for="set-filter">局數</label>
        <select id="set-filter" v-model="selectedSet" class="field min-w-32">
          <option value="all">全部局數</option>
          <option v-for="set in match?.sets" :key="set.id" :value="set.set_number">第 {{ set.set_number }} 局</option>
        </select>
        <button class="button-secondary inline-flex items-center gap-2" :disabled="coach.refreshing.value" @click="coach.refresh"><RefreshCw class="size-4" :class="{ 'animate-spin': coach.refreshing.value }" />同步</button>
      </div>
    </header>

    <section class="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="saved-views-heading">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div><h2 id="saved-views-heading" class="flex items-center gap-2 font-semibold"><Bookmark class="size-4 text-teal-700" />保存分析視圖</h2><p class="mt-1 text-sm text-stone-500">只保存篩選與版面；每次開啟都用目前資料重算。</p></div>
        <form class="flex gap-2" @submit.prevent="saveCurrentView"><label class="sr-only" for="saved-view-name">視圖名稱</label><input id="saved-view-name" v-model="viewName" maxlength="80" class="field min-w-44" placeholder="例如：第 1 局" /><button type="submit" class="button-secondary inline-flex items-center gap-2" :disabled="!viewName.trim() || savedPending"><Save class="size-4" />保存目前篩選</button></form>
      </div>
      <p v-if="savedError" class="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-900" role="alert">{{ savedError }}</p>
      <div v-if="savedViews.length" class="mt-4 flex gap-2 overflow-x-auto pb-1"><button v-for="view in savedViews" :key="view.id" type="button" class="min-w-48 rounded-xl border border-stone-200 p-3 text-left hover:bg-stone-50" @click="openSavedView(view)"><strong class="block text-sm">{{ view.name }}</strong><span class="mt-1 block text-xs text-stone-500">saved {{ submittedAt(view.saved_at) }} · schema {{ view.filter_schema_version }}</span></button></div>
      <p v-else class="mt-4 text-sm text-stone-500">尚未保存視圖。</p>
    </section>

    <div v-if="coach.pending.value" class="space-y-2" aria-busy="true"><div v-for="index in 4" :key="index" class="h-24 animate-pulse rounded-2xl bg-stone-200" /></div>
    <div v-else-if="coach.error.value && !match" class="rounded-2xl bg-rose-50 p-6 text-rose-900" role="alert"><p class="flex items-center gap-2 font-semibold"><CircleAlert class="size-5" />無法載入 Rally 紀錄</p><p class="mt-2 text-sm">{{ coach.error.value.message }}</p></div>
    <p v-if="retryError" class="rounded-xl bg-rose-50 p-3 text-sm text-rose-900" role="alert">{{ retryError }}</p>
    <div v-else-if="!rallies.length" class="rounded-2xl bg-white p-8 text-center shadow-sm"><p class="font-semibold">目前沒有已提交 Rally</p><p class="mt-1 text-sm text-stone-500">標註員按 Enter 建立 immutable submission 後，紀錄會自動出現在這裡。</p></div>
    <ol v-else class="overflow-hidden rounded-2xl bg-white shadow-sm">
      <li v-for="rally in rallies" :key="rally.id" class="border-b border-stone-100 last:border-0">
        <div class="flex items-center gap-2 pr-4">
        <NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`" class="grid min-h-24 min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-4 transition-colors hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700">
          <div class="grid size-14 place-items-center rounded-xl bg-stone-950 text-center text-white"><span class="text-[10px] text-white/60">SET {{ rally.set_number }}</span><strong class="text-lg leading-none">#{{ rally.ordinal }}</strong></div>
          <div class="min-w-0"><p class="truncate font-semibold">{{ outcomeLabel(rally) }}</p><p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500"><span class="inline-flex items-center gap-1"><Clock3 class="size-3.5" />{{ submittedAt(rally.submission.submitted_at) }}</span><span>{{ processLabel(rally.processing_status) }}</span><span v-if="rally.submission.analysis">AI {{ rally.submission.analysis.version }} · {{ rally.submission.analysis.status }}</span></p></div>
          <ChevronRight class="size-5 text-stone-400" aria-hidden="true" />
        </NuxtLink>
        <button v-if="canRetry && rally.processing_status === 'failed'" type="button" class="button-secondary inline-flex shrink-0 items-center gap-2" :disabled="Boolean(retryingRallyId)" @click="retryRally(rally.id)"><RefreshCw class="size-4" :class="{ 'animate-spin': retryingRallyId === rally.id }" />{{ retryingRallyId === rally.id ? '排程中' : '重試處理' }}</button>
        </div>
      </li>
    </ol>
  </section>
</template>
