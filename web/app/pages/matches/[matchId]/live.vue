<script setup lang="ts">
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
</script>

<template>
  <section class="space-y-4">
    <header>
      <p class="text-sm text-stone-500">Match {{ matchId }}</p>
      <h1 class="text-2xl font-semibold">{{ match?.title || '現場' }}</h1>
      <p class="mt-1 max-w-3xl text-sm text-stone-600">{{ pending ? '載入場次資料…' : error ? error.message : `${match?.teams.length ?? 0} 隊 · ${match?.rosterEntries.length ?? 0} 位 roster` }}</p>
    </header>
    <div class="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-sm text-stone-500">
      此頁已納入 PWA 多頁路由與底部導覽；由主 Agent 依 Phase vertical slice 串接正式 GraphQL／REST／WebSocket 資料。
    </div>
  </section>
</template>
