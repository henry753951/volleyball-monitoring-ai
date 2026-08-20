<script setup lang="ts">
import { ArrowUpRight, Check, CircleAlert, Minus, ShieldCheck } from 'lucide-vue-next'
import type { CoachMetric } from '~/lib/coachDomain'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const analyticsState = useCoachAnalytics(matchId)
const analytics = computed(() => analyticsState.data.value)
const resolvedRallies = computed(
  () => analytics.value?.sets.reduce((sum, set) => sum + set.resolved_count, 0) ?? 0,
)
const totalContacts = computed(() => analytics.value?.metrics.contact_event_count?.value ?? 0)
const identityCoverage = computed(() => analytics.value?.metrics.identity_coverage?.value ?? 0)
const teamName = (id: string | null) =>
  analytics.value?.teams.find(team => team.id === id)?.shortName ||
  analytics.value?.teams.find(team => team.id === id)?.name ||
  '未知'
const labels: Record<string, string> = {
  rally_count: '回合',
  resolved_rally_win_rate: '已確認賽果比例',
  contact_event_count: '擊球事件',
  participant_event_count: '球員參與事件',
  court_position_samples: '球場位置樣本',
  complete_path_rate: '完整球路比例',
  identity_coverage: '球員識別覆蓋',
  action_samples: '動作分類樣本',
  human_ball_event_samples: '人工球種樣本',
}
const dependencyLabels: Record<string, string> = {
  analysis_result: '分析結果',
  contact_association: '擊球關聯',
  court_pos: '球場座標',
  immutable_submission: '已提交回合',
  manual_identity_mapping: '球員識別',
  provider_action_extension: '動作分類',
  human_ball_event: '人工球種標記',
  resolved_outcome: '已確認賽果',
}

const capabilities = computed(() => [
  { label: '人工球種', available: analytics.value?.feature_availability.ball_events ?? false },
  { label: '球員識別', available: analytics.value?.feature_availability.identity ?? false },
  { label: '球場座標', available: analytics.value?.feature_availability.court_positions ?? false },
  { label: '動作分類', available: analytics.value?.feature_availability.action ?? false },
])

function metricValue(key: string, metric: CoachMetric) {
  return key.endsWith('_rate') || key.endsWith('_coverage')
    ? `${(metric.value * 100).toFixed(1)}%`
    : new Intl.NumberFormat('zh-TW').format(metric.value)
}

function metricDependencies(metric: CoachMetric) {
  return (
    metric.feature_dependencies
      .map(dependency => dependencyLabels[dependency] ?? dependency)
      .join(' · ') || '—'
  )
}
</script>

