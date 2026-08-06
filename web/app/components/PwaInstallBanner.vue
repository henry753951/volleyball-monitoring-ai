<script setup lang="ts">
const { $pwa } = useNuxtApp()
</script>

<template>
  <div
    v-if="$pwa?.needRefresh"
    class="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+4.25rem)] z-50 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white/95 p-3 shadow-lg backdrop-blur"
  >
    <p class="text-sm">有新的 PWA 版本可用。</p>
    <button class="rounded-xl bg-stone-950 px-3 py-2 text-sm text-white" @click="$pwa.updateServiceWorker()">
      重新載入
    </button>
  </div>
</template>
