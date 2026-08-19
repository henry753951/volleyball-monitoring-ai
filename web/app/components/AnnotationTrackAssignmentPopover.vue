<script setup lang="ts">
import { CircleHelp, LoaderCircle, ShieldCheck, UserRoundCog, X } from 'lucide-vue-next'
import { computed } from 'vue'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'
import PlayerIdentityPreview from './PlayerIdentityPreview.vue'
import UiPlayerCombobox from './ui/PlayerCombobox.vue'
import UiPopover from './ui/Popover.vue'

const props = defineProps<{
  open: boolean
  matchId: string
  analysisRunId: string | null
  trackId: number | null
  leftTeamId: string | null
  rightTeamId: string | null
  x: number
  y: number
}>()
const emit = defineEmits<{ close: [] }>()
const workstation = useAnnotationWorkstationService()
const assignment = workstation.identity!
if (!assignment)
  throw new Error(
    'Identity assignment controller was not provided by the annotation route boundary',
  )
const presentation = computed(() => {
  const track = props.trackId === null ? null : assignment.view.model.track.byId(props.trackId)
  const teamId =
    track?.court_side === 'left'
      ? props.leftTeamId
      : track?.court_side === 'right'
        ? props.rightTeamId
        : null
  return {
    track,
    team: assignment.state.analytics?.teams.find(item => item.id === teamId) ?? null,
    players: assignment.view.model.players.forTeam(null),
    status: track
      ? assignment.view.model.track.status(track)
      : { label: '無辨識資料', tone: 'muted' as const },
    tidLabel: track ? assignment.view.model.track.tidLabel(track) : null,
    gidLabel: track ? assignment.view.model.track.gidLabel(track) : null,
    options:
      props.trackId === null
        ? []
        : assignment.view.model.options.forTrack({ teamId: null, trackId: props.trackId }),
    previewSide:
      import.meta.client && props.x < window.innerWidth / 2
        ? ('right' as const)
        : ('left' as const),
  }
})

function handleOpenChange(open: boolean) {
  if (open) assignment.actions.setInteractionSurface('popover')
  if (!open) emit('close')
}

function requestTrackAssignment(rosterEntryId: string | null) {
  if (props.trackId === null) return
  assignment.actions.setInteractionSurface('popover')
  void workstation.actions.execute(rosterEntryId ? 'identity.assign' : 'identity.clear', {
    trackId: props.trackId,
    rosterEntryId,
  })
}
</script>

