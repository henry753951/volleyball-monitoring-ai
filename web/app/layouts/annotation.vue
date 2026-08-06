<script setup lang="ts">
import { Activity, History, Users } from 'lucide-vue-next'
const route = useRoute()
const matchId = computed(() => String(route.params.matchId ?? 'demo'))
</script>

<template>
  <div class="min-h-dvh bg-stone-50 pb-[env(safe-area-inset-bottom)] text-stone-950">
    <PwaInstallBanner />
    <LandscapeGuard />
    <header class="sticky top-0 z-30 border-b border-stone-200 bg-white/92 px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div class="mx-auto flex min-h-16 max-w-screen-2xl items-center justify-between gap-3 py-2">
        <div class="flex min-w-0 items-center gap-3">
          <NuxtLink to="/" class="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm shadow-sm">返回場次</NuxtLink>
          <div class="min-w-0">
            <p class="truncate font-semibold">多人標註工作台</p>
            <p class="flex items-center gap-1 truncate text-xs text-stone-500"><Activity class="size-3.5" /> Match {{ matchId }} · authoritative revision由server同步</p>
          </div>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <span class="hidden items-center gap-1 rounded-xl bg-stone-100 px-3 py-2 text-stone-600 sm:flex"><Users class="size-4" /> 協作者</span>
          <NuxtLink :to="`/matches/${matchId}/history`" class="flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-3 py-2"><History class="size-4" /> 紀錄</NuxtLink>
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-screen-2xl p-4"><slot /></main>
  </div>
</template>
