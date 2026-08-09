<script setup lang="ts">
import { Check, LoaderCircle, UserRoundCog, X } from 'lucide-vue-next'
import { createCoachDomainClient, type CoachMatchAnalytics } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

const props = defineProps<{
  open: boolean
  matchId: string
  analysisRunId: string | null
  trackId: number | null
  currentFrame: number
  leftTeamId: string | null
  rightTeamId: string | null
  x: number
  y: number
}>()
const emit = defineEmits<{ close: []; changed: [] }>()
const client = createCoachDomainClient(createGraphQLTransport('/graphql'))
const analytics = shallowRef<CoachMatchAnalytics | null>(null)
const pending = ref(false)
const error = ref<string | null>(null)

const track = computed(() => analytics.value?.tracks.find(item => item.analysis_run_id === props.analysisRunId && item.track_id === props.trackId) ?? null)
const runTracks = computed(() => analytics.value?.tracks.filter(item => item.analysis_run_id === props.analysisRunId) ?? [])
const teamId = computed(() => track.value?.court_side === 'right' ? props.rightTeamId : props.leftTeamId)
const activeTrackIds = computed(() => new Set(runTracks.value.filter(item => props.currentFrame >= Number(item.first_frame_index) && props.currentFrame <= Number(item.last_frame_index)).map(item => item.track_id)))
const unavailableRosterIds = computed(() => new Set(runTracks.value.filter(item => item.track_id !== props.trackId && activeTrackIds.value.has(item.track_id) && item.roster_entry_id).map(item => item.roster_entry_id)))
const players = computed(() => analytics.value?.players.filter(player => player.team_id === teamId.value && !unavailableRosterIds.value.has(player.roster_entry_id)) ?? [])

async function refresh() {
  if (!props.open || !props.analysisRunId || props.trackId === null) return
  pending.value = true
  error.value = null
  try { analytics.value = await client.analytics(props.matchId) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '無法載入球員名單' }
  finally { pending.value = false }
}

async function assign(rosterEntryId: string) {
  if (!props.analysisRunId || props.trackId === null) return
  pending.value = true
  try {
    if (rosterEntryId) await client.assignTrackIdentity({ analysisRunId: props.analysisRunId, trackId: props.trackId, rosterEntryId })
    else await client.clearTrackIdentity({ analysisRunId: props.analysisRunId, trackId: props.trackId })
    emit('changed')
    emit('close')
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '指派失敗' }
  finally { pending.value = false }
}

watch(() => [props.open, props.analysisRunId, props.trackId], refresh, { immediate: true })
</script>

<template>
  <div v-if="open && trackId !== null" class="track-popover" :style="{ left: `${x}px`, top: `${y}px` }" role="dialog" aria-label="快速指派球員" @click.stop>
    <header><span><UserRoundCog :size="15" />Track {{ trackId }}</span><button type="button" aria-label="關閉" @click="emit('close')"><X :size="14" /></button></header>
    <div v-if="pending && !analytics" class="loading"><LoaderCircle class="spin" :size="16" />載入中</div>
    <template v-else>
      <button type="button" class="player-option" :class="{ selected: !track?.roster_entry_id }" :disabled="pending" @click="assign('')"><span>未知球員</span><Check v-if="!track?.roster_entry_id" :size="13" /></button>
      <UiScrollArea class="player-scroll"><div>
        <button v-for="player in players" :key="player.roster_entry_id" type="button" class="player-option" :class="{ selected: track?.roster_entry_id === player.roster_entry_id }" :disabled="pending" @click="assign(player.roster_entry_id)"><span><b>#{{ player.jersey_number }}</b>{{ player.name }}</span><Check v-if="track?.roster_entry_id === player.roster_entry_id" :size="13" /></button>
      </div></UiScrollArea>
      <p v-if="!players.length" class="empty">目前沒有可指派的場下球員</p>
      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.track-popover{position:absolute;z-index:30;width:228px;max-height:300px;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;overflow:hidden;transform:translate(-50%,10px);border:1px solid #3c444c;border-radius:9px;background:#15191df5;color:#edf1f4;box-shadow:0 16px 36px #000a;backdrop-filter:blur(12px)}.track-popover header{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 7px 0 10px;border-bottom:1px solid #2b3238}.track-popover header span{display:flex;align-items:center;gap:6px;font-size:.65rem;font-weight:750}.track-popover header button{width:25px;min-height:25px!important;display:grid;place-items:center;padding:0!important;border:0!important;background:transparent!important}.player-scroll{max-height:210px}.player-option{width:100%;min-height:34px!important;display:flex;align-items:center;justify-content:space-between;padding:0 10px!important;border:0!important;border-bottom:1px solid #252b31!important;border-radius:0!important;background:transparent!important;color:#bac2ca!important;font-size:.61rem}.player-option:hover,.player-option.selected{background:#232b32!important;color:#fff!important}.player-option span{display:flex;align-items:center;gap:7px}.player-option b{min-width:26px;color:#9fc7eb}.loading,.empty{min-height:56px;display:flex;align-items:center;justify-content:center;gap:7px;margin:0;color:#7f8994;font-size:.61rem}.error{margin:6px;padding:6px;border-radius:5px;background:#391d20;color:#ffb4b9;font-size:.58rem}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
