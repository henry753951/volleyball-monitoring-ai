<script setup lang="ts">
import { Check, CircleAlert, Minus } from 'lucide-vue-next'
import type { CoachMetric } from '~/lib/coachDomain'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const analyticsState = useCoachAnalytics(matchId)
const analytics = computed(() => analyticsState.data.value)
const labels: Record<string, string> = {
  rally_count: '回合',
  resolved_rally_win_rate: '已確認賽果比例',
  contact_event_count: '擊球事件',
  participant_event_count: '球員參與事件',
  court_position_samples: '球場位置樣本',
  complete_path_rate: '完整球路比例',
  identity_coverage: '球員識別覆蓋',
  action_samples: '動作分類樣本',
}
const dependencyLabels: Record<string, string> = {
  analysis_result: '分析結果',
  contact_association: '擊球關聯',
  court_pos: '球場座標',
  immutable_submission: '已提交回合',
  manual_identity_mapping: '球員識別',
  provider_action_extension: '動作分類',
  resolved_outcome: '已確認賽果',
}

const capabilities = computed(() => [
  { label: '球員識別', available: analytics.value?.feature_availability.identity ?? false },
  { label: '球場座標', available: analytics.value?.feature_availability.court_positions ?? false },
  { label: '動作分類', available: analytics.value?.feature_availability.action ?? false },
])

function metricValue(key: string, metric: CoachMetric) {
  return key.endsWith('_rate') || key.endsWith('_coverage') ? `${(metric.value * 100).toFixed(1)}%` : new Intl.NumberFormat('zh-TW').format(metric.value)
}

function metricDependencies(metric: CoachMetric) {
  return metric.feature_dependencies.map(dependency => dependencyLabels[dependency] ?? dependency).join(' · ') || '—'
}
</script>

<template>
  <section class="stats-view">
    <div v-if="analyticsState.pending.value" class="stats-loading" aria-busy="true" />
    <div v-else-if="analyticsState.error.value && !analytics" class="stats-state" role="alert"><CircleAlert :size="22" /><strong>統計載入失敗</strong><span>{{ analyticsState.error.value.message }}</span><button type="button" @click="analyticsState.refresh">重試</button></div>
    <UiScrollArea v-else-if="analytics" class="stats-scroll">
      <div class="stats-content">
        <header class="stats-heading">
          <div><h1>分析總覽</h1><p>所有數字直接取自目前完成的分析結果，並保留樣本與缺值。</p></div>
          <div class="stats-capabilities" aria-label="分析能力">
            <span v-for="capability in capabilities" :key="capability.label" :class="{ unavailable: !capability.available }"><Check v-if="capability.available" :size="13" /><Minus v-else :size="13" />{{ capability.label }}</span>
          </div>
        </header>

        <section class="stats-metrics" aria-labelledby="metric-title">
          <header><h2 id="metric-title">場次指標</h2><span>{{ Object.keys(analytics.metrics).length }} 項</span></header>
          <UiScrollArea horizontal class="stats-table-scroll">
            <table>
              <thead><tr><th>指標</th><th>結果</th><th>樣本</th><th>排除</th><th>未知</th><th>資料依據</th></tr></thead>
              <tbody>
                <tr v-for="(metric, key) in analytics.metrics" :key="key">
                  <th>{{ labels[String(key)] || key }}</th><td class="metric-value">{{ metricValue(String(key), metric) }}</td><td>{{ metric.sample_count }}</td><td>{{ metric.excluded_count }}</td><td>{{ metric.unknown_count }}</td><td class="metric-dependencies">{{ metricDependencies(metric) }}</td>
                </tr>
              </tbody>
            </table>
          </UiScrollArea>
        </section>

        <section class="team-outcomes">
          <header><h2>隊伍回合結果</h2><span>僅計入已確認賽果</span></header>
          <div class="team-outcomes__rows">
            <div v-for="team in analytics.teams" :key="team.id">
              <strong>{{ team.name }}</strong>
              <dl><div><dt>勝</dt><dd>{{ team.wins }}</dd></div><div><dt>負</dt><dd>{{ team.losses }}</dd></div><div><dt>未知</dt><dd>{{ team.unknown }}</dd></div><div><dt>樣本</dt><dd>{{ team.sample_count }}</dd></div></dl>
            </div>
          </div>
        </section>

        <p v-if="!analytics.feature_availability.action" class="stats-note">目前分析沒有動作分類資料，因此不顯示 attack、serve 或 efficiency 等衍生指標。</p>
      </div>
    </UiScrollArea>
  </section>
