<script setup lang="ts">
import { ExternalLink, Home, Radio, RotateCcw, Users } from 'lucide-vue-next'

const route = useRoute()
const matchId = computed(() => typeof route.params.matchId === 'string' ? route.params.matchId : '')
const hasMatchContext = computed(() => Boolean(matchId.value) && matchId.value !== 'new')
const matchTitle = useState('coach-shell-match-title', () => '')
const usesFixedViewport = computed(() => /^\/matches\/[^/]+\/(?:live|rallies|players|replay\/[^/]+)\/?$/.test(route.path))
const nav = computed(() => hasMatchContext.value ? [
  { to: `/matches/${matchId.value}/live`, label: '現場', icon: Radio },
  { to: `/matches/${matchId.value}/rallies`, label: '回合', icon: RotateCcw },
  { to: `/matches/${matchId.value}/players`, label: '球員', icon: Users },
] : [])

useHead({ bodyAttrs: { class: 'coach-viewport-body' } })

watch(matchId, async (id) => {
  if (!id || id === 'new') { matchTitle.value = ''; return }
  try { matchTitle.value = (await useCoreDomain().match(id))?.title ?? '' }
  catch { matchTitle.value = '' }
}, { immediate: true })
</script>

<template>
  <div class="coach-shell" :class="{ 'coach-shell--match': hasMatchContext }">
    <PwaInstallBanner />
    <LandscapeGuard />
    <header class="coach-toolbar">
      <div class="coach-toolbar__inner">
        <NuxtLink v-if="hasMatchContext" to="/" class="coach-toolbar__home" aria-label="首頁"><Home :size="18" /><span>首頁</span></NuxtLink>
        <NuxtLink v-else to="/" class="coach-toolbar__brand" aria-label="VollyAI 首頁">VollyAI</NuxtLink>
        <div class="coach-toolbar__title"><strong>{{ matchTitle || (hasMatchContext ? '場次' : '教練檢視') }}</strong></div>
        <div class="coach-toolbar__actions"><WsPingBadge /><a v-if="!hasMatchContext" href="/control" target="_blank" rel="noopener" class="coach-toolbar__control">控制台<ExternalLink :size="14" /></a></div>
      </div>
    </header>
    <main class="coach-content" :class="{ 'coach-content--fixed': usesFixedViewport }">
      <div v-if="usesFixedViewport" class="coach-content__inner coach-content__inner--fixed"><slot /></div>
      <UiScrollArea v-else class="coach-content__scroll"><div class="coach-content__inner"><slot /></div></UiScrollArea>
    </main>
    <nav v-if="hasMatchContext" class="coach-tabs" aria-label="場次導覽">
      <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" class="coach-tab" active-class="coach-tab--active"><component :is="item.icon" :size="21" /><span>{{ item.label }}</span></NuxtLink>
    </nav>
  </div>
</template>

<style>
body.coach-viewport-body{height:100dvh;overflow:hidden}
</style>

<style scoped>
.coach-shell{width:100%;height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;background:#edf1f5;color:#16181d}.coach-toolbar{position:relative;z-index:40;padding-top:env(safe-area-inset-top);background:rgba(250,251,252,.88);backdrop-filter:blur(22px) saturate(175%);-webkit-backdrop-filter:blur(22px) saturate(175%);box-shadow:0 1px 0 #18223012}.coach-toolbar__inner{height:56px;display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2fr) minmax(120px,1fr);align-items:center;gap:10px;padding:0 max(18px,env(safe-area-inset-left));padding-right:max(18px,env(safe-area-inset-right))}.coach-toolbar__brand{color:#17202b;font-size:1rem;font-weight:760;letter-spacing:-.02em;text-decoration:none}.coach-toolbar__home,.coach-toolbar__control{display:inline-flex;width:max-content;min-height:44px;align-items:center;gap:6px;padding:0 10px;border-radius:10px;color:#1266c4;font-size:.82rem;font-weight:650;text-decoration:none}.coach-toolbar__home:active,.coach-toolbar__control:active,.coach-toolbar__brand:active{transform:scale(.97)}.coach-toolbar__home:focus-visible,.coach-toolbar__control:focus-visible,.coach-toolbar__brand:focus-visible,.coach-tab:focus-visible{box-shadow:0 0 0 3px #1266c43d}.coach-toolbar__title{min-width:0;text-align:center}.coach-toolbar__title strong{display:block;overflow:hidden;font-size:.92rem;letter-spacing:-.01em;text-overflow:ellipsis;white-space:nowrap}.coach-toolbar__actions{display:flex;justify-content:flex-end;align-items:center;gap:6px}.coach-content{min-height:0;overflow:hidden}.coach-content__inner{width:min(100%,1440px);min-height:100%;margin:0 auto;padding:22px max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right));box-sizing:border-box}.coach-content__inner--fixed{height:100%;min-height:0}.coach-content__scroll{width:100%;height:100%;min-height:0}.coach-tabs{position:relative;z-index:40;height:calc(64px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(3,1fr);padding:5px max(10px,env(safe-area-inset-left)) env(safe-area-inset-bottom);background:rgba(250,251,252,.9);box-shadow:0 -8px 26px #18223012;backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%)}.coach-tab{display:flex;min-width:0;min-height:44px;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:12px;color:#7a808a;font-size:.68rem;font-weight:600;text-decoration:none}.coach-tab--active{color:#1266c4}.coach-tab:active{background:#1266c414;transform:scale(.97)}@media(max-width:650px){.coach-toolbar__control{font-size:0}.coach-toolbar__control svg{display:block}.coach-toolbar__inner{grid-template-columns:96px minmax(0,1fr) 112px}.coach-content__inner{padding:16px 14px}}@media(prefers-reduced-transparency:reduce){.coach-toolbar,.coach-tabs{background:#fafbfc;backdrop-filter:none;-webkit-backdrop-filter:none}}@media(prefers-reduced-motion:reduce){.coach-toolbar__home,.coach-toolbar__control,.coach-toolbar__brand,.coach-tab{transition:none;transform:none!important}}
</style>
