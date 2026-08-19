<script setup lang="ts">
import { ArrowLeftRight, Check, CircleHelp, Pencil, Trash2, Trophy } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { CoachDraft, CoachRally, CoachTeam } from '~/lib/coachDomain'
import { annotationOutcomeLabel } from '~/utils/annotationOutcome'
import { deriveCoachDisplayOrdinals, segmentStartCaptureTimeUs } from '~/utils/rallyDisplayOrder'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'

type SegmentListItem =
  | {
      kind: 'draft'
      id: string
      setNumber: number
      ordinal: number
      startCaptureTimeUs: bigint | null
      draft: CoachDraft
    }
  | {
      kind: 'rally'
      id: string
      setNumber: number
      ordinal: number
      startCaptureTimeUs: bigint | null
      rally: CoachRally
    }

const props = defineProps<{
  tab: 'match' | 'mapping' | 'analysis'
  mappingAvailable: boolean
  analysisAvailable: boolean
  matchId: string
  leftTeam: CoachTeam | null
  rightTeam: CoachTeam | null
  currentLeftTeam: CoachTeam | null
  currentRightTeam: CoachTeam | null
  leftSetWins: number
  rightSetWins: number
  setNumber: number
  setResults?: Array<{
    set_number: number
    winning_team_id: string | null
    status?: string
  }>
  rallyOrdinal: number | string
  leftTeamId: string | null
  rightTeamId: string | null
  contextRallyId: string | null
  drafts: CoachDraft[]
  rallies: CoachRally[]
  selectedRallyId: string | null
  displayedRallyId: string | null
  displayedOutcomeLabel: string | null
  displayedOutcomeSide: 'left' | 'right' | null
  analysisRunId: string | null
  teams: CoachTeam[]
  formatRallyDuration: (rally: CoachRally) => string
  setNumbers: number[]
}>()

const emit = defineEmits<{
  'update:tab': [tab: 'match' | 'mapping' | 'analysis']
  'select-track': [selection: { trackId: number; rallyId: string; firstFrameIndex: string }]
}>()
const workstation = useAnnotationWorkstationService()
if (!workstation.segments || !workstation.timeline)
  throw new Error('Match inspector requires segment and timeline workstation services')
const segments = workstation.segments
const timeline = workstation.timeline
const placementSaving = segments.placementSaving
const sideSwapPending = segments.sideSwapPending
const sideSwapTarget = segments.sideSwapTarget
const nextSetState = workstation.actions.state('segment.start-next-set')
const reopenLastSetState = workstation.actions.state('segment.reopen-last-set')
const swapCurrentSidesState = workstation.actions.state('segment.swap-current-sides')
const swapRallySidesState = workstation.actions.state('segment.swap-rally-sides')
const total = computed(
  () => new Set([...props.drafts.map(item => item.id), ...props.rallies.map(item => item.id)]).size,
)
const correctionDraftIds = computed(
  () => new Set(props.drafts.filter(draft => draft.active_submission_id).map(draft => draft.id)),
)
const resettableRallies = computed(() =>
  props.rallies.filter(
    rally =>
      rally.submission.analysis?.status === 'completed' && !correctionDraftIds.value.has(rally.id),
  ),
)
const placementOpen = ref(false)
const placementRallyId = ref<string | null>(null)
const placementSetNumber = ref(1)