<template>
  <section class="stats-view">
    <div v-if="analyticsState.pending.value" class="stats-loading" aria-busy="true" />
    <div v-else-if="analyticsState.error.value && !analytics" class="stats-state" role="alert">
      <CircleAlert :size="22" /><strong>統計載入失敗</strong
      ><span>{{ analyticsState.error.value.message }}</span
      ><button type="button" @click="analyticsState.refresh">重試</button>
    </div>
    <UiScrollArea v-else-if="analytics" class="stats-scroll">
      <div class="stats-content">
        <header class="stats-heading">
          <div>
            <h1>分析總覽</h1>
            <p>球種與結果以人工標記為準；AI 僅提供座標、追蹤與畫面疊圖。</p>
          </div>
          <div class="stats-capabilities" aria-label="分析能力">
            <span
              v-for="capability in capabilities"
              :key="capability.label"
              :class="{ unavailable: !capability.available }"
              ><Check v-if="capability.available" :size="13" /><Minus v-else :size="13" />{{
                capability.label
              }}</span
            >
          </div>
        </header>

        <section class="overview-cards" aria-label="場次摘要">
          <article>
            <span>已確認回合</span><strong>{{ resolvedRallies }}</strong
            ><small>共 {{ analytics.metrics.rally_count?.value ?? 0 }} 回合</small>
          </article>
          <article>
            <span>擊球事件</span><strong>{{ totalContacts }}</strong
            ><small>已審核片段</small>
          </article>
          <article>
            <span>球員辨識</span><strong>{{ Math.round(identityCoverage * 100) }}%</strong
            ><small>{{
              analytics.unassigned_tracks.length
                ? `${analytics.unassigned_tracks.length} 個追蹤待確認`
                : '全部已確認'
            }}</small>
          </article>
          <article class="quality">
            <span><ShieldCheck :size="15" />分析可用性</span
            ><strong>{{
              analytics.feature_availability.court_positions ? '場地資料完整' : '等待場地資料'
            }}</strong
            ><small>{{
              analytics.feature_availability.ball_events ? '含人工球種' : '等待人工球種標記'
            }}</small>
          </article>
        </section>

        <section class="stats-metrics" aria-labelledby="metric-title">
          <header>
            <h2 id="metric-title">場次指標</h2>
            <span>{{ Object.keys(analytics.metrics).length }} 項</span>
          </header>
          <UiScrollArea horizontal class="stats-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>指標</th>
                  <th>結果</th>
                  <th>樣本</th>
                  <th>排除</th>
                  <th>未知</th>
                  <th>資料依據</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(metric, key) in analytics.metrics" :key="key">
                  <th>{{ labels[String(key)] || key }}</th>
                  <td class="metric-value">{{ metricValue(String(key), metric) }}</td>
                  <td>{{ metric.sample_count }}</td>
                  <td>{{ metric.excluded_count }}</td>
                  <td>{{ metric.unknown_count }}</td>
                  <td class="metric-dependencies">{{ metricDependencies(metric) }}</td>
                </tr>
              </tbody>
            </table>
          </UiScrollArea>
        </section>

        <section class="team-outcomes">
          <header>
            <h2>隊伍回合結果</h2>
            <span>僅計入已確認賽果</span>
          </header>
          <div class="team-outcomes__rows">
            <div v-for="team in analytics.teams" :key="team.id">
              <strong>{{ team.name }}</strong>
              <dl>
                <div>
                  <dt>勝</dt>
                  <dd>{{ team.wins }}</dd>
                </div>
                <div>
                  <dt>負</dt>
                  <dd>{{ team.losses }}</dd>
                </div>
                <div>
                  <dt>未知</dt>
                  <dd>{{ team.unknown }}</dd>
                </div>
                <div>
                  <dt>樣本</dt>
                  <dd>{{ team.sample_count }}</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section class="set-summary">
          <header>
            <h2>各局累計</h2>
            <span>隨審核資料更新</span>
          </header>
          <div class="set-table">
            <div class="set-row heading">
              <span>局</span
              ><span v-for="team in analytics.teams" :key="team.id">{{
                team.shortName || team.name
              }}</span
              ><span>回合</span>
            </div>
            <div v-for="set in analytics.sets" :key="set.set_number" class="set-row">
              <b>{{ set.set_number }}</b
              ><strong v-for="team in analytics.teams" :key="team.id">{{
                set.team_points[team.id] ?? 0
              }}</strong
              ><span>{{ set.resolved_count }} / {{ set.rally_count }}</span>
            </div>
          </div>
        </section>

        <section class="rally-summary">
          <header>
            <h2>每一球</h2>
            <span>點選後開啟該回合回放</span>
          </header>
          <div class="rally-list">
            <NuxtLink v-for="rally in analytics.rallies" :key="rally.id" :to="rally.replay_url">
              <span>總回合 {{ rally.ordinal }}</span
              ><strong>{{ rally.contact_count }} 次擊球</strong
              ><b :class="{ unknown: rally.score_resolution !== 'resolved' }">{{
                rally.score_resolution === 'resolved' ? teamName(rally.scoring_team_id) : '結果未知'
              }}</b
              ><small>前往回放</small><ArrowUpRight :size="16" />
            </NuxtLink>
          </div>
        </section>

        <p v-if="!analytics.feature_availability.ball_events" class="stats-note">
          目前沒有人工球種資料，因此不以動作模型推測發球、接發、殺球或成功率。
        </p>
      </div>
    </UiScrollArea>
  </section>
</template>