<template>
  <UiPopover
    :open="open && trackId !== null"
    side="right"
    align="start"
    :side-offset="12"
    :collision-padding="12"
    sticky="always"
    :content-class="`track-popover ${presentation.track?.court_side ?? ''}`"
    aria-label="快速指派球員"
    @update:open="handleOpenChange"
  >
    <template #anchor
      ><span class="track-popover-anchor" :style="{ left: `${x}px`, top: `${y}px` }"
    /></template>
    <header>
      <span
        ><UserRoundCog :size="15" /><b>{{
          presentation.team?.shortName || presentation.team?.name || '兩隊'
        }}</b>
        · {{ presentation.tidLabel }} · {{ presentation.gidLabel }}<small>球員辨識</small></span
      ><button type="button" aria-label="關閉" @click="emit('close')"><X :size="14" /></button>
    </header>
    <div v-if="assignment.state.loading && !assignment.state.analytics" class="loading">
      <LoaderCircle class="spin" :size="16" />載入中
    </div>
    <template v-else>
      <div class="identity-summary" :data-tone="presentation.status.tone">
        <ShieldCheck
          v-if="['manual', 'propagated'].includes(presentation.status.tone)"
          :size="13"
        /><CircleHelp v-else :size="13" /><span
          ><b>{{ presentation.status.label }}</b
          ><small
            >{{ presentation.tidLabel }} · {{ presentation.gidLabel
            }}<template v-if="presentation.track?.identity_confidence != null">
              · {{ Math.round(presentation.track.identity_confidence * 100) }}%</template
            ></small
          ></span
        >
      </div>
      <div
        v-if="presentation.players.length && !assignment.state.dialogs.correction"
        class="player-picker"
      >
        <span>選擇球員</span
        ><UiPlayerCombobox
          :model-value="presentation.track?.roster_entry_id ?? ''"
          :options="presentation.options"
          :disabled="!workstation.actions.state('identity.assign').value.enabled"
          :preview-side="presentation.previewSide"
          :aria-label="`指派 ${presentation.tidLabel} ${presentation.gidLabel} 的球員`"
          @update:model-value="requestTrackAssignment($event)"
        >
          <template #preview="{ option }"
            ><PlayerIdentityPreview
              v-if="assignment.view.model.players.byRosterEntry(option.value)"
              :match-id="matchId"
              :roster-entry-id="option.value"
              :player-name="assignment.view.model.players.byRosterEntry(option.value)!.name"
              :jersey-number="
                assignment.view.model.players.byRosterEntry(option.value)!.jersey_number
              "
              :tracks="assignment.state.analytics?.tracks ?? []"
              :analysis-run-id="analysisRunId"
              :track-id="trackId"
          /></template>
        </UiPlayerCombobox>
      </div>
      <div
        v-if="
          assignment.state.interactionSurface === 'popover' && assignment.state.dialogs.correction
        "
        class="correction-choice"
        role="dialog"
        aria-label="選擇球員修正方式"
      >
        <strong>為什麼要改成「{{ assignment.state.dialogs.correction.playerName }}」？</strong>
        <p>
          <template v-if="assignment.state.dialogs.correction.previousPlayerName">
            目前整個 GID 綁定「{{ assignment.state.dialogs.correction.previousPlayerName }}」。
          </template>
          請確認是整個 GID 與球員配錯，還是只有這個 Local ID 被分到錯的 GID。
        </p>
        <p v-if="assignment.state.dialogs.correction.occupiedGidLabel" class="swap-warning">
          「{{ assignment.state.dialogs.correction.playerName }}」目前由
          {{ assignment.state.dialogs.correction.occupiedGidLabel }} 使用；選第一項會交換兩個 GID，
          不會清掉另一邊的其他 Local。
        </p>
        <button
          type="button"
          @click="workstation.actions.execute('identity.apply-correction', 'from_here')"
        >
          <b>{{
            assignment.state.dialogs.correction.occupiedGidLabel
              ? '交換兩個 GID 的球員綁定'
              : '只重綁目前 GID'
          }}</b
          ><small>保留其他 GID；從這段起生效，過去片段不回寫</small>
        </button>
        <template
          v-for="candidate in assignment.state.dialogs.correction.swapCandidates"
          :key="candidate.gidId"
        >
          <button
            v-if="!assignment.state.dialogs.correction.occupiedGidLabel"
            type="button"
            @click="assignment.actions.swapGidBinding(candidate.gidId)"
          >
            <b>與 {{ candidate.gidLabel }} 交換球員</b
            ><small
              >最近出現在第 {{ candidate.setNumber }} 局 · 回合 {{ candidate.rallyOrdinal }}</small
            >
          </button>
        </template>
        <button
          v-if="!assignment.state.dialogs.correction.occupiedGidLabel"
          type="button"
          @click="workstation.actions.execute('identity.apply-correction', 'split_identity')"
        >
          <b>只有這個 Local ID 的 GID 判錯</b
          ><small>把這個 Local 從原 GID 拆開，原 GID 的其他 Local 不變</small>
        </button>
        <button
          type="button"
          @click="workstation.actions.execute('identity.apply-correction', 'clip_only')"
        >
          <b>只改這個 Local 的顯示</b><small>不改 GID、不交換，也不讓這次修正進入後續特徵庫</small>
        </button>
        <button type="button" class="cancel" @click="assignment.actions.closeCorrection">
          取消
        </button>
      </div>
      <p v-if="!presentation.players.length" class="empty">目前沒有可指派的球員</p>
      <p v-if="assignment.state.error" class="error">{{ assignment.state.error }}</p>
    </template>
  </UiPopover>
