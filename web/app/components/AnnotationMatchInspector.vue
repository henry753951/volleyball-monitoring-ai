<script setup lang="ts">
import { ArrowLeftRight, Check, CircleHelp, Pencil, Trophy } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { CoachDraft, CoachRally, CoachTeam } from '~/lib/coachDomain'
import { annotationOutcomeLabel } from '~/utils/annotationOutcome'
import { deriveCoachDisplayOrdinals, segmentStartCaptureTimeUs } from '~/utils/rallyDisplayOrder'

type SegmentListItem =
  | { kind: 'draft'; id: string; setNumber: number; ordinal: number; startCaptureTimeUs: bigint | null; draft: CoachDraft }
  | { kind: 'rally'; id: string; setNumber: number; ordinal: number; startCaptureTimeUs: bigint | null; rally: CoachRally }

const props = defineProps<{
  tab: 'match' | 'mapping' | 'analysis'
  mappingAvailable: boolean
  analysisAvailable: boolean
  matchId: string
  leftTeam: CoachTeam | null
  rightTeam: CoachTeam | null
  currentLeftTeam: CoachTeam | null
  currentRightTeam: CoachTeam | null
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
  canSwapSides: boolean
  formatRallyDuration: (rally: CoachRally) => string
  currentFrame: number
  setNumbers: number[]
  placementSaving?: boolean
  focusedTrackId?: number | null
  mappingRefreshToken?: number
  sideSwapPending?: boolean
  swapAffectsCurrentDraft?: boolean
}>()

const emit = defineEmits<{
  'update:tab': [tab: 'match' | 'mapping' | 'analysis']
  selectDraft: [id: string, captureTimeUs: string]
  selectRally: [rally: CoachRally]
  nextSet: [side: 'left' | 'right']
  swapSides: []
  swapRallySides: [rally: CoachRally]
  mappingChanged: []
  updatePlacement: [input: { rallyId: string; setNumber: number; ordinal: number }]
}>()
const total = computed(() => new Set([...props.drafts.map(item => item.id), ...props.rallies.map(item => item.id)]).size)
const placementOpen = ref(false)
const placementRallyId = ref<string | null>(null)
const placementSetNumber = ref(1)

