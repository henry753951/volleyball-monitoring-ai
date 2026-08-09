<script setup lang="ts">
import { Check, Pencil, Trophy } from 'lucide-vue-next'
import type { CoachDraft, CoachRally, CoachTeam } from '~/lib/coachDomain'

type SegmentListItem =
  | { kind: 'draft'; id: string; setNumber: number; ordinal: number; draft: CoachDraft }
  | { kind: 'rally'; id: string; setNumber: number; ordinal: number; rally: CoachRally }

const props = defineProps<{
  tab: 'match' | 'mapping' | 'analysis'
  mappingAvailable: boolean
  analysisAvailable: boolean
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
  currentFrame: number
  setNumbers: number[]
  placementSaving?: boolean
  focusedTrackId?: number | null
  mappingRefreshToken?: number
}>()

const emit = defineEmits<{
  'update:tab': [tab: 'match' | 'mapping' | 'analysis']
  selectDraft: [id: string, captureTimeUs: string]
  selectRally: [rally: CoachRally]
  nextSet: [side: 'left' | 'right']
  mappingChanged: []
  updatePlacement: [input: { rallyId: string; setNumber: number; ordinal: number }]
}>()
const total = computed(() => new Set([...props.drafts.map(item => item.id), ...props.rallies.map(item => item.id)]).size)
const placementOpen = ref(false)
const placementRallyId = ref<string | null>(null)
const placementSetNumber = ref(1)
const placementOrdinal = ref(1)
const groups = computed(() => {
  const items: SegmentListItem[] = [
    ...props.drafts.map(draft => ({ draft, id: draft.id, kind: 'draft' as const, ordinal: draft.display_ordinal, setNumber: draft.display_set_number })),
    ...props.rallies.map(rally => ({ id: rally.id, kind: 'rally' as const, ordinal: rally.display_ordinal, rally, setNumber: rally.display_set_number })),
  ].sort((left, right) => left.setNumber - right.setNumber || left.ordinal - right.ordinal || left.id.localeCompare(right.id))
  const grouped = new Map<number, SegmentListItem[]>()
  for (const item of items) grouped.set(item.setNumber, [...(grouped.get(item.setNumber) ?? []), item])
  return [...grouped.entries()].map(([number, setItems]) => {
    const completed = [...setItems].reverse().find((item): item is Extract<SegmentListItem, { kind: 'rally' }> => item.kind === 'rally')
    return { items: setItems, leftScore: completed?.rally.left_score_after ?? 0, number, rightScore: completed?.rally.right_score_after ?? 0 }
  })
})

function openPlacement(item: SegmentListItem) {
  placementRallyId.value = item.id
  placementSetNumber.value = item.setNumber
  placementOrdinal.value = item.ordinal
  placementOpen.value = true
}
function savePlacement() {
  if (!placementRallyId.value || props.placementSaving) return
  emit('updatePlacement', { ordinal: placementOrdinal.value, rallyId: placementRallyId.value, setNumber: placementSetNumber.value })
}
function selectItem(item: SegmentListItem) {
  if (item.kind === 'draft') emit('selectDraft', item.id, item.draft.key_points[0]?.capture_time_us ?? '0')
  else emit('selectRally', item.rally)
}
function rallyStateLabel(rally: CoachRally) {
  if (rally.processing_status === 'failed') return '處理失敗'
  if (rally.processing_status === 'clip_queued' || rally.processing_status === 'clipping') return '剪切中'
  if (rally.processing_status === 'ai_queued') return '等待 Worker'
  if (rally.processing_status === 'ai_processing') return 'AI 分析中'
  if (rally.processing_status === 'artifact_ingesting') return '回傳結果中'
  return rally.submission.analysis?.status === 'completed' ? '分析完成' : '處理中'
}
defineExpose({ closePlacement: () => { placementOpen.value = false } })
</script>

