<script setup lang="ts">
import { ChevronRight, CircleAlert, Clock3, RefreshCw } from 'lucide-vue-next'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const coach = useCoachMatchState(matchId)
const match = computed(() => coach.data.value?.match ?? null)
const selectedSet = ref<number | 'all'>('all')
const rallies = computed(() => (match.value?.rallies ?? []).filter(rally => selectedSet.value === 'all' || rally.set_number === selectedSet.value))
const teamById = computed(() => new Map((match.value?.teams ?? []).map(team => [team.id, team])))

function outcomeLabel(rally: (typeof rallies.value)[number]) {
  if (rally.submission.score_resolution === 'unknown') return '結果未知'
  return teamById.value.get(rally.submission.scoring_team_id ?? '')?.name ?? rally.submission.scoring_court_side ?? '未計分'
}
function processLabel(value: string) {
  return ({ idle: '等待處理', clip_queued: '片段排程', clipping: '建立片段', ai_queued: 'AI 排程', ai_processing: 'AI 分析', artifact_ingesting: '匯入結果', completed: '完成', failed: '失敗', superseded: '已取代' }[value] ?? value)
}
const submittedAt = (value: string) => new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
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

    <div v-if="coach.pending.value" class="space-y-2" aria-busy="true"><div v-for="index in 4" :key="index" class="h-24 animate-pulse rounded-2xl bg-stone-200" /></div>
    <div v-else-if="coach.error.value && !match" class="rounded-2xl bg-rose-50 p-6 text-rose-900" role="alert"><p class="flex items-center gap-2 font-semibold"><CircleAlert class="size-5" />無法載入 Rally 紀錄</p><p class="mt-2 text-sm">{{ coach.error.value.message }}</p></div>
    <div v-else-if="!rallies.length" class="rounded-2xl bg-white p-8 text-center shadow-sm"><p class="font-semibold">目前沒有已提交 Rally</p><p class="mt-1 text-sm text-stone-500">標註員按 Enter 建立 immutable submission 後，紀錄會自動出現在這裡。</p></div>
    <ol v-else class="overflow-hidden rounded-2xl bg-white shadow-sm">
      <li v-for="rally in rallies" :key="rally.id" class="border-b border-stone-100 last:border-0">
        <NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`" class="grid min-h-24 grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-4 transition-colors hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700">
          <div class="grid size-14 place-items-center rounded-xl bg-stone-950 text-center text-white"><span class="text-[10px] text-white/60">SET {{ rally.set_number }}</span><strong class="text-lg leading-none">#{{ rally.ordinal }}</strong></div>
          <div class="min-w-0"><p class="truncate font-semibold">{{ outcomeLabel(rally) }}</p><p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500"><span class="inline-flex items-center gap-1"><Clock3 class="size-3.5" />{{ submittedAt(rally.submission.submitted_at) }}</span><span>{{ processLabel(rally.processing_status) }}</span><span v-if="rally.submission.analysis">AI {{ rally.submission.analysis.version }} · {{ rally.submission.analysis.status }}</span></p></div>
          <ChevronRight class="size-5 text-stone-400" aria-hidden="true" />
        </NuxtLink>
      </li>
    </ol>
  </section>
</template>
