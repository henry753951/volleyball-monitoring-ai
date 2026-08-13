<script setup lang="ts">
import { CircleHelp, LoaderCircle, RotateCcw, ShieldCheck, UserRoundCheck } from 'lucide-vue-next'
import { computed } from 'vue'
import { useIdentityAssignmentController } from '~/composables/useIdentityAssignmentController'
import type { CoachTeam } from '~/lib/coachDomain'
import IdentityReplacementDialog from './IdentityReplacementDialog.vue'
import PlayerIdentityPreview from './PlayerIdentityPreview.vue'
import UiPlayerCombobox from './ui/PlayerCombobox.vue'
import UiSwitch from './ui/Switch.vue'

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
const assignment = useIdentityAssignmentController({
  matchId: () => props.matchId,
  analysisRunId: () => props.analysisRunId,
  currentFrame: () => props.currentFrame,
  refreshKey: () => props.refreshToken,
  refreshAfterCommit: true,
  onChanged: () => emit('changed'),
})

const groups = computed(() => [
  { side: 'left', teamId: props.leftTeamId, label: props.teams.find(team => team.id === props.leftTeamId)?.name ?? '左隊' },
  { side: 'right', teamId: props.rightTeamId, label: props.teams.find(team => team.id === props.rightTeamId)?.name ?? '右隊' },
  { side: 'unknown', teamId: null, label: '未判定場側' },
].map(group => ({
  ...group,
  rows: assignment.view.model.tracks
    .filter(track => track.court_side === group.side)
    .map(track => ({
      track,
      active: assignment.view.model.activeTrackIds.has(track.track_id),
      status: assignment.view.model.track.status(track),
      gidLabel: assignment.view.model.track.gidLabel(track),
      options: assignment.view.model.options.forTrack({ teamId: group.teamId, trackId: track.track_id }),
    })),
})))

function toggleComplete() {
  void assignment.actions.setMappingCompleted(!props.mappingCompleted)
}
</script>

<template>
  <div class="identity-panel">
    <div v-if="!analysisRunId" class="identity-empty">選取已完成分析的片段</div>
    <div v-else-if="assignment.state.loading && !assignment.state.analytics" class="identity-empty"><LoaderCircle class="spin" :size="18" />載入中</div>
    <template v-else>
      <p class="mapping-hint">系統會沿用先前確認的球員；不確定的項目可從完整名單修正。</p>
      <section v-for="group in groups" :key="group.side">
        <header><span>{{ group.label }}</span><b>{{ group.rows.length }}</b></header>
        <p v-if="!group.rows.length">沒有追蹤球員</p>
        <template v-for="row in group.rows" :key="row.track.track_id">
          <label :class="{ focused: focusedTrackId === row.track.track_id }">
            <code><span>T{{ String(row.track.track_id).padStart(2, '0') }}</span><i :class="{ active: row.active }">{{ row.active ? '畫面中' : '未出現' }}</i><small v-if="row.gidLabel">{{ row.gidLabel }}</small></code>
            <span class="identity-control">
              <span class="identity-state" :data-tone="row.status.tone"><ShieldCheck v-if="['manual', 'propagated'].includes(row.status.tone)" :size="11" /><CircleHelp v-else :size="11" />{{ row.status.label }}<small v-if="row.track.identity_confidence != null">{{ Math.round(row.track.identity_confidence * 100) }}%</small></span>
              <span class="identity-select">
                <UiPlayerCombobox :model-value="row.track.roster_entry_id ?? ''" :options="row.options" :disabled="assignment.state.savingTrackId === row.track.track_id" :aria-label="`指派 T${row.track.track_id} 的球員`" @update:model-value="assignment.actions.requestAssignment({ trackId: row.track.track_id, rosterEntryId: $event })">
                  <template #preview="{ option }"><PlayerIdentityPreview v-if="assignment.view.model.players.byRosterEntry(option.value)" :match-id="matchId" :roster-entry-id="option.value" :player-name="assignment.view.model.players.byRosterEntry(option.value)!.name" :jersey-number="assignment.view.model.players.byRosterEntry(option.value)!.jersey_number" :tracks="assignment.state.analytics?.tracks ?? []" :analysis-run-id="analysisRunId" :track-id="row.track.track_id" /></template>
                </UiPlayerCombobox>
                <LoaderCircle v-if="assignment.state.savingTrackId === row.track.track_id" class="spin" :size="14" />
              </span>
            </span>
          </label>
          <div v-if="assignment.state.dialogs.correction?.trackId === row.track.track_id" class="identity-choice" role="dialog" aria-label="選擇球員修正方式">
            <strong>要如何套用「{{ assignment.state.dialogs.correction.playerName }}」？</strong>
            <p>這會決定後續片段是否沿用這次修正。</p>
            <button type="button" @click="assignment.actions.applyCorrection('from_here')"><b>從這段起改正球員</b><small>適合先前綁錯姓名；較早片段不變</small></button>
            <button type="button" @click="assignment.actions.applyCorrection('split_identity')"><b>這其實是不同的人</b><small>適合替補或辨識混人；拆開後續資料</small></button>
            <button type="button" @click="assignment.actions.applyCorrection('clip_only')"><b>只修正這個片段</b><small>不影響之後的自動辨識</small></button>
            <button type="button" class="cancel" @click="assignment.actions.closeCorrection">取消</button>
          </div>
        </template>
      </section>
      <p v-if="!assignment.view.model.identityReady" class="identity-required"><CircleHelp :size="13" />仍有待指派球員，確認後即可完成。</p>
      <button type="button" class="identity-complete" :class="{ completed: mappingCompleted }" :disabled="assignment.view.busy || !assignment.view.model.tracks.length || (!mappingCompleted && !assignment.view.model.identityReady)" @click="toggleComplete">
        <RotateCcw v-if="mappingCompleted" :size="15" />
        <UserRoundCheck v-else :size="15" />
        {{ mappingCompleted ? '重新開放指派' : '完成球員指派' }}
      </button>
      <label class="replacement-preference"><span>球員已被使用時顯示取代提示</span><UiSwitch v-model="assignment.preferences.replacementWarningEnabled" /></label>
      <p v-if="assignment.state.error" class="identity-error" role="alert">{{ assignment.state.error }}</p>
    </template>
    <IdentityReplacementDialog v-if="assignment.state.dialogs.replacement" :open="true" :player-name="assignment.state.dialogs.replacement.playerName" :occupied-track-id="assignment.state.dialogs.replacement.occupiedTrackId" :target-track-id="assignment.state.dialogs.replacement.trackId" :warning-enabled="assignment.preferences.replacementWarningEnabled" @update:warning-enabled="assignment.preferences.replacementWarningEnabled = $event" @close="assignment.actions.closeReplacement" @confirm="assignment.actions.confirmReplacement" />
  </div>
