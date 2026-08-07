<script setup lang="ts">
import { Activity, CircleAlert, Radio, RefreshCw, Trophy } from 'lucide-vue-next'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const coach = useCoachMatchState(matchId)
const match = computed(() => coach.data.value?.match ?? null)
const activeSet = computed(() => match.value?.sets.find(set => set.status === 'live') ?? match.value?.sets.at(-1) ?? null)
const latestRally = computed(() => match.value?.rallies[0] ?? null)
const currentCapture = computed(() => match.value?.captures[0] ?? null)
const teamById = computed(() => new Map((match.value?.teams ?? []).map(team => [team.id, team])))
const leftTeam = computed(() => teamById.value.get(activeSet.value?.side_assignment?.left_team_id ?? '') ?? null)
const rightTeam = computed(() => teamById.value.get(activeSet.value?.side_assignment?.right_team_id ?? '') ?? null)
const scoringTeam = computed(() => teamById.value.get(latestRally.value?.submission.scoring_team_id ?? '') ?? null)
const captureHealthy = computed(() => currentCapture.value?.health === 'healthy' && currentCapture.value.status === 'live')

const statusLabel = (value?: string | null) => ({
  idle: '等待處理', clip_queued: '片段排程中', clipping: '建立片段中', ai_queued: 'AI 排程中', ai_processing: 'AI 分析中', artifact_ingesting: '匯入結果中', completed: '分析完成', failed: '處理失敗', superseded: '已取代',
}[value ?? ''] ?? value ?? '尚無資料')
</script>

<template>
  <section class="space-y-4" aria-live="polite">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="text-sm text-stone-500">教練現場面板</p>
        <h1 class="text-2xl font-semibold tracking-tight">{{ match?.title || '現場賽況' }}</h1>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 text-stone-600 shadow-sm">
          <Radio class="size-4" :class="captureHealthy ? 'text-emerald-600' : 'text-amber-600'" />
          {{ currentCapture ? `${currentCapture.source_label || '直播來源'} · ${currentCapture.health}` : '尚無直播來源' }}
        </span>
        <button class="button-secondary inline-flex items-center gap-2" :disabled="coach.refreshing.value" @click="coach.refresh">
          <RefreshCw class="size-4" :class="{ 'animate-spin': coach.refreshing.value }" />同步
        </button>
      </div>
    </header>

    <div v-if="coach.pending.value" class="min-h-60 animate-pulse rounded-2xl bg-stone-200" aria-busy="true" />
    <div v-else-if="coach.error.value && !match" class="rounded-2xl bg-rose-50 p-6 text-rose-900" role="alert">
      <p class="flex items-center gap-2 font-semibold"><CircleAlert class="size-5" />無法載入現場賽況</p>
      <p class="mt-2 text-sm">{{ coach.error.value.message }}</p>
      <button class="button-secondary mt-4" @click="coach.refresh">再試一次</button>
    </div>
    <div v-else-if="!match" class="rounded-2xl bg-amber-50 p-6 text-amber-950">找不到場次，或你沒有查看權限。</div>
    <template v-else>
      <article class="overflow-hidden rounded-2xl bg-stone-950 text-white shadow-lg shadow-stone-950/15">
        <div class="grid min-h-[18rem] grid-cols-[1fr_auto_1fr] items-center gap-4 p-6 sm:p-8">
          <div class="min-w-0 text-center">
            <p class="truncate text-lg text-white/70">{{ leftTeam?.shortName || leftTeam?.name || '左側' }}</p>
            <p class="mt-2 text-[clamp(5rem,13vw,9rem)] font-semibold leading-none tracking-[-0.04em]">{{ activeSet?.left_score ?? 0 }}</p>
          </div>
          <div class="flex min-w-24 flex-col items-center gap-3 text-center">
            <Trophy class="size-7 text-amber-300" />
            <div><p class="text-xs text-white/50">SET</p><p class="text-4xl font-semibold">{{ activeSet?.set_number ?? '—' }}</p></div>
            <span class="rounded-full bg-white/10 px-3 py-1 text-xs text-white/70">revision {{ activeSet?.score_revision ?? 0 }}</span>
          </div>
          <div class="min-w-0 text-center">
            <p class="truncate text-lg text-white/70">{{ rightTeam?.shortName || rightTeam?.name || '右側' }}</p>
            <p class="mt-2 text-[clamp(5rem,13vw,9rem)] font-semibold leading-none tracking-[-0.04em]">{{ activeSet?.right_score ?? 0 }}</p>
          </div>
        </div>
      </article>

      <div class="grid gap-4 md:grid-cols-[1.35fr_.65fr]">
        <section class="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="latest-rally-heading">
          <div class="flex items-center justify-between gap-3">
            <div><h2 id="latest-rally-heading" class="font-semibold">最新 Rally</h2><p class="text-sm text-stone-500">只顯示 immutable submission 的正式結果</p></div>
            <span v-if="latestRally" class="rounded-full bg-teal-50 px-3 py-1 text-sm font-semibold text-teal-800">Set {{ latestRally.set_number }} · #{{ latestRally.ordinal }}</span>
          </div>
          <div v-if="latestRally" class="mt-5 flex flex-wrap items-center justify-between gap-4">
            <div><p class="text-sm text-stone-500">Rally outcome</p><p class="mt-1 text-xl font-semibold">{{ scoringTeam?.name || (latestRally.submission.score_resolution === 'unknown' ? '結果未知' : latestRally.submission.scoring_court_side || '未計分') }}</p></div>
            <div class="text-right"><p class="text-sm text-stone-500">處理狀態</p><p class="mt-1 font-semibold" :class="latestRally.processing_status === 'failed' ? 'text-rose-700' : 'text-stone-900'">{{ statusLabel(latestRally.processing_status) }}</p></div>
          </div>
          <p v-else class="mt-5 text-sm text-stone-500">尚無已提交 Rally。</p>
        </section>
        <section class="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="capture-heading">
          <h2 id="capture-heading" class="flex items-center gap-2 font-semibold"><Activity class="size-5" />影音來源</h2>
          <p class="mt-4 text-lg font-semibold">{{ currentCapture?.source_label || '尚未啟動' }}</p>
          <p class="mt-1 text-sm" :class="captureHealthy ? 'text-emerald-700' : 'text-amber-700'">{{ currentCapture ? `${currentCapture.status} · ${currentCapture.health}` : '等待 server-side DVR' }}</p>
        </section>
      </div>
    </template>
  </section>
</template>
