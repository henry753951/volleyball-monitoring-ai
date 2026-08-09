<script setup lang="ts">
import {
  Activity,
  CalendarDays,
  ChevronRight,
  ExternalLink,
  Gauge,
  History,
  Home,
  KeyRound,
} from 'lucide-vue-next'

const route = useRoute()
const views = [
  { id: 'overview', label: '運行總覽', icon: Gauge, to: '/control' },
  { id: 'matches', label: '場次管理', icon: CalendarDays, to: { path: '/control', query: { view: 'matches' } } },
  { id: 'systems', label: '系統狀態', icon: Activity, to: { path: '/control', query: { view: 'systems' } } },
  { id: 'workers', label: 'AI Workers', icon: KeyRound, to: { path: '/control', query: { view: 'workers' } } },
  { id: 'history', label: '作業紀錄', icon: History, to: '/control/jobs' },
] as const
const activeView = computed(() => {
  if (route.path === '/control/jobs') return 'history'
  const requested = typeof route.query.view === 'string' ? route.query.view : 'overview'
  if (requested === 'media') return 'matches'
  if (requested === 'ai') return 'workers'
  return requested
})
</script>

<template>
  <div class="control-shell">
    <aside class="control-rail">
      <NuxtLink to="/control" class="control-brand" aria-label="VollyAI 控制台總覽">
        <span class="control-brand__mark"><Activity :size="17" /></span>
        <span><strong>VollyAI</strong><small>OPERATE</small></span>
      </NuxtLink>

      <nav aria-label="控制台功能">
        <span class="control-rail__label">工作區</span>
        <NuxtLink
          v-for="item in views"
          :key="item.id"
          :to="item.to"
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
.control-shell{--rail-width:216px;height:100dvh;display:grid;grid-template-columns:var(--rail-width) minmax(0,1fr);overflow:hidden;color-scheme:dark;background:#090a0c;color:#f1f3f5;font-family:"Segoe UI Variable Text",-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif}.control-rail{height:100dvh;display:flex;flex-direction:column;padding:12px 10px;border-right:1px solid #27282c;background:#0c0d0f}.control-brand{height:48px;display:flex;align-items:center;gap:10px;padding:0 9px;color:inherit;text-decoration:none}.control-brand__mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid #3b3d42;border-radius:8px;background:#191a1e;color:#f4f5f6}.control-brand>span:last-child{display:grid;gap:1px}.control-brand strong{font-size:.82rem;letter-spacing:-.02em}.control-brand small{color:#85878d;font-size:.5rem;font-weight:800;letter-spacing:.12em}.control-rail nav{display:grid;gap:2px;margin-top:18px}.control-rail__label{padding:0 10px 7px;color:#74767c;font-size:.58rem;font-weight:750}.control-nav-item{min-height:38px;display:grid;grid-template-columns:20px 1fr 14px;align-items:center;gap:8px;padding:0 10px;border-radius:7px;color:#a0a2a8;font-size:.7rem;font-weight:650;text-decoration:none;transition:background-color 120ms ease,color 120ms ease}.control-nav-item:hover{background:#18191d;color:#f0f1f2}.control-nav-item.active{background:#24262a;color:#fff}.control-nav-item__arrow{opacity:0}.control-nav-item.active .control-nav-item__arrow{opacity:.72}.control-nav-item:focus-visible,.control-rail__footer a:focus-visible,.control-brand:focus-visible{outline:2px solid #f1f3f5;outline-offset:2px}.control-rail__footer{display:grid;gap:5px;margin-top:auto;padding-top:12px;border-top:1px solid #27282c}.control-environment,.control-rail__footer a{min-height:34px;display:flex;align-items:center;gap:8px;padding:0 9px;color:#8c8e94;font-size:.64rem}.control-environment i{width:7px;height:7px;border-radius:50%;background:#48bf84}.control-rail__footer a{border-radius:7px;color:#a2a4aa;text-decoration:none}.control-rail__footer a:hover{background:#18191d;color:#fff}.control-rail__footer a svg:last-child{margin-left:auto}.control-main{min-width:0;height:100dvh;overflow:auto;overscroll-behavior:contain;background:#0a0b0d;scrollbar-color:#3f4147 #111216;scrollbar-width:thin}
@media(max-width:820px){.control-shell{--rail-width:58px}.control-rail{padding-inline:7px}.control-brand{justify-content:center;padding:0}.control-brand>span:last-child,.control-rail__label,.control-nav-item span,.control-nav-item__arrow,.control-environment,.control-rail__footer a span,.control-rail__footer a svg:last-child{display:none}.control-nav-item{grid-template-columns:1fr;justify-items:center;padding:0}.control-rail__footer a{justify-content:center;padding:0}}
@media(prefers-reduced-motion:reduce){.control-nav-item,.control-nav-item__arrow{transition:none}}
.control-shell{background:#111112}.control-rail{border-right-color:#252527;background:#141415}.control-brand__mark{border:0;background:#222224}.control-brand small,.control-rail__label{color:#8f8f94}.control-nav-item{color:#aaaab0}.control-nav-item:hover{background:#202022}.control-nav-item.active{background:#2b2b2e}.control-rail__footer{border-top-color:#28282b}.control-main{background:#181818;scrollbar-color:#48484c #1d1d1f}
</style>
