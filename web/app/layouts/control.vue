<script setup lang="ts">
import { MonitorCog } from 'lucide-vue-next'
</script>

<template>
  <div class="control-shell">
    <header class="control-toolbar">
      <NuxtLink to="/control" class="control-toolbar__menu"><MonitorCog :size="17" /><span>控制台</span></NuxtLink>
      <strong>場次管理</strong>
      <span />
    </header>
    <main><slot /></main>
  </div>
</template>

<style scoped>
.control-shell{min-height:100dvh;color-scheme:dark;background:#0b0e12;color:#edf2f6;font-family:"Segoe UI Variable Text",-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif}.control-toolbar{position:sticky;top:0;z-index:30;height:46px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 12px;border-bottom:1px solid #2b323a;background:#101419e8;backdrop-filter:blur(20px) saturate(150%)}.control-toolbar__menu{display:inline-flex;width:max-content;min-height:32px;align-items:center;gap:7px;padding:0 9px;border-radius:8px;color:#a8b3bd;font-size:.72rem;text-decoration:none}.control-toolbar__menu svg{color:#61a9df}.control-toolbar strong{font-size:.8rem;letter-spacing:.01em}.control-toolbar__menu:active{background:#ffffff0c;transform:scale(.97)}.control-shell main{padding:16px}@media(prefers-reduced-transparency:reduce){.control-toolbar{background:#101419;backdrop-filter:none}}
</style>
