<script setup lang="ts">
import { classifyMatchViewState } from '../../../utils/matchViewState'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const match = ref<Awaited<ReturnType<ReturnType<typeof useCoreDomain>['match']>> | null>(null)
const pending = ref(true)
const error = ref<Error | null>(null)
onMounted(async () => {
  try { match.value = await useCoreDomain().match(matchId.value) }
  catch (cause) { error.value = cause instanceof Error ? cause : new Error('無法載入場次') }
  finally { pending.value = false }
})
const viewState = computed(() => classifyMatchViewState(pending.value, error.value, match.value))
function reloadLive() {
  if (import.meta.client) window.location.reload()
}
</script>

<template>
  <section class="space-y-4">
    <header>
      <p class="text-sm text-stone-500">Match {{ matchId }}</p>
      <h1 class="text-2xl font-semibold">{{ match?.title || '現場' }}</h1>
      <p class="mt-1 max-w-3xl text-sm text-stone-600" aria-live="polite">{{ viewState === 'loading' ? '載入場次資料…' : viewState === 'error' ? error?.message : viewState === 'not_found' ? '找不到這場次，或你沒有存取權限。' : `${match?.teams.length ?? 0} 隊 · ${match?.rosterEntries.length ?? 0} 位 roster` }}</p>
    </header>
    <div v-if="viewState === 'loading'" class="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-sm text-stone-500" aria-busy="true">正在載入場次…</div>
    <div v-else-if="viewState === 'error'" class="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-sm text-rose-800" role="alert"><p class="font-semibold">場次載入失敗</p><p class="mt-1">{{ error?.message }}</p><button class="button-secondary mt-4" @click="reloadLive">重新載入</button></div>
    <div v-else-if="viewState === 'not_found'" class="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-sm text-amber-900" role="status"><p class="font-semibold">無法開啟這場次</p><p class="mt-1">請回到場次清單確認可用的真實場次。</p><NuxtLink to="/" class="button-primary mt-4 inline-flex">回到場次清單</NuxtLink></div>
    <div v-else class="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-sm text-stone-500">
      此頁已納入 PWA 多頁路由與底部導覽；由主 Agent 依 Phase vertical slice 串接正式 GraphQL／REST／WebSocket 資料。
    </div>
  </section>
</template>
