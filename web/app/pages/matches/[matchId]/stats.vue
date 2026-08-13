<script setup lang="ts">
import { ArrowUpRight, CircleAlert, ShieldCheck } from 'lucide-vue-next'
import { createCoachDomainClient, type CoachMatchAnalytics } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const analytics = shallowRef<CoachMatchAnalytics | null>(null)
const pending = ref(true)
const error = shallowRef<Error | null>(null)
let refreshing = false
let refreshTimer: ReturnType<typeof setInterval> | undefined

async function load() {
  if (refreshing) return
  refreshing = true
  if (!analytics.value) pending.value = true
  try {
    analytics.value = await createCoachDomainClient(createGraphQLTransport('/graphql')).analytics(matchId.value)
    error.value = null
  }
  catch (cause) { error.value = cause instanceof Error ? cause : new Error('無法載入賽事統計') }
  finally { pending.value = false; refreshing = false }
}
onMounted(() => {
  void load()
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 2_000)
})
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })

const resolvedRallies = computed(() => analytics.value?.sets.reduce((sum, set) => sum + set.resolved_count, 0) ?? 0)
const totalContacts = computed(() => analytics.value?.metrics.contact_event_count?.value ?? 0)
const identityCoverage = computed(() => analytics.value?.metrics.identity_coverage?.value ?? 0)
const teamName = (id: string | null) => analytics.value?.teams.find(team => team.id === id)?.shortName || analytics.value?.teams.find(team => team.id === id)?.name || '未知'
</script>