function compareSegmentCaptureOrder(left: SegmentListItem, right: SegmentListItem): number {
  if (
    left.startCaptureTimeUs !== null &&
    right.startCaptureTimeUs !== null &&
    left.startCaptureTimeUs !== right.startCaptureTimeUs
  ) {
    return left.startCaptureTimeUs < right.startCaptureTimeUs ? -1 : 1
  }
  if (left.startCaptureTimeUs !== null && right.startCaptureTimeUs === null) return -1
  if (left.startCaptureTimeUs === null && right.startCaptureTimeUs !== null) return 1
  return left.id.localeCompare(right.id)
}
const displayOrdinals = computed(() => deriveCoachDisplayOrdinals(props.drafts, props.rallies))
const segmentItems = computed<SegmentListItem[]>(() => {
  const itemsById = new Map<string, SegmentListItem>()
  for (const rally of props.rallies)
    itemsById.set(rally.id, {
      id: rally.id,
      kind: 'rally' as const,
      ordinal: displayOrdinals.value.get(rally.id) ?? 1,
      rally,
      setNumber: rally.display_set_number,
      startCaptureTimeUs: segmentStartCaptureTimeUs(rally.submission),
    })
  for (const draft of props.drafts)
    itemsById.set(draft.id, {
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
    .map(item => (item.id === rallyId ? { ...item, setNumber: placementSetNumber.value } : item))
    .sort(compareSegmentCaptureOrder)
  const index = ordered.findIndex(item => item.id === rallyId)
  return index < 0 ? 1 : index + 1
})
const sortedSegmentItems = computed(() =>
  [...segmentItems.value].sort(
    (left, right) =>
      left.setNumber - right.setNumber ||
      left.ordinal - right.ordinal ||
      left.id.localeCompare(right.id),
  ),
)
function segmentSideIds(item: SegmentListItem) {
  const source = item.kind === 'draft' ? item.draft : item.rally.submission
  return {
    left: source.left_team_id ?? props.leftTeamId,
    right: source.right_team_id ?? props.rightTeamId,
  }
}
const sideSwapBoundaryIds = computed(() => {
  const previousSideOrderBySet = new Map<number, string>()
  const boundaryIds = new Set<string>()
  for (const item of sortedSegmentItems.value) {
    const sides = segmentSideIds(item)
    if (!sides.left || !sides.right) continue
    const sideOrder = `${sides.left}:${sides.right}`
    const previousSideOrder = previousSideOrderBySet.get(item.setNumber)
    if (previousSideOrder && previousSideOrder !== sideOrder) boundaryIds.add(item.id)
    previousSideOrderBySet.set(item.setNumber, sideOrder)
  }
  return boundaryIds
})
function segmentScoringTeamId(item: SegmentListItem) {
  const sides = segmentSideIds(item)
  if (!sides.left || !sides.right) return null
  if (item.id === props.displayedRallyId && props.displayedOutcomeSide) {
    return props.displayedOutcomeSide === 'left' ? sides.left : sides.right
  }
  const source = item.kind === 'draft' ? item.draft : item.rally.submission
  if (source.score_resolution !== 'resolved') return null
  if (source.scoring_team_id === sides.left || source.scoring_team_id === sides.right)
    return source.scoring_team_id
  if (source.scoring_court_side === 'left') return sides.left
  if (source.scoring_court_side === 'right') return sides.right
  return null
}
const segmentScores = computed(() => {
  const teamScoresBySet = new Map<number, Map<string, number>>()
  const scores = new Map<string, { left: number; right: number }>()
  for (const item of sortedSegmentItems.value) {
    const sides = segmentSideIds(item)
    const teamScores = teamScoresBySet.get(item.setNumber) ?? new Map<string, number>()
    const scoringTeamId = segmentScoringTeamId(item)
    if (scoringTeamId) teamScores.set(scoringTeamId, (teamScores.get(scoringTeamId) ?? 0) + 1)
    teamScoresBySet.set(item.setNumber, teamScores)
    scores.set(item.id, {
      left: sides.left ? (teamScores.get(sides.left) ?? 0) : 0,
      right: sides.right ? (teamScores.get(sides.right) ?? 0) : 0,
    })
  }
  return scores
})
const displayedScore = computed(() => {
  const contextScore = props.contextRallyId ? segmentScores.value.get(props.contextRallyId) : null
  if (contextScore) return contextScore
  const selectedScore = props.selectedRallyId
    ? segmentScores.value.get(props.selectedRallyId)
    : null
  if (selectedScore) return selectedScore
  const currentSetItems = sortedSegmentItems.value.filter(
    item => item.setNumber === props.setNumber,
  )
  return (
    (currentSetItems.length ? segmentScores.value.get(currentSetItems.at(-1)?.id ?? '') : null) ?? {
      left: 0,
      right: 0,
    }
  )
})
const actionLeftTeam = computed(
  () =>
    props.teams.find(team => team.id === sideSwapTarget?.value?.expectedLeftTeamId) ??
    props.currentLeftTeam,
)
const actionRightTeam = computed(
  () =>
    props.teams.find(team => team.id === sideSwapTarget?.value?.expectedRightTeamId) ??
    props.currentRightTeam,
)
const winningTeamBySet = computed(
  () =>
    new Map(
      (props.setResults ?? [])
        .filter(result => result.status === undefined || result.status.toLowerCase() === 'finished')
        .map(result => [result.set_number, result.winning_team_id]),
    ),
)
function winningTeamLabel(setNumber: number) {
  const winnerId = winningTeamBySet.value.get(setNumber)
  if (!winnerId) return null
  return teamLabel(props.teams.find(team => team.id === winnerId) ?? null, '隊伍')
}
const latestWinnerSetNumber = computed(() => {
  const setNumbers = [...winningTeamBySet.value.entries()]
    .filter(([, winningTeamId]) => Boolean(winningTeamId))
    .map(([setNumber]) => setNumber)
  return setNumbers.length ? Math.max(...setNumbers) : null
})
const groups = computed(() => {
  const grouped = new Map<number, SegmentListItem[]>()
  for (const item of sortedSegmentItems.value)
    grouped.set(item.setNumber, [...(grouped.get(item.setNumber) ?? []), item])
  return [...grouped.entries()].map(([number, setItems]) => {
    const latestScore = segmentScores.value.get(setItems.at(-1)?.id ?? '') ?? {
      left: 0,
      right: 0,
    }
    return {
      items: setItems,
      leftScore: latestScore.left,
      number,
      rightScore: latestScore.right,
    }
  })
})

function openPlacement(item: SegmentListItem) {
  placementRallyId.value = item.id
  placementSetNumber.value = item.setNumber
  placementOpen.value = true
}
function savePlacement() {
  if (!placementRallyId.value || placementSaving.value) return
  void workstation.actions.execute('segment.update-placement', {
    ordinal: placementOrdinal.value,
    rallyId: placementRallyId.value,
    setNumber: placementSetNumber.value,
  })
}
function selectItem(item: SegmentListItem) {
  if (item.kind === 'draft')
    void timeline.selectHistorical(item.id, item.draft.key_points[0]?.capture_time_us ?? '0')
  else timeline.selectRally(item.rally)
}
function rallyStateLabel(rally: CoachRally) {
  if (rally.processing_status === 'idle') return '待重新分析'
  if (rally.processing_status === 'failed') return '處理失敗'
  if (rally.processing_status === 'clip_queued' || rally.processing_status === 'clipping')
    return '剪切中'
  if (rally.processing_status === 'ai_queued') return '等待 Worker'
  if (rally.processing_status === 'ai_processing') return 'AI 分析中'
  if (rally.processing_status === 'artifact_ingesting') return '回傳結果中'
  return rally.submission.analysis?.status === 'completed' ? '分析完成' : '處理中'
}
function segmentTeams(item: SegmentListItem) {
  const { left: leftTeamId, right: rightTeamId } = segmentSideIds(item)
  return {
    left: props.teams.find(team => team.id === leftTeamId) ?? null,
    right: props.teams.find(team => team.id === rightTeamId) ?? null,
  }
}
function teamLabel(team: CoachTeam | null, fallback: string) {
  return team?.shortName || team?.name || fallback
}
function segmentOutcomeLabel(item: SegmentListItem) {
  if (item.id === props.displayedRallyId) return props.displayedOutcomeLabel
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
defineExpose({
  closePlacement: () => {
    placementOpen.value = false
  },
})
</script>

<template>
  <aside class="inspector">
    <div class="mode-switch">
      <button
        type="button"
        :class="{ active: tab === 'match' }"
        @click="emit('update:tab', 'match')"
      >
        場次資訊
      </button>
      <button
        type="button"
        :class="{ active: tab === 'mapping' }"
        :disabled="!mappingAvailable"
        :title="mappingAvailable ? '球員指派' : '選取分析完成的片段後可使用'"
        @click="emit('update:tab', 'mapping')"
      >
        球員指派
      </button>
      <button
        type="button"
        :class="{ active: tab === 'analysis' }"
        :disabled="!analysisAvailable"
        :title="analysisAvailable ? '分析結果' : '選取分析完成的片段後可使用'"
        @click="emit('update:tab', 'analysis')"
      >
        分析結果
      </button>
    </div>
    <div v-if="tab === 'match'" class="match-inspector">
      <div class="score-summary">
        <div class="set-scoreline">
          <span>第 {{ setNumber }} 局 · 回合 {{ rallyOrdinal }}</span>
        </div>
        <div class="score-board">
          <div class="score-team left">
            <span>{{ leftTeam?.shortName || leftTeam?.name || '左隊' }}</span
            ><small :aria-label="`左隊勝局 ${leftSetWins}`">{{ leftSetWins }}</small>
          </div>
          <b>{{ displayedScore.left }}</b
          ><i>:</i><b>{{ displayedScore.right }}</b>
          <div class="score-team right">
            <span>{{ rightTeam?.shortName || rightTeam?.name || '右隊' }}</span
            ><small :aria-label="`右隊勝局 ${rightSetWins}`">{{ rightSetWins }}</small>
          </div>
        </div>
        <div class="court-side-row">
          <span>{{ sideSwapTarget?.label ?? '換場起點' }}</span>
          <div>
            <b>左側 {{ teamLabel(currentLeftTeam, '隊伍') }}</b
            ><ArrowLeftRight :size="13" aria-hidden="true" /><b
              >右側 {{ teamLabel(currentRightTeam, '隊伍') }}</b
            >
          </div>
          <UiButton
            variant="ghost"
            size="sm"
            :disabled="!swapCurrentSidesState.enabled"
            :title="swapCurrentSidesState.reason ?? undefined"
            @click="workstation.actions.execute('segment.swap-current-sides')"
            ><ArrowLeftRight :size="13" />{{ sideSwapPending ? '對調中' : '對調左右' }}</UiButton
          >
        </div>
        <div class="next-set-actions">
          <button
            type="button"
            :disabled="!nextSetState.enabled || !actionLeftTeam"
            :title="nextSetState.reason ?? undefined"
            @click="workstation.actions.execute('segment.start-next-set', 'left')"
          >
            {{ teamLabel(actionLeftTeam, '左隊') }} 勝局</button
          ><button
            type="button"
            :disabled="!nextSetState.enabled || !actionRightTeam"
            :title="nextSetState.reason ?? undefined"
            @click="workstation.actions.execute('segment.start-next-set', 'right')"
          >
            {{ teamLabel(actionRightTeam, '右隊') }} 勝局
          </button>
        </div>
        <div class="set-boundary-help" role="note" aria-label="局與換場規則">
          <div class="set-boundary-help__row">
            <b>勝局</b><span>目前回合結束本局；下一回合從 0 : 0 開始</span>
          </div>
          <div class="set-boundary-help__row">
            <b>換場</b><span>從目前回合起，左右隊伍反轉</span>
          </div>
        </div>
      </div>
      <div class="segment-list-title">
        <span>片段</span>
        <div class="segment-title-actions">
          <UiButton
            v-if="resettableRallies.length"
            variant="ghost"
            size="sm"
            :disabled="segments.deletePending.value"
            :aria-label="`批次刪除 ${resettableRallies.length} 個分析`"
            @click="segments.requestBatchAnalysisReset(resettableRallies)"
            ><Trash2 :size="12" />批次刪除 {{ resettableRallies.length }}</UiButton
          ><b>{{ total }}</b>
        </div>
      </div>
      <UiScrollArea class="segment-scroll"
        ><div class="segment-list">
          <section v-for="group in groups" :key="group.number" class="set-group">
            <header class="set-divider">
              <span>第 {{ group.number }} 局</span
              ><b>{{ group.leftScore }} : {{ group.rightScore }}</b>
            </header>
            <template v-for="item in group.items" :key="item.id">
              <div
                v-if="sideSwapBoundaryIds.has(item.id)"
                class="side-swap-marker"
                role="separator"
                :aria-label="`第 ${item.ordinal} 回合起換場`"
              >
                <span class="side-swap-marker__icon" aria-hidden="true"
                  ><ArrowLeftRight :size="12"
                /></span>
                <span class="side-swap-marker__copy">
                  <strong>第 {{ item.ordinal }} 回合起換場</strong>
                  <small
                    >左側 {{ teamLabel(segmentTeams(item).left, '隊伍') }} · 右側
                    {{ teamLabel(segmentTeams(item).right, '隊伍') }}</small
                  >
                </span>
              </div>
              <div class="segment-row" :class="{ active: selectedRallyId === item.id }">
                <button type="button" class="segment-main" @click="selectItem(item)">
                  <span class="segment-heading">
                    <strong
                      ><i
                        :class="
                          item.kind === 'draft'
                            ? 'draft'
                            : {
                                failed: item.rally.processing_status === 'failed',
                                processing:
                                  item.rally.processing_status !== 'failed' &&
                                  item.rally.submission.analysis?.status !== 'completed',
                                mapped: item.rally.submission.analysis?.identity_mapping_completed,
                              }
                        "
                      />回合 {{ item.ordinal }}</strong
                    >
                    <span class="score-at-rally"
                      >{{ segmentScores.get(item.id)?.left ?? 0 }} :
                      {{ segmentScores.get(item.id)?.right ?? 0 }}</span
                    >
                  </span>
                  <small class="segment-side-order"
                    >左側 {{ teamLabel(segmentTeams(item).left, '隊伍') }} · 右側
                    {{ teamLabel(segmentTeams(item).right, '隊伍') }}</small
                  >
                  <span class="segment-meta">
                    <small v-if="item.kind === 'draft'"
                      >{{
                        item.draft.active_submission_id
                          ? '修正版草稿'
                          : item.draft.annotation_status === 'ready'
                            ? '待送出'
                            : '標記中'
                      }}
                      ·
                      {{
                        item.draft.key_points.filter(point => point.marker_kind === 'contact')
                          .length
                      }}
                      次擊球</small
                    >
                    <small v-else
                      >{{ rallyStateLabel(item.rally) }} · {{ formatRallyDuration(item.rally) }} ·
                      {{
                        item.rally.submission.analysis?.contact_count ??
                        item.rally.submission.contact_count
                      }}
                      次擊球</small
                    >
                    <span
                      v-if="segmentOutcomeLabel(item)"
                      class="outcome-badge"
                      :class="{ unknown: segmentOutcomeLabel(item) === '得分未知' }"
                      ><CircleHelp
                        v-if="segmentOutcomeLabel(item) === '得分未知'"
                        :size="11"
                      /><Trophy v-else :size="11" />{{ segmentOutcomeLabel(item) }}</span
                    >
                  </span>
                </button>
                <div class="segment-actions">
                  <UiTooltip
                    v-if="item.kind === 'rally'"
                    content="從此回合起對調左右隊伍，包含之後所有回合"
                    ><UiButton
                      variant="ghost"
                      size="icon-sm"
                      class="row-action"
                      aria-label="從此回合起對調左右隊伍"
                      :disabled="!swapRallySidesState.enabled"
                      @click="workstation.actions.execute('segment.swap-rally-sides', item.rally)"
                      ><ArrowLeftRight :size="14" /></UiButton
                  ></UiTooltip>
                  <UiTooltip content="編輯局與回合"
                    ><UiButton
                      variant="ghost"
                      size="icon-sm"
                      class="row-action"
                      aria-label="編輯局與回合"
                      @click="openPlacement(item)"
                      ><Pencil :size="13" /></UiButton
                  ></UiTooltip>
                </div>
              </div>
            </template>
            <div
              v-if="winningTeamLabel(group.number)"
              class="set-result-marker"
              role="status"
              :aria-label="`第 ${group.number} 局 ${winningTeamLabel(group.number)} 勝`"
            >
              <Trophy :size="13" aria-hidden="true" />
              <strong>第 {{ group.number }} 局 · {{ winningTeamLabel(group.number) }} 勝</strong>
              <small>下一回合：新局 · 0 : 0</small>
              <UiTooltip v-if="group.number === latestWinnerSetNumber" content="刪除這個勝局標記">
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  class="set-result-marker__remove"
                  :disabled="!reopenLastSetState.enabled"
                  :title="reopenLastSetState.reason ?? '刪除這個勝局標記'"
                  :aria-label="`刪除第 ${group.number} 局勝局標記`"
                  @click="workstation.actions.execute('segment.reopen-last-set')"
                >
                  <Trash2 :size="12" aria-hidden="true" />
                </UiButton>
              </UiTooltip>
            </div>
          </section></div
      ></UiScrollArea>
    </div>
    <div v-else-if="tab === 'mapping'" class="mapping-inspector">
      <UiScrollArea class="mapping-scroll"
        ><div class="mapping-scroll-content">
          <AnnotationIdentityPanel
            :match-id="matchId"
            :analysis-run-id="analysisRunId"
            :left-team-id="leftTeamId"
            :right-team-id="rightTeamId"
            :teams="teams"
            @select-track="emit('select-track', $event)"
          /></div
      ></UiScrollArea>
    </div>
    <div v-else class="analysis-inspector">
      <UiScrollArea class="mapping-scroll"
        ><div class="mapping-scroll-content"><slot name="analysis" /></div
      ></UiScrollArea>
    </div>
    <UiAnimatedModal
      :open="placementOpen"
      title="調整片段所屬局"
      description="重新選擇局數，回合編號會自動重算。"
      width="compact"
      @close="placementOpen = false"
    >
      <form class="placement-form" @submit.prevent="savePlacement">
        <label
          ><span>局數</span
          ><select v-model.number="placementSetNumber">
            <option v-for="number in setNumbers" :key="number" :value="number">
              第 {{ number }} 局
            </option>
          </select></label
        ><output class="placement-order" aria-live="polite"
          ><span>自動排序結果</span><strong>第 {{ placementOrdinal }} 回合</strong
          ><small>顯示順序會隨時間軸位置自動更新。</small></output
        >
      </form>
      <template #footer
        ><UiButton variant="ghost" @click="placementOpen = false">取消</UiButton
        ><UiButton :disabled="placementSaving" @click="savePlacement"
          ><Check :size="14" />{{ placementSaving ? '儲存中' : '儲存' }}</UiButton
        ></template
      >
    </UiAnimatedModal>
  </aside>
</template>

<style scoped>
.inspector {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--line);
  background: var(--surface-1);
  color: #f4f4f5;
  font-size: 0.77rem;
}
.inspector button {
  color: inherit;
  cursor: pointer;
}
.inspector button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.mode-switch {
  flex: none;
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 10px 10px 0;
  border: 1px solid #27272a;
  border-radius: 8px;
  overflow: hidden;
  background: #111113;
}
.mode-switch button {
  min-height: 32px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 0.68rem;
}
.mode-switch button + button {
  border-left: 1px solid #27272a;
}
.mode-switch button.active {
  background: #27272a;
  color: #fafafa;
}
.match-inspector,
.mapping-inspector {
  min-height: 0;
  flex: 1;
}
.match-inspector {
  display: grid;
  grid-template-rows: auto 34px minmax(0, 1fr);
}
.score-summary {
  margin: 0 10px;
  padding-top: 10px;
  border-bottom: 1px solid var(--line);
}
.set-scoreline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 5px;
  color: #8f99a3;
  font-size: 0.58rem;
  font-weight: 650;
}
.set-scoreline b {
  color: #d7dce1;
  font-size: 0.6rem;
}
.score-board {
  min-height: 62px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
}
.score-board span {
  overflow: hidden;
  color: #aab2bb;
  font-size: 0.68rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.score-board span:last-child {
  text-align: right;
}
.score-board b {
  font-size: 1.55rem;
}
.score-board i {
  color: #69737d;
  font-style: normal;
}
.next-set-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 5px;
  border-top: 1px solid #282e34;
}
.next-set-actions button {
  min-height: 25px;
  padding: 2px 6px;
  border: 1px solid #343a40;
  border-radius: 6px;
  background: #181b1f;
  color: #aeb6be;
  font-size: 0.58rem;
}
.set-boundary-help {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0 8px 7px;
  color: #8f99a3;
  font-size: 0.55rem;
  line-height: 1.45;
}
.set-boundary-help__row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 5px;
  align-items: baseline;
}
.set-boundary-help__row b {
  color: #e1e6eb;
  font-size: 0.56rem;
}
.segment-list-title {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  color: #aab2bb;
  font-size: 0.65rem;
  font-weight: 700;
}
.segment-list-title b {
  min-width: 20px;
  padding: 2px 5px;
  border-radius: 999px;
  background: #293039;
  font-size: 0.6rem;
  text-align: center;
}
.segment-title-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.segment-title-actions :deep(button) {
  min-height: 25px;
  padding: 2px 6px;
  color: #c7cdd3;
  font-size: 0.58rem;
}
.segment-scroll,
.mapping-scroll {
  height: 100%;
  min-height: 0;
}
.segment-scroll {
  border-top: 1px solid #242a30;
}
.segment-list {
  padding: 0;
}
.segment-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid #242a30;
  border-radius: 0;
  background: transparent;
  font-size: 0.66rem;
  transition: background-color 140ms ease;
}
.segment-row:hover {
  background: #1b1f23;
}
.segment-row.active {
  background: #272b30;
}
.segment-row small {
  color: #77838e;
  font-size: 0.58rem;
  font-weight: 500;
}
.segment-row i {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #4295d8;
}
.segment-row i.processing {
  background: #d5a331;
}
.segment-row i.mapped {
  background: #36b878;
}
.segment-row i.draft {
  background: #71717a;
}
.mapping-inspector,
.analysis-inspector {
  padding: 10px;
  overflow: hidden;
}
.mapping-scroll-content {
  padding-right: 10px;
  padding-bottom: 10px;
}
</style>
<style scoped>
.segment-row i.failed {
  background: #e16c74;
}
.mode-switch {
  grid-template-columns: repeat(3, 1fr);
}
.mode-switch button {
  font-size: 0.65rem;
}
.match-inspector,
.mapping-inspector,
.analysis-inspector {
  min-height: 0;
  flex: 1;
}
.mapping-inspector,
.analysis-inspector {
  overflow: hidden;
}
.set-scoreline {
  display: block;
  padding: 3px 5px;
}
.score-board {
  min-height: 64px;
}
.score-team {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.score-team.left span {
  text-align: left;
}
.score-team.right span {
  text-align: right;
}
.score-team small {
  width: max-content;
  padding: 3px 6px;
  border-radius: 5px;
  background: #202328;
  color: #aeb5bc;
  font-size: 0.49rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.score-team.left small {
  justify-self: start;
}
.score-team.right small {
  justify-self: end;
}
.court-side-row {
  min-height: 38px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-top: 1px solid #282e34;
  color: #8f99a3;
  font-size: 0.56rem;
}
.court-side-row > div {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.court-side-row b {
  color: #d7dce1;
  font-size: 0.58rem;
  white-space: nowrap;
}
.court-side-row button {
  min-height: 27px !important;
  padding: 3px 7px !important;
  font-size: 0.57rem;
}
.set-divider {
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-bottom: 1px solid #30363d;
  background: #171a1e;
  color: #b9c0c7;
  font-size: 0.61rem;
}
.set-divider b {
  color: #f1f3f5;
  font-variant-numeric: tabular-nums;
}
.side-swap-marker {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-top: 1px solid #34505e;
  border-bottom: 1px solid #34505e;
  background: #152229;
  color: #a9cddd;
}
.side-swap-marker__icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid #4b7b90;
  border-radius: 6px;
  background: #1b3541;
  color: #8dd1ed;
}
.side-swap-marker__copy {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.side-swap-marker__copy strong {
  color: #d8f1fb;
  font-size: 0.62rem;
  font-weight: 750;
}
.side-swap-marker__copy small {
  overflow: hidden;
  color: #91b4c3 !important;
  font-size: 0.56rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.set-result-marker {
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid #4c432b;
  background: #242018;
  color: #e5c978;
}
.set-result-marker strong {
  color: #f5e5ad;
  font-size: 0.6rem;
  font-weight: 750;
}
.set-result-marker small {
  margin-left: auto;
  color: #b6a36b !important;
  font-size: 0.54rem;
}
.set-result-marker__remove {
  flex: none;
  width: 24px !important;
  min-height: 24px !important;
  display: grid !important;
  place-items: center;
  margin-left: 2px;
  padding: 0 !important;
  border: 1px solid #66533a !important;
  border-radius: 5px !important;
  background: transparent !important;
  color: #f0d99a !important;
}
.set-result-marker__remove:hover:not(:disabled) {
  background: #3a3020 !important;
  color: #fff1bd !important;
}
.set-result-marker__remove:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.segment-row {
  min-height: 82px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  padding: 0;
}
.segment-main {
  min-width: 0;
  min-height: 81px;
  display: grid;
  align-content: center;
  gap: 5px;
  padding: 8px 8px 8px 10px;
  border: 0;
  background: transparent;
  text-align: left;
}
.segment-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.segment-heading strong {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f1f3f5;
  font-size: 0.68rem;
}
.segment-row small {
  color: #929ba4;
  font-size: 0.6rem;
}
.segment-side-order {
  color: #c6ccd2 !important;
  white-space: normal;
  overflow-wrap: anywhere;
}
.segment-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.segment-meta > small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.score-at-rally {
  color: #d5dbe1;
  font-size: 0.65rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.outcome-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border: 1px solid #4a525a;
  border-radius: 5px;
  background: #22272c;
  color: #f1f3f5;
  font-size: 0.57rem;
  font-weight: 700;
  white-space: nowrap;
}
.outcome-badge.unknown {
  border-style: dashed;
  color: #c5cbd1;
}
.segment-actions {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-left: 1px solid #242a30;
}
.row-action {
  color: #aab2bb !important;
}
.placement-form {
  display: grid;
  gap: 12px;
  padding: 18px;
}
.placement-form label {
  display: grid;
  gap: 6px;
  color: #a8b0b8;
  font-size: 0.64rem;
}
.placement-form select {
  height: 36px;
  padding: 0 10px;
  border: 1px solid #3a4148;
  border-radius: 7px;
  outline: 0;
  background: #171a1e;
  color: #f4f4f5;
  font-size: 0.72rem;
}
.placement-form select:focus {
  border-color: #8b949e;
  box-shadow: 0 0 0 2px rgb(139 148 158 / 18%);
}
.placement-order {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  padding: 11px 12px;
  border: 1px solid #30363d;
  border-radius: 8px;
  background: #14171a;
  color: #a8b0b8;
  text-align: left;
}
.placement-order > span {
  font-size: 0.62rem;
}
.placement-order > strong {
  color: #f4f4f5;
  font-size: 0.76rem;
}
.placement-order > small {
  grid-column: 1/-1;
  color: #858f99;
  font-size: 0.6rem;
  line-height: 1.45;
}
</style>
