<script setup lang="ts">
import { ChevronLeft, ExternalLink, Radio, RotateCcw, Users } from 'lucide-vue-next'

const route = useRoute()
const matchId = computed(() =>
  typeof route.params.matchId === 'string' ? route.params.matchId : '',
)
const hasMatchContext = computed(() => Boolean(matchId.value) && matchId.value !== 'new')
const isReplay = computed(() => /^\/matches\/[^/]+\/replay\/[^/]+\/?$/.test(route.path))
const matchTitle = useState('coach-shell-match-title', () => '')
const rallyStatus = useCoachRallyStatus()
const usesFixedViewport = computed(() =>
  /^\/matches\/[^/]+\/(?:live|rallies|players|stats|replay\/[^/]+)\/?$/.test(route.path),
)
const nav = computed(() =>
  hasMatchContext.value
    ? [
        { to: `/matches/${matchId.value}/live`, label: '現場', icon: Radio },
        { to: `/matches/${matchId.value}/rallies`, label: '回合', icon: RotateCcw },
        { to: `/matches/${matchId.value}/players`, label: '球員', icon: Users },
      ]
    : [],
)
const backNavigation = computed(() => {
  if (isReplay.value) return { to: `/matches/${matchId.value}/rallies`, label: '回合' }
  if (/^\/matches\/[^/]+\/stats\/?$/.test(route.path))
    return { to: `/matches/${matchId.value}/players`, label: '球員' }
  return { to: '/', label: '場次列表' }
})

function isNavActive(target: string) {
  if (target.endsWith('/players') && /^\/matches\/[^/]+\/stats\/?$/.test(route.path)) return true
  return route.path === target || route.path === `${target}/`
}

useHead({ bodyAttrs: { class: 'coach-viewport-body' } })