<template>
  <section class="stats-view">
    <header class="stats-header">
      <div><span>賽事統計</span><h1>{{ analytics?.match.title || '載入中' }}</h1></div>
      <button type="button" :disabled="pending" @click="load">更新</button>
    </header>

    <div v-if="pending" class="stats-loading" aria-busy="true" />
    <div v-else-if="error" class="stats-error" role="alert"><CircleAlert :size="20" /><strong>統計載入失敗</strong><span>{{ error.message }}</span></div>
    <template v-else-if="analytics">
      <div class="overview-cards">
        <article><span>已確認回合</span><strong>{{ resolvedRallies }}</strong><small>共 {{ analytics.metrics.rally_count?.value ?? 0 }} 回合</small></article>
        <article><span>擊球事件</span><strong>{{ totalContacts }}</strong><small>已審核片段</small></article>
        <article><span>球員辨識</span><strong>{{ Math.round(identityCoverage * 100) }}%</strong><small>{{ analytics.unassigned_tracks.length ? `${analytics.unassigned_tracks.length} 個追蹤待確認` : '全部已確認' }}</small></article>
        <article class="quality"><span><ShieldCheck :size="15" />分析可用性</span><strong>{{ analytics.feature_availability.court_positions ? '場地資料完整' : '等待場地資料' }}</strong><small>{{ analytics.feature_availability.action ? '含動作分類' : '僅顯示可驗證事件' }}</small></article>
      </div>

      <div class="stats-grid">
        <section class="score-card">
          <header><h2>各局累計</h2><span>隨審核資料更新</span></header>
          <div class="set-table">
            <div class="set-row heading"><span>局</span><span v-for="team in analytics.teams" :key="team.id">{{ team.shortName || team.name }}</span><span>回合</span></div>
            <div v-for="set in analytics.sets" :key="set.set_number" class="set-row"><b>{{ set.set_number }}</b><strong v-for="team in analytics.teams" :key="team.id">{{ set.team_points[team.id] ?? 0 }}</strong><span>{{ set.resolved_count }} / {{ set.rally_count }}</span></div>
          </div>
        </section>

        <section class="team-card">
          <header><h2>回合結果</h2><span>未知結果可於標註台修正</span></header>
          <div class="team-results"><article v-for="team in analytics.teams" :key="team.id"><strong>{{ team.name }}</strong><b>{{ team.wins }}</b><span>勝回合</span><small>{{ team.unknown }} 回合尚未確認</small></article></div>
        </section>
      </div>

      <section class="rally-card">
        <header><h2>每一球</h2><span>點選後開啟該回合回放</span></header>
        <div class="rally-list">
          <NuxtLink v-for="rally in analytics.rallies" :key="rally.id" :to="rally.replay_url">
            <span>第 {{ rally.set_number }} 局</span><strong>回合 {{ rally.ordinal }}</strong><b :class="{ unknown: rally.score_resolution !== 'resolved' }">{{ rally.score_resolution === 'resolved' ? teamName(rally.scoring_team_id) : '結果未知' }}</b><small>{{ rally.contact_count }} 次擊球</small><ArrowUpRight :size="16" />
          </NuxtLink>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.stats-view{display:grid;gap:16px;width:min(100%,1280px);margin:0 auto;color:#202327}.stats-header{display:flex;align-items:end;justify-content:space-between;gap:16px}.stats-header div{display:grid;gap:3px}.stats-header span,.score-card header span,.team-card header span,.rally-card header span{color:#777f88;font-size:.72rem}.stats-header h1{margin:0;font-size:1.45rem;letter-spacing:-.025em}.stats-header button{min-height:38px;padding:0 15px;border:1px solid #d9dde1;border-radius:9px;background:#fff;font-weight:700}.stats-loading{height:300px;border-radius:16px;background:#e7e9ec;animation:pulse 1.2s ease-in-out infinite}.stats-error{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;padding:18px;border-radius:14px;background:#fff1f2;color:#872b35}.stats-error span{grid-column:2;font-size:.8rem}.overview-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.overview-cards article{min-height:116px;display:grid;align-content:center;gap:4px;padding:16px;border:1px solid #e6e8eb;border-radius:14px;background:#fff}.overview-cards span{display:flex;align-items:center;gap:5px;color:#69717a;font-size:.72rem}.overview-cards strong{font-size:1.75rem;letter-spacing:-.035em}.overview-cards small{color:#8b929a;font-size:.66rem}.overview-cards .quality strong{font-size:1rem}.stats-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:12px}.score-card,.team-card,.rally-card{overflow:hidden;border:1px solid #e3e6e9;border-radius:16px;background:#fff}.score-card header,.team-card header,.rally-card header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px;border-bottom:1px solid #eceef0}.score-card h2,.team-card h2,.rally-card h2{margin:0;font-size:.9rem}.set-table{display:grid}.set-row{min-height:46px;display:grid;grid-template-columns:48px repeat(2,minmax(70px,1fr)) 90px;align-items:center;padding:0 17px;border-top:1px solid #f0f1f2;text-align:center;font-size:.78rem}.set-row:first-child{border:0}.set-row.heading{min-height:34px;background:#f7f8f9;color:#7a828a;font-size:.64rem}.set-row>*:first-child{text-align:left}.set-row strong{font-size:1rem}.team-results{display:grid;grid-template-columns:repeat(2,1fr);height:calc(100% - 52px)}.team-results article{display:grid;align-content:center;justify-items:center;gap:3px;padding:15px;text-align:center}.team-results article+article{border-left:1px solid #eceef0}.team-results strong{font-size:.72rem}.team-results b{font-size:2rem}.team-results span,.team-results small{color:#7c848c;font-size:.65rem}.rally-list{display:grid;max-height:360px;overflow:auto}.rally-list a{min-height:50px;display:grid;grid-template-columns:70px minmax(90px,1fr) minmax(90px,1fr) 80px 20px;align-items:center;gap:10px;padding:0 16px;border-top:1px solid #eef0f2;color:inherit;text-decoration:none}.rally-list a:first-child{border:0}.rally-list a:hover{background:#f6f8f9}.rally-list span,.rally-list small{color:#737b84;font-size:.68rem}.rally-list strong,.rally-list b{font-size:.74rem}.rally-list b{color:#247154}.rally-list b.unknown{color:#8a7444}@keyframes pulse{50%{opacity:.55}}@media(max-width:900px){.overview-cards{grid-template-columns:repeat(2,1fr)}.stats-grid{grid-template-columns:1fr}}@media(max-width:640px){.overview-cards{grid-template-columns:1fr}.rally-list a{grid-template-columns:62px 1fr auto}.rally-list small,.rally-list b{display:none}}
</style>
