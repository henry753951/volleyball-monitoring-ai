<script setup lang="ts">
const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
</script>

<template>
  <section class="space-y-4">
    <header>
      <p class="text-sm text-stone-500">Match { matchId }</p>
      <h1 class="text-2xl font-semibold">現場</h1>
      <p class="mt-1 max-w-3xl text-sm text-stone-600">顯示最新完成的 Rally、目前比分、AI 處理狀態與快速回放入口。</p>
    </header>
    <div class="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-sm text-stone-500">
      此頁已納入 PWA 多頁路由與底部導覽；由主 Agent 依 Phase vertical slice 串接正式 GraphQL／REST／WebSocket 資料。
    </div>
  </section>
</template>