<template>
  <aside class="inspector">
    <div class="mode-switch">
      <button type="button" :class="{ active: tab === 'match' }" @click="emit('update:tab', 'match')">場次資訊</button>
      <button type="button" :class="{ active: tab === 'mapping' }" :disabled="!mappingAvailable" :title="mappingAvailable ? '球員指派' : '選取分析完成的片段後可使用'" @click="emit('update:tab', 'mapping')">球員指派</button>
      <button type="button" :class="{ active: tab === 'analysis' }" :disabled="!analysisAvailable" :title="analysisAvailable ? '分析結果' : '選取分析完成的片段後可使用'" @click="emit('update:tab', 'analysis')">分析結果</button>
    </div>
    <div v-if="tab === 'match'" class="match-inspector">
      <div class="score-summary">
        <div class="set-scoreline"><span>第 {{ setNumber }} 局 · 回合 {{ rallyOrdinal }}</span></div>
        <div class="score-board"><div class="score-team left"><span>{{ leftTeam?.shortName || leftTeam?.name || '左隊' }}</span><small :aria-label="`左隊勝局 ${leftSetWins}`">{{ leftSetWins }}</small></div><b>{{ leftScore }}</b><i>:</i><b>{{ rightScore }}</b><div class="score-team right"><span>{{ rightTeam?.shortName || rightTeam?.name || '右隊' }}</span><small :aria-label="`右隊勝局 ${rightSetWins}`">{{ rightSetWins }}</small></div></div>
        <div class="next-set-actions"><button type="button" :disabled="!canStartNextSet || !leftTeamId" @click="emit('nextSet', 'left')">{{ leftTeam?.shortName ?? '左隊' }} 勝局</button><button type="button" :disabled="!canStartNextSet || !rightTeamId" @click="emit('nextSet', 'right')">{{ rightTeam?.shortName ?? '右隊' }} 勝局</button></div>
      </div>
      <div class="segment-list-title"><span>片段</span><b>{{ total }}</b></div>
      <UiScrollArea class="segment-scroll"><div class="segment-list">
        <section v-for="group in groups" :key="group.number" class="set-group">
          <header class="set-divider"><span>第 {{ group.number }} 局</span><b>{{ group.leftScore }} : {{ group.rightScore }}</b></header>
          <div v-for="item in group.items" :key="item.id" class="segment-row" :class="{ active: selectedRallyId === item.id }">
            <button type="button" class="segment-main" @click="selectItem(item)">
              <div><span>回合 {{ item.ordinal }}</span><small v-if="item.kind === 'draft'">{{ item.draft.annotation_status === 'ready' ? '待送出' : '標記中' }} · {{ item.draft.key_points.filter(point => point.marker_kind === 'contact').length }} 次擊球</small><small v-else>{{ rallyStateLabel(item.rally) }} · {{ formatRallyDuration(item.rally) }} · {{ item.rally.submission.contact_count }} 次擊球</small></div>
              <span v-if="item.kind === 'rally'" class="score-at-rally">{{ item.rally.left_score_after }} : {{ item.rally.right_score_after }}</span>
              <span v-if="item.kind === 'rally' && item.rally.winner_side" class="winner-badge"><Trophy :size="11" />{{ item.rally.winner_side === 'left' ? leftTeam?.shortName ?? '左隊' : rightTeam?.shortName ?? '右隊' }}</span>
              <i :class="item.kind === 'draft' ? 'draft' : { failed: item.rally.processing_status === 'failed', processing: item.rally.processing_status !== 'failed' && item.rally.submission.analysis?.status !== 'completed', mapped: item.rally.submission.analysis?.identity_mapping_completed }" />
            </button>
            <UiTooltip content="編輯局與回合"><UiButton variant="ghost" size="icon-sm" class="placement-edit" aria-label="編輯局與回合" @click="openPlacement(item)"><Pencil :size="13" /></UiButton></UiTooltip>
          </div>
        </section>
      </div></UiScrollArea>
    </div>
    <div v-else-if="tab === 'mapping'" class="mapping-inspector"><UiScrollArea class="mapping-scroll"><div class="mapping-scroll-content"><AnnotationIdentityPanel :match-id="matchId" :analysis-run-id="analysisRunId" :left-team-id="leftTeamId" :right-team-id="rightTeamId" :teams="teams" :mapping-completed="mappingCompleted" :current-frame="currentFrame" :focused-track-id="focusedTrackId" :refresh-token="mappingRefreshToken" @changed="emit('mappingChanged')" /></div></UiScrollArea></div>
    <div v-else class="analysis-inspector"><UiScrollArea class="mapping-scroll"><div class="mapping-scroll-content"><slot name="analysis" /></div></UiScrollArea></div>
    <UiAnimatedModal :open="placementOpen" title="調整片段位置" description="只變更清單中的局與回合，不改動送出內容、PTS 或分析結果。" width="compact" @close="placementOpen = false">
      <form class="placement-form" @submit.prevent="savePlacement"><label><span>局數</span><select v-model.number="placementSetNumber"><option v-for="number in setNumbers" :key="number" :value="number">第 {{ number }} 局</option></select></label><label><span>回合</span><input v-model.number="placementOrdinal" type="number" min="1" max="999"></label></form>
      <template #footer><UiButton variant="ghost" @click="placementOpen = false">取消</UiButton><UiButton :disabled="placementSaving" @click="savePlacement"><Check :size="14" />{{ placementSaving ? '儲存中' : '儲存' }}</UiButton></template>
    </UiAnimatedModal>
  </aside>
</template>