<style scoped>
.stats-view,
.stats-scroll {
  height: 100%;
  min-height: 0;
}
.stats-content {
  padding: 8px 2px 30px;
}
.stats-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  padding: 4px 0 18px;
  border-bottom: 1px solid #dfe4e8;
}
.stats-heading h1 {
  margin: 0;
  font-size: 1.45rem;
  line-height: 1.05;
  letter-spacing: -0.035em;
}
.stats-heading p {
  margin: 5px 0 0;
  color: #707985;
  font-size: 0.69rem;
}
.stats-capabilities {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 16px;
}
.stats-capabilities span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #27795c;
  font-size: 0.65rem;
  font-weight: 700;
}
.stats-capabilities span.unavailable {
  color: #8a919a;
}
.overview-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 24px;
}
.overview-cards article {
  min-height: 110px;
  display: grid;
  align-content: center;
  gap: 4px;
  padding: 16px;
  border: 1px solid #e1e5e9;
  border-radius: 14px;
  background: #fff;
}
.overview-cards span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #69717a;
  font-size: 0.68rem;
}
.overview-cards strong {
  font-size: 1.7rem;
  letter-spacing: -0.035em;
}
.overview-cards small {
  color: #8b929a;
  font-size: 0.62rem;
}
.overview-cards .quality strong {
  font-size: 0.92rem;
}
.stats-metrics,
.team-outcomes,
.set-summary,
.rally-summary {
  margin-top: 28px;
}
.stats-metrics > header,
.team-outcomes > header,
.set-summary > header,
.rally-summary > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #dfe4e8;
}
.stats-metrics h2,
.team-outcomes h2,
.set-summary h2,
.rally-summary h2 {
  margin: 0;
  font-size: 0.88rem;
}
.stats-metrics header span,
.team-outcomes header span,
.set-summary header span,
.rally-summary header span {
  color: #7b838e;
  font-size: 0.62rem;
}
.stats-table-scroll {
  width: 100%;
}
.stats-metrics table {
  width: 100%;
  min-width: 820px;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.69rem;
}
.stats-metrics th,
.stats-metrics td {
  height: 56px;
  padding: 0 12px;
  border-bottom: 1px solid #e3e7eb;
}
.stats-metrics thead th {
  height: 36px;
  color: #7b848e;
  font-size: 0.58rem;
  font-weight: 650;
}
.stats-metrics tbody th {
  font-size: 0.72rem;
}
.stats-metrics td {
  font-variant-numeric: tabular-nums;
}
.metric-value {
  font-size: 1rem !important;
  font-weight: 740;
  letter-spacing: -0.02em;
}
.metric-dependencies {
  max-width: 260px;
  color: #7b848e;
  font-size: 0.61rem;
}
.team-outcomes__rows > div {
  min-height: 74px;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(340px, 0.75fr);
  align-items: center;
  gap: 18px;
  border-bottom: 1px solid #e2e6ea;
  padding: 8px 12px;
}
.team-outcomes__rows > div > strong {
  font-size: 0.78rem;
}
.team-outcomes dl {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 0;
}
.team-outcomes dl > div {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 7px;
}
.team-outcomes dt {
  color: #7e8791;
  font-size: 0.59rem;
}
.team-outcomes dd {
  margin: 0;
  font-size: 0.83rem;
  font-weight: 730;
  font-variant-numeric: tabular-nums;
}
.set-summary,
.rally-summary {
  overflow: hidden;
  border: 1px solid #e1e5e9;
  border-radius: 14px;
  background: #fff;
}
.set-summary > header,
.rally-summary > header {
  padding: 14px 16px;
}
.set-table {
  display: grid;
}
.set-row {
  min-height: 46px;
  display: grid;
  grid-template-columns: 48px repeat(2, minmax(70px, 1fr)) 90px;
  align-items: center;
  padding: 0 17px;
  border-top: 1px solid #eef0f2;
  text-align: center;
  font-size: 0.75rem;
}
.set-row.heading {
  min-height: 34px;
  background: #f7f8f9;
  color: #7a828a;
  font-size: 0.62rem;
}
.set-row > *:first-child {
  text-align: left;
}
.set-row strong {
  font-size: 1rem;
}
.rally-list {
  display: grid;
  max-height: 420px;
  overflow: auto;
}
.rally-list a {
  min-height: 50px;
  display: grid;
  grid-template-columns: 70px minmax(90px, 1fr) minmax(90px, 1fr) 80px 20px;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-top: 1px solid #eef0f2;
  color: inherit;
  text-decoration: none;
}
.rally-list a:first-child {
  border: 0;
}
.rally-list a:hover {
  background: #f6f8f9;
}
.rally-list span,
.rally-list small {
  color: #737b84;
  font-size: 0.68rem;
}
.rally-list strong,
.rally-list b {
  font-size: 0.74rem;
}
.rally-list b {
  color: #247154;
}
.rally-list b.unknown {
  color: #8a7444;
}
.stats-note {
  margin: 24px 0 0;
  padding: 12px 0;
  border-block: 1px solid #ead8b9;
  color: #7b5d24;
  font-size: 0.67rem;
  line-height: 1.5;
}
.stats-loading {
  height: 100%;
  background: linear-gradient(100deg, #edf0f3 20%, #e2e6ea 40%, #edf0f3 60%);
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}
.stats-state {
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: #707984;
}
.stats-state span {
  font-size: 0.7rem;
}
.stats-state button {
  min-height: 38px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  background: #e4e9ef;
  font-weight: 700;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
@media (max-width: 900px) {
  .overview-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 700px) {
  .stats-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .stats-capabilities {
    justify-content: flex-start;
  }
  .team-outcomes__rows > div {
    grid-template-columns: 1fr;
  }
  .team-outcomes dl > div {
    justify-content: flex-start;
  }
  .overview-cards {
    grid-template-columns: 1fr;
  }
  .rally-list a {
    grid-template-columns: 62px 1fr auto;
  }
  .rally-list small,
  .rally-list b {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .stats-loading {
    animation: none;
  }
}
.stats-content {
  padding: clamp(22px, 3vw, 38px) clamp(22px, 4vw, 60px) calc(36px + env(safe-area-inset-bottom));
}
@media (max-width: 700px) {
  .stats-content {
    padding: 18px 16px calc(30px + env(safe-area-inset-bottom));
  }
}
</style>
