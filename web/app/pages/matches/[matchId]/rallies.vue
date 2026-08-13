<script setup lang="ts">
import { ChevronRight, RotateCcw } from 'lucide-vue-next'
import { coachRallyContactCount, coachRallyPathCount, coachRallyTrackCount } from '~/utils/coachPresentation'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const coach = useCoachMatchState(matchId)
const match = computed(() => coach.data.value?.match ?? null)
const selectedSet = ref<number | 'all'>('all')
const teamById = computed(() => new Map((match.value?.teams ?? []).map(team => [team.id, team])))
const rallies = computed(() => (match.value?.rallies ?? []).filter((rally) => {
  if (rally.submission.analysis?.status !== 'completed') return false
  return selectedSet.value === 'all' || rally.set_number === selectedSet.value
}))

function outcomeLabel(rally: (typeof rallies.value)[number]) {
  if (rally.submission.score_resolution === 'unknown') return '結果待確認'
  return teamById.value.get(rally.submission.scoring_team_id ?? '')?.name ?? '未計分'
}

function durationLabel(value?: string | null) {
  if (!value) return '—'
  const milliseconds = Number(BigInt(value) / 1_000n)
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)} 秒`
}

function submittedTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}
</script>

<template>
  <section class="rally-browser">
    <header class="rally-browser__bar">
      <UiScrollArea horizontal class="rally-browser__set-scroll">
        <div class="rally-browser__sets" role="tablist" aria-label="局數">
          <button type="button" role="tab" :aria-selected="selectedSet === 'all'" :class="{ active: selectedSet === 'all' }" @click="selectedSet = 'all'">全部回合</button>
          <button v-for="set in match?.sets" :key="set.id" type="button" role="tab" :aria-selected="selectedSet === set.set_number" :class="{ active: selectedSet === set.set_number }" @click="selectedSet = set.set_number">第 {{ set.set_number }} 局</button>
        </div>
      </UiScrollArea>
      <span>{{ rallies.length }} 回合</span>
    </header>

    <div class="rally-columns" aria-hidden="true"><span>回合與結果</span><span>持續時間</span><span>分析結果</span><i /></div>
    <div v-if="coach.pending.value" class="rally-list rally-list--loading" aria-busy="true"><i v-for="n in 4" :key="n" /></div>
    <div v-else-if="!rallies.length" class="rally-empty"><RotateCcw :size="22" /><strong>目前沒有已完成的回合</strong><span>分析完成後會自動出現在這裡。</span></div>
    <UiScrollArea v-else class="rally-list-scroll">
      <ol class="rally-list">
        <li v-for="rally in rallies" :key="rally.id">
          <NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`">
            <div class="rally-primary">
              <span class="rally-state" :class="{ mapped: rally.submission.analysis?.identity_mapping_completed }" />
              <div><strong>回合 {{ rally.ordinal }}</strong><small>第 {{ rally.set_number }} 局 · {{ submittedTime(rally.submission.submitted_at) }}</small></div>
              <b>{{ outcomeLabel(rally) }}</b>
            </div>
            <div class="rally-measure"><strong>{{ durationLabel(rally.submission.clip?.duration_us) }}</strong><small>影片</small></div>
            <div class="rally-analysis">
              <strong>{{ coachRallyContactCount(rally) }} 擊球</strong>
              <span>{{ coachRallyPathCount(rally) }} 球路 · {{ coachRallyTrackCount(rally) }} 軌跡</span>
            </div>
            <ChevronRight :size="20" />
          </NuxtLink>
        </li>
      </ol>
    </UiScrollArea>
  </section>
</template>

<style scoped>
.rally-browser{height:100%;min-height:0;display:grid;grid-template-rows:48px 30px minmax(0,1fr);overflow:hidden}.rally-browser__bar{position:relative;z-index:3;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #dfe4e9;background:#f4f6f8}.rally-browser__bar>span{flex:none;color:#717a85;font-size:.7rem;font-weight:650;font-variant-numeric:tabular-nums}.rally-browser__set-scroll{width:min(100%,760px);height:47px}.rally-browser__sets{width:max-content;min-width:100%;height:47px;display:flex;align-items:stretch;gap:22px}.rally-browser__sets button{position:relative;min-width:max-content;padding:0 2px;border:0;background:transparent;color:#737c87;font-size:.73rem;font-weight:680}.rally-browser__sets button.active{color:#11151a}.rally-browser__sets button.active::after{position:absolute;inset:auto 0 0;height:2px;border-radius:2px;background:#0670df;content:""}.rally-columns{display:grid;grid-template-columns:minmax(300px,1.4fr) minmax(120px,.45fr) minmax(220px,.72fr) 20px;align-items:end;gap:18px;padding:0 14px 7px;border-bottom:1px solid #e4e8ec;color:#858d97;font-size:.59rem;font-weight:650}.rally-columns i{display:block}.rally-list-scroll{height:100%;min-height:0}.rally-list{margin:0;padding:0;list-style:none}.rally-list li{border-bottom:1px solid #e1e5e9}.rally-list li a{min-height:88px;display:grid;grid-template-columns:minmax(300px,1.4fr) minmax(120px,.45fr) minmax(220px,.72fr) 20px;align-items:center;gap:18px;padding:10px 14px;color:inherit;text-decoration:none}.rally-list li a:hover{background:#fff}.rally-list li a:active{background:#eaf2fc}.rally-list li a:focus-visible{outline:3px solid #0670df38;outline-offset:-3px}.rally-primary{min-width:0;display:grid;grid-template-columns:8px minmax(120px,.7fr) minmax(120px,1fr);align-items:center;gap:12px}.rally-state{width:7px;height:7px;border-radius:50%;background:#2f79d7;box-shadow:0 0 0 4px #2f79d712}.rally-state.mapped{background:#278a62;box-shadow:0 0 0 4px #278a6214}.rally-primary>div{min-width:0;display:grid;gap:3px}.rally-primary strong,.rally-measure strong,.rally-analysis strong{font-size:.8rem;letter-spacing:-.005em}.rally-primary small,.rally-measure small,.rally-analysis span{color:#7a838e;font-size:.63rem}.rally-primary>b{overflow:hidden;font-size:.78rem;text-overflow:ellipsis;white-space:nowrap}.rally-measure,.rally-analysis{display:grid;gap:3px}.rally-measure strong,.rally-analysis strong{font-variant-numeric:tabular-nums}.rally-list li svg{color:#9098a2}.rally-list--loading{display:grid}.rally-list--loading i{height:88px;border-bottom:1px solid #e2e6ea;background:linear-gradient(100deg,#edf0f3 20%,#e3e7eb 40%,#edf0f3 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.rally-empty{height:100%;display:grid;place-content:center;justify-items:center;gap:7px;color:#737c87}.rally-empty strong{color:#313840;font-size:.8rem}.rally-empty span{font-size:.68rem}@keyframes shimmer{to{background-position:-200% 0}}@media(max-width:760px){.rally-browser{grid-template-rows:48px minmax(0,1fr)}.rally-columns{display:none}.rally-list li a{grid-template-columns:minmax(0,1fr) 20px;gap:10px;min-height:92px}.rally-primary{grid-template-columns:8px minmax(105px,.75fr) minmax(100px,1fr)}.rally-measure{display:none}.rally-analysis{grid-column:1;padding-left:20px;grid-template-columns:auto 1fr;align-items:baseline;gap:10px}.rally-list li svg{grid-column:2;grid-row:1/3}.rally-browser__sets{gap:18px}}@media(prefers-reduced-motion:reduce){.rally-list--loading i{animation:none}}
</style>