<style scoped>
.inspector{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;padding:10px;overflow:hidden;border-left:1px solid var(--line);background:var(--surface-1);color:#f4f4f5;font-size:.77rem}.inspector button{color:inherit;cursor:pointer}.inspector button:disabled{cursor:not-allowed;opacity:.42}.mode-switch{flex:none;display:grid;grid-template-columns:1fr 1fr;margin-bottom:10px;border:1px solid #27272a;border-radius:8px;overflow:hidden;background:#111113}.mode-switch button{min-height:32px;border:0;background:transparent;color:var(--muted);font-size:.68rem}.mode-switch button+button{border-left:1px solid #27272a}.mode-switch button.active{background:#27272a;color:#fafafa}.match-inspector,.mapping-inspector{min-height:0;flex:1}.match-inspector{display:grid;grid-template-rows:auto 30px minmax(0,1fr)}.score-summary{padding-top:5px;border-bottom:1px solid var(--line)}.set-scoreline{display:flex;align-items:center;justify-content:space-between;padding:2px 5px;color:#8f99a3;font-size:.58rem;font-weight:650}.set-scoreline b{color:#d7dce1;font-size:.6rem}.score-board{min-height:62px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto minmax(0,1fr);align-items:center;gap:7px;padding:0 8px;font-variant-numeric:tabular-nums}.score-board span{overflow:hidden;color:#aab2bb;font-size:.68rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.score-board span:last-child{text-align:right}.score-board b{font-size:1.55rem}.score-board i{color:#69737d;font-style:normal}.next-set-actions{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:5px;border-top:1px solid #282e34}.next-set-actions button{min-height:25px;padding:2px 6px;border:1px solid #343a40;border-radius:6px;background:#181b1f;color:#aeb6be;font-size:.58rem}.segment-list-title{height:30px;display:flex;align-items:center;justify-content:space-between;color:#aab2bb;font-size:.65rem;font-weight:700}.segment-list-title b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;font-size:.6rem;text-align:center}.segment-scroll,.mapping-scroll{height:100%;min-height:0}.segment-list{padding-right:0}.segment-row{width:100%;min-height:49px;display:flex;align-items:center;justify-content:space-between;padding:0 4px;border:0;border-bottom:1px solid #242a30;border-radius:0;background:transparent;font-size:.66rem}.segment-row:hover,.segment-row.active{background:#27272a}.segment-row>div{min-width:0;display:grid;gap:3px;text-align:left}.segment-row small{color:#77838e;font-size:.58rem;font-weight:500}.segment-row i{width:8px;height:8px;border-radius:50%;background:#4295d8}.segment-row i.processing{background:#d5a331}.segment-row i.mapped{background:#36b878}.segment-row i.draft{background:#71717a}.mapping-inspector{overflow:hidden}.mapping-scroll-content{padding-right:10px;padding-bottom:10px}
</style>
<style scoped>
.segment-row i.failed{background:#e16c74}
.mode-switch{grid-template-columns:repeat(3,1fr)}.mode-switch button{font-size:.65rem}.match-inspector,.mapping-inspector,.analysis-inspector{min-height:0;flex:1}.mapping-inspector,.analysis-inspector{overflow:hidden}.set-scoreline{display:block;padding:3px 5px}.score-board{min-height:64px}.score-team{min-width:0;display:grid;gap:4px}.score-team.left span{text-align:left}.score-team.right span{text-align:right}.score-team small{width:max-content;padding:3px 6px;border-radius:5px;background:#202328;color:#aeb5bc;font-size:.49rem;font-weight:650;font-variant-numeric:tabular-nums}.score-team.left small{justify-self:start}.score-team.right small{justify-self:end}
.set-divider{height:29px;display:flex;align-items:center;justify-content:space-between;padding:0 8px;border-bottom:1px solid #30363d;background:#171a1e;color:#b9c0c7;font-size:.61rem}.set-divider b{color:#f1f3f5;font-variant-numeric:tabular-nums}.segment-row{min-height:52px;display:grid;grid-template-columns:minmax(0,1fr) 30px;padding:0}.segment-main{min-width:0;min-height:51px;display:grid;grid-template-columns:minmax(0,1fr) auto auto 8px;align-items:center;gap:7px;padding:0 4px 0 8px;border:0;background:transparent;text-align:left}.segment-main>div{min-width:0;display:grid;gap:3px}.segment-row small{color:#929ba4}.score-at-rally{color:#c0c7ce;font-size:.6rem;font-variant-numeric:tabular-nums}.winner-badge{display:inline-flex;align-items:center;gap:3px;padding:3px 5px;border-radius:5px;background:#2b2f34;color:#f1f3f5;font-size:.55rem;font-weight:700}.placement-edit{opacity:0;color:#aab2bb!important}.segment-row:hover .placement-edit,.segment-row.active .placement-edit,.placement-edit:focus-visible{opacity:1}.placement-form{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px}.placement-form label{display:grid;gap:6px;color:#a8b0b8;font-size:.64rem}.placement-form input,.placement-form select{height:36px;padding:0 10px;border:1px solid #3a4148;border-radius:7px;outline:0;background:#171a1e;color:#f4f4f5;font-size:.72rem}.placement-form input:focus,.placement-form select:focus{border-color:#8b949e;box-shadow:0 0 0 2px rgb(139 148 158 / 18%)}
</style>