</template>

<style scoped>
.stats-view,.stats-scroll{height:100%;min-height:0}.stats-content{padding:8px 2px 30px}.stats-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;padding:4px 0 18px;border-bottom:1px solid #dfe4e8}.stats-heading h1{margin:0;font-size:1.45rem;line-height:1.05;letter-spacing:-.035em}.stats-heading p{margin:5px 0 0;color:#707985;font-size:.69rem}.stats-capabilities{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:16px}.stats-capabilities span{display:inline-flex;align-items:center;gap:5px;color:#27795c;font-size:.65rem;font-weight:700}.stats-capabilities span.unavailable{color:#8a919a}.stats-metrics,.team-outcomes{margin-top:28px}.stats-metrics>header,.team-outcomes>header{display:flex;align-items:end;justify-content:space-between;gap:12px;padding-bottom:8px;border-bottom:1px solid #dfe4e8}.stats-metrics h2,.team-outcomes h2{margin:0;font-size:.88rem}.stats-metrics header span,.team-outcomes header span{color:#7b838e;font-size:.62rem}.stats-table-scroll{width:100%}.stats-metrics table{width:100%;min-width:820px;border-collapse:collapse;text-align:left;font-size:.69rem}.stats-metrics th,.stats-metrics td{height:56px;padding:0 12px;border-bottom:1px solid #e3e7eb}.stats-metrics thead th{height:36px;color:#7b848e;font-size:.58rem;font-weight:650}.stats-metrics tbody th{font-size:.72rem}.stats-metrics td{font-variant-numeric:tabular-nums}.metric-value{font-size:1rem!important;font-weight:740;letter-spacing:-.02em}.metric-dependencies{max-width:260px;color:#7b848e;font-size:.61rem}.team-outcomes__rows>div{min-height:74px;display:grid;grid-template-columns:minmax(180px,1fr) minmax(340px,.75fr);align-items:center;gap:18px;border-bottom:1px solid #e2e6ea;padding:8px 12px}.team-outcomes__rows>div>strong{font-size:.78rem}.team-outcomes dl{display:grid;grid-template-columns:repeat(4,1fr);margin:0}.team-outcomes dl>div{display:flex;align-items:baseline;justify-content:flex-end;gap:7px}.team-outcomes dt{color:#7e8791;font-size:.59rem}.team-outcomes dd{margin:0;font-size:.83rem;font-weight:730;font-variant-numeric:tabular-nums}.stats-note{margin:24px 0 0;padding:12px 0;border-block:1px solid #ead8b9;color:#7b5d24;font-size:.67rem;line-height:1.5}.stats-loading{height:100%;background:linear-gradient(100deg,#edf0f3 20%,#e2e6ea 40%,#edf0f3 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.stats-state{height:100%;display:grid;place-content:center;justify-items:center;gap:8px;color:#707984}.stats-state span{font-size:.7rem}.stats-state button{min-height:38px;padding:0 14px;border:0;border-radius:9px;background:#e4e9ef;font-weight:700}@keyframes shimmer{to{background-position:-200% 0}}@media(max-width:700px){.stats-heading{align-items:flex-start;flex-direction:column}.stats-capabilities{justify-content:flex-start}.team-outcomes__rows>div{grid-template-columns:1fr}.team-outcomes dl>div{justify-content:flex-start}}@media(prefers-reduced-motion:reduce){.stats-loading{animation:none}}
</style>
