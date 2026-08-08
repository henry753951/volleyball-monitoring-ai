<script setup lang="ts">
import type { CoachDraft, CoachRally, CoachTeam } from '~/lib/coachDomain'

const props = defineProps<{
  tab: 'match' | 'mapping'
  mappingAvailable: boolean
  matchId: string
  leftTeam: CoachTeam | null
  rightTeam: CoachTeam | null
  leftScore: number
  rightScore: number
  leftSetWins: number
  rightSetWins: number
  setNumber: number
  rallyOrdinal: number | string
  leftTeamId: string | null
  rightTeamId: string | null
  drafts: CoachDraft[]
  rallies: CoachRally[]
  selectedRallyId: string | null
  analysisRunId: string | null
  mappingCompleted: boolean
  teams: CoachTeam[]
  canStartNextSet: boolean
  formatRallyDuration: (rally: CoachRally) => string
}>()

const emit = defineEmits<{
  'update:tab': [tab: 'match' | 'mapping']
  selectDraft: [id: string, captureTimeUs: string]
  selectRally: [rally: CoachRally]
  nextSet: [side: 'left' | 'right']
  mappingChanged: []
}>()
const total = computed(() => new Set([...props.drafts.map(item => item.id), ...props.rallies.map(item => item.id)]).size)
</script>

<template>
  <aside class="inspector">
    <div class="mode-switch">
      <button type="button" :class="{ active: tab === 'match' }" @click="emit('update:tab', 'match')">場次資訊</button>
      <button type="button" :class="{ active: tab === 'mapping' }" :disabled="!mappingAvailable" :title="mappingAvailable ? '球員指派' : '選取分析完成的片段後可使用'" @click="emit('update:tab', 'mapping')">球員指派</button>
    </div>
    <div v-if="tab === 'match'" class="match-inspector">
      <div class="score-summary">
        <div class="set-scoreline"><span>第 {{ setNumber }} 局 · 回合 {{ rallyOrdinal }}</span><b>局數 {{ leftSetWins }} : {{ rightSetWins }}</b></div>
        <div class="score-board"><span>{{ leftTeam?.shortName || leftTeam?.name || '左隊' }}</span><b>{{ leftScore }}</b><i>:</i><b>{{ rightScore }}</b><span>{{ rightTeam?.shortName || rightTeam?.name || '右隊' }}</span></div>
        <div class="next-set-actions"><button type="button" :disabled="!canStartNextSet || !leftTeamId" @click="emit('nextSet', 'left')">{{ leftTeam?.shortName ?? '左隊' }} 勝局</button><button type="button" :disabled="!canStartNextSet || !rightTeamId" @click="emit('nextSet', 'right')">{{ rightTeam?.shortName ?? '右隊' }} 勝局</button></div>
      </div>
      <div class="segment-list-title"><span>片段</span><b>{{ total }}</b></div>
      <UiScrollArea class="segment-scroll"><div class="segment-list">
        <button v-for="draft in drafts" :key="draft.id" type="button" class="segment-row" :class="{ active: selectedRallyId === draft.id }" @click="emit('selectDraft', draft.id, draft.key_points[0]?.capture_time_us ?? '0')"><div><span>第 {{ draft.set_number }} 局 · 回合 {{ draft.ordinal }}</span><small>{{ draft.annotation_status === 'ready' ? '待送出' : '標記中' }} · {{ draft.key_points.filter(point => point.marker_kind === 'contact').length }} 次擊球</small></div><i class="draft" /></button>
        <button v-for="rally in rallies" :key="rally.id" type="button" class="segment-row" :class="{ active: selectedRallyId === rally.id }" @click="emit('selectRally', rally)"><div><span>第 {{ rally.set_number }} 局 · 回合 {{ rally.ordinal }}</span><small>{{ formatRallyDuration(rally) }} · {{ rally.submission.contact_count }} 次擊球</small></div><i :class="{ processing: rally.submission.analysis?.status !== 'completed', mapped: rally.submission.analysis?.identity_mapping_completed }" /></button>
      </div></UiScrollArea>
    </div>
    <div v-else class="mapping-inspector"><UiScrollArea class="mapping-scroll"><div class="mapping-scroll-content"><AnnotationIdentityPanel :match-id="matchId" :analysis-run-id="analysisRunId" :left-team-id="leftTeamId" :right-team-id="rightTeamId" :teams="teams" :mapping-completed="mappingCompleted" @changed="emit('mappingChanged')" /></div></UiScrollArea></div>
  </aside>
</template>

<style scoped>
.inspector{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;padding:10px;overflow:hidden;border-left:1px solid var(--line);background:var(--surface-1);color:#f4f4f5;font-size:.77rem}.inspector button{color:inherit;cursor:pointer}.inspector button:disabled{cursor:not-allowed;opacity:.42}.mode-switch{flex:none;display:grid;grid-template-columns:1fr 1fr;margin-bottom:10px;border:1px solid #27272a;border-radius:8px;overflow:hidden;background:#111113}.mode-switch button{min-height:32px;border:0;background:transparent;color:var(--muted);font-size:.68rem}.mode-switch button+button{border-left:1px solid #27272a}.mode-switch button.active{background:#27272a;color:#fafafa}.match-inspector,.mapping-inspector{min-height:0;flex:1}.match-inspector{display:grid;grid-template-rows:auto 30px minmax(0,1fr)}.score-summary{padding-top:5px;border-bottom:1px solid var(--line)}.set-scoreline{display:flex;align-items:center;justify-content:space-between;padding:2px 5px;color:#8f99a3;font-size:.58rem;font-weight:650}.set-scoreline b{color:#d7dce1;font-size:.6rem}.score-board{min-height:62px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto minmax(0,1fr);align-items:center;gap:7px;padding:0 8px;font-variant-numeric:tabular-nums}.score-board span{overflow:hidden;color:#aab2bb;font-size:.68rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.score-board span:last-child{text-align:right}.score-board b{font-size:1.55rem}.score-board i{color:#69737d;font-style:normal}.next-set-actions{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:5px;border-top:1px solid #282e34}.next-set-actions button{min-height:25px;padding:2px 6px;border:1px solid #343a40;border-radius:6px;background:#181b1f;color:#aeb6be;font-size:.58rem}.segment-list-title{height:30px;display:flex;align-items:center;justify-content:space-between;color:#aab2bb;font-size:.65rem;font-weight:700}.segment-list-title b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;font-size:.6rem;text-align:center}.segment-scroll,.mapping-scroll{height:100%;min-height:0}.segment-list{padding-right:0}.segment-row{width:100%;min-height:49px;display:flex;align-items:center;justify-content:space-between;padding:0 4px;border:0;border-bottom:1px solid #242a30;border-radius:0;background:transparent;font-size:.66rem}.segment-row:hover,.segment-row.active{background:#27272a}.segment-row>div{min-width:0;display:grid;gap:3px;text-align:left}.segment-row small{color:#77838e;font-size:.58rem;font-weight:500}.segment-row i{width:8px;height:8px;border-radius:50%;background:#4295d8}.segment-row i.processing{background:#d5a331}.segment-row i.mapped{background:#36b878}.segment-row i.draft{background:#71717a}.mapping-inspector{overflow:hidden}.mapping-scroll-content{padding-right:10px;padding-bottom:10px}
</style>
