<script setup lang="ts">
import { BarChart3, ChevronRight, CircleAlert, UserRoundSearch } from 'lucide-vue-next'
import { rosterPositionLabel } from '~/lib/rosterPositions'
import {
  actionColor,
  actionOutcomeRate,
  formatActionTime,
  type CoachPlayerActionEvent,
} from '~/utils/coachPlayerActions'
import type { CoachRouteMapSideLabel } from '~/components/CoachBallRouteMap.vue'
import {
  playerContactShare,
  playerParticipation,
  teamParticipation,
  teamTracks,
} from '~/utils/coachPresentation'
import { provideIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'

type ViewMode = 'players' | 'tracks' | 'teams'
type TeamTone = 'blue' | 'red'

const route = useRoute()
provideIdentityAssignmentService()
const matchId = computed(() => String(route.params.matchId))
const analyticsState = useCoachAnalytics(matchId)
const analytics = computed(() => analyticsState.data.value)
const viewMode = ref<ViewMode>('players')
const viewTabs = [
  { value: 'players', label: '球員' },
  { value: 'tracks', label: '片段 ID' },
  { value: 'teams', label: '隊伍' },
] as const
const selectedPlayerId = ref<string | null>(null)
const selectedTrackKey = ref<string | null>(null)
const selectedTeamId = ref<string | null>(null)
const selectedActionKey = ref('all')
const selectedActionEvent = shallowRef<CoachPlayerActionEvent | null>(null)
const detailScrollArea = ref<{ $el?: HTMLElement } | null>(null)
const detailOverviewSentinel = ref<HTMLElement | null>(null)
const detailOverviewStuck = ref(false)

watchEffect(onCleanup => {
  if (!import.meta.client) return

  const scrollAreaRoot = detailScrollArea.value?.$el
  const sentinel = detailOverviewSentinel.value
  const viewport = scrollAreaRoot?.querySelector<HTMLElement>('.scroll-area__viewport')
  if (!viewport || !sentinel) return

  const observer = new IntersectionObserver(
    ([entry]) => {
      const stuck = !entry?.isIntersecting
      if (detailOverviewStuck.value !== stuck) detailOverviewStuck.value = stuck
    },
    { root: viewport, threshold: 0.01 },
  )
  observer.observe(sentinel)
  onCleanup(() => observer.disconnect())
})

const orderedPlayers = computed(() =>
  (analytics.value?.teams ?? []).flatMap(team => playersForTeam(team.id)),
)

const selectedPlayer = computed(
  () =>
    analytics.value?.players.find(player => player.roster_entry_id === selectedPlayerId.value) ??
    orderedPlayers.value[0] ??
    null,
)
const selectedPlayerTeam = computed(
  () => analytics.value?.teams.find(team => team.id === selectedPlayer.value?.team_id) ?? null,
)
const selectedTeam = computed(
  () =>
    analytics.value?.teams.find(team => team.id === selectedTeamId.value) ??
    analytics.value?.teams[0] ??
    null,
)
const selectedTeamPlayers = computed(
  () => analytics.value?.players.filter(player => player.team_id === selectedTeam.value?.id) ?? [],
)
const selectedTeamTracks = computed(() =>
  analytics.value && selectedTeam.value ? teamTracks(analytics.value, selectedTeam.value.id) : [],
)
const selectedTeamParticipation = computed(() =>
  analytics.value && selectedTeam.value
    ? teamParticipation(analytics.value, selectedTeam.value.id)
    : 0,
)
const selectedTeamWinRate = computed(() => {
  const team = selectedTeam.value
  return team?.sample_count ? team.wins / team.sample_count : null
})
const selectedParticipation = computed(() =>
  analytics.value && selectedPlayer.value
    ? playerParticipation(analytics.value, selectedPlayer.value.roster_entry_id)
    : [],
)
const selectedShare = computed(() =>
  analytics.value && selectedPlayer.value
    ? playerContactShare(analytics.value, selectedPlayer.value.roster_entry_id)
    : 0,
)
const identityCoverage = computed(() => analytics.value?.metrics.identity_coverage?.value ?? 0)
const localTracks = computed(() =>
  [...(analytics.value?.tracks ?? [])].sort(
    (left, right) =>
      Number(Boolean(left.roster_entry_id)) - Number(Boolean(right.roster_entry_id)) ||
      right.set_number - left.set_number ||
      right.rally_ordinal - left.rally_ordinal ||
      left.track_id - right.track_id,
  ),
)
const selectedLocalTrack = computed(
  () =>
    localTracks.value.find(track => trackKey(track) === selectedTrackKey.value) ??
    localTracks.value[0] ??
    null,
)
const selectedMappedPlayer = computed(
  () =>
    analytics.value?.players.find(
      player => player.roster_entry_id === selectedLocalTrack.value?.roster_entry_id,
    ) ?? null,
)
const selectedTracks = computed(() => {
  if (viewMode.value === 'players')
    return (
      analytics.value?.tracks.filter(
        track => track.roster_entry_id === selectedPlayer.value?.roster_entry_id,
      ) ?? []
    )
  if (viewMode.value === 'teams') return selectedTeamTracks.value
  return selectedLocalTrack.value ? [selectedLocalTrack.value] : []
})
const eventState = useCoachTrackEvents(selectedTracks)
const selectedReplay = computed(() =>
  selectedLocalTrack.value
    ? (eventState.replays.get(selectedLocalTrack.value.rally_id) ?? null)
    : null,
)
const selectedLocalTeamId = computed(() => {
  const track = selectedLocalTrack.value
  const replay = selectedReplay.value
  if (!track || !replay) return null
  return track.court_side === 'left'
    ? replay.rally.left_team.id
    : track.court_side === 'right'
      ? replay.rally.right_team.id
      : null
})
const selectedSideReplay = computed(() => {
  for (const track of selectedTracks.value) {
    const replay = eventState.replays.get(track.rally_id)
    if (replay) return replay
  }
  return null
})
const selectedSubjectSide = computed<'left' | 'right' | null>(() => {
  for (const track of selectedTracks.value) {
    const directSide = track.court_side
    if (directSide === 'left' || directSide === 'right') return directSide

    const replay = eventState.replays.get(track.rally_id)
    const replaySide = replay?.analysis?.tracks.find(
      item => item.track_id === track.track_id,
    )?.court_side
    if (replaySide === 'left' || replaySide === 'right') return replaySide
  }
  return null
})
const selectedSubjectTeamId = computed(() => {
  if (viewMode.value === 'players') return selectedPlayerTeam.value?.id ?? null
  if (viewMode.value === 'teams') return selectedTeam.value?.id ?? null

  const replay = selectedSideReplay.value
  if (selectedSubjectSide.value === 'left' && replay) return replay.rally.left_team.id
  if (selectedSubjectSide.value === 'right' && replay) return replay.rally.right_team.id
  return selectedMappedPlayer.value?.team_id ?? null
})
const selectedOverviewTeamId = computed(() =>
  viewMode.value === 'players'
    ? selectedPlayerTeam.value?.id
    : viewMode.value === 'teams'
      ? selectedTeam.value?.id
      : selectedSubjectTeamId.value,
)
const routeMapSideLabels = computed<{
  left: CoachRouteMapSideLabel
  right: CoachRouteMapSideLabel
}>(() => {
  const replay = selectedSideReplay.value
  const subjectSide = selectedSubjectSide.value
  const subjectScope = viewMode.value === 'teams' ? 'team' : 'player'
  const subjectTeamId = selectedSubjectTeamId.value
  const subjectTeam = analytics.value?.teams.find(team => team.id === subjectTeamId) ?? null
  const opponentTeam = analytics.value?.teams.find(team => team.id !== subjectTeamId) ?? null

  function teamForSide(side: 'left' | 'right') {
    const replayTeam = side === 'left' ? replay?.rally.left_team : replay?.rally.right_team
    if (side === subjectSide) return subjectTeam ?? replayTeam
    if (replayTeam && replayTeam.id !== subjectTeamId) return replayTeam
    return opponentTeam ?? replayTeam
  }

  function labelForSide(side: 'left' | 'right'): CoachRouteMapSideLabel {
    const team = teamForSide(side)
    return {
      teamShortName: team?.shortName || team?.name || '—',
      tone: teamTone(team?.id),
      scope: subjectSide === side ? subjectScope : null,
    }
  }

  const rawLabels = { left: labelForSide('left'), right: labelForSide('right') }
  return selectedSubjectSide.value === 'right'
    ? { left: rawLabels.right, right: rawLabels.left }
    : rawLabels
})
const actionOptions = computed(() => {
  const byKey = new Map<string, { key: string; label: string; count: number }>()
  for (const event of eventState.events.value) {
    const current = byKey.get(event.actionKey)
    byKey.set(event.actionKey, {
      key: event.actionKey,
      label: event.actionLabel,
      count: (current?.count ?? 0) + 1,
    })
  }
  const order = ['hit', 'spike', 'serve', 'serve_receive']
  return [...byKey.values()].sort(
    (left, right) => order.indexOf(left.key) - order.indexOf(right.key),
  )
})
const filteredEvents = computed(() =>
  selectedActionKey.value === 'all'
    ? eventState.events.value
    : eventState.events.value.filter(event => event.actionKey === selectedActionKey.value),
)
const outcomeSummary = computed(() => actionOutcomeRate(filteredEvents.value))
const selectedRouteCount = computed(
  () =>
    filteredEvents.value.filter(event => event.routeStart !== null && event.routeEnd !== null)
      .length,
)
const selectedLandingCount = computed(
  () => filteredEvents.value.filter(event => event.routeEnd !== null).length,
)
const selectedActionLabel = computed(() =>
  selectedActionKey.value === 'all'
    ? '全部球種'
    : (actionOptions.value.find(option => option.key === selectedActionKey.value)?.label ??
      '所選球種'),
)
const highlightSubjectLabel = computed(() => {
  if (viewMode.value === 'players' && selectedPlayer.value)
    return `#${selectedPlayer.value.jersey_number} ${selectedPlayer.value.name}`
  if (viewMode.value === 'tracks' && selectedLocalTrack.value) {
    const identity = selectedMappedPlayer.value
      ? `#${selectedMappedPlayer.value.jersey_number} ${selectedMappedPlayer.value.name}`
      : '未分配球員'
    return `${trackLabel(selectedLocalTrack.value)} · ${identity}`
  }
  return selectedTeam.value?.name ?? '隊伍'
})
const selectedActionReplay = computed(() =>
  selectedActionEvent.value
    ? (eventState.replays.get(selectedActionEvent.value.rallyId) ?? null)
    : null,
)
const analyticsErrorMessage = computed(() => {
  const message = analyticsState.error.value?.message
  if (!message) return ''
  if (message === 'Unexpected error.')
    return '分析服務版本與本地資料庫尚未同步。請完成資料庫 migration 後重試。'
  return message
})

watch(
  analytics,
  value => {
    if (
      !selectedPlayerId.value ||
      !value?.players.some(player => player.roster_entry_id === selectedPlayerId.value)
    )
      selectedPlayerId.value = orderedPlayers.value[0]?.roster_entry_id ?? null
    if (!selectedTeamId.value || !value?.teams.some(team => team.id === selectedTeamId.value))
      selectedTeamId.value = value?.teams[0]?.id ?? null
    if (
      !selectedTrackKey.value ||
      !value?.tracks.some(track => trackKey(track) === selectedTrackKey.value)
    ) {
      const first = value?.tracks.find(track => !track.roster_entry_id) ?? value?.tracks[0]
      selectedTrackKey.value = first ? trackKey(first) : null
    }
  },
  { immediate: true },
)
watch([viewMode, actionOptions], () => {
  if (
    selectedActionKey.value !== 'all' &&
    !actionOptions.value.some(option => option.key === selectedActionKey.value)
  )
    selectedActionKey.value = 'all'
})

function trackKey(track: { analysis_run_id: string; track_id: number }) {
  return `${track.analysis_run_id}:${track.track_id}`
}

function teamTone(teamId: string | null | undefined): TeamTone {
  const index = analytics.value?.teams.findIndex(team => team.id === teamId) ?? -1
  return index === 1 ? 'red' : 'blue'
}

function teamToneClass(teamId: string | null | undefined) {
  return `team-tone-${teamTone(teamId)}`
}

function playerBadge(player: NonNullable<typeof selectedPlayer.value>) {
  return `[${player.position === 'UNSPECIFIED' ? '—' : player.position}] ${player.jersey_number}`
}

function playersForTeam(teamId: string) {
  return [...(analytics.value?.players.filter(player => player.team_id === teamId) ?? [])].sort(
    (left, right) =>
      Number(left.jersey_number) - Number(right.jersey_number) ||
      left.jersey_number.localeCompare(right.jersey_number, 'zh-Hant', { numeric: true }) ||
      left.name.localeCompare(right.name, 'zh-Hant'),
  )
}

function trackLabel(track: NonNullable<typeof selectedLocalTrack.value>) {
  return `ID ${String(track.track_id).padStart(2, '0')}`
}

function selectPlayer(playerId: string) {
  selectedPlayerId.value = playerId
  selectedActionKey.value = 'all'
}

function selectTrack(key: string) {
  selectedTrackKey.value = key
  selectedActionKey.value = 'all'
}

function selectTeam(teamId: string) {
  selectedTeamId.value = teamId
  selectedActionKey.value = 'all'
}

function openPlayer(playerId: string) {
  viewMode.value = 'players'
  selectPlayer(playerId)
}

function outcomeLabel(event: CoachPlayerActionEvent) {
  return event.resultKey === 'point_scored'
    ? '得分'
    : event.resultKey === 'success'
      ? '成功'
      : event.resultKey === 'error'
        ? '失誤'
        : event.resultKey === 'point_lost'
          ? '失分'
          : event.resultKey === 'failure'
            ? '失敗'
            : '未填結果'
}

function refreshAfterIdentityChange() {
  void analyticsState.refresh()
  void eventState.refresh()
}

function openActionReplay(event: CoachPlayerActionEvent) {
  selectedActionEvent.value = event
}

const BALL_TYPE_LABELS: Record<string, string> = {
  serve: '發',
  receive: '接',
  spike: '殺',
  contact: '擊',
}

function compactActionCounts(counts: Record<string, number>) {
  return ['serve', 'receive', 'spike', 'contact']
    .map(key => ({ key, label: BALL_TYPE_LABELS[key]!, count: counts[key] ?? 0 }))
    .filter(item => item.count > 0)
}

function actionCount(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

function teamActionCounts(teamId: string) {
  const counts: Record<string, number> = {}
  for (const player of analytics.value?.players.filter(item => item.team_id === teamId) ?? [])
    for (const [key, count] of Object.entries(player.action_counts))
      counts[key] = (counts[key] ?? 0) + count
  return compactActionCounts(counts)
}
</script>

<template>
  <section class="players-view">
    <div v-if="analyticsState.pending.value" class="players-loading" aria-busy="true" />
    <div v-else-if="analyticsState.error.value && !analytics" class="players-state" role="alert">
      <CircleAlert :size="22" /><strong>球員資料載入失敗</strong
      ><span>{{ analyticsErrorMessage }}</span
      ><button type="button" @click="analyticsState.refresh">重試</button>
    </div>
    <div v-else-if="analytics" class="players-layout">
      <aside class="entity-list" aria-label="分析對象">
        <header>
          <UiTabs
            v-model="viewMode"
            class="entity-mode"
            :options="viewTabs"
            aria-label="分析方式"
          />
          <NuxtLink :to="`/matches/${matchId}/stats`" aria-label="完整統計"
            ><BarChart3 :size="16"
          /></NuxtLink>
        </header>
        <UiScrollArea class="entity-list__scroll">
          <div v-if="viewMode === 'players'">
            <section
              v-for="team in analytics.teams"
              :key="team.id"
              :class="['entity-list__group', teamToneClass(team.id)]"
            >
              <h2>
                <span>{{ team.name }}</span>
                <small>{{ playersForTeam(team.id).length }} 人</small>
              </h2>
              <button
                v-for="player in playersForTeam(team.id)"
                :key="player.roster_entry_id"
                type="button"
                :class="[
                  'entity-player-row',
                  teamToneClass(player.team_id),
                  { active: selectedPlayer?.roster_entry_id === player.roster_entry_id },
                ]"
                @click="selectPlayer(player.roster_entry_id)"
              >
                <span class="entity-jersey">#{{ player.jersey_number }}</span>
                <span class="entity-player-copy">
                  <b>{{ player.name }}</b>
                  <small>{{ rosterPositionLabel(player.position) }}</small>
                </span>
                <span class="entity-total">
                  <b>{{ actionCount(player.action_counts) }}</b>
                  <small>球路</small>
                </span>
                <span class="entity-actions" aria-label="球種摘要">
                  <i
                    v-for="item in compactActionCounts(player.action_counts)"
                    :key="item.key"
                    :style="{ '--action-color': actionColor(item.key) }"
                    >{{ item.label }} {{ item.count }}</i
                  ><small v-if="!compactActionCounts(player.action_counts).length"
                    >尚無人工球種</small
                  >
                </span>
              </button>
            </section>
            <p v-if="!analytics.players.length" class="entity-list__empty">尚無球員資料</p>
          </div>
          <div v-else-if="viewMode === 'tracks'">
            <section
              v-for="rally in analytics.rallies.filter(item =>
                localTracks.some(track => track.rally_id === item.id),
              )"
              :key="rally.id"
              class="entity-list__group"
            >
              <h2>第 {{ rally.set_number }} 局 · 回合 {{ rally.ordinal }}</h2>
              <button
                v-for="track in localTracks.filter(item => item.rally_id === rally.id)"
                :key="trackKey(track)"
                type="button"
                :class="{ active: selectedTrackKey === trackKey(track) }"
                @click="selectTrack(trackKey(track))"
              >
                <span>{{ trackLabel(track) }}</span
                ><b>{{
                  analytics.players.find(player => player.roster_entry_id === track.roster_entry_id)
                    ?.name ?? '未分配球員'
                }}</b
                ><small>{{
                  track.court_side === 'left'
                    ? '左側'
                    : track.court_side === 'right'
                      ? '右側'
                      : '場側未知'
                }}</small>
              </button>
            </section>
            <p v-if="!localTracks.length" class="entity-list__empty">尚無片段追蹤資料</p>
          </div>
          <div v-else>
            <section class="entity-list__group team-entities">
              <h2>全隊統計</h2>
              <button
                v-for="team in analytics.teams"
                :key="team.id"
                type="button"
                :class="[teamToneClass(team.id), { active: selectedTeam?.id === team.id }]"
                @click="selectTeam(team.id)"
              >
                <span>{{ team.shortName || 'TEAM' }}</span
                ><b>{{ team.name }}</b
                ><span class="entity-actions" aria-label="隊伍球種摘要">
                  <i
                    v-for="item in teamActionCounts(team.id)"
                    :key="item.key"
                    :style="{ '--action-color': actionColor(item.key) }"
                    >{{ item.label }} {{ item.count }}</i
                  ><small v-if="!teamActionCounts(team.id).length"
                    >{{ teamParticipation(analytics, team.id) }} 回合</small
                  >
                </span>
              </button>
            </section>
            <p v-if="!analytics.teams.length" class="entity-list__empty">尚無隊伍資料</p>
          </div>
        </UiScrollArea>
      </aside>

      <UiScrollArea
        ref="detailScrollArea"
        v-if="
          (viewMode === 'players' && selectedPlayer) ||
          (viewMode === 'tracks' && selectedLocalTrack) ||
          (viewMode === 'teams' && selectedTeam)
        "
        class="entity-detail-scroll"
      >
        <main class="entity-detail">
          <span ref="detailOverviewSentinel" class="entity-overview-sentinel" aria-hidden="true" />
          <section
            :class="[
              'entity-overview',
              teamToneClass(selectedOverviewTeamId),
              { 'is-stuck': detailOverviewStuck },
            ]"
          >
            <header class="entity-title">
              <div v-if="viewMode === 'players' && selectedPlayer">
                <span :class="['entity-badge', 'player', teamToneClass(selectedPlayerTeam?.id)]">
                  <small>{{
                    selectedPlayer.position === 'UNSPECIFIED' ? '—' : selectedPlayer.position
                  }}</small>
                  <strong>#{{ selectedPlayer.jersey_number }}</strong>
                </span>
                <div class="entity-title__copy">
                  <p class="entity-title__meta">
                    <span
                      :class="['entity-team-mark', teamToneClass(selectedPlayerTeam?.id)]"
                      aria-hidden="true"
                    />
                    <span>{{ selectedPlayerTeam?.name }}</span>
                    <span class="entity-title__separator" aria-hidden="true">·</span>
                    <span>{{ rosterPositionLabel(selectedPlayer.position) }}</span>
                  </p>
                  <h1 :title="selectedPlayer.name">{{ selectedPlayer.name }}</h1>
                </div>
              </div>
              <div v-else-if="viewMode === 'tracks' && selectedLocalTrack">
                <span :class="['entity-badge', 'local', teamToneClass(selectedSubjectTeamId)]">
                  {{ trackLabel(selectedLocalTrack) }}
                </span>
                <div class="entity-title__copy">
                  <p class="entity-title__meta">
                    第 {{ selectedLocalTrack.set_number }} 局 · 回合
                    {{ selectedLocalTrack.rally_ordinal }} ·
                    {{
                      selectedLocalTrack.court_side === 'left'
                        ? '左側'
                        : selectedLocalTrack.court_side === 'right'
                          ? '右側'
                          : '場側未知'
                    }}
                  </p>
                  <h1 :title="selectedMappedPlayer?.name ?? '未分配球員'">
                    {{ selectedMappedPlayer?.name ?? '未分配球員' }}
                  </h1>
                </div>
              </div>
              <div v-else-if="selectedTeam">
                <span :class="['entity-badge', 'team', teamToneClass(selectedTeam.id)]">
                  {{ selectedTeam.shortName || 'TEAM' }}
                </span>
                <div class="entity-title__copy">
                  <p class="entity-title__meta">
                    隊伍完整統計 · {{ selectedTeamPlayers.length }} 名登錄球員
                  </p>
                  <h1 :title="selectedTeam.name">{{ selectedTeam.name }}</h1>
                </div>
              </div>
            </header>

            <dl class="entity-measures">
              <template v-if="viewMode === 'players' && selectedPlayer">
                <div>
                  <dt>分析擊球</dt>
                  <dd>{{ selectedPlayer.contact_count }}</dd>
                  <small>已綁定到此球員的事件</small>
                </div>
                <div>
                  <dt>佔已辨識擊球</dt>
                  <dd>{{ (selectedShare * 100).toFixed(1) }}%</dd>
                  <small
                    >{{
                      analytics.players.reduce((sum, player) => sum + player.contact_count, 0)
                    }}
                    個已辨識事件</small
                  >
                </div>
                <div>
                  <dt>參與回合</dt>
                  <dd>{{ selectedParticipation.length }}</dd>
                  <small>具有此球員軌跡的回合</small>
                </div>
                <div>
                  <dt>場次識別覆蓋</dt>
                  <dd>{{ (identityCoverage * 100).toFixed(1) }}%</dd>
                  <small
                    >{{ analytics.metrics.identity_coverage?.sample_count ?? 0 }} 條球員軌跡</small
                  >
                </div>
              </template>
              <template v-else-if="viewMode === 'tracks' && selectedLocalTrack">
                <div>
                  <dt>人工球種事件</dt>
                  <dd>{{ eventState.events.value.length }}</dd>
                  <small>此片段 ID 關聯的人工標記</small>
                </div>
                <div>
                  <dt>球種</dt>
                  <dd>{{ actionOptions.length }}</dd>
                  <small>發球、接發、擊球與殺球</small>
                </div>
                <div>
                  <dt>出現範圍</dt>
                  <dd>
                    {{
                      Number(
                        BigInt(selectedLocalTrack.last_frame_index) -
                          BigInt(selectedLocalTrack.first_frame_index) +
                          1n,
                      )
                    }}
                  </dd>
                  <small
                    >frames {{ selectedLocalTrack.first_frame_index }}–{{
                      selectedLocalTrack.last_frame_index
                    }}</small
                  >
                </div>
                <div>
                  <dt>人物狀態</dt>
                  <dd class="mapping-state">{{ selectedMappedPlayer ? '已綁定' : '待分配' }}</dd>
                  <small>{{
                    selectedMappedPlayer ? playerBadge(selectedMappedPlayer) : '等待人工選擇球員'
                  }}</small>
                </div>
              </template>
              <template v-else-if="selectedTeam">
                <div>
                  <dt>人工球種</dt>
                  <dd>{{ eventState.events.value.length }}</dd>
                  <small>含未分配片段 ID 的分析事件</small>
                </div>
                <div>
                  <dt>球種</dt>
                  <dd>{{ actionOptions.length }}</dd>
                  <small>隊伍所有人工球種分類</small>
                </div>
                <div>
                  <dt>參與回合</dt>
                  <dd>{{ selectedTeamParticipation }}</dd>
                  <small>含已辨識的匿名人物 ID</small>
                </div>
                <div>
                  <dt>已確認勝率</dt>
                  <dd>
                    {{
                      selectedTeamWinRate === null
                        ? '—'
                        : `${(selectedTeamWinRate * 100).toFixed(1)}%`
                    }}
                  </dd>
                  <small
                    >{{ selectedTeam.wins }} 勝 · {{ selectedTeam.losses }} 負 ·
                    {{ selectedTeam.unknown }} 未知</small
                  >
                </div>
              </template>
            </dl>
          </section>

          <CoachTrackIdentityEditor
            v-if="viewMode === 'tracks' && selectedLocalTrack"
            :match-id="matchId"
            :analysis-run-id="selectedLocalTrack.analysis_run_id"
            :track-id="selectedLocalTrack.track_id"
            :team-id="selectedLocalTeamId"
            @changed="refreshAfterIdentityChange"
          />

          <section class="action-workspace">
            <header class="action-toolbar">
              <div class="action-heading">
                <h2>球路與落點</h2>
                <p>依 HIT、殺球、發球與接發篩選，查看方向、落點與短回放</p>
              </div>
              <div class="action-filters" aria-label="球種篩選">
                <button
                  type="button"
                  :class="{ active: selectedActionKey === 'all' }"
                  @click="selectedActionKey = 'all'"
                >
                  全部球種 <b>{{ eventState.events.value.length }}</b>
                </button>
                <button
                  v-for="option in actionOptions"
                  :key="option.key"
                  type="button"
                  :class="{ active: selectedActionKey === option.key }"
                  @click="selectedActionKey = option.key"
                >
                  <i :style="{ background: actionColor(option.key) }" />{{ option.label }}
                  <b>{{ option.count }}</b>
                </button>
              </div>
            </header>

            <div class="action-overview">
              <aside class="action-rate" aria-label="球路資料摘要">
                <div class="action-rate__primary">
                  <span>人工結果成功率</span>
                  <strong>{{
                    outcomeSummary.rate === null
                      ? '—'
                      : `${(outcomeSummary.rate * 100).toFixed(1)}%`
                  }}</strong>
                  <p>{{ outcomeSummary.won }} / {{ outcomeSummary.resolved }} 個已判定事件</p>
                </div>
                <dl>
                  <div>
                    <dt>完整球路</dt>
                    <dd>{{ selectedRouteCount }}</dd>
                  </div>
                  <div>
                    <dt>有效落點</dt>
                    <dd>{{ selectedLandingCount }}</dd>
                  </div>
                </dl>
                <CoachHighlightExport
                  :match-id="matchId"
                  :events="filteredEvents"
                  :replays="eventState.replays"
                  :subject-label="highlightSubjectLabel"
                  :filter-label="selectedActionLabel"
                  :loading="eventState.pending.value"
                />
              </aside>
              <CoachBallRouteMap
                :events="filteredEvents"
                :label="selectedActionLabel"
                :side-labels="routeMapSideLabels"
                :selected-side="selectedSubjectSide"
                @select="openActionReplay"
              />
            </div>

            <section class="action-records">
              <header>
                <div>
                  <h2>球種時間軸</h2>
                  <p>點選紀錄會在目前頁面播放事件前 3 秒至後 2 秒</p>
                </div>
                <span>{{ filteredEvents.length }} 筆</span>
              </header>
              <UiScrollArea v-if="filteredEvents.length" class="action-records__scroll">
                <div class="action-records__list">
                  <button
                    v-for="event in filteredEvents"
                    :key="event.id"
                    type="button"
                    @click="openActionReplay(event)"
                  >
                    <i :style="{ background: actionColor(event.actionKey) }" />
                    <div class="action-record__identity">
                      <strong>{{ event.actionLabel }}</strong
                      ><span
                        >第 {{ event.setNumber }} 局 · 回合 {{ event.rallyOrdinal }} · ID
                        {{ event.trackId }}</span
                      >
                    </div>
                    <time>{{ formatActionTime(event.anchorTimeUs) }}</time>
                    <span class="action-record__outcome" :data-outcome="event.outcome">{{
                      outcomeLabel(event)
                    }}</span>
                    <span class="action-record__route-state">{{
                      event.routeStart && event.routeEnd
                        ? '起點 → 終點'
                        : event.routeEnd
                          ? '只有落點'
                          : '尚無球路'
                    }}</span>
                    <ChevronRight :size="17" />
                  </button>
                </div>
              </UiScrollArea>
              <div v-else class="action-records__empty">
                <UserRoundSearch :size="20" /><strong>{{
                  eventState.error.value ? '球種紀錄載入失敗' : '目前沒有符合的球種紀錄'
                }}</strong
                ><span>{{
                  eventState.error.value?.message ?? '尚未有人工作出球種標記，不顯示模型推測資料。'
                }}</span>
              </div>
            </section>
          </section>

          <section v-if="viewMode === 'players'" class="participation-list">
            <header>
              <div>
                <h2>參與回合</h2>
                <p>由已完成分析與人物綁定即時彙整</p>
              </div>
              <span>{{ selectedParticipation.length }} 回合</span>
            </header>
            <div v-if="selectedParticipation.length">
              <NuxtLink
                v-for="track in selectedParticipation"
                :key="track.rally_id"
                :to="`/matches/${matchId}/replay/${track.rally_id}`"
              >
                <div>
                  <strong>第 {{ track.set_number }} 局 · 回合 {{ track.rally_ordinal }}</strong
                  ><span
                    >ID {{ track.track_id }} · frame {{ track.first_frame_index }}–{{
                      track.last_frame_index
                    }}</span
                  >
                </div>
                <ChevronRight :size="18" />
              </NuxtLink>
            </div>
            <p v-else>目前沒有已綁定到這位球員的分析軌跡。</p>
          </section>

          <section v-if="viewMode === 'teams' && selectedTeam" class="team-roster-summary">
            <header>
              <div>
                <h2>球員分布</h2>
                <p>點選球員可切換到個人球路、落點熱區與時間軸</p>
              </div>
              <span>{{ selectedTeamPlayers.length }} 人</span>
            </header>
            <div v-if="selectedTeamPlayers.length" class="team-roster-summary__rows">
              <button
                v-for="player in [...selectedTeamPlayers].sort(
                  (left, right) => right.contact_count - left.contact_count,
                )"
                :key="player.roster_entry_id"
                type="button"
                @click="openPlayer(player.roster_entry_id)"
              >
                <span class="team-player-jersey">#{{ player.jersey_number }}</span>
                <span class="team-player-copy">
                  <strong>{{ player.name }}</strong>
                  <small>{{ rosterPositionLabel(player.position) }}</small>
                </span>
                <span class="team-player-metric">
                  <b>{{ player.contact_count }}</b>
                  <small>球路</small>
                </span>
                <span class="team-player-metric">
                  <b>{{ player.rally_count }}</b>
                  <small>回合</small>
                </span>
                <ChevronRight :size="17" />
              </button>
            </div>
            <p v-else>這支隊伍尚未建立球員名單。</p>
          </section>
        </main>
      </UiScrollArea>
      <main v-else class="players-state">尚無可分析資料。</main>
    </div>
    <CoachEventReplayDialog
      :open="selectedActionEvent !== null"
      :event="selectedActionEvent"
      :replay="selectedActionReplay"
      @close="selectedActionEvent = null"
    />
  </section>
