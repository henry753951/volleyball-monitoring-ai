<script setup lang="ts">
import { BarChart3, ChevronRight, CircleAlert, UserRoundSearch } from 'lucide-vue-next'
import { rosterPositionLabel } from '~/lib/rosterPositions'
import {
  actionColor,
  actionOutcomeRate,
  formatActionTime,
  replayEventUrl,
  type CoachPlayerActionEvent,
} from '~/utils/coachPlayerActions'
import {
  playerContactShare,
  playerParticipation,
  teamParticipation,
  teamTracks,
} from '~/utils/coachPresentation'
import { provideIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'

type ViewMode = 'players' | 'tracks' | 'teams'

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
  return [...byKey.values()].sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-Hant'),
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
  void navigateTo(replayEventUrl(matchId.value, event))
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
            <section v-for="team in analytics.teams" :key="team.id" class="entity-list__group">
              <h2>
                <span>{{ team.name }}</span>
                <small>{{ playersForTeam(team.id).length }} 人</small>
              </h2>
              <button
                v-for="player in playersForTeam(team.id)"
                :key="player.roster_entry_id"
                type="button"
                class="entity-player-row"
                :class="{ active: selectedPlayer?.roster_entry_id === player.roster_entry_id }"
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
                :class="{ active: selectedTeam?.id === team.id }"
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
        v-if="
          (viewMode === 'players' && selectedPlayer) ||
          (viewMode === 'tracks' && selectedLocalTrack) ||
          (viewMode === 'teams' && selectedTeam)
        "
        class="entity-detail-scroll"
      >
        <main class="entity-detail">
          <section class="entity-overview">
            <header class="entity-title">
              <div v-if="viewMode === 'players' && selectedPlayer">
                <span class="entity-badge">{{ playerBadge(selectedPlayer) }}</span>
                <p>
                  {{ selectedPlayerTeam?.name }} ·
                  {{ rosterPositionLabel(selectedPlayer.position) }}
                </p>
                <h1>{{ selectedPlayer.name }}</h1>
              </div>
              <div v-else-if="viewMode === 'tracks' && selectedLocalTrack">
                <span class="entity-badge local">{{ trackLabel(selectedLocalTrack) }}</span>
                <p>
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
                <h1>{{ selectedMappedPlayer?.name ?? '未分配球員' }}</h1>
              </div>
              <div v-else-if="selectedTeam">
                <span class="entity-badge team">{{ selectedTeam.shortName || 'TEAM' }}</span>
                <p>隊伍完整統計 · {{ selectedTeamPlayers.length }} 名登錄球員</p>
                <h1>{{ selectedTeam.name }}</h1>
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
                <p>依人工球種篩選，查看移動路徑、落點熱區與判定結果</p>
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
                <small
                  >成功率僅計入人工判定的事件。<template v-if="outcomeSummary.unknown"
                    >{{ outcomeSummary.unknown }} 筆尚未判定。</template
                  ></small
                >
              </aside>
              <CoachBallRouteMap
                :events="filteredEvents"
                :label="selectedActionLabel"
                @select="openActionReplay"
              />
            </div>

            <section class="action-records">
              <header>
                <div>
                  <h2>球種時間軸</h2>
                  <p>選擇紀錄會從事件前 3 秒進入 Replay</p>
                </div>
                <span>{{ filteredEvents.length }} 筆</span>
              </header>
              <UiScrollArea v-if="filteredEvents.length" class="action-records__scroll">
                <div class="action-records__list">
                  <NuxtLink
                    v-for="event in filteredEvents"
                    :key="event.id"
                    :to="replayEventUrl(matchId, event)"
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
                  </NuxtLink>
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
  background: #eef1f4;
}
.entity-list > header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid #dde2e7;
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
.entity-list__group h2 {
  position: sticky;
  top: 0;
  z-index: 2;
  min-height: 34px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 10px;
  margin: 0 9px 0 0;
  padding: 10px 14px 7px;
  background: rgba(238, 241, 244, 0.94);
  color: #707985;
  font-size: 0.63rem;
  backdrop-filter: blur(12px);
}
.entity-list__group h2 small {
  color: #929aa3;
  font-size: 0.54rem;
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
.entity-list__group > button.active {
  background: #fff;
  color: #075fbe;
  box-shadow: inset 3px 0 #0670df;
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
  min-height: 76px !important;
  grid-template-columns: 46px minmax(0, 1fr) auto !important;
  grid-template-rows: auto auto;
  gap: 4px 9px !important;
  margin: 2px 8px 2px 0;
  padding: 9px 12px 9px 10px !important;
  border-radius: 0 12px 12px 0;
}
.entity-player-row.active {
  box-shadow:
    inset 3px 0 #0670df,
    0 5px 16px rgb(37 54 72 / 8%) !important;
}
.entity-jersey {
  width: 38px;
  height: 38px;
  display: grid;
  grid-row: 1 / 3;
  place-items: center;
  align-self: center;
  border-radius: 11px;
  background: #dfe5ea;
  color: #35414c;
  font-size: 0.72rem !important;
  font-weight: 800 !important;
}
.entity-player-row.active .entity-jersey {
  background: #0b67c2;
  color: #fff;
}
.entity-player-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.entity-player-copy b {
  overflow: hidden;
  font-size: 0.69rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entity-player-copy small,
.entity-total small {
  color: #87909a;
  font-size: 0.54rem;
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
.entity-player-row.active .entity-total b {
  color: #075fbe;
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
  box-sizing: border-box;
}
.entity-overview {
  display: grid;
  grid-template-columns: minmax(270px, 0.9fr) minmax(0, 2fr);
  align-items: stretch;
  margin-inline: calc(var(--detail-gutter) * -1);
  padding: 16px var(--detail-gutter);
  border-bottom: 1px solid #e2e7eb;
  background: #f4f7f9;
}
.entity-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding-right: 26px;
}
.entity-title > div {
  min-width: 0;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 10px;
}
.entity-badge {
  width: 44px;
  height: 44px;
  display: flex;
  grid-row: 1 / 3;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  border-radius: 13px;
  background: #17202a;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 780;
  font-variant-numeric: tabular-nums;
}
.entity-badge.local {
  background: #e9edf1;
  color: #333a42;
}
.entity-title p {
  align-self: end;
  margin: 0 0 3px;
  color: #737c87;
  font-size: 0.66rem;
  font-weight: 620;
}
.entity-title h1 {
  align-self: start;
  margin: 0;
  overflow: hidden;
  font-size: clamp(1.45rem, 2.1vw, 1.95rem);
  line-height: 1.08;
  letter-spacing: -0.035em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entity-measures {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: center;
  gap: clamp(8px, 1.2vw, 18px);
  margin: 0;
}
.entity-measures > div {
  min-width: 0;
  padding: 6px 0;
}
.entity-measures dt {
  color: #68727e;
  font-size: 0.64rem;
  font-weight: 650;
}
.entity-measures dd {
  margin: 5px 0 3px;
  font-size: clamp(1.4rem, 2vw, 1.8rem);
  font-weight: 720;
  line-height: 1;
  letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums;
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
  grid-template-columns: minmax(190px, 0.9fr) auto minmax(210px, 1.2fr);
  align-items: center;
  gap: 22px;
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
.action-rate small {
  max-width: 42ch;
  margin: 0;
  color: #7b858f;
  font-size: 0.59rem;
  line-height: 1.55;
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
.action-records__list a {
  min-height: 58px;
  display: grid;
  grid-template-columns: 4px minmax(180px, 1fr) 74px 88px 82px 18px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #e4e7eb;
  color: inherit;
  text-decoration: none;
}
.action-records__list a:hover {
  background: #f2f5f8;
}
.action-records__list > a > i {
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
  .action-rate > small {
    grid-column: 1 / -1;
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
  .action-records__list a {
    grid-template-columns: 4px minmax(150px, 1fr) 65px 90px 18px;
  }
  .action-record__route-state {
    display: none;
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
  .action-records__list a {
    grid-template-columns: 4px minmax(130px, 1fr) 62px 18px;
  }
  .action-record__outcome,
  .action-record__route-state {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .players-loading {
    animation: none;
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
