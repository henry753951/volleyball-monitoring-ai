<script setup lang="ts">
import {
  Activity,
  CalendarDays,
  ChevronRight,
  Cpu,
  ExternalLink,
  Gauge,
  Home,
  RadioTower,
} from 'lucide-vue-next'

const route = useRoute()
const views = [
  { id: 'overview', label: '運行總覽', icon: Gauge },
  { id: 'matches', label: '場次管理', icon: CalendarDays },
  { id: 'systems', label: '系統狀態', icon: Activity },
  { id: 'media', label: '媒體與串流', icon: RadioTower },
  { id: 'ai', label: 'AI 作業', icon: Cpu },
] as const
const activeView = computed(() => typeof route.query.view === 'string' ? route.query.view : 'overview')
</script>

<template>
  <div class="control-shell">
    <aside class="control-rail">
      <NuxtLink to="/control" class="control-brand" aria-label="VollyAI 控制台總覽">
        <span class="control-brand__mark"><Activity :size="17" /></span>
        <span><strong>VollyAI</strong><small>CONTROL</small></span>
      </NuxtLink>

      <nav aria-label="控制台功能">
        <span class="control-rail__label">工作區</span>
        <NuxtLink
          v-for="item in views"
          :key="item.id"
          :to="{ path: '/control', query: item.id === 'overview' ? {} : { view: item.id } }"
          class="control-nav-item"
          :class="{ active: activeView === item.id }"
        >
          <component :is="item.icon" :size="17" />
          <span>{{ item.label }}</span>
          <ChevronRight :size="14" class="control-nav-item__arrow" />
        </NuxtLink>
      </nav>

      <div class="control-rail__footer">
        <span class="control-environment"><i />本機工作環境</span>
        <NuxtLink to="/" target="_blank"><Home :size="15" /><span>教練端</span><ExternalLink :size="12" /></NuxtLink>
      </div>
    </aside>

    <main class="control-main"><slot /></main>
  </div>
</template>

<style scoped>
.control-shell{--rail-width:224px;min-height:100dvh;display:grid;grid-template-columns:var(--rail-width) minmax(0,1fr);color-scheme:dark;background:#090a0c;color:#f1f3f5;font-family:"Segoe UI Variable Text",-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif}.control-rail{position:sticky;top:0;height:100dvh;display:flex;flex-direction:column;padding:14px 11px 12px;border-right:1px solid #24272b;background:#0d0f12}.control-brand{height:48px;display:flex;align-items:center;gap:10px;padding:0 9px;color:inherit;text-decoration:none}.control-brand__mark{width:31px;height:31px;display:grid;place-items:center;border:1px solid #383c41;border-radius:9px;background:#1a1d21;color:#f4f5f6;box-shadow:0 8px 18px #0006}.control-brand>span:last-child{display:grid;gap:1px}.control-brand strong{font-size:.82rem;letter-spacing:-.01em}.control-brand small{color:#737980;font-size:.52rem;font-weight:800;letter-spacing:.14em}.control-rail nav{display:grid;gap:3px;margin-top:22px}.control-rail__label{padding:0 10px 7px;color:#696f76;font-size:.58rem;font-weight:750;letter-spacing:.06em}.control-nav-item{min-height:38px;display:grid;grid-template-columns:20px 1fr 14px;align-items:center;gap:8px;padding:0 10px;border-radius:9px;color:#969ca3;font-size:.72rem;font-weight:650;text-decoration:none;transition:background-color 140ms ease,color 140ms ease}.control-nav-item:hover{background:#171a1e;color:#e5e7e9}.control-nav-item.active{background:#f0f1f2;color:#111315;box-shadow:0 6px 16px #0007}.control-nav-item__arrow{opacity:0;transition:opacity 140ms ease}.control-nav-item.active .control-nav-item__arrow{opacity:.72}.control-nav-item:focus-visible,.control-rail__footer a:focus-visible,.control-brand:focus-visible{outline:2px solid #f1f3f5;outline-offset:2px}.control-rail__footer{display:grid;gap:6px;margin-top:auto;padding-top:14px;border-top:1px solid #24272b}.control-environment,.control-rail__footer a{min-height:34px;display:flex;align-items:center;gap:8px;padding:0 9px;color:#858b92;font-size:.65rem}.control-environment i{width:7px;height:7px;border-radius:50%;background:#45c987;box-shadow:0 0 0 3px #45c9871f}.control-rail__footer a{border-radius:8px;color:#9fa5ab;text-decoration:none}.control-rail__footer a:hover{background:#171a1e;color:#f0f1f2}.control-rail__footer a svg:last-child{margin-left:auto}.control-main{min-width:0;min-height:100dvh;overflow:hidden;background:#0a0c0f}
@media(max-width:820px){.control-shell{--rail-width:58px}.control-rail{padding-inline:7px}.control-brand{justify-content:center;padding:0}.control-brand>span:last-child,.control-rail__label,.control-nav-item span,.control-nav-item__arrow,.control-environment,.control-rail__footer a span,.control-rail__footer a svg:last-child{display:none}.control-nav-item{grid-template-columns:1fr;justify-items:center;padding:0}.control-rail__footer a{justify-content:center;padding:0}}
@media(prefers-reduced-motion:reduce){.control-nav-item,.control-nav-item__arrow{transition:none}}
</style>