watch(
  matchId,
  async id => {
    if (!id || id === 'new') {
      matchTitle.value = ''
      return
    }
    try {
      matchTitle.value = (await useCoreDomain().match(id))?.title ?? ''
    } catch {
      matchTitle.value = ''
    }
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="coach-shell"
    :class="{ 'coach-shell--match': hasMatchContext, 'coach-shell--replay': isReplay }"
  >
    <PwaInstallBanner />
    <LandscapeGuard />
    <header class="coach-toolbar">
      <div class="coach-toolbar__inner">
        <NuxtLink
          v-if="hasMatchContext"
          :to="backNavigation.to"
          class="coach-toolbar__back"
          :aria-label="`返回${backNavigation.label}`"
          ><ChevronLeft :size="20" /><span>{{ backNavigation.label }}</span></NuxtLink
        >
        <NuxtLink v-else to="/" class="coach-toolbar__brand" aria-label="VollyAI 場次列表"
          >VollyAI</NuxtLink
        >
        <div class="coach-toolbar__title">
          <strong>{{ matchTitle || (hasMatchContext ? '場次' : '教練檢視') }}</strong>
        </div>
        <div class="coach-toolbar__actions">
          <WsPingBadge /><a
            v-if="!hasMatchContext"
            href="/control"
            target="_blank"
            rel="noopener"
            class="coach-toolbar__control"
            >控制台<ExternalLink :size="14"
          /></a>
        </div>
      </div>
    </header>
    <main
      class="coach-content"
      :class="{ 'coach-content--fixed': usesFixedViewport, 'coach-content--replay': isReplay }"
    >
      <div v-if="usesFixedViewport" class="coach-content__inner coach-content__inner--fixed">
        <slot />
      </div>
      <UiScrollArea v-else class="coach-content__scroll"
        ><div class="coach-content__inner"><slot /></div
      ></UiScrollArea>
    </main>

    <footer v-if="isReplay" class="rally-status" aria-label="回合分析狀態">
      <NuxtLink :to="`/matches/${matchId}/rallies`" class="rally-status__back"
        ><ChevronLeft :size="18" /><span>回合</span></NuxtLink
      >
      <div class="rally-status__identity">
        <strong>{{
          rallyStatus
            ? `第 ${rallyStatus.setNumber} 局 · 回合 ${rallyStatus.rallyOrdinal}`
            : '載入回合'
        }}</strong
        ><span>{{
          rallyStatus?.analysisState === 'mapped'
            ? '球員識別完成'
            : rallyStatus
              ? '分析完成'
              : '同步中'
        }}</span>
      </div>
      <dl v-if="rallyStatus">
        <div>
          <dt>時間</dt>
          <dd>{{ rallyStatus.currentTime }} / {{ rallyStatus.duration }}</dd>
        </div>
        <div>
          <dt>擊球</dt>
          <dd>{{ rallyStatus.contactCount }}</dd>
        </div>
        <div>
          <dt>球路</dt>
          <dd>{{ rallyStatus.activePath ?? '—' }} / {{ rallyStatus.pathCount }}</dd>
        </div>
      </dl>
    </footer>
    <nav v-else-if="hasMatchContext" class="coach-tabs" aria-label="場次導覽">
      <NuxtLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="coach-tab"
        :class="{ 'coach-tab--active': isNavActive(item.to) }"
        ><component :is="item.icon" :size="21" /><span>{{ item.label }}</span></NuxtLink
      >
    </nav>
  </div>
</template>

<style>
body.coach-viewport-body {
  height: 100dvh;
  overflow: hidden;
}
</style>

<style scoped>
.coach-shell {
  --coach-blue: #0670df;
  --coach-canvas: #f4f6f8;
  width: 100%;
  height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--coach-canvas);
  color: #15181d;
  font-family:
    system-ui,
    -apple-system,
    'SF Pro Text',
    'PingFang TC',
    sans-serif;
}
.coach-toolbar {
  position: relative;
  z-index: 40;
  padding-top: env(safe-area-inset-top);
  background: rgba(249, 250, 251, 0.84);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 1px 0 #17202b0d;
}
.coach-toolbar__inner {
  height: 54px;
  display: grid;
  grid-template-columns: minmax(138px, 1fr) minmax(0, 2.2fr) minmax(138px, 1fr);
  align-items: center;
  gap: 10px;
  padding: 0 max(14px, env(safe-area-inset-left));
  padding-right: max(14px, env(safe-area-inset-right));
}
.coach-toolbar__brand {
  color: #17202b;
  font-size: 1rem;
  font-weight: 760;
  letter-spacing: -0.02em;
  text-decoration: none;
}
.coach-toolbar__back,
.coach-toolbar__control {
  display: inline-flex;
  width: max-content;
  min-height: 44px;
  align-items: center;
  gap: 2px;
  padding: 0 8px 0 3px;
  border-radius: 10px;
  color: var(--coach-blue);
  font-size: 0.8rem;
  font-weight: 650;
  text-decoration: none;
}
.coach-toolbar__control {
  gap: 6px;
  padding-inline: 9px;
}
.coach-toolbar__back:active,
.coach-toolbar__control:active,
.coach-toolbar__brand:active {
  transform: scale(0.97);
}
.coach-toolbar__back:focus-visible,
.coach-toolbar__control:focus-visible,
.coach-toolbar__brand:focus-visible,
.coach-tab:focus-visible,
.rally-status__back:focus-visible {
  outline: 3px solid #0670df3b;
  outline-offset: 1px;
}
.coach-toolbar__title {
  min-width: 0;
  text-align: center;
}
.coach-toolbar__title strong {
  display: block;
  overflow: hidden;
  font-size: 0.9rem;
  letter-spacing: -0.012em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.coach-toolbar__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
}
.coach-content {
  min-height: 0;
  overflow: hidden;
}
.coach-content__inner {
  width: min(100%, 1440px);
  min-height: 100%;
  margin: 0 auto;
  padding: 18px max(18px, env(safe-area-inset-left));
  padding-right: max(18px, env(safe-area-inset-right));
  box-sizing: border-box;
}
.coach-shell--match .coach-content__inner {
  width: 100%;
  max-width: none;
}
.coach-content__inner--fixed {
  height: 100%;
  min-height: 0;
  padding: 0;
}
.coach-content--replay .coach-content__inner {
  width: 100%;
  padding: 0;
}
.coach-content__scroll {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.coach-tabs {
  position: relative;
  z-index: 40;
  height: calc(62px + env(safe-area-inset-bottom));
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 4px max(10px, env(safe-area-inset-left)) env(safe-area-inset-bottom);
  background: rgba(249, 250, 251, 0.88);
  box-shadow: 0 -8px 28px #17202b0d;
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}
.coach-tab {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 44px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border-radius: 10px;
  color: #7b828c;
  font-size: 0.66rem;
  font-weight: 620;
  text-decoration: none;
}
.coach-tab--active {
  color: var(--coach-blue);
}
.coach-tab--active::after {
  position: absolute;
  left: calc(50% - 14px);
  bottom: 0;
  width: 28px;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
  content: '';
}
.coach-tab:active {
  background: #0670df0d;
  transform: scale(0.97);
}
.rally-status {
  position: relative;
  z-index: 40;
  min-height: calc(58px + env(safe-area-inset-bottom));
  display: grid;
  grid-template-columns: 84px minmax(190px, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 5px max(14px, env(safe-area-inset-right)) env(safe-area-inset-bottom)
    max(14px, env(safe-area-inset-left));
  background: rgba(247, 249, 251, 0.92);
  box-shadow: 0 -8px 28px #17202b0c;
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}
.rally-status__back {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  color: var(--coach-blue);
  font-size: 0.75rem;
  font-weight: 700;
  text-decoration: none;
}
.rally-status__identity {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.rally-status__identity strong {
  overflow: hidden;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rally-status__identity span {
  color: #777f89;
  font-size: 0.6rem;
}
.rally-status dl {
  display: flex;
  align-items: center;
  gap: 24px;
  margin: 0;
}
.rally-status dl > div {
  display: grid;
  gap: 2px;
}
.rally-status dt {
  color: #7d858f;
  font-size: 0.58rem;
}
.rally-status dd {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
}
.rally-status dl > div:first-child dd {
  min-width: 76px;
}
@media (max-width: 720px) {
  .coach-toolbar__inner {
    grid-template-columns: 110px minmax(0, 1fr) 105px;
  }
  .coach-toolbar__back {
    font-size: 0.74rem;
  }
  .coach-content__inner:not(.coach-content__inner--fixed) {
    padding: 14px 12px;
  }
  .rally-status {
    grid-template-columns: 62px minmax(120px, 1fr) auto;
    gap: 8px;
  }
  .rally-status dl {
    gap: 12px;
  }
  .rally-status dl > div:first-child {
    display: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .coach-toolbar,
  .coach-tabs,
  .rally-status {
    background: #f9fafb;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .coach-toolbar__back,
  .coach-toolbar__control,
  .coach-toolbar__brand,
  .coach-tab {
    transition: none;
    transform: none !important;
  }
}
</style>
