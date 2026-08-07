
<script setup lang="ts">
const route = useRoute()
const viewerState = useViewerState()
const matchState = useMatches()
const authRequired = computed(() => route.query.auth === 'required')
const authUnavailable = computed(() => route.query.auth === 'unavailable' || Boolean(viewerState.error.value))

onMounted(async () => {
  await viewerState.refresh()
  if (viewerState.viewer.value) await matchState.refresh()
})
</script>

<template>
  <section class="space-y-6">
    <header class="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm backdrop-blur-xl"><p class="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">Volleyball Monitoring</p><h1 class="mt-2 text-3xl font-semibold tracking-tight">場次與過去紀錄</h1><p class="mt-2 max-w-2xl text-stone-600">從真實場次進入現場、歷史回放與標註工作台。</p></header>
    <div v-if="authUnavailable" class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800" role="alert"><p class="font-semibold">目前無法驗證登入狀態</p><p class="mt-1 text-sm">{{ viewerState.error.value?.message || '身份服務暫時無法連線。' }}</p><button class="button-secondary mt-3" @click="viewerState.refresh">重新連線</button></div>
    <div v-else-if="authRequired || (viewerState.checked.value && !viewerState.viewer.value)" class="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900" role="status">目前需要登入才能查看場次。請確認開發身份後再試。</div>
    <div v-else-if="viewerState.pending.value || matchState.pending.value" class="grid gap-4 md:grid-cols-2"><div v-for="n in 2" :key="n" class="h-36 animate-pulse rounded-3xl bg-stone-200" /></div>
    <div v-else-if="matchState.error.value" class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800"><p class="font-semibold">場次載入失敗</p><p class="mt-1 text-sm">{{ matchState.error.value.message }}</p><button class="button-secondary mt-3" @click="matchState.refresh">重新載入</button></div>
    <template v-else>
      <div class="flex items-center justify-between gap-3"><h2 class="text-xl font-semibold">可用場次</h2><NuxtLink to="/matches/new" class="button-primary">新增場次</NuxtLink></div>
      <div v-if="!matchState.matches.value.length" class="rounded-3xl border border-dashed border-stone-300 bg-white/70 p-10 text-center"><p class="font-semibold">目前沒有場次</p><p class="mt-1 text-sm text-stone-600">建立第一場比賽，填入左右隊伍與 roster。</p><NuxtLink to="/matches/new" class="button-primary mt-5 inline-flex">開始建立</NuxtLink></div>
      <div v-else class="grid gap-4 lg:grid-cols-2"> <NuxtLink v-for="match in matchState.matches.value" :key="match.id" :to="`/matches/${match.id}/live`" class="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div class="flex items-start justify-between gap-3"><div><p class="text-xs text-stone-500">{{ match.status }}</p><h3 class="mt-1 text-xl font-semibold">{{ match.title }}</h3><p class="mt-1 text-sm text-stone-600">{{ match.venue || '未設定場地' }}</p></div><span class="rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">{{ match.teams.length }} 隊</span></div><p class="mt-4 text-sm text-stone-500">{{ match.rosterEntries.length }} 位 roster · {{ match.sets.length }} 局</p></NuxtLink></div>
    </template>
  </section>
</template>
