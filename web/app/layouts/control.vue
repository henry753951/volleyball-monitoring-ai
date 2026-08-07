<script setup lang="ts">
import { Home, MonitorCog } from 'lucide-vue-next'
</script>

<template>
  <div class="control-shell">
    <header class="control-toolbar">
      <div class="control-toolbar__menu"><MonitorCog :size="17" /><span>控制台</span></div>
      <strong>場次管理</strong>
      <NuxtLink to="/" aria-label="首頁"><Home :size="17" /><span>首頁</span></NuxtLink>
    </header>
    <main><slot /></main>
  </div>
</template>

<style scoped>
.control-shell{min-height:100dvh;background:#edf0f4;color:#171a1f;font-family:"Segoe UI Variable Text",-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif}.control-toolbar{position:sticky;top:0;z-index:30;height:46px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 12px;border-bottom:1px solid #d5d9df;background:rgba(248,249,251,.9);backdrop-filter:blur(20px) saturate(170%)}.control-toolbar__menu,.control-toolbar a{display:inline-flex;width:max-content;min-height:32px;align-items:center;gap:7px;padding:0 9px;border-radius:8px;color:#4d5661;font-size:.72rem;text-decoration:none}.control-toolbar a{justify-self:end;color:#0a66d8}.control-toolbar strong{font-size:.8rem}.control-toolbar a:active{background:#0a66d812;transform:scale(.97)}.control-shell main{padding:16px}@media(prefers-reduced-transparency:reduce){.control-toolbar{background:#f8f9fb;backdrop-filter:none}}
</style>
