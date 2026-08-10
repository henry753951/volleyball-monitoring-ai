<script setup lang="ts">
import { LoaderCircle, RotateCcw, UserRoundCheck } from 'lucide-vue-next'
import { createCoachDomainClient, type CoachMatchAnalytics, type CoachTeam } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

const props = defineProps<{
  matchId: string
  analysisRunId: string | null
  leftTeamId: string | null
  rightTeamId: string | null
  teams: CoachTeam[]
  mappingCompleted: boolean
  currentFrame?: number
  focusedTrackId?: number | null
  refreshToken?: number
}>()
const emit = defineEmits<{ changed: [] }>()
const client = createCoachDomainClient(createGraphQLTransport('/graphql'))
const analytics = shallowRef<CoachMatchAnalytics | null>(null)
const pending = ref(false)
const savingTrack = ref<number | null>(null)
const error = ref<string | null>(null)

const tracks = computed(() => analytics.value?.tracks.filter(track => track.analysis_run_id === props.analysisRunId) ?? [])
const groups = computed(() => [
  { side: 'left', teamId: props.leftTeamId, label: props.teams.find(team => team.id === props.leftTeamId)?.name ?? '左隊' },
  { side: 'right', teamId: props.rightTeamId, label: props.teams.find(team => team.id === props.rightTeamId)?.name ?? '右隊' },
].map(group => ({ ...group, tracks: tracks.value.filter(track => track.court_side === group.side || (track.court_side === 'unknown' && group.side === 'left')) })))
const activeTracks = computed(() => new Set(tracks.value.filter(track => props.currentFrame !== undefined && props.currentFrame >= Number(track.first_frame_index) && props.currentFrame <= Number(track.last_frame_index)).map(track => track.track_id)))

function playersFor(teamId: string | null) {
  return analytics.value?.players.filter(player => !teamId || player.team_id === teamId) ?? []
}
function playerOptions(teamId: string | null, trackId: number) {
  const unavailable = new Set(tracks.value.filter(track => track.track_id !== trackId && activeTracks.value.has(track.track_id) && track.roster_entry_id).map(track => track.roster_entry_id))
  return [
    { value: '', label: '清除關聯' },
    ...playersFor(teamId).filter(player => !unavailable.has(player.roster_entry_id)).map(player => ({ value: player.roster_entry_id, label: `#${player.jersey_number} ${player.name}` })),
  ]
}

async function refresh() {
  if (!props.analysisRunId) { analytics.value = null; return }
  pending.value = true
  error.value = null
  try { analytics.value = await client.analytics(props.matchId) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '無法載入球員指派' }
  finally { pending.value = false }
}

async function assign(trackId: number, rosterEntryId: string) {
  if (!props.analysisRunId) return
  savingTrack.value = trackId
  error.value = null
  try {
    if (rosterEntryId) await client.assignTrackIdentity({ analysisRunId: props.analysisRunId, trackId, rosterEntryId })
    else await client.clearTrackIdentity({ analysisRunId: props.analysisRunId, trackId })
    await refresh()
    emit('changed')
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '儲存失敗' }
  finally { savingTrack.value = null }
}

function handleAssign(trackId: number, event: Event) {
  void assign(trackId, (event.target as HTMLSelectElement).value)
}

async function toggleComplete() {
  if (!props.analysisRunId || pending.value) return
  pending.value = true
  error.value = null
  try {
    await client.setTrackIdentityMappingComplete({ analysisRunId: props.analysisRunId, completed: !props.mappingCompleted })
    emit('changed')
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '狀態更新失敗' }
  finally { pending.value = false }
}

watch([() => props.analysisRunId, () => props.refreshToken], refresh, { immediate: true })
</script>