</template>

<style scoped>
.players-view {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.players-layout {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: clamp(272px, 25vw, 316px) minmax(0, 1fr);
  overflow: hidden;
  border-block: 1px solid #e0e5e9;
  background: #fbfcfd;
}
.entity-list {
  min-height: 0;
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr);
  overflow: hidden;
  border-right: 1px solid #dfe4e8;
  background: #f3f6f9;
}
.entity-list > header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #dce3ea;
  background: #f8fafc;
}
.entity-list > header > a {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: #69737e;
}
.entity-list > header > a:hover {
  background: #e2e7ec;
  color: #0670df;
}
.entity-mode {
  min-width: 0;
  flex: 1;
}
.entity-list__scroll,
.entity-detail-scroll {
  height: 100%;
  min-height: 0;
}
.entity-detail-scroll :deep(.scroll-area__viewport) {
  overflow-anchor: none;
}
.entity-list__group h2 {
  position: sticky;
  top: 0;
  z-index: 2;
  min-height: 38px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 10px;
  margin: 0 10px 0 0;
  padding: 12px 14px 7px;
  background: rgba(243, 246, 249, 0.94);
  color: #5d6977;
  font-size: 0.68rem;
  font-weight: 760;
  letter-spacing: -0.01em;
  backdrop-filter: blur(12px);
}
.entity-list__group h2 small {
  color: #8b98a6;
  font-size: 0.58rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.entity-list__group > button {
  width: 100%;
  min-height: 55px;
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 0 18px 0 14px;
  border: 0;
  background: transparent;
  color: #20242a;
  text-align: left;
}
.entity-list__group > button:hover {
  background: #e5eaf0;
}
.entity-list__group > button:focus-visible,
.entity-list > header > a:focus-visible {
  outline: 2px solid #0875dd !important;
  outline-offset: -2px;
}
.entity-list__group > button.active {
  background: #fff;
  color: #075fbe;
  box-shadow: inset 3px 0 #0670df;
}
.entity-list__group.team-tone-blue > h2 {
  color: #0b5fae;
}
.entity-list__group.team-tone-red > h2 {
  color: #b42f42;
}
.entity-list__group > button.team-tone-blue.active {
  color: #075fbe;
  box-shadow: inset 3px 0 #0875dd;
}
.entity-list__group > button.team-tone-red.active {
  color: #b42f42;
  box-shadow: inset 3px 0 #d44859;
}
.entity-list__group > button > span {
  font-size: 0.67rem;
  font-weight: 780;
  font-variant-numeric: tabular-nums;
}
.entity-list__group > button > b {
  overflow: hidden;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entity-list__group > button > small {
  color: #858d97;
  font-size: 0.57rem;
  font-variant-numeric: tabular-nums;
}
.entity-actions {
  display: flex !important;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 4px 7px;
  font-weight: 650 !important;
}
.entity-actions i {
  padding-left: 5px;
  border-left: 2px solid var(--action-color);
  color: #64707b;
  font-size: 0.53rem;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.entity-actions small {
  color: #858d97;
  font-size: 0.56rem;
  font-weight: 500;
}
.entity-player-row {
  min-height: 78px !important;
  grid-template-columns: 46px minmax(0, 1fr) auto !important;
  grid-template-rows: auto auto;
  gap: 4px 9px !important;
  margin: 2px 10px 2px 0;
  padding: 10px 14px 10px 10px !important;
  border-radius: 0 12px 12px 0;
}
.entity-player-row.active {
  box-shadow:
    inset 3px 0 #0875dd,
    0 6px 18px rgb(37 54 72 / 9%) !important;
}
.entity-player-row.team-tone-red.active {
  box-shadow:
    inset 3px 0 #d44859,
    0 6px 18px rgb(117 31 47 / 11%) !important;
}
.entity-jersey {
  width: 38px;
  height: 38px;
  display: grid;
  grid-row: 1 / 3;
  place-items: center;
  align-self: center;
  border: 1px solid #d7e0e8;
  border-radius: 12px;
  background: #e7edf2;
  color: #4b5b6b;
  font-size: 0.72rem !important;
  font-weight: 800 !important;
}
.entity-player-row.active .entity-jersey {
  border-color: #0875dd;
  background: #0875dd;
  color: #fff;
}
.entity-player-row.team-tone-red.active .entity-jersey {
  border-color: #d44859;
  background: #d44859;
}
.entity-player-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.entity-player-copy b {
  overflow: hidden;
  color: #243241;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entity-player-copy small,
.entity-total small {
  color: #7b8998;
  font-size: 0.59rem;
  font-weight: 560;
}
.entity-total {
  display: grid;
  justify-items: end;
  gap: 1px;
}
.entity-total b {
  color: #303944;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
}
.entity-player-row.team-tone-blue.active .entity-total b {
  color: #075fbe;
}
.entity-player-row.team-tone-red.active .entity-total b {
  color: #b42f42;
}
.entity-player-row > .entity-actions {
  grid-column: 2 / 4;
  min-width: 0;
}
.entity-list__empty {
  padding: 22px 14px;
  color: #7b858f;
  font-size: 0.68rem;
}
.entity-detail {
  --detail-gutter: clamp(24px, 3.4vw, 52px);

  min-width: 0;
  min-height: 100%;
  padding: 0 var(--detail-gutter) 48px;
  background: #fff;
  box-sizing: border-box;
}
.entity-overview-sentinel {
  width: 1px;
  height: 1px;
  display: block;
  margin-bottom: -1px;
  opacity: 0;
  pointer-events: none;
}
.entity-overview {
  --entity-overview-ease: cubic-bezier(0.22, 1, 0.36, 1);

  position: sticky;
  top: 0;
  z-index: 8;
  display: grid;
  grid-template-columns: minmax(360px, 1.15fr) minmax(0, 2fr);
  align-items: stretch;
  margin-inline: calc(var(--detail-gutter) * -1);
  padding: 24px var(--detail-gutter) 22px;
  border-bottom: 1px solid #dce5ed;
  background: radial-gradient(circle at 8% 0%, #e8f2fc 0, transparent 36%), #f8fafc;
  box-shadow: 0 0 0 transparent;
  isolation: isolate;
  transition:
    grid-template-columns 220ms var(--entity-overview-ease),
    gap 220ms var(--entity-overview-ease),
    padding 220ms var(--entity-overview-ease),
    border-color 180ms ease,
    box-shadow 220ms var(--entity-overview-ease);
}
.entity-overview.team-tone-blue {
  background: radial-gradient(circle at 8% 0%, #dceeff 0, transparent 36%), #f8fafc;
}
.entity-overview.team-tone-red {
  background: radial-gradient(circle at 8% 0%, #ffe6e9 0, transparent 36%), #fffafb;
}
.entity-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding-right: 30px;
  transition:
    gap 220ms var(--entity-overview-ease),
    padding 220ms var(--entity-overview-ease);
}
.entity-title > div {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  transition:
    grid-template-columns 220ms var(--entity-overview-ease),
    gap 220ms var(--entity-overview-ease);
}
.entity-title__copy {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 5px;
  transition: gap 220ms var(--entity-overview-ease);
}
.entity-badge {
  width: 52px;
  height: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 0 5px;
  border: 1px solid #d8e2eb;
  border-radius: 12px;
  background: #edf2f6;
  box-shadow: none;
  color: #34485c;
  font-variant-numeric: tabular-nums;
  transition:
    width 220ms var(--entity-overview-ease),
    height 220ms var(--entity-overview-ease),
    padding 220ms var(--entity-overview-ease),
    border-color 180ms ease,
    border-radius 220ms var(--entity-overview-ease),
    background-color 180ms ease,
    color 180ms ease;
}
.entity-badge.player small {
  color: currentColor;
  font-size: 0.5rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  opacity: 0.68;
}
.entity-badge.player.team-tone-blue {
  border-color: #c6dcf2;
  background: #e8f3ff;
  color: #0b5ea9;
}
.entity-badge.player.team-tone-red {
  border-color: #f0cbd1;
  background: #ffedf0;
  color: #ae3044;
}
.entity-badge.player strong {
  font-size: 1.2rem;
  font-weight: 760;
  line-height: 1.1;
  letter-spacing: -0.04em;
  transition: font-size 220ms var(--entity-overview-ease);
}
.entity-badge.local {
  background: #e9edf1;
  color: #333a42;
  font-size: 0.72rem;
  font-weight: 780;
}
.entity-badge.team {
  font-size: 0.72rem;
  font-weight: 780;
}
.entity-badge.team.team-tone-blue {
  border-color: #c6dcf2;
  background: #e8f3ff;
  color: #0b5ea9;
}
.entity-badge.team.team-tone-red {
  border-color: #f0cbd1;
  background: #ffedf0;
  color: #ae3044;
}
.entity-title p {
  margin: 0;
  color: #68798b;
  font-size: 0.72rem;
  font-weight: 680;
  line-height: 1.2;
  transition: font-size 220ms var(--entity-overview-ease);
}
.entity-title__meta {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.entity-title__meta > span:not(.entity-team-mark):not(.entity-title__separator) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entity-team-mark {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #0875dd;
  box-shadow: 0 0 0 3px #0875dd1c;
}
.entity-team-mark.team-tone-blue {
  background: #0875dd;
  box-shadow: 0 0 0 3px #0875dd1c;
}
.entity-team-mark.team-tone-red {
  background: #d44859;
  box-shadow: 0 0 0 3px #d448591c;
}
.entity-title__separator {
  color: #a2afbc;
}
.entity-title h1 {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  display: block;
  overflow: hidden;
  color: #172333;
  font-size: clamp(1.15rem, 2vw, 1.65rem);
  font-weight: 760;
  line-height: 1.08;
  letter-spacing: -0.03em;
  overflow-wrap: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
  -webkit-line-clamp: 1;
  transition:
    font-size 220ms var(--entity-overview-ease),
    line-height 220ms var(--entity-overview-ease),
    letter-spacing 220ms var(--entity-overview-ease);
}
.entity-measures {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: center;
  gap: 0;
  margin: 0;
  padding-left: 26px;
  border-left: 1px solid #dce5ed;
  transition:
    grid-template-columns 220ms var(--entity-overview-ease),
    padding 220ms var(--entity-overview-ease),
    border-color 180ms ease;
}
.entity-measures > div {
  min-width: 0;
  padding: 6px clamp(8px, 1.2vw, 18px);
  border-right: 1px solid #e1e8ef;
  transition:
    padding 220ms var(--entity-overview-ease),
    border-color 180ms ease;
}
.entity-measures > div:last-child {
  border-right: 0;
}
.entity-measures dt {
  color: #718194;
  font-size: 0.62rem;
  font-weight: 650;
  transition: font-size 220ms var(--entity-overview-ease);
}
.entity-measures dd {
  margin: 6px 0 3px;
  color: #172333;
  font-size: clamp(1.25rem, 2vw, 1.9rem);
  font-weight: 760;
  line-height: 1;
  letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums;
  transition:
    margin 220ms var(--entity-overview-ease),
    font-size 220ms var(--entity-overview-ease);
}
.entity-measures dd.mapping-state {
  font-size: 1.25rem;
  letter-spacing: -0.01em;
}
.entity-measures small {
  display: none;
  color: #858d97;
  font-size: 0.58rem;
  line-height: 1.4;
}
.action-workspace {
  margin-top: 24px;
}
.action-toolbar {
  display: grid;
  gap: 14px;
  margin-inline: calc(var(--detail-gutter) * -1);
  padding: 0 var(--detail-gutter);
  border-bottom: 1px solid #dfe4e8;
}
.action-heading {
  display: grid;
  gap: 4px;
}
.action-heading h2 {
  margin: 0;
  color: #1d252d;
  font-size: 1rem;
  font-weight: 760;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.action-heading p {
  margin: 0;
  color: #7c858f;
  font-size: 0.63rem;
  line-height: 1.45;
}
.action-filters {
  display: flex;
  max-width: 100%;
  overflow-x: auto;
  gap: 20px;
  scrollbar-width: none;
}
.action-filters::-webkit-scrollbar {
  display: none;
}
.action-filters button {
  position: relative;
  min-height: 40px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: #68727c;
  font-size: 0.66rem;
  font-weight: 700;
}
.action-filters button:hover {
  color: #202a34;
}
.action-filters button.active {
  color: #075fbe;
}
.action-filters button.active::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: #0875dd;
  content: '';
}
.action-filters i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.action-filters b {
  color: #8a949e;
  font-size: 0.59rem;
  font-variant-numeric: tabular-nums;
}
.action-filters button.active b {
  color: #4688ca;
}
.action-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  margin-inline: calc(var(--detail-gutter) * -1);
  padding: 16px var(--detail-gutter) 26px;
  border-bottom: 1px solid #dfe4e8;
}
.action-rate {
  min-height: 76px;
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(160px, 1fr) auto minmax(240px, 32rem);
  align-items: center;
  gap: 18px;
  padding: 12px 16px;
  border: 1px solid #dfe5ea;
  border-radius: 14px;
  background: #f4f7f9;
}
.action-rate__primary {
  min-width: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 2px 12px;
}
.action-rate__primary > span {
  grid-column: 1 / -1;
  color: #6d7782;
  font-size: 0.66rem;
  font-weight: 680;
}
.action-rate__primary > strong {
  margin: 4px 0 0;
  font-size: clamp(1.8rem, 3vw, 2.7rem);
  line-height: 1;
  letter-spacing: -0.045em;
  font-variant-numeric: tabular-nums;
}
.action-rate__primary p {
  margin: 0;
  color: #414951;
  font-size: 0.62rem;
  white-space: nowrap;
}
.action-rate dl {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
  margin: 0;
  padding: 0 22px;
  border-inline: 1px solid #dce2e7;
}
.action-rate dl > div {
  display: grid;
  gap: 4px;
  min-width: 72px;
  padding: 0;
}
.action-rate dt {
  color: #75808a;
  font-size: 0.56rem;
}
.action-rate dd {
  margin: 0;
  color: #26313b;
  font-size: 1.2rem;
  font-weight: 760;
  font-variant-numeric: tabular-nums;
}
.action-rate > :deep(.highlight-export) {
  width: 100%;
  max-width: 32rem;
  margin: 0;
  justify-self: end;
}
.action-records {
  padding-top: 26px;
}
.action-records > header,
.participation-list > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin-inline: calc(var(--detail-gutter) * -1);
  padding: 0 var(--detail-gutter) 10px;
  border-bottom: 1px solid #dfe4e8;
}
.action-records h2,
.participation-list h2 {
  margin: 0;
  font-size: 0.86rem;
}
.action-records header p,
.participation-list header p {
  margin: 3px 0 0;
  color: #79828c;
  font-size: 0.61rem;
}
.action-records header > span,
.participation-list header > span {
  color: #707a85;
  font-size: 0.63rem;
}
.action-records__scroll {
  height: min(300px, 36dvh);
}
.action-records__list button {
  width: 100%;
  min-height: 58px;
  display: grid;
  grid-template-columns: 4px minmax(180px, 1fr) 74px 88px 82px 18px;
  align-items: center;
  gap: 12px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid #e4e7eb;
  background: transparent;
  color: inherit;
  text-align: left;
}
.action-records__list button:hover {
  background: #f2f5f8;
}
.action-records__list button:focus-visible {
  outline: 2px solid #0875dd;
  outline-offset: -2px;
}
.action-records__list > button > i {
  width: 3px;
  height: 30px;
  border-radius: 2px;
}
.action-record__identity {
  display: grid;
  gap: 3px;
}
.action-record__identity strong {
  font-size: 0.71rem;
}
.action-record__identity span,
.action-record__route-state {
  color: #7c858f;
  font-size: 0.58rem;
}
.action-record__route-state {
  white-space: nowrap;
}
.action-records time {
  font-size: 0.68rem;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
}
.action-record__outcome {
  font-size: 0.6rem;
}
.action-record__outcome[data-outcome='won'] {
  color: #187742;
}
.action-record__outcome[data-outcome='lost'] {
  color: #a53a3f;
}
.action-record__outcome[data-outcome='unknown'] {
  color: #7b858e;
}
.action-records__list svg {
  color: #8b949d;
}
.action-records__empty {
  min-height: 130px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  color: #77818b;
}
.action-records__empty strong {
  font-size: 0.7rem;
}
.action-records__empty span {
  font-size: 0.6rem;
}
.participation-list {
  margin-top: 36px;
}
.participation-list > div a {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid #e4e7eb;
  color: inherit;
  text-decoration: none;
}
.participation-list > div a:hover {
  background: #f2f5f8;
}
.participation-list > div a > div {
  display: grid;
  gap: 3px;
}
.participation-list > div strong {
  font-size: 0.71rem;
}
.participation-list > div span {
  color: #7c858f;
  font-size: 0.58rem;
  font-variant-numeric: tabular-nums;
}
.participation-list > p {
  margin: 0;
  padding: 22px 0;
  color: #7b848f;
  font-size: 0.68rem;
}
.players-loading {
  height: 100%;
  background: linear-gradient(100deg, #edf0f3 20%, #e2e6ea 40%, #edf0f3 60%);
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}
.players-state {
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: #707984;
}
.players-state span {
  max-width: 48ch;
  font-size: 0.7rem;
  line-height: 1.55;
  text-align: center;
}
.players-state button {
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
@media (max-width: 980px) {
  .players-layout {
    grid-template-columns: 260px minmax(0, 1fr);
  }
  .action-rate {
    grid-template-columns: minmax(165px, 0.8fr) auto;
    gap: 14px;
  }
  .action-rate > :deep(.highlight-export) {
    grid-column: 1 / -1;
    max-width: none;
    padding-top: 10px;
    border-top: 1px solid #dce2e7;
  }
  .entity-overview {
    grid-template-columns: minmax(180px, 0.65fr) minmax(0, 2fr);
  }
  .entity-title {
    padding-right: 18px;
  }
  .entity-measures {
    grid-template-columns: repeat(2, 1fr);
  }
  .entity-measures > div:nth-child(3) {
    border: 0;
  }
  .entity-measures > div:nth-child(4) {
    border: 0;
  }
  .action-records__list button {
    grid-template-columns: 4px minmax(150px, 1fr) 65px 90px 18px;
  }
  .action-record__route-state {
    display: none;
  }
}
@media (max-width: 1360px) {
  .entity-overview {
    grid-template-columns: 1fr;
    gap: 18px;
  }
  .entity-title {
    padding-right: 0;
  }
  .entity-measures {
    padding-top: 14px;
    padding-left: 0;
    border-top: 1px solid #dce5ed;
    border-left: 0;
  }
}
@media (max-width: 760px) {
  .players-layout {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .entity-detail {
    --detail-gutter: 22px;

    padding: 0 var(--detail-gutter) 48px;
  }
  .entity-overview {
    grid-template-columns: 1fr;
  }
  .entity-title {
    padding-right: 0;
  }
  .entity-measures {
    border-top: 1px solid #dfe4e8;
    border-left: 0;
  }
  .entity-measures > div:nth-child(3) {
    border-left: 0;
    border-top: 1px solid #e1e5e9;
  }
  .entity-measures > div:nth-child(4) {
    border-top: 1px solid #e1e5e9;
  }
  .action-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
  .action-filters {
    justify-content: flex-start;
  }
  .action-records__list button {
    grid-template-columns: 4px minmax(130px, 1fr) 62px 18px;
  }
  .action-record__outcome,
  .action-record__route-state {
    display: none;
  }
}
.entity-overview.is-stuck {
  grid-template-columns: minmax(240px, 0.9fr) minmax(0, 2fr);
  align-items: center;
  gap: 0;
  padding-block: 7px;
  border-bottom-color: transparent;
  box-shadow: 0 5px 18px rgb(23 35 51 / 14%);
}
.entity-overview.is-stuck .entity-title {
  padding-right: 16px;
}
.entity-overview.is-stuck .entity-title > div {
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 7px;
}
.entity-overview.is-stuck .entity-title__copy {
  gap: 2px;
}
.entity-overview.is-stuck .entity-badge {
  width: 34px;
  height: 34px;
  padding-inline: 3px;
  border-radius: 9px;
  box-shadow: none;
}
.entity-overview.is-stuck .entity-badge.player small {
  font-size: 0.38rem;
}
.entity-overview.is-stuck .entity-badge.player strong {
  font-size: 0.88rem;
}
.entity-overview.is-stuck .entity-badge.local,
.entity-overview.is-stuck .entity-badge.team {
  font-size: 0.58rem;
}
.entity-overview.is-stuck .entity-title p {
  font-size: 0.56rem;
}
.entity-overview.is-stuck .entity-title__meta {
  gap: 5px;
}
.entity-overview.is-stuck .entity-team-mark {
  width: 5px;
  height: 5px;
  box-shadow: none;
}
.entity-overview.is-stuck .entity-title h1 {
  display: block;
  font-size: clamp(0.95rem, 1.45vw, 1.18rem);
  line-height: 1.08;
  letter-spacing: -0.025em;
  overflow-wrap: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
  -webkit-line-clamp: 1;
}
.entity-overview.is-stuck .entity-measures {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding: 0 0 0 12px;
  border-top: 0;
  border-left: 1px solid #dce5ed;
}
.entity-overview.is-stuck .entity-measures > div,
.entity-overview.is-stuck .entity-measures > div:nth-child(3),
.entity-overview.is-stuck .entity-measures > div:nth-child(4) {
  padding: 2px clamp(6px, 1vw, 12px);
  border-top: 0;
  border-right: 1px solid #e1e8ef;
}
.entity-overview.is-stuck .entity-measures > div:last-child {
  border-right: 0;
}
.entity-overview.is-stuck .entity-measures dt {
  overflow: hidden;
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entity-overview.is-stuck .entity-measures dd,
.entity-overview.is-stuck .entity-measures dd.mapping-state {
  margin: 3px 0 0;
  font-size: clamp(0.95rem, 1.55vw, 1.18rem);
}
@media (prefers-reduced-motion: reduce) {
  .players-loading {
    animation: none;
  }
  .entity-overview,
  .entity-title,
  .entity-title > div,
  .entity-title__copy,
  .entity-badge,
  .entity-badge.player strong,
  .entity-title p,
  .entity-title h1,
  .entity-measures,
  .entity-measures > div,
  .entity-measures dt,
  .entity-measures dd {
    transition: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .entity-list__group h2 {
    background: #eef1f4;
    backdrop-filter: none;
  }
}
.team-entities > button {
  grid-template-columns: 52px minmax(0, 1fr) auto;
}
.entity-badge.team {
  background: #0b67c2;
}
.action-records > header,
.participation-list > header,
.team-roster-summary > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin-inline: calc(var(--detail-gutter) * -1);
  padding: 0 var(--detail-gutter) 10px;
  border-bottom: 1px solid #dfe4e8;
}
.action-records h2,
.participation-list h2,
.team-roster-summary h2 {
  margin: 0;
  font-size: 0.86rem;
}
.action-records header p,
.participation-list header p,
.team-roster-summary header p {
  margin: 3px 0 0;
  color: #79828c;
  font-size: 0.61rem;
}
.action-records header > span,
.participation-list header > span,
.team-roster-summary header > span {
  color: #707a85;
  font-size: 0.63rem;
}
.team-roster-summary {
  margin-top: 36px;
}
.team-roster-summary > p {
  margin: 0;
  padding: 22px 0;
  color: #7b848f;
  font-size: 0.68rem;
}
.team-roster-summary__rows {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding-top: 14px;
}
.team-roster-summary__rows > button {
  width: 100%;
  min-height: 76px;
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) auto auto 18px;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #e0e5ea;
  border-radius: 14px;
  background: #fff;
  color: #20262c;
  text-align: left;
  transition:
    border-color 140ms ease,
    background 140ms ease,
    transform 140ms ease;
}
.team-roster-summary__rows > button:hover {
  border-color: #bfd1e0;
  background: #f8fafc;
  transform: translateY(-1px);
}
.team-roster-summary__rows > button:focus-visible {
  outline: 3px solid rgb(11 103 194 / 22%);
  outline-offset: 2px;
}
.team-player-jersey {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: #17212b;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.team-player-copy {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.team-player-copy strong {
  overflow: hidden;
  color: #1d252d;
  font-size: 0.72rem;
  font-weight: 720;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-player-copy small {
  color: #7c858f;
  font-size: 0.58rem;
  line-height: 1.25;
}
.team-player-metric {
  min-width: 34px;
  display: grid;
  justify-items: end;
  gap: 2px;
}
.team-player-metric b {
  color: #26313a;
  font-size: 0.78rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.team-player-metric small {
  color: #8a939c;
  font-size: 0.54rem;
  white-space: nowrap;
}
.team-roster-summary__rows svg {
  color: #8b949d;
}
@media (max-width: 760px) {
  .team-roster-summary__rows {
    grid-template-columns: 1fr;
  }
  .team-roster-summary__rows > button {
    grid-template-columns: 46px minmax(0, 1fr) auto auto 18px;
  }
}
</style>