</template>

<style scoped>
.identity-panel{display:grid;gap:14px}.mapping-hint{margin:0;padding:4px;color:#8f99a3;font-size:.58rem;line-height:1.5}.identity-panel section{display:grid;gap:2px}.identity-panel section header{height:31px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2c3238;color:#d9dfe5;font-size:.7rem;font-weight:700}.identity-panel section header b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;color:#aeb8c2;font-size:.61rem;text-align:center}.identity-panel section>p,.identity-empty{min-height:56px;display:flex;align-items:center;justify-content:center;gap:7px;color:#7f8994;font-size:.68rem}.identity-panel label{min-height:42px;display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:8px;border-bottom:1px solid #23292f}.identity-panel code{color:#aab3bd;font-size:.64rem}.identity-select{position:relative;display:flex;min-width:0;align-items:center}.identity-select>.spin{position:absolute;right:9px;z-index:2;color:#52c88a;pointer-events:none}.identity-complete{min-height:36px!important;display:flex;align-items:center;justify-content:center;gap:7px;border-color:#397253!important;background:#183527!important;color:#a9ebc8!important;font-size:.7rem}.identity-complete.completed{border-color:#59636d!important;background:#20252b!important;color:#d5dbe1!important}.identity-error{margin:0;padding:8px;border:1px solid #7f3e43;border-radius:6px;background:#321a1d;color:#ffb4b9;font-size:.67rem}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
<style scoped>
.identity-panel label{min-height:46px;grid-template-columns:86px minmax(0,1fr);padding:0 4px}.identity-panel label.focused{background:#202a32;box-shadow:inset 2px 0 #9fc7eb}.identity-panel code{display:grid;gap:2px}.identity-panel code i{color:#68737e;font-size:.5rem;font-style:normal}.identity-panel code i.active{color:#72d8a0}
.replacement-preference{min-height:38px!important;display:flex!important;grid-template-columns:none!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;padding:5px 2px!important;color:#a1a1aa;font-size:.59rem}
.identity-panel label{min-height:58px;grid-template-columns:70px minmax(0,1fr)}
.identity-panel code>span{color:#e4e9ed;font-size:.7rem}
.identity-panel code small{overflow:hidden;color:#76828d;font-size:.5rem;font-weight:500;text-overflow:ellipsis}
.identity-control{display:grid;gap:4px;min-width:0;padding:5px 0}
.identity-state{display:flex;align-items:center;gap:4px;color:#99a4ae;font-size:.56rem}
.identity-state[data-tone="manual"],.identity-state[data-tone="propagated"]{color:#8cddb1}
.identity-state[data-tone="required"]{color:#f4c881}
.identity-state small{margin-left:auto;color:inherit;font-size:.52rem}
.identity-choice{display:grid;gap:6px;padding:10px 8px 12px;border-bottom:1px solid #38414a;background:#171c20}
.identity-choice strong{color:#f2f5f7;font-size:.68rem}
.identity-choice>p{min-height:0!important;display:block!important;margin:0 0 2px!important;color:#aeb7bf!important;font-size:.58rem!important}
.identity-choice button{min-height:42px!important;display:grid!important;justify-items:start;padding:7px 9px!important;border:1px solid #3d4852!important;border-radius:7px!important;background:#20272d!important;text-align:left}
.identity-choice button:hover{border-color:#60707d!important;background:#283139!important}
.identity-choice button:focus-visible{outline:2px solid #9fc7eb;outline-offset:1px}
.identity-choice button b{color:#eef2f5;font-size:.63rem}
.identity-choice button small{color:#a6b0b8;font-size:.54rem}
.identity-choice button.cancel{min-height:30px!important;display:block!important;background:transparent!important;color:#b9c1c8!important;text-align:center}
.identity-required{min-height:32px!important;display:flex!important;align-items:center!important;justify-content:flex-start!important;gap:6px!important;margin:0!important;padding:6px 8px!important;color:#f4c881!important;font-size:.58rem!important}
</style>
