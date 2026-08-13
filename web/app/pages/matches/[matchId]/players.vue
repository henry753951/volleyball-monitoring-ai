<script setup lang="ts">
import { BarChart3, ChevronRight, CircleAlert } from 'lucide-vue-next'
import { rosterPositionLabel } from '~/lib/rosterPositions'
import { playerContactShare, playerParticipation } from '~/utils/coachPresentation'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const analyticsState = useCoachAnalytics(matchId)
const analytics = computed(() => analyticsState.data.value)
const selectedPlayerId = ref<string | null>(null)
const selectedPlayer = computed(() => analytics.value?.players.find(player => player.roster_entry_id === selectedPlayerId.value) ?? analytics.value?.players[0] ?? null)
const selectedTeam = computed(() => analytics.value?.teams.find(team => team.id === selectedPlayer.value?.team_id) ?? null)
const selectedParticipation = computed(() => analytics.value && selectedPlayer.value ? playerParticipation(analytics.value, selectedPlayer.value.roster_entry_id) : [])
const selectedShare = computed(() => analytics.value && selectedPlayer.value ? playerContactShare(analytics.value, selectedPlayer.value.roster_entry_id) : 0)
const identityCoverage = computed(() => analytics.value?.metrics.identity_coverage?.value ?? 0)

watch(analytics, (value) => {
  if (!selectedPlayerId.value || !value?.players.some(player => player.roster_entry_id === selectedPlayerId.value)) selectedPlayerId.value = value?.players[0]?.roster_entry_id ?? null
}, { immediate: true })

function playerBadge(player: NonNullable<typeof selectedPlayer.value>) {
  return `[${player.position === 'UNSPECIFIED' ? '—' : player.position}] ${player.jersey_number}`
}
</script>

<template>
  <section class="players-view">
    <div v-if="analyticsState.pending.value" class="players-loading" aria-busy="true"><i v-for="n in 7" :key="n" /></div>
    <div v-else-if="analyticsState.error.value && !analytics" class="players-state" role="alert"><CircleAlert :size="22" /><strong>球員資料載入失敗</strong><span>{{ analyticsState.error.value.message }}</span><button type="button" @click="analyticsState.refresh">重試</button></div>
    <div v-else-if="analytics" class="players-layout">
      <aside class="player-list" aria-label="球員名單">
        <header><strong>球員</strong><NuxtLink :to="`/matches/${matchId}/stats`"><BarChart3 :size="16" />完整統計</NuxtLink></header>
        <UiScrollArea class="player-list__scroll">
          <div>
            <section v-for="team in analytics.teams" :key="team.id" class="player-list__team">
              <h2>{{ team.name }}</h2>
              <button v-for="player in analytics.players.filter(item => item.team_id === team.id)" :key="player.roster_entry_id" type="button" :class="{ active: selectedPlayer?.roster_entry_id === player.roster_entry_id }" @click="selectedPlayerId = player.roster_entry_id">
                <span>{{ playerBadge(player) }}</span><b>{{ player.name }}</b><small>{{ player.contact_count }} 擊球</small>
              </button>
            </section>
            <p v-if="!analytics.players.length">尚無球員資料</p>
          </div>
        </UiScrollArea>
      </aside>

      <UiScrollArea v-if="selectedPlayer" class="player-detail-scroll">
        <main class="player-detail">
          <header class="player-title">
            <div><span class="player-badge">{{ playerBadge(selectedPlayer) }}</span><p>{{ selectedTeam?.name }} · {{ rosterPositionLabel(selectedPlayer.position) }}</p><h1>{{ selectedPlayer.name }}</h1></div>
            <span v-if="analyticsState.refreshing.value" class="player-sync">同步中</span>
          </header>

          <dl class="player-measures">
            <div><dt>分析擊球</dt><dd>{{ selectedPlayer.contact_count }}</dd><small>已綁定到此球員的事件</small></div>
            <div><dt>佔已辨識擊球</dt><dd>{{ (selectedShare * 100).toFixed(1) }}%</dd><small>{{ analytics.players.reduce((sum, player) => sum + player.contact_count, 0) }} 個已辨識事件</small></div>
            <div><dt>參與回合</dt><dd>{{ selectedParticipation.length }}</dd><small>具有此球員軌跡的回合</small></div>
            <div><dt>場次識別覆蓋</dt><dd>{{ (identityCoverage * 100).toFixed(1) }}%</dd><small>{{ analytics.metrics.identity_coverage?.sample_count ?? 0 }} 條球員軌跡</small></div>
          </dl>

          <section class="player-rallies">
            <header><div><h2>參與回合</h2><p>由已完成分析與球員 mapping 即時彙整</p></div><span>{{ selectedParticipation.length }} 回合</span></header>
            <div v-if="selectedParticipation.length" class="player-rallies__list">
              <NuxtLink v-for="track in selectedParticipation" :key="track.rally_id" :to="`/matches/${matchId}/replay/${track.rally_id}`">
                <div><strong>第 {{ track.set_number }} 局 · 回合 {{ track.rally_ordinal }}</strong><span>Track {{ track.track_id }} · frame {{ track.first_frame_index }}–{{ track.last_frame_index }}</span></div><ChevronRight :size="18" />
              </NuxtLink>
            </div>
            <p v-else class="player-rallies__empty">目前沒有已綁定到這位球員的分析軌跡。</p>
          </section>
        </main>
      </UiScrollArea>
      <main v-else class="players-state">尚無球員資料。</main>
    </div>
  </section>