<template>
  <div class="identity-panel">
    <div v-if="!analysisRunId" class="identity-empty">選取已完成分析的片段</div>
    <div v-else-if="pending && !analytics" class="identity-empty"><LoaderCircle class="spin" :size="18" />載入中</div>
    <template v-else>
      <p class="mapping-hint">點擊播放器中的球員框可開啟手動 ReID；也可直接使用清單調整。</p>
      <section v-for="group in groups" :key="group.side">
        <header><span>{{ group.label }}</span><b>{{ group.tracks.length }}</b></header>
        <p v-if="!group.tracks.length">沒有追蹤球員</p>
        <label v-for="track in group.tracks" :key="track.track_id" :class="{ focused: focusedTrackId === track.track_id }">
          <code>Track {{ track.track_id }}<i :class="{ active: activeTracks.has(track.track_id) }">{{ activeTracks.has(track.track_id) ? '場上' : '離場' }}</i></code>
          <span class="identity-select">
            <select :value="track.roster_entry_id ?? ''" :disabled="savingTrack === track.track_id" :aria-label="`指派 Track ${track.track_id} 的球員`" @change="handleAssign(track.track_id, $event)">
              <option v-for="option in playerOptions(group.teamId, track.track_id)" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <LoaderCircle v-if="savingTrack === track.track_id" class="spin" :size="14" />
          </span>
        </label>
      </section>
      <button type="button" class="identity-complete" :class="{ completed: mappingCompleted }" :disabled="pending || !tracks.length" @click="toggleComplete">
        <RotateCcw v-if="mappingCompleted" :size="15" />
        <UserRoundCheck v-else :size="15" />
        {{ mappingCompleted ? '重新開放指派' : '完成球員指派' }}
      </button>
      <p v-if="error" class="identity-error" role="alert">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.identity-panel{display:grid;gap:14px}.mapping-hint{margin:0;padding:4px;color:#8f99a3;font-size:.58rem;line-height:1.5}.identity-panel section{display:grid;gap:2px}.identity-panel section header{height:31px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2c3238;color:#d9dfe5;font-size:.7rem;font-weight:700}.identity-panel section header b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;color:#aeb8c2;font-size:.61rem;text-align:center}.identity-panel section>p,.identity-empty{min-height:56px;display:flex;align-items:center;justify-content:center;gap:7px;color:#7f8994;font-size:.68rem}.identity-panel label{min-height:42px;display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:8px;border-bottom:1px solid #23292f}.identity-panel code{color:#aab3bd;font-size:.64rem}.identity-select{position:relative;display:flex;min-width:0;align-items:center}.identity-select select{width:100%;height:32px;padding:0 30px 0 9px;border:1px solid #3f464d;border-radius:7px;outline:0;background:#191d21;color:#f1f4f6;font-size:.66rem;cursor:pointer}.identity-select select:hover:not(:disabled){border-color:#59636d;background:#20252a}.identity-select select:focus-visible{border-color:#9fc7eb;box-shadow:0 0 0 2px #9fc7eb2e}.identity-select select:disabled{cursor:wait;opacity:.58}.identity-select>.spin{position:absolute;right:9px;z-index:2;color:#52c88a;pointer-events:none}.identity-complete{min-height:36px!important;display:flex;align-items:center;justify-content:center;gap:7px;border-color:#397253!important;background:#183527!important;color:#a9ebc8!important;font-size:.7rem}.identity-complete.completed{border-color:#59636d!important;background:#20252b!important;color:#d5dbe1!important}.identity-error{margin:0;padding:8px;border:1px solid #7f3e43;border-radius:6px;background:#321a1d;color:#ffb4b9;font-size:.67rem}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
<style scoped>
.identity-panel label{min-height:46px;grid-template-columns:86px minmax(0,1fr);padding:0 4px}.identity-panel label.focused{background:#202a32;box-shadow:inset 2px 0 #9fc7eb}.identity-panel code{display:grid;gap:2px}.identity-panel code i{color:#68737e;font-size:.5rem;font-style:normal}.identity-panel code i.active{color:#72d8a0}
</style>
