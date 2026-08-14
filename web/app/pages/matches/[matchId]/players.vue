<script setup lang="ts">
import { Activity, BarChart3, ChevronRight, CircleAlert, UserRoundSearch } from 'lucide-vue-next'
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

type ViewMode = 'players' | 'tracks' | 'teams'

const route = useRoute()
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

const selectedPlayer = computed(() => analytics.value?.players.find(player => player.roster_entry_id === selectedPlayerId.value) ?? analytics.value?.players[0] ?? null)
const selectedPlayerTeam = computed(() => analytics.value?.teams.find(team => team.id === selectedPlayer.value?.team_id) ?? null)
const selectedTeam = computed(() => analytics.value?.teams.find(team => team.id === selectedTeamId.value) ?? analytics.value?.teams[0] ?? null)
const selectedTeamPlayers = computed(() => analytics.value?.players.filter(player => player.team_id === selectedTeam.value?.id) ?? [])
const selectedTeamTracks = computed(() => analytics.value && selectedTeam.value ? teamTracks(analytics.value, selectedTeam.value.id) : [])
const selectedTeamParticipation = computed(() => analytics.value && selectedTeam.value ? teamParticipation(analytics.value, selectedTeam.value.id) : 0)
const selectedTeamWinRate = computed(() => {
  const team = selectedTeam.value
  return team?.sample_count ? team.wins / team.sample_count : null
})
const selectedParticipation = computed(() => analytics.value && selectedPlayer.value ? playerParticipation(analytics.value, selectedPlayer.value.roster_entry_id) : [])
const selectedShare = computed(() => analytics.value && selectedPlayer.value ? playerContactShare(analytics.value, selectedPlayer.value.roster_entry_id) : 0)
const identityCoverage = computed(() => analytics.value?.metrics.identity_coverage?.value ?? 0)
const localTracks = computed(() => [...(analytics.value?.tracks ?? [])].sort((left, right) => Number(Boolean(left.roster_entry_id)) - Number(Boolean(right.roster_entry_id)) || right.set_number - left.set_number || right.rally_ordinal - left.rally_ordinal || left.track_id - right.track_id))
const selectedLocalTrack = computed(() => localTracks.value.find(track => trackKey(track) === selectedTrackKey.value) ?? localTracks.value[0] ?? null)
const selectedMappedPlayer = computed(() => analytics.value?.players.find(player => player.roster_entry_id === selectedLocalTrack.value?.roster_entry_id) ?? null)
const selectedTracks = computed(() => {
  if (viewMode.value === 'players') return analytics.value?.tracks.filter(track => track.roster_entry_id === selectedPlayer.value?.roster_entry_id) ?? []
  if (viewMode.value === 'teams') return selectedTeamTracks.value
  return selectedLocalTrack.value ? [selectedLocalTrack.value] : []
})
const eventState = useCoachTrackEvents(selectedTracks)
const selectedReplay = computed(() => selectedLocalTrack.value ? eventState.replays.get(selectedLocalTrack.value.rally_id) ?? null : null)
const selectedLocalTeamId = computed(() => {
  const track = selectedLocalTrack.value
  const replay = selectedReplay.value
  if (!track || !replay) return null
  return track.court_side === 'left' ? replay.rally.left_team.id : track.court_side === 'right' ? replay.rally.right_team.id : null
})
const actionOptions = computed(() => {
  const byKey = new Map<string, { key: string; label: string; count: number }>()
  for (const event of eventState.events.value) {
    const current = byKey.get(event.actionKey)
    byKey.set(event.actionKey, { key: event.actionKey, label: event.actionLabel, count: (current?.count ?? 0) + 1 })
  }
  return [...byKey.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-Hant'))
})
const filteredEvents = computed(() => selectedActionKey.value === 'all' ? eventState.events.value : eventState.events.value.filter(event => event.actionKey === selectedActionKey.value))
const outcomeSummary = computed(() => actionOutcomeRate(filteredEvents.value))
const selectedHeatmap = computed(() => filteredEvents.value.filter(event => event.courtPosition))
const selectedActionLabel = computed(() => selectedActionKey.value === 'all' ? '全部動作' : actionOptions.value.find(option => option.key === selectedActionKey.value)?.label ?? '所選動作')
const analyticsErrorMessage = computed(() => {
  const message = analyticsState.error.value?.message
  if (!message) return ''
  if (message === 'Unexpected error.') return '分析服務版本與本地資料庫尚未同步。請完成資料庫 migration 後重試。'
  return message
})

watch(analytics, (value) => {
  if (!selectedPlayerId.value || !value?.players.some(player => player.roster_entry_id === selectedPlayerId.value)) selectedPlayerId.value = value?.players[0]?.roster_entry_id ?? null
  if (!selectedTeamId.value || !value?.teams.some(team => team.id === selectedTeamId.value)) selectedTeamId.value = value?.teams[0]?.id ?? null
  if (!selectedTrackKey.value || !value?.tracks.some(track => trackKey(track) === selectedTrackKey.value)) {
    const first = value?.tracks.find(track => !track.roster_entry_id) ?? value?.tracks[0]
    selectedTrackKey.value = first ? trackKey(first) : null
  }
}, { immediate: true })
watch([viewMode, actionOptions], () => {
  if (selectedActionKey.value !== 'all' && !actionOptions.value.some(option => option.key === selectedActionKey.value)) selectedActionKey.value = 'all'
})

function trackKey(track: { analysis_run_id: string; track_id: number }) {
  return `${track.analysis_run_id}:${track.track_id}`
}

function playerBadge(player: NonNullable<typeof selectedPlayer.value>) {
  return `[${player.position === 'UNSPECIFIED' ? '—' : player.position}] ${player.jersey_number}`
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
  return event.outcome === 'won' ? '該回合得分' : event.outcome === 'lost' ? '對方得分' : '結果未判定'
}

function refreshAfterIdentityChange() {
  void analyticsState.refresh()
  void eventState.refresh()
}
</script>

<template>
  <section class="players-view">
    <div v-if="analyticsState.pending.value" class="players-loading" aria-busy="true" />
    <div v-else-if="analyticsState.error.value && !analytics" class="players-state" role="alert"><CircleAlert :size="22" /><strong>球員資料載入失敗</strong><span>{{ analyticsErrorMessage }}</span><button type="button" @click="analyticsState.refresh">重試</button></div>
    <div v-else-if="analytics" class="players-layout">
      <aside class="entity-list" aria-label="分析對象">
        <header>
          <UiTabs v-model="viewMode" class="entity-mode" :options="viewTabs" aria-label="分析方式" />
          <NuxtLink :to="`/matches/${matchId}/stats`" aria-label="完整統計"><BarChart3 :size="16" /></NuxtLink>
        </header>
        <UiScrollArea class="entity-list__scroll">
          <div v-if="viewMode === 'players'">
            <section v-for="team in analytics.teams" :key="team.id" class="entity-list__group">
              <h2>{{ team.name }}</h2>
              <button v-for="player in analytics.players.filter(item => item.team_id === team.id)" :key="player.roster_entry_id" type="button" :class="{ active: selectedPlayer?.roster_entry_id === player.roster_entry_id }" @click="selectPlayer(player.roster_entry_id)">
                <span>{{ playerBadge(player) }}</span><b>{{ player.name }}</b><small>{{ player.contact_count }} 擊球</small>
              </button>
            </section>
            <p v-if="!analytics.players.length" class="entity-list__empty">尚無球員資料</p>
          </div>
          <div v-else-if="viewMode === 'tracks'">
            <section v-for="rally in analytics.rallies.filter(item => localTracks.some(track => track.rally_id === item.id))" :key="rally.id" class="entity-list__group">
              <h2>第 {{ rally.set_number }} 局 · 回合 {{ rally.ordinal }}</h2>
              <button v-for="track in localTracks.filter(item => item.rally_id === rally.id)" :key="trackKey(track)" type="button" :class="{ active: selectedTrackKey === trackKey(track) }" @click="selectTrack(trackKey(track))">
                <span>{{ trackLabel(track) }}</span><b>{{ analytics.players.find(player => player.roster_entry_id === track.roster_entry_id)?.name ?? '未分配球員' }}</b><small>{{ track.court_side === 'left' ? '左側' : track.court_side === 'right' ? '右側' : '場側未知' }}</small>
              </button>
            </section>
            <p v-if="!localTracks.length" class="entity-list__empty">尚無片段追蹤資料</p>
          </div>
          <div v-else>
            <section class="entity-list__group team-entities">
              <h2>全隊統計</h2>
              <button v-for="team in analytics.teams" :key="team.id" type="button" :class="{ active: selectedTeam?.id === team.id }" @click="selectTeam(team.id)">
                <span>{{ team.shortName || 'TEAM' }}</span><b>{{ team.name }}</b><small>{{ teamParticipation(analytics, team.id) }} 回合</small>
              </button>
            </section>
            <p v-if="!analytics.teams.length" class="entity-list__empty">尚無隊伍資料</p>
          </div>
        </UiScrollArea>
      </aside>

      <UiScrollArea v-if="(viewMode === 'players' && selectedPlayer) || (viewMode === 'tracks' && selectedLocalTrack) || (viewMode === 'teams' && selectedTeam)" class="entity-detail-scroll">
        <main class="entity-detail">
          <header class="entity-title">
            <div v-if="viewMode === 'players' && selectedPlayer">
              <span class="entity-badge">{{ playerBadge(selectedPlayer) }}</span>
              <p>{{ selectedPlayerTeam?.name }} · {{ rosterPositionLabel(selectedPlayer.position) }}</p>
              <h1>{{ selectedPlayer.name }}</h1>
            </div>
            <div v-else-if="viewMode === 'tracks' && selectedLocalTrack">
              <span class="entity-badge local">{{ trackLabel(selectedLocalTrack) }}</span>
              <p>第 {{ selectedLocalTrack.set_number }} 局 · 回合 {{ selectedLocalTrack.rally_ordinal }} · {{ selectedLocalTrack.court_side === 'left' ? '左側' : selectedLocalTrack.court_side === 'right' ? '右側' : '場側未知' }}</p>
              <h1>{{ selectedMappedPlayer?.name ?? '未分配球員' }}</h1>
            </div>
            <div v-else-if="selectedTeam">
              <span class="entity-badge team">{{ selectedTeam.shortName || 'TEAM' }}</span>
              <p>隊伍完整統計 · {{ selectedTeamPlayers.length }} 名登錄球員</p>
              <h1>{{ selectedTeam.name }}</h1>
            </div>
            <span v-if="analyticsState.refreshing.value || eventState.pending.value" class="entity-sync">同步中</span>
          </header>

          <dl class="entity-measures">
            <template v-if="viewMode === 'players' && selectedPlayer">
              <div><dt>分析擊球</dt><dd>{{ selectedPlayer.contact_count }}</dd><small>已綁定到此球員的事件</small></div>
              <div><dt>佔已辨識擊球</dt><dd>{{ (selectedShare * 100).toFixed(1) }}%</dd><small>{{ analytics.players.reduce((sum, player) => sum + player.contact_count, 0) }} 個已辨識事件</small></div>
              <div><dt>參與回合</dt><dd>{{ selectedParticipation.length }}</dd><small>具有此球員軌跡的回合</small></div>
              <div><dt>場次識別覆蓋</dt><dd>{{ (identityCoverage * 100).toFixed(1) }}%</dd><small>{{ analytics.metrics.identity_coverage?.sample_count ?? 0 }} 條球員軌跡</small></div>
            </template>
            <template v-else-if="viewMode === 'tracks' && selectedLocalTrack">
              <div><dt>動作事件</dt><dd>{{ eventState.events.value.length }}</dd><small>此片段 ID 的模型動作</small></div>
              <div><dt>動作種類</dt><dd>{{ actionOptions.length }}</dd><small>依 provider label 動態產生</small></div>
              <div><dt>出現範圍</dt><dd>{{ Number(BigInt(selectedLocalTrack.last_frame_index) - BigInt(selectedLocalTrack.first_frame_index) + 1n) }}</dd><small>frames {{ selectedLocalTrack.first_frame_index }}–{{ selectedLocalTrack.last_frame_index }}</small></div>
              <div><dt>人物狀態</dt><dd class="mapping-state">{{ selectedMappedPlayer ? '已綁定' : '待分配' }}</dd><small>{{ selectedMappedPlayer ? playerBadge(selectedMappedPlayer) : '仍保留此 local ID 的所有紀錄' }}</small></div>
            </template>
            <template v-else-if="selectedTeam">
              <div><dt>模型動作</dt><dd>{{ eventState.events.value.length }}</dd><small>含未分配片段 ID 的分析事件</small></div>
              <div><dt>動作種類</dt><dd>{{ actionOptions.length }}</dd><small>隊伍所有可用動作分類</small></div>
              <div><dt>參與回合</dt><dd>{{ selectedTeamParticipation }}</dd><small>含已辨識的匿名人物 ID</small></div>
              <div><dt>已確認勝率</dt><dd>{{ selectedTeamWinRate === null ? '—' : `${(selectedTeamWinRate * 100).toFixed(1)}%` }}</dd><small>{{ selectedTeam.wins }} 勝 · {{ selectedTeam.losses }} 負 · {{ selectedTeam.unknown }} 未知</small></div>
            </template>
          </dl>

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
              <div><Activity :size="17" /><span><strong>動作分析</strong><small>依模型輸出動態分類；未知 label 會保留原名</small></span></div>
              <div class="action-filters" aria-label="動作篩選">
                <button type="button" :class="{ active: selectedActionKey === 'all' }" @click="selectedActionKey = 'all'">全部 <b>{{ eventState.events.value.length }}</b></button>
                <button v-for="option in actionOptions" :key="option.key" type="button" :class="{ active: selectedActionKey === option.key }" @click="selectedActionKey = option.key"><i :style="{ background: actionColor(option.key) }" />{{ option.label }} <b>{{ option.count }}</b></button>
              </div>
            </header>

            <div class="action-overview">
              <article class="action-heatmap">
                <header><strong>{{ selectedActionLabel }}位置</strong><span>{{ selectedHeatmap.length }} 個座標樣本</span></header>
                <div class="court-map" aria-label="動作位置熱圖">
                  <i class="net" />
                  <span
                    v-for="event in selectedHeatmap"
                    :key="event.id"
                    :style="{ left: `${Math.max(0, Math.min(100, event.courtPosition!.x * 100))}%`, top: `${Math.max(0, Math.min(100, event.courtPosition!.y * 100))}%`, '--action-color': actionColor(event.actionKey) }"
                    :title="`第 ${event.setNumber} 局 · 回合 ${event.rallyOrdinal} · ${event.actionLabel}`"
                  />
                  <p v-if="!filteredEvents.length">目前沒有可用的動作資料</p>
                  <p v-else-if="!selectedHeatmap.length">這個篩選沒有可用的場地位置</p>
                </div>
              </article>
              <aside class="action-rate">
                <span>動作後回合得分率</span>
                <strong>{{ outcomeSummary.rate === null ? '—' : `${(outcomeSummary.rate * 100).toFixed(1)}%` }}</strong>
                <p>{{ outcomeSummary.won }} / {{ outcomeSummary.resolved }} 個已判定事件</p>
                <small>這是該動作發生後的回合結果，不會把回合得分誤標成直接殺球成功。<template v-if="outcomeSummary.unknown">另有 {{ outcomeSummary.unknown }} 筆結果未判定。</template></small>
              </aside>
            </div>

            <section class="action-records">
              <header><div><h2>動作時間軸</h2><p>選擇紀錄會從事件前 5 秒進入 Replay</p></div><span>{{ filteredEvents.length }} 筆</span></header>
              <UiScrollArea v-if="filteredEvents.length" class="action-records__scroll">
                <div class="action-records__list">
                  <NuxtLink v-for="event in filteredEvents" :key="event.id" :to="replayEventUrl(matchId, event)">
                    <i :style="{ background: actionColor(event.actionKey) }" />
                    <div class="action-record__identity"><strong>{{ event.actionLabel }}</strong><span>第 {{ event.setNumber }} 局 · 回合 {{ event.rallyOrdinal }} · ID {{ event.trackId }}</span></div>
                    <time>{{ formatActionTime(event.anchorTimeUs) }}</time>
                    <span class="action-record__outcome" :data-outcome="event.outcome">{{ outcomeLabel(event) }}</span>
                    <span v-if="event.actionConfidence !== null" class="action-record__confidence">{{ Math.round(event.actionConfidence * 100) }}%</span>
                    <ChevronRight :size="17" />
                  </NuxtLink>
                </div>
              </UiScrollArea>
              <div v-else class="action-records__empty"><UserRoundSearch :size="20" /><strong>{{ eventState.error.value ? '動作紀錄載入失敗' : '目前沒有符合的動作紀錄' }}</strong><span>{{ eventState.error.value?.message ?? '模型尚未提供動作 label 時，不顯示推測資料。' }}</span></div>
            </section>
          </section>

          <section v-if="viewMode === 'players'" class="participation-list">
            <header><div><h2>參與回合</h2><p>由已完成分析與人物綁定即時彙整</p></div><span>{{ selectedParticipation.length }} 回合</span></header>
            <div v-if="selectedParticipation.length">
              <NuxtLink v-for="track in selectedParticipation" :key="track.rally_id" :to="`/matches/${matchId}/replay/${track.rally_id}`">
                <div><strong>第 {{ track.set_number }} 局 · 回合 {{ track.rally_ordinal }}</strong><span>ID {{ track.track_id }} · frame {{ track.first_frame_index }}–{{ track.last_frame_index }}</span></div><ChevronRight :size="18" />
              </NuxtLink>
            </div>
            <p v-else>目前沒有已綁定到這位球員的分析軌跡。</p>
          </section>

          <section v-if="viewMode === 'teams' && selectedTeam" class="team-roster-summary">
            <header><div><h2>球員分布</h2><p>點選球員可切換到個人動作、熱區與時間軸</p></div><span>{{ selectedTeamPlayers.length }} 人</span></header>
            <div v-if="selectedTeamPlayers.length" class="team-roster-summary__rows">
              <button v-for="player in [...selectedTeamPlayers].sort((left, right) => right.contact_count - left.contact_count)" :key="player.roster_entry_id" type="button" @click="openPlayer(player.roster_entry_id)">
                <span class="entity-badge">{{ playerBadge(player) }}</span>
                <strong>{{ player.name }}</strong>
                <span>{{ rosterPositionLabel(player.position) }}</span>
                <b>{{ player.contact_count }} 擊球</b>
                <small>{{ player.rally_count }} 回合</small>
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
.players-view{height:100%;min-height:0;overflow:hidden}.players-layout{height:100%;min-height:0;display:grid;grid-template-columns:300px minmax(0,1fr);overflow:hidden;border-block:1px solid #e0e5e9;background:#fbfcfd}.entity-list{min-height:0;display:grid;grid-template-rows:52px minmax(0,1fr);overflow:hidden;border-right:1px solid #dfe4e8;background:#eef1f4}.entity-list>header{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #dde2e7}.entity-list>header>a{width:36px;height:36px;display:grid;place-items:center;border-radius:9px;color:#69737e}.entity-list>header>a:hover{background:#e2e7ec;color:#0670df}.entity-mode{min-width:0;flex:1}.entity-list__scroll,.entity-detail-scroll{height:100%;min-height:0}.entity-list__group h2{position:sticky;top:0;z-index:2;margin:0;padding:12px 14px 7px;background:rgba(238,241,244,.94);color:#707985;font-size:.63rem;backdrop-filter:blur(12px)}.entity-list__group>button{width:100%;min-height:55px;display:grid;grid-template-columns:62px minmax(0,1fr) auto;align-items:center;gap:8px;padding:0 14px;border:0;background:transparent;color:#20242a;text-align:left}.entity-list__group>button:hover{background:#e5eaf0}.entity-list__group>button.active{background:#fff;color:#075fbe;box-shadow:inset 3px 0 #0670df}.entity-list__group>button>span{font-size:.67rem;font-weight:780;font-variant-numeric:tabular-nums}.entity-list__group>button>b{overflow:hidden;font-size:.72rem;text-overflow:ellipsis;white-space:nowrap}.entity-list__group>button>small{color:#858d97;font-size:.57rem;font-variant-numeric:tabular-nums}.entity-list__empty{padding:22px 14px;color:#7b858f;font-size:.68rem}.entity-detail{min-width:0;min-height:100%;padding:clamp(25px,3.6vw,50px) clamp(28px,4.5vw,68px);box-sizing:border-box}.entity-title{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.entity-title>div{min-width:0}.entity-badge{display:inline-flex;min-height:27px;align-items:center;padding:0 8px;border-radius:7px;background:#17202a;color:#fff;font-size:.68rem;font-weight:780;font-variant-numeric:tabular-nums}.entity-badge.local{background:#e9edf1;color:#333a42}.entity-title p{margin:13px 0 3px;color:#737c87;font-size:.7rem;font-weight:620}.entity-title h1{margin:0;font-size:clamp(2rem,4vw,3.45rem);line-height:1;letter-spacing:-.035em}.entity-sync{color:#74808b;font-size:.62rem}.entity-measures{display:grid;grid-template-columns:repeat(4,1fr);margin:clamp(28px,4vw,54px) 0 26px;border-block:1px solid #dfe4e8}.entity-measures>div{min-width:0;padding:18px}.entity-measures>div+div{border-left:1px solid #e1e5e9}.entity-measures dt{color:#68727e;font-size:.64rem;font-weight:650}.entity-measures dd{margin:8px 0 5px;font-size:clamp(1.55rem,2.7vw,2.45rem);font-weight:720;line-height:1;letter-spacing:-.035em;font-variant-numeric:tabular-nums}.entity-measures dd.mapping-state{font-size:1.25rem;letter-spacing:-.01em}.entity-measures small{display:block;color:#858d97;font-size:.58rem;line-height:1.4}.action-workspace{margin-top:34px}.action-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;padding-bottom:12px;border-bottom:1px solid #dfe4e8}.action-toolbar>div:first-child{display:flex;align-items:center;gap:8px}.action-toolbar>div:first-child>span{display:grid;gap:2px}.action-toolbar strong{font-size:.78rem}.action-toolbar small{color:#7c858f;font-size:.59rem}.action-filters{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}.action-filters button{min-height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:#68727c;font-size:.63rem;font-weight:690}.action-filters button:hover{background:#eef2f5}.action-filters button.active{background:#e4ebf2;color:#10161d}.action-filters i{width:7px;height:7px;border-radius:50%}.action-filters b{font-size:.57rem;font-variant-numeric:tabular-nums}.action-overview{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(220px,.5fr);gap:24px;padding:26px 0;border-bottom:1px solid #dfe4e8}.action-heatmap>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.action-heatmap>header strong{font-size:.72rem}.action-heatmap>header span{color:#7b858f;font-size:.59rem}.court-map{position:relative;aspect-ratio:18/9;overflow:hidden;border:1px solid #8496a3;background:linear-gradient(90deg,#e8c88f 0 49.7%,#d3b276 49.7% 50.3%,#e8c88f 50.3%)}.court-map::before,.court-map::after{position:absolute;inset-block:0;width:1px;background:#ffffffbd;content:""}.court-map::before{left:16.666%}.court-map::after{right:16.666%}.court-map .net{position:absolute;z-index:1;inset-block:0;left:50%;width:2px;background:#f8fafc}.court-map>span{position:absolute;z-index:2;width:12px;height:12px;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:50%;background:var(--action-color);box-shadow:0 2px 7px color-mix(in srgb,var(--action-color) 55%,transparent)}.court-map p{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:#6d5c40;font-size:.68rem}.action-rate{display:flex;min-width:0;flex-direction:column;justify-content:center;padding-left:24px;border-left:1px solid #e0e5e9}.action-rate>span{color:#6d7782;font-size:.66rem;font-weight:680}.action-rate>strong{margin:10px 0 4px;font-size:clamp(2.2rem,4.2vw,4rem);line-height:1;letter-spacing:-.045em;font-variant-numeric:tabular-nums}.action-rate p{margin:0;color:#414951;font-size:.68rem}.action-rate small{max-width:34ch;margin-top:12px;color:#7b858f;font-size:.59rem;line-height:1.55}.action-records{padding-top:26px}.action-records>header,.participation-list>header{display:flex;align-items:end;justify-content:space-between;gap:16px;padding-bottom:10px;border-bottom:1px solid #dfe4e8}.action-records h2,.participation-list h2{margin:0;font-size:.86rem}.action-records header p,.participation-list header p{margin:3px 0 0;color:#79828c;font-size:.61rem}.action-records header>span,.participation-list header>span{color:#707a85;font-size:.63rem}.action-records__scroll{height:min(300px,36dvh)}.action-records__list a{min-height:58px;display:grid;grid-template-columns:4px minmax(180px,1fr) 74px 100px 48px 18px;align-items:center;gap:12px;border-bottom:1px solid #e4e7eb;color:inherit;text-decoration:none}.action-records__list a:hover{background:#f2f5f8}.action-records__list>a>i{width:3px;height:30px;border-radius:2px}.action-record__identity{display:grid;gap:3px}.action-record__identity strong{font-size:.71rem}.action-record__identity span,.action-record__confidence{color:#7c858f;font-size:.58rem}.action-records time{font-size:.68rem;font-weight:720;font-variant-numeric:tabular-nums}.action-record__outcome{font-size:.6rem}.action-record__outcome[data-outcome="won"]{color:#187742}.action-record__outcome[data-outcome="lost"]{color:#a53a3f}.action-record__outcome[data-outcome="unknown"]{color:#7b858e}.action-records__list svg{color:#8b949d}.action-records__empty{min-height:130px;display:grid;place-content:center;justify-items:center;gap:6px;color:#77818b}.action-records__empty strong{font-size:.7rem}.action-records__empty span{font-size:.6rem}.participation-list{margin-top:36px}.participation-list>div a{min-height:58px;display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid #e4e7eb;color:inherit;text-decoration:none}.participation-list>div a:hover{background:#f2f5f8}.participation-list>div a>div{display:grid;gap:3px}.participation-list>div strong{font-size:.71rem}.participation-list>div span{color:#7c858f;font-size:.58rem;font-variant-numeric:tabular-nums}.participation-list>p{margin:0;padding:22px 0;color:#7b848f;font-size:.68rem}.players-loading{height:100%;background:linear-gradient(100deg,#edf0f3 20%,#e2e6ea 40%,#edf0f3 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.players-state{height:100%;display:grid;place-content:center;justify-items:center;gap:8px;color:#707984}.players-state span{max-width:48ch;font-size:.7rem;line-height:1.55;text-align:center}.players-state button{min-height:38px;padding:0 14px;border:0;border-radius:9px;background:#e4e9ef;font-weight:700}@keyframes shimmer{to{background-position:-200% 0}}@media(max-width:980px){.players-layout{grid-template-columns:260px minmax(0,1fr)}.action-overview{grid-template-columns:1fr}.action-rate{padding:18px 0 0;border-top:1px solid #e0e5e9;border-left:0}.action-records__list a{grid-template-columns:4px minmax(150px,1fr) 65px 90px 18px}.action-record__confidence{display:none}}@media(max-width:760px){.players-layout{grid-template-columns:220px minmax(0,1fr)}.entity-detail{padding:22px}.entity-measures{grid-template-columns:repeat(2,1fr)}.entity-measures>div:nth-child(3){border-left:0;border-top:1px solid #e1e5e9}.entity-measures>div:nth-child(4){border-top:1px solid #e1e5e9}.action-toolbar{align-items:flex-start;flex-direction:column}.action-filters{justify-content:flex-start}.action-records__list a{grid-template-columns:4px minmax(130px,1fr) 62px 18px}.action-record__outcome,.action-record__confidence{display:none}}@media(prefers-reduced-motion:reduce){.players-loading{animation:none}}@media(prefers-reduced-transparency:reduce){.entity-list__group h2{background:#eef1f4;backdrop-filter:none}}
.players-layout{grid-template-columns:316px minmax(0,1fr)}
.team-entities>button{grid-template-columns:52px minmax(0,1fr) auto}
.entity-badge.team{background:#0b67c2}
.action-records>header,.participation-list>header,.team-roster-summary>header{display:flex;align-items:end;justify-content:space-between;gap:16px;padding-bottom:10px;border-bottom:1px solid #dfe4e8}
.action-records h2,.participation-list h2,.team-roster-summary h2{margin:0;font-size:.86rem}
.action-records header p,.participation-list header p,.team-roster-summary header p{margin:3px 0 0;color:#79828c;font-size:.61rem}
.action-records header>span,.participation-list header>span,.team-roster-summary header>span{color:#707a85;font-size:.63rem}
.team-roster-summary{margin-top:36px}
.team-roster-summary>p{margin:0;padding:22px 0;color:#7b848f;font-size:.68rem}
.team-roster-summary__rows>button{width:100%;min-height:58px;display:grid;grid-template-columns:68px minmax(160px,1fr) minmax(90px,.7fr) 82px 68px 18px;align-items:center;gap:12px;padding:0;border:0;border-bottom:1px solid #e4e7eb;background:transparent;color:#20262c;text-align:left}
.team-roster-summary__rows>button:hover{background:#f2f5f8}
.team-roster-summary__rows>button>strong{font-size:.72rem}
.team-roster-summary__rows>button>span:not(.entity-badge),.team-roster-summary__rows>button>small{color:#7c858f;font-size:.6rem}
.team-roster-summary__rows>button>b{font-size:.68rem;font-variant-numeric:tabular-nums}
.team-roster-summary__rows svg{color:#8b949d}
@media(max-width:980px){.players-layout{grid-template-columns:272px minmax(0,1fr)}.team-roster-summary__rows>button{grid-template-columns:68px minmax(130px,1fr) 78px 68px 18px}.team-roster-summary__rows>button>span:nth-child(3){display:none}}
@media(max-width:760px){.players-layout{grid-template-columns:232px minmax(0,1fr)}.team-roster-summary__rows>button{grid-template-columns:68px minmax(110px,1fr) 68px 18px}.team-roster-summary__rows>button>small{display:none}}
</style>
