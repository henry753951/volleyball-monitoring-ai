<script setup lang="ts">
import { Activity, ChartNoAxesColumn, History, Map, Radio, Settings, Users } from 'lucide-vue-next'

const route = useRoute()
const matchId = computed(() => typeof route.params.matchId === 'string' ? route.params.matchId : '')
const hasMatchContext = computed(() => Boolean(matchId.value) && matchId.value !== 'new')
const nav = computed(() => [
  { to: `/matches/${matchId.value}/live`, label: '現場', icon: Radio },
  { to: `/matches/${matchId.value}/paths`, label: '球路', icon: Map },
  { to: `/matches/${matchId.value}/players`, label: '球員', icon: Users },
  { to: `/matches/${matchId.value}/stats`, label: '統計', icon: ChartNoAxesColumn },
  { to: `/matches/${matchId.value}/history`, label: '紀錄', icon: History },
].filter(() => hasMatchContext.value))
</script>

<template>
  <div class="min-h-dvh bg-stone-50 pb-[calc(4.25rem+env(safe-area-inset-bottom))] text-stone-950">
    <PwaInstallBanner />
    <LandscapeGuard />
    <header class="sticky top-0 z-30 border-b border-stone-200 bg-white/92 px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div class="mx-auto flex min-h-16 max-w-screen-2xl items-center justify-between gap-3 py-2">
        <div class="flex min-w-0 items-center gap-3">
          <NuxtLink to="/" class="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm shadow-sm">返回選單</NuxtLink>
          <div class="min-w-0">
            <p class="truncate font-semibold">Volleyball Monitoring</p>
            <p class="flex items-center gap-1 truncate text-xs text-stone-500">
              <Activity class="size-3.5" />{{ matchId ? `Match ${matchId} · ` : '' }}狀態由 API / WebSocket 同步
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <NuxtLink v-if="hasMatchContext" :to="`/matches/${matchId}/history`" class="rounded-xl px-3 py-2 text-sm text-stone-600">過去紀錄</NuxtLink>
          <NuxtLink to="/settings" aria-label="設定" class="rounded-xl border border-stone-200 p-2.5"><Settings class="size-4" /></NuxtLink>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-screen-2xl p-4"><slot /></main>

    <nav class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-stone-200 bg-white/95 px-[max(.5rem,env(safe-area-inset-left))] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      <NuxtLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl px-2 text-[11px] text-stone-500"
        active-class="font-semibold text-teal-700"
      >
        <component :is="item.icon" class="size-5" />
        {{ item.label }}
      </NuxtLink>
    </nav>
  </div>
</template>