</template>

<style scoped>
.players-view{height:100%;min-height:0;overflow:hidden}.players-layout{height:100%;min-height:0;display:grid;grid-template-columns:288px minmax(0,1fr);overflow:hidden;border-block:1px solid #e0e5e9;background:#fbfcfd}.player-list{min-height:0;display:grid;grid-template-rows:50px minmax(0,1fr);overflow:hidden;border-right:1px solid #dfe4e8;background:#eef1f4}.player-list>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 14px;border-bottom:1px solid #dde2e7}.player-list>header strong{font-size:.82rem}.player-list>header a{min-height:36px;display:inline-flex;align-items:center;gap:5px;color:#0670df;font-size:.67rem;font-weight:700;text-decoration:none}.player-list__scroll,.player-detail-scroll{height:100%;min-height:0}.player-list__team h2{position:sticky;top:0;z-index:2;margin:0;padding:12px 14px 7px;background:rgba(238,241,244,.94);color:#707985;font-size:.63rem;backdrop-filter:blur(12px)}.player-list button{width:100%;min-height:54px;display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:center;gap:8px;padding:0 14px;border:0;background:transparent;color:#20242a;text-align:left}.player-list button:hover{background:#e5eaf0}.player-list button.active{background:#fff;color:#075fbe;box-shadow:inset 3px 0 #0670df}.player-list button span{font-size:.68rem;font-weight:780;font-variant-numeric:tabular-nums}.player-list button b{overflow:hidden;font-size:.74rem;text-overflow:ellipsis;white-space:nowrap}.player-list button small{color:#858d97;font-size:.59rem;font-variant-numeric:tabular-nums}.player-detail{min-width:0;min-height:100%;padding:clamp(26px,4vw,58px) clamp(28px,5vw,72px);box-sizing:border-box}.player-title{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.player-title>div{min-width:0}.player-badge{display:inline-flex;min-height:27px;align-items:center;padding:0 8px;border-radius:7px;background:#17202a;color:#fff;font-size:.68rem;font-weight:780;font-variant-numeric:tabular-nums}.player-title p{margin:13px 0 3px;color:#737c87;font-size:.7rem;font-weight:620}.player-title h1{margin:0;font-size:clamp(2rem,4vw,3.6rem);line-height:1;letter-spacing:-.04em}.player-sync{color:#74808b;font-size:.62rem}.player-measures{display:grid;grid-template-columns:repeat(4,1fr);margin:clamp(30px,5vw,64px) 0 0;border-block:1px solid #dfe4e8}.player-measures>div{min-width:0;padding:20px 18px}.player-measures>div+div{border-left:1px solid #e1e5e9}.player-measures dt{color:#68727e;font-size:.65rem;font-weight:650}.player-measures dd{margin:8px 0 5px;font-size:clamp(1.65rem,3vw,2.65rem);font-weight:720;line-height:1;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.player-measures small{display:block;color:#858d97;font-size:.59rem;line-height:1.4}.player-rallies{margin-top:clamp(28px,4vw,48px)}.player-rallies>header{display:flex;align-items:end;justify-content:space-between;gap:16px;padding-bottom:10px;border-bottom:1px solid #dfe4e8}.player-rallies h2{margin:0;font-size:.9rem}.player-rallies header p{margin:3px 0 0;color:#79828c;font-size:.63rem}.player-rallies header>span{color:#707a85;font-size:.65rem}.player-rallies__list a{min-height:58px;display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid #e4e7eb;color:inherit;text-decoration:none}.player-rallies__list a:hover{background:#f2f5f8}.player-rallies__list a>div{display:grid;gap:3px}.player-rallies__list strong{font-size:.73rem}.player-rallies__list span{color:#7c858f;font-size:.6rem;font-variant-numeric:tabular-nums}.player-rallies__list svg{color:#8c949d}.player-rallies__empty{margin:0;padding:24px 0;color:#7b848f;font-size:.7rem}.players-loading{height:100%;display:grid;grid-template-columns:288px 1fr;background:#fbfcfd}.players-loading i{display:none}.players-loading::before,.players-loading::after{content:"";background:linear-gradient(100deg,#edf0f3 20%,#e2e6ea 40%,#edf0f3 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.players-loading::before{border-right:1px solid #dde2e7}.players-state{height:100%;display:grid;place-content:center;justify-items:center;gap:8px;color:#707984}.players-state span{font-size:.7rem}.players-state button{min-height:38px;padding:0 14px;border:0;border-radius:9px;background:#e4e9ef;font-weight:700}@keyframes shimmer{to{background-position:-200% 0}}@media(max-width:820px){.players-layout{grid-template-columns:240px minmax(0,1fr)}.player-detail{padding:24px}.player-measures{grid-template-columns:repeat(2,1fr)}.player-measures>div:nth-child(3){border-left:0;border-top:1px solid #e1e5e9}.player-measures>div:nth-child(4){border-top:1px solid #e1e5e9}}@media(max-width:620px){.players-layout{grid-template-columns:200px minmax(0,1fr)}.player-list>header a{font-size:0}.player-title h1{font-size:1.8rem}.player-measures{grid-template-columns:1fr}.player-measures>div+div{border-left:0;border-top:1px solid #e1e5e9}}@media(prefers-reduced-motion:reduce){.players-loading::before,.players-loading::after{animation:none}}
</style>
