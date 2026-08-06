<script setup lang="ts">
const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
</script>

<template>
  <section class="space-y-4">
    <header>
      <p class="text-sm text-stone-500">Match { matchId }</p>
      <h1 class="text-2xl font-semibold">統計</h1>
      <p class="mt-1 max-w-3xl text-sm text-stone-600">依可用欄位與 feature_availability 顯示樣本數、未知數與品質，不假造 action 指標。</p>
    </header>
    <div class="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-sm text-stone-500">
      此頁已納入 PWA 多頁路由與底部導覽；由主 Agent 依 Phase vertical slice 串接正式 GraphQL／REST／WebSocket 資料。
    </div>
  </section>
</template>