</template>

<style>
.track-popover-anchor {
  position: fixed;
  width: 2px;
  height: 2px;
  pointer-events: none;
}
.ui-popover.track-popover {
  --team: #91a0b2;
  z-index: 1250;
  width: min(304px, calc(100vw - 24px));
  max-height: min(470px, calc(100dvh - 24px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  overflow: hidden;
  padding: 0;
  border-color: color-mix(in srgb, var(--team) 30%, #3f3f46);
  border-radius: 12px;
  background: #11161bf2;
  color: #edf1f4;
  box-shadow: 0 20px 54px #000c;
  backdrop-filter: blur(18px) saturate(140%);
}
.track-popover.left {
  --team: #22d3ee;
}
.track-popover.right {
  --team: #fb7185;
}
.track-popover header {
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid #ffffff14;
  box-shadow: inset 3px 0 var(--team);
}
.track-popover header span {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.67rem;
  font-weight: 700;
}
.track-popover header b {
  color: var(--team);
  font-weight: 850;
}
.track-popover header small {
  padding: 2px 5px;
  border-radius: 4px;
  background: #ffffff0d;
  color: #98a3ad;
  font-size: 0.49rem;
}
.track-popover header button {
  width: 29px;
  min-height: 29px !important;
  display: grid;
  place-items: center;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
}
.track-popover .ui-popover__arrow {
  fill: #11161b;
}
.identity-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  border-bottom: 1px solid #ffffff0c;
  color: #aab4bd;
  background: #171d22;
}
.identity-summary[data-tone='manual'],
.identity-summary[data-tone='propagated'] {
  color: #8cddb1;
}
.identity-summary[data-tone='required'] {
  color: #f4c881;
}
.identity-summary span {
  display: grid;
  gap: 1px;
}
.identity-summary b {
  font-size: 0.61rem;
}
.identity-summary small {
  color: #aab3bb;
  font-size: 0.52rem;
}
.player-picker {
  display: grid;
  gap: 6px;
  padding: 11px;
}
.player-picker > span {
  color: #aab3bb;
  font-size: 0.56rem;
  font-weight: 700;
}
.warning-preference {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 11px;
  border-top: 1px solid #ffffff0c;
  color: #aeb7bf;
  font-size: 0.55rem;
}
.loading,
.empty {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin: 0;
  color: #a1a1aa;
  font-size: 0.62rem;
}
.error {
  margin: 6px 10px 10px;
  padding: 7px;
  border-radius: 6px;
  background: #391d20;
  color: #ffb4b9;
  font-size: 0.58rem;
}
.correction-choice {
  display: grid;
  gap: 6px;
  padding: 11px;
  background: #171c20;
}
.correction-choice strong {
  font-size: 0.66rem;
}
.correction-choice p {
  margin: 0 0 2px;
  color: #aeb7bf;
  font-size: 0.56rem;
  line-height: 1.45;
}
.correction-choice p.swap-warning {
  padding: 6px 7px;
  border: 1px solid #6b572d;
  border-radius: 6px;
  background: #2c2518;
  color: #f4cf82;
}
.correction-choice button {
  min-height: 42px !important;
  display: grid !important;
  justify-items: start;
  padding: 7px 9px !important;
  border: 1px solid #3d4852 !important;
  border-radius: 7px !important;
  background: #20272d !important;
  text-align: left;
}
.correction-choice button:hover {
  border-color: #60707d !important;
  background: #283139 !important;
}
.correction-choice button:focus-visible {
  outline: 2px solid #9fc7eb;
  outline-offset: 1px;
}
.correction-choice button b {
  color: #eef2f5;
  font-size: 0.61rem;
}
.correction-choice button small {
  color: #a6b0b8;
  font-size: 0.52rem;
}
.correction-choice button.cancel {
  min-height: 30px !important;
  display: block !important;
  background: transparent !important;
  color: #b9c1c8 !important;
  text-align: center;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
