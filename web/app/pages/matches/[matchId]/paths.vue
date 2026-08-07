<script setup lang="ts">
import { ChevronRight, Route as RouteIcon } from 'lucide-vue-next'
const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const coach = useCoachMatchState(matchId)
const analyzed = computed(() => (coach.data.value?.match.rallies ?? []).filter(rally => rally.submission.analysis?.status === 'completed'))
</script>

<template>
  <section class="space-y-4">
    <header><p class="text-sm text-stone-500">{{ coach.data.value?.match.title || `Match ${matchId}` }}</p><h1 class="text-2xl font-semibold tracking-tight">球路</h1><p class="mt-1 max-w-3xl text-sm text-stone-600">選擇已完成分析的 Rally，查看 AI 回傳的 A/B court_pos 球路；中央系統不做座標投影。</p></header>
    <div v-if="coach.pending.value" class="h-48 animate-pulse rounded-2xl bg-stone-200" aria-busy="true" />
    <div v-else-if="!analyzed.length" class="rounded-2xl bg-white p-8 text-center shadow-sm"><RouteIcon class="mx-auto size-8 text-stone-400" /><p class="mt-3 font-semibold">尚無完成的球路分析</p><p class="mt-1 text-sm text-stone-500">Immutable submission 完成 AI callback 後會出現在這裡。</p></div>
    <ol v-else class="overflow-hidden rounded-2xl bg-white shadow-sm"><li v-for="rally in analyzed" :key="rally.id" class="border-b border-stone-100 last:border-0"><NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`" class="flex min-h-20 items-center justify-between gap-4 px-5 py-4 hover:bg-stone-50"><div><p class="font-semibold">Set {{ rally.set_number }} · Rally #{{ rally.ordinal }}</p><p class="mt-1 text-sm text-stone-500">{{ rally.submission.analysis?.version }} · {{ rally.submission.analysis?.status }}</p></div><ChevronRight class="size-5 text-stone-400" /></NuxtLink></li></ol>
  </section>
</template>