function compareSegmentCaptureOrder(left: SegmentListItem, right: SegmentListItem): number {
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs !== null && left.startCaptureTimeUs !== right.startCaptureTimeUs) {
    return left.startCaptureTimeUs < right.startCaptureTimeUs ? -1 : 1
  }
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs === null) return -1
  if (left.startCaptureTimeUs === null && right.startCaptureTimeUs !== null) return 1
  return left.id.localeCompare(right.id)
}
const displayOrdinals = computed(() => deriveCoachDisplayOrdinals(props.drafts, props.rallies))
const segmentItems = computed<SegmentListItem[]>(() => {
  const itemsById = new Map<string, SegmentListItem>()
  for (const rally of props.rallies) itemsById.set(rally.id, {
    id: rally.id,
    kind: 'rally' as const,
    ordinal: displayOrdinals.value.get(rally.id) ?? 1,
    rally,
    setNumber: rally.display_set_number,
    startCaptureTimeUs: segmentStartCaptureTimeUs(rally.submission),
  })
  for (const draft of props.drafts) itemsById.set(draft.id, {
    draft,
    id: draft.id,
    kind: 'draft' as const,
    ordinal: displayOrdinals.value.get(draft.id) ?? 1,
    setNumber: draft.display_set_number,
    startCaptureTimeUs: segmentStartCaptureTimeUs(draft),
  })
  return [...itemsById.values()]
})
const placementOrdinal = computed(() => {
  const rallyId = placementRallyId.value
  if (!rallyId) return 1
  const ordered = segmentItems.value
    .filter(item => item.id === rallyId || item.setNumber === placementSetNumber.value)
    .map(item => item.id === rallyId ? { ...item, setNumber: placementSetNumber.value } : item)
    .sort(compareSegmentCaptureOrder)
  const index = ordered.findIndex(item => item.id === rallyId)
  return index < 0 ? 1 : index + 1
})
const groups = computed(() => {
  const items = [...segmentItems.value]
    .sort((left, right) => left.setNumber - right.setNumber || left.ordinal - right.ordinal || left.id.localeCompare(right.id))
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
  if (rally.processing_status === 'idle') return '待重新分析'
  if (rally.processing_status === 'failed') return '處理失敗'
  if (rally.processing_status === 'clip_queued' || rally.processing_status === 'clipping') return '剪切中'
  if (rally.processing_status === 'ai_queued') return '等待 Worker'
  if (rally.processing_status === 'ai_processing') return 'AI 分析中'
  if (rally.processing_status === 'artifact_ingesting') return '回傳結果中'
  return rally.submission.analysis?.status === 'completed' ? '分析完成' : '處理中'
}
function segmentTeams(item: SegmentListItem) {
  const source = item.kind === 'draft' ? item.draft : item.rally.submission
  const leftTeamId = source.left_team_id ?? props.leftTeamId
  const rightTeamId = source.right_team_id ?? props.rightTeamId
  return {
    left: props.teams.find(team => team.id === leftTeamId) ?? null,
    right: props.teams.find(team => team.id === rightTeamId) ?? null,
  }
}
function teamLabel(team: CoachTeam | null, fallback: string) {
  return team?.shortName || team?.name || fallback
}
function segmentOutcomeLabel(item: SegmentListItem) {
  const source = item.kind === 'draft' ? item.draft : item.rally.submission
  const sides = segmentTeams(item)
  return annotationOutcomeLabel({
    scoreResolution: source.score_resolution,
    scoringCourtSide: source.scoring_court_side,
    scoringTeamId: source.scoring_team_id,
    teams: props.teams,
    leftLabel: teamLabel(sides.left, '左隊'),
    rightLabel: teamLabel(sides.right, '右隊'),
  })
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
        <div class="court-side-row">
          <span>{{ swapAffectsCurrentDraft ? '目前片段左右' : '下一片段左右' }}</span>
          <div><b>左側 {{ teamLabel(currentLeftTeam, '隊伍') }}</b><ArrowLeftRight :size="13" aria-hidden="true" /><b>右側 {{ teamLabel(currentRightTeam, '隊伍') }}</b></div>
          <UiButton variant="ghost" size="sm" :disabled="!canSwapSides || sideSwapPending" @click="emit('swapSides')"><ArrowLeftRight :size="13" />{{ sideSwapPending ? '對調中' : '對調左右' }}</UiButton>
        </div>
        <div class="next-set-actions"><button type="button" :disabled="!canStartNextSet || !currentLeftTeam" @click="emit('nextSet', 'left')">{{ teamLabel(currentLeftTeam, '左隊') }} 勝局</button><button type="button" :disabled="!canStartNextSet || !currentRightTeam" @click="emit('nextSet', 'right')">{{ teamLabel(currentRightTeam, '右隊') }} 勝局</button></div>
      </div>
      <div class="segment-list-title"><span>片段</span><b>{{ total }}</b></div>
      <UiScrollArea class="segment-scroll"><div class="segment-list">
        <section v-for="group in groups" :key="group.number" class="set-group">
          <header class="set-divider"><span>第 {{ group.number }} 局</span><b>{{ group.leftScore }} : {{ group.rightScore }}</b></header>
          <div v-for="item in group.items" :key="item.id" class="segment-row" :class="{ active: selectedRallyId === item.id }">
            <button type="button" class="segment-main" @click="selectItem(item)">
              <span class="segment-heading">
                <strong><i :class="item.kind === 'draft' ? 'draft' : { failed: item.rally.processing_status === 'failed', processing: item.rally.processing_status !== 'failed' && item.rally.submission.analysis?.status !== 'completed', mapped: item.rally.submission.analysis?.identity_mapping_completed }" />回合 {{ item.ordinal }}</strong>
                <span v-if="item.kind === 'rally'" class="score-at-rally">{{ item.rally.left_score_after }} : {{ item.rally.right_score_after }}</span>
              </span>
              <small class="segment-side-order">左側 {{ teamLabel(segmentTeams(item).left, '隊伍') }} · 右側 {{ teamLabel(segmentTeams(item).right, '隊伍') }}</small>
              <span class="segment-meta">
                <small v-if="item.kind === 'draft'">{{ item.draft.annotation_status === 'ready' ? '待送出' : '標記中' }} · {{ item.draft.key_points.filter(point => point.marker_kind === 'contact').length }} 次擊球</small>
                <small v-else>{{ rallyStateLabel(item.rally) }} · {{ formatRallyDuration(item.rally) }} · {{ item.rally.submission.analysis?.contact_count ?? item.rally.submission.contact_count }} 次擊球</small>
                <span v-if="segmentOutcomeLabel(item)" class="outcome-badge" :class="{ unknown: segmentOutcomeLabel(item) === '得分未知' }"><CircleHelp v-if="segmentOutcomeLabel(item) === '得分未知'" :size="11" /><Trophy v-else :size="11" />{{ segmentOutcomeLabel(item) }}</span>
              </span>
            </button>
            <div class="segment-actions">
              <UiTooltip v-if="item.kind === 'rally'" :content="item.rally.submission.analysis?.status === 'completed' ? '對調此片段的左右隊伍' : '分析完成後可修正此片段左右'"><UiButton variant="ghost" size="icon-sm" class="row-action" aria-label="修正此片段的左右隊伍" :disabled="sideSwapPending || item.rally.submission.analysis?.status !== 'completed'" @click="emit('swapRallySides', item.rally)"><ArrowLeftRight :size="14" /></UiButton></UiTooltip>
              <UiTooltip content="編輯局與回合"><UiButton variant="ghost" size="icon-sm" class="row-action" aria-label="編輯局與回合" @click="openPlacement(item)"><Pencil :size="13" /></UiButton></UiTooltip>
            </div>
          </div>
        </section>
      </div></UiScrollArea>
    </div>
    <div v-else-if="tab === 'mapping'" class="mapping-inspector"><UiScrollArea class="mapping-scroll"><div class="mapping-scroll-content"><AnnotationIdentityPanel :match-id="matchId" :analysis-run-id="analysisRunId" :left-team-id="leftTeamId" :right-team-id="rightTeamId" :teams="teams" :mapping-completed="mappingCompleted" :current-frame="currentFrame" :focused-track-id="focusedTrackId" :refresh-token="mappingRefreshToken" @changed="emit('mappingChanged')" /></div></UiScrollArea></div>
    <div v-else class="analysis-inspector"><UiScrollArea class="mapping-scroll"><div class="mapping-scroll-content"><slot name="analysis" /></div></UiScrollArea></div>
    <UiAnimatedModal :open="placementOpen" title="調整片段所屬局" description="只儲存片段屬於哪一局；回合編號會依片段在時間軸的位置即時計算，不改動 PTS、送出內容或分析結果。" width="compact" @close="placementOpen = false">
      <form class="placement-form" @submit.prevent="savePlacement"><label><span>局數</span><select v-model.number="placementSetNumber"><option v-for="number in setNumbers" :key="number" :value="number">第 {{ number }} 局</option></select></label><output class="placement-order" aria-live="polite"><span>自動排序結果</span><strong>第 {{ placementOrdinal }} 回合</strong><small>顯示順序會隨時間軸位置自動更新。</small></output></form>
      <template #footer><UiButton variant="ghost" @click="placementOpen = false">取消</UiButton><UiButton :disabled="placementSaving" @click="savePlacement"><Check :size="14" />{{ placementSaving ? '儲存中' : '儲存' }}</UiButton></template>
    </UiAnimatedModal>
  </aside>
</template>

<style scoped>
.inspector{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--line);background:var(--surface-1);color:#f4f4f5;font-size:.77rem}.inspector button{color:inherit;cursor:pointer}.inspector button:disabled{cursor:not-allowed;opacity:.42}.mode-switch{flex:none;display:grid;grid-template-columns:1fr 1fr;margin:10px 10px 0;border:1px solid #27272a;border-radius:8px;overflow:hidden;background:#111113}.mode-switch button{min-height:32px;border:0;background:transparent;color:var(--muted);font-size:.68rem}.mode-switch button+button{border-left:1px solid #27272a}.mode-switch button.active{background:#27272a;color:#fafafa}.match-inspector,.mapping-inspector{min-height:0;flex:1}.match-inspector{display:grid;grid-template-rows:auto 34px minmax(0,1fr)}.score-summary{margin:0 10px;padding-top:10px;border-bottom:1px solid var(--line)}.set-scoreline{display:flex;align-items:center;justify-content:space-between;padding:2px 5px;color:#8f99a3;font-size:.58rem;font-weight:650}.set-scoreline b{color:#d7dce1;font-size:.6rem}.score-board{min-height:62px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto minmax(0,1fr);align-items:center;gap:7px;padding:0 8px;font-variant-numeric:tabular-nums}.score-board span{overflow:hidden;color:#aab2bb;font-size:.68rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.score-board span:last-child{text-align:right}.score-board b{font-size:1.55rem}.score-board i{color:#69737d;font-style:normal}.next-set-actions{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:5px;border-top:1px solid #282e34}.next-set-actions button{min-height:25px;padding:2px 6px;border:1px solid #343a40;border-radius:6px;background:#181b1f;color:#aeb6be;font-size:.58rem}.segment-list-title{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;color:#aab2bb;font-size:.65rem;font-weight:700}.segment-list-title b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;font-size:.6rem;text-align:center}.segment-scroll,.mapping-scroll{height:100%;min-height:0}.segment-scroll{border-top:1px solid #242a30}.segment-list{padding:0}.segment-row{width:100%;border:0;border-bottom:1px solid #242a30;border-radius:0;background:transparent;font-size:.66rem;transition:background-color 140ms ease}.segment-row:hover{background:#1b1f23}.segment-row.active{background:#272b30}.segment-row small{color:#77838e;font-size:.58rem;font-weight:500}.segment-row i{width:7px;height:7px;flex:none;border-radius:50%;background:#4295d8}.segment-row i.processing{background:#d5a331}.segment-row i.mapped{background:#36b878}.segment-row i.draft{background:#71717a}.mapping-inspector,.analysis-inspector{padding:10px;overflow:hidden}.mapping-scroll-content{padding-right:10px;padding-bottom:10px}
</style>
<style scoped>
.segment-row i.failed{background:#e16c74}
.mode-switch{grid-template-columns:repeat(3,1fr)}.mode-switch button{font-size:.65rem}.match-inspector,.mapping-inspector,.analysis-inspector{min-height:0;flex:1}.mapping-inspector,.analysis-inspector{overflow:hidden}.set-scoreline{display:block;padding:3px 5px}.score-board{min-height:64px}.score-team{min-width:0;display:grid;gap:4px}.score-team.left span{text-align:left}.score-team.right span{text-align:right}.score-team small{width:max-content;padding:3px 6px;border-radius:5px;background:#202328;color:#aeb5bc;font-size:.49rem;font-weight:650;font-variant-numeric:tabular-nums}.score-team.left small{justify-self:start}.score-team.right small{justify-self:end}
  .court-side-row{min-height:38px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:5px 6px;border-top:1px solid #282e34;color:#8f99a3;font-size:.56rem}.court-side-row>div{min-width:0;display:flex;align-items:center;justify-content:center;gap:5px}.court-side-row b{color:#d7dce1;font-size:.58rem;white-space:nowrap}.court-side-row button{min-height:27px!important;padding:3px 7px!important;font-size:.57rem}.set-divider{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border-bottom:1px solid #30363d;background:#171a1e;color:#b9c0c7;font-size:.61rem}.set-divider b{color:#f1f3f5;font-variant-numeric:tabular-nums}.segment-row{min-height:82px;display:grid;grid-template-columns:minmax(0,1fr) 36px;padding:0}.segment-main{min-width:0;min-height:81px;display:grid;align-content:center;gap:5px;padding:8px 8px 8px 10px;border:0;background:transparent;text-align:left}.segment-heading{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:8px}.segment-heading strong{min-width:0;display:flex;align-items:center;gap:6px;color:#f1f3f5;font-size:.68rem}.segment-row small{color:#929ba4;font-size:.6rem}.segment-side-order{color:#c6ccd2!important;white-space:normal;overflow-wrap:anywhere}.segment-meta{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:6px}.segment-meta>small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.score-at-rally{color:#d5dbe1;font-size:.65rem;font-weight:700;font-variant-numeric:tabular-nums}.outcome-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 5px;border:1px solid #4a525a;border-radius:5px;background:#22272c;color:#f1f3f5;font-size:.57rem;font-weight:700;white-space:nowrap}.outcome-badge.unknown{border-style:dashed;color:#c5cbd1}.segment-actions{align-self:stretch;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-left:1px solid #242a30}.row-action{color:#aab2bb!important}.placement-form{display:grid;gap:12px;padding:18px}.placement-form label{display:grid;gap:6px;color:#a8b0b8;font-size:.64rem}.placement-form select{height:36px;padding:0 10px;border:1px solid #3a4148;border-radius:7px;outline:0;background:#171a1e;color:#f4f4f5;font-size:.72rem}.placement-form select:focus{border-color:#8b949e;box-shadow:0 0 0 2px rgb(139 148 158 / 18%)}.placement-order{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 12px;padding:11px 12px;border:1px solid #30363d;border-radius:8px;background:#14171a;color:#a8b0b8;text-align:left}.placement-order>span{font-size:.62rem}.placement-order>strong{color:#f4f4f5;font-size:.76rem}.placement-order>small{grid-column:1/-1;color:#858f99;font-size:.6rem;line-height:1.45}
</style>
