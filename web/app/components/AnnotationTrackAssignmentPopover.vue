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
const team = computed(() => analytics.value?.teams.find(item => item.id === teamId.value) ?? null)
const previousTrackByRoster = computed(() => {
  const result = new Map<string, number>()
  const candidates = runTracks.value
    .filter(item => item.track_id !== props.trackId && !activeTrackIds.value.has(item.track_id) && item.roster_entry_id)
    .sort((left, right) => Number(right.last_frame_index) - Number(left.last_frame_index))
  for (const item of candidates) if (!result.has(item.roster_entry_id!)) result.set(item.roster_entry_id!, item.track_id)
  return result
})

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
  <div v-if="open && trackId !== null" class="track-popover" :class="track?.court_side" :style="{ left: `${x}px`, top: `${y}px` }" role="dialog" aria-label="快速指派球員" @click.stop>
    <header><span><UserRoundCog :size="15" /><b>{{ team?.shortName || team?.name || '隊伍' }}</b> · T{{ String(trackId).padStart(2, '0') }}<small>手動 ReID</small></span><button type="button" aria-label="關閉" @click="emit('close')"><X :size="14" /></button></header>
    <div v-if="pending && !analytics" class="loading"><LoaderCircle class="spin" :size="16" />載入中</div>
    <template v-else>
      <button type="button" class="player-option" :class="{ selected: !track?.roster_entry_id }" :disabled="pending" @click="assign('')"><span>清除球員關聯</span><Check v-if="!track?.roster_entry_id" :size="13" /></button>
      <UiScrollArea class="player-scroll"><div>
        <button v-for="player in players" :key="player.roster_entry_id" type="button" class="player-option" :class="{ selected: track?.roster_entry_id === player.roster_entry_id }" :disabled="pending" @click="assign(player.roster_entry_id)"><span><b>#{{ player.jersey_number }}</b><span class="player-name">{{ player.name }}<small v-if="previousTrackByRoster.has(player.roster_entry_id)">接續 T{{ String(previousTrackByRoster.get(player.roster_entry_id)).padStart(2, '0') }}</small><small v-else>目前未追蹤</small></span></span><Check v-if="track?.roster_entry_id === player.roster_entry_id" :size="13" /></button>
      </div></UiScrollArea>
      <p v-if="!players.length" class="empty">目前沒有可指派的場下球員</p>
      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.track-popover{--team:#91a0b2;position:absolute;z-index:30;width:252px;max-height:340px;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;overflow:hidden;transform:translate(-50%,10px);border:1px solid color-mix(in srgb,var(--team) 28%,#303840);border-radius:10px;background:#11161be8;color:#edf1f4;box-shadow:0 18px 42px #000b;backdrop-filter:blur(16px) saturate(135%)}.track-popover.left{--team:#22d3ee}.track-popover.right{--team:#fb7185}.track-popover header{height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 7px 0 11px;border-bottom:1px solid #ffffff14;box-shadow:inset 3px 0 var(--team)}.track-popover header span{display:flex;align-items:center;gap:6px;font-size:.65rem;font-weight:700}.track-popover header b{color:var(--team);font-weight:850}.track-popover header small{padding:2px 5px;border-radius:4px;background:#ffffff0d;color:#98a3ad;font-size:.48rem}.track-popover header button{width:27px;min-height:27px!important;display:grid;place-items:center;padding:0!important;border:0!important;background:transparent!important}.player-scroll{max-height:240px}.player-option{width:100%;min-height:42px!important;display:flex;align-items:center;justify-content:space-between;padding:0 10px!important;border:0!important;border-bottom:1px solid #ffffff0c!important;border-radius:0!important;background:transparent!important;color:#bac2ca!important;font-size:.62rem}.player-option:hover,.player-option.selected{background:color-mix(in srgb,var(--team) 9%,#1b2228)!important;color:#fff!important}.player-option>span{display:flex;align-items:center;gap:8px;text-align:left}.player-option b{min-width:28px;color:var(--team)}.player-name{display:grid!important;gap:1px!important}.player-name small{color:#737f8b;font-size:.52rem;font-weight:500}.loading,.empty{min-height:56px;display:flex;align-items:center;justify-content:center;gap:7px;margin:0;color:#7f8994;font-size:.61rem}.error{margin:6px;padding:6px;border-radius:5px;background:#391d20;color:#ffb4b9;font-size:.58rem}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
