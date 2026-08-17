<script setup lang="ts">
import {
  CircleHelp,
  Database,
  ListTree,
  LoaderCircle,
  RefreshCw,
  ScanText,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'
import type { CoachTeam } from '~/lib/coachDomain'
import IdentityJerseySuggestionDialog from './IdentityJerseySuggestionDialog.vue'
import PlayerIdentityPreview from './PlayerIdentityPreview.vue'
import UiPlayerCombobox from './ui/PlayerCombobox.vue'

const props = defineProps<{
  matchId: string
  analysisRunId: string | null
  leftTeamId: string | null
  rightTeamId: string | null
  teams: CoachTeam[]
}>()
const emit = defineEmits<{
  'select-track': [selection: { trackId: number; rallyId: string; firstFrameIndex: string }]
}>()
const displayMode = ref<'local' | 'group'>('local')
const workstation = useAnnotationWorkstationService()
const assignment = workstation.identity!
if (!assignment)
  throw new Error(
    'Identity assignment controller was not provided by the annotation route boundary',
  )

const assignmentCount = computed(
  () => assignment.view.model.tracks.filter(track => track.roster_entry_id).length,
)
const manualCount = computed(
  () => assignment.view.model.tracks.filter(track => track.identity_source === 'manual').length,
)

const localGroups = computed(() =>
  [
    {
      side: 'left',
      teamId: props.leftTeamId,
      label: props.teams.find(team => team.id === props.leftTeamId)?.name ?? '左隊',
    },
    {
      side: 'right',
      teamId: props.rightTeamId,
      label: props.teams.find(team => team.id === props.rightTeamId)?.name ?? '右隊',
    },
    { side: 'unknown', teamId: null, label: '未判定場側' },
  ].map(group => ({
    ...group,
    rows: assignment.view.model.tracks
      .filter(track => track.court_side === group.side)
      .map(track => ({
        track,
        active: assignment.view.model.activeTrackIds.has(track.track_id),
        status: assignment.view.model.track.status(track),
        tidLabel: assignment.view.model.track.tidLabel(track),
        gidCode: assignment.view.model.track.gidCode(track),
        options: assignment.view.model.options.forTrack({
          teamId: group.teamId,
          trackId: track.track_id,
        }),
      })),
  })),
)

const gidGroups = computed(() =>
  [
    {
      teamId: props.leftTeamId,
      label: props.teams.find(team => team.id === props.leftTeamId)?.name ?? '左隊',
    },
    {
      teamId: props.rightTeamId,
      label: props.teams.find(team => team.id === props.rightTeamId)?.name ?? '右隊',
    },
    { teamId: null, label: '未判定隊伍' },
  ]
    .map(group => ({
      ...group,
      rows: assignment.view.model.gidGroups
        .filter(identity => identity.teamId === group.teamId)
        .map(identity => ({
          ...identity,
          options: assignment.view.model.options
            .forTrack({
              teamId: group.teamId,
              trackId: identity.representativeTrackId,
              trackIds: identity.trackIds,
            })
            .filter(option => option.value),
          tidLabels: identity.tracks.map(track => assignment.view.model.track.tidLabel(track)),
        })),
    }))
    .filter(group => group.rows.length > 0),
)

function requestTrackAssignment(trackId: number, rosterEntryId: string | null) {
  assignment.actions.setInteractionSurface('panel')
  void workstation.actions.execute(rosterEntryId ? 'identity.assign' : 'identity.clear', {
    trackId,
    rosterEntryId,
  })
}

function requestGroupAssignment(trackId: number, trackIds: number[], rosterEntryId: string | null) {
  assignment.actions.setInteractionSurface('panel')
  void workstation.actions.execute('identity.assign-gid', {
    trackId,
    trackIds,
    rosterEntryId,
  })
}

function selectTrack(trackId: number, rallyId: string, firstFrameIndex: string) {
  emit('select-track', { trackId, rallyId, firstFrameIndex })
}

function handleTrackRowKeydown(
  event: KeyboardEvent,
  trackId: number,
  rallyId: string,
  firstFrameIndex: string,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  selectTrack(trackId, rallyId, firstFrameIndex)
}
</script>

<template>
  <div class="identity-panel">
    <div v-if="!analysisRunId" class="identity-empty">選取已完成分析的片段</div>
    <div v-else-if="assignment.state.loading && !assignment.state.analytics" class="identity-empty">
      <LoaderCircle class="spin" :size="18" />載入中
    </div>
    <template v-else>
      <div class="identity-toolbar">
        <div class="identity-view-switch" role="tablist" aria-label="球員分派顯示方式">
          <button
            type="button"
            role="tab"
            :aria-selected="displayMode === 'local'"
            :class="{ active: displayMode === 'local' }"
            @click="displayMode = 'local'"
          >
            <ListTree :size="13" />Local 分派<b>{{ assignment.view.model.tracks.length }}</b>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="displayMode === 'group'"
            :class="{ active: displayMode === 'group' }"
            @click="displayMode = 'group'"
          >
            <UsersRound :size="13" />人員群組<b>{{ assignment.view.model.gidGroups.length }}</b>
          </button>
        </div>
        <div class="identity-progress" aria-label="球員指派進度">
          <span
            ><b>{{ assignmentCount }}</b> / {{ assignment.view.model.tracks.length }} 已指派</span
          >
          <small>{{ manualCount }} 筆人工確認 · 未標記不影響後續操作</small>
        </div>
        <button
          type="button"
          class="identity-jersey"
          :disabled="!workstation.actions.state('identity.jersey-suggestions').value.enabled"
          :title="
            workstation.actions.state('identity.jersey-suggestions').value.reason ?? undefined
          "
          @click="workstation.actions.execute('identity.jersey-suggestions')"
        >
          <LoaderCircle
            v-if="assignment.state.jerseySuggestionRequesting"
            class="spin"
            :size="15"
          />
          <ScanText v-else :size="15" />
          <span><b>背號感知</b><small>產生差異建議，不會自動覆寫</small></span>
          <Sparkles :size="13" />
        </button>
        <div class="identity-job-actions" aria-label="ReID 維護工具">
          <button
            type="button"
            class="identity-auto"
            :disabled="!workstation.actions.state('identity.association-rerun').value.enabled"
            :title="
              workstation.actions.state('identity.association-rerun').value.reason ?? undefined
            "
            @click="workstation.actions.execute('identity.association-rerun')"
          >
            <LoaderCircle
              v-if="assignment.state.reidJobAction === 'association'"
              class="spin"
              :size="13"
            /><RefreshCw v-else :size="13" /><span>重新配對</span>
          </button>
          <button
            type="button"
            class="identity-auto"
            :disabled="!workstation.actions.state('identity.feature-rebuild').value.enabled"
            :title="workstation.actions.state('identity.feature-rebuild').value.reason ?? undefined"
            @click="workstation.actions.execute('identity.feature-rebuild')"
          >
            <LoaderCircle
              v-if="assignment.state.reidJobAction === 'feature'"
              class="spin"
              :size="13"
            /><Database v-else :size="13" /><span>重新取特徵</span>
          </button>
        </div>
      </div>
      <p class="mapping-hint">
        {{
          displayMode === 'local'
            ? '逐一確認每個 Local ID 的球員；點擊項目可回到它出現的回合。'
            : '群組代表跨片段的追蹤關聯；球員指派會套用到群組中的 Local ID。'
        }}
      </p>
      <template v-if="displayMode === 'local'">
        <section v-for="group in localGroups" :key="group.side">
          <header>
            <span>{{ group.label }}</span
            ><b>{{ group.rows.length }}</b>
          </header>
          <p v-if="!group.rows.length">沒有追蹤球員</p>
          <template v-for="row in group.rows" :key="row.track.track_id">
            <div
              class="identity-row"
              role="button"
              tabindex="0"
              :aria-label="`跳到 ${row.tidLabel} 出現的回合`"
              @click="
                selectTrack(row.track.track_id, row.track.rally_id, row.track.first_frame_index)
              "
              @keydown="
                handleTrackRowKeydown(
                  $event,
                  row.track.track_id,
                  row.track.rally_id,
                  row.track.first_frame_index,
                )
              "
            >
              <div class="identity-row__meta">
                <div class="identity-row__idline">
                  <code>{{ row.tidLabel }}</code>
                  <span :class="['identity-presence', { active: row.active }]">
                    {{ row.active ? '畫面中' : '未出現' }}
                  </span>
                </div>
                <span class="identity-group-code">{{ row.gidCode }}</span>
              </div>
              <span class="identity-control">
                <span class="identity-state" :data-tone="row.status.tone"
                  ><ShieldCheck
                    v-if="['manual', 'propagated'].includes(row.status.tone)"
                    :size="11"
                  /><CircleHelp v-else :size="11" />{{ row.status.label
                  }}<small v-if="row.track.identity_confidence != null"
                    >{{ Math.round(row.track.identity_confidence * 100) }}%</small
                  ></span
                >
                <span class="identity-select" @click.stop @keydown.stop>
                  <UiPlayerCombobox
                    :model-value="row.track.roster_entry_id ?? ''"
                    :options="row.options"
                    :disabled="!workstation.actions.state('identity.assign').value.enabled"
                    :aria-label="`指派 ${row.tidLabel} ${row.gidCode} 的球員`"
                    @update:model-value="requestTrackAssignment(row.track.track_id, $event)"
                  >
                    <template #preview="{ option }"
                      ><PlayerIdentityPreview
                        v-if="assignment.view.model.players.byRosterEntry(option.value)"
                        :match-id="matchId"
                        :roster-entry-id="option.value"
                        :player-name="
                          assignment.view.model.players.byRosterEntry(option.value)!.name
                        "
                        :jersey-number="
                          assignment.view.model.players.byRosterEntry(option.value)!.jersey_number
                        "
                        :tracks="assignment.state.analytics?.tracks ?? []"
                        :analysis-run-id="analysisRunId"
                        :track-id="row.track.track_id"
                    /></template>
                  </UiPlayerCombobox>
                  <LoaderCircle
                    v-if="assignment.state.savingTrackId === row.track.track_id"
                    class="spin"
                    :size="14"
                  />
                </span>
              </span>
            </div>
            <div
              v-if="
                assignment.state.interactionSurface === 'panel' &&
                assignment.state.dialogs.correction?.trackId === row.track.track_id
              "
              class="identity-choice"
              role="dialog"
              aria-label="選擇球員修正方式"
            >
              <strong
                >為什麼要改成「{{ assignment.state.dialogs.correction.playerName }}」？</strong
              >
              <p>
                <template v-if="assignment.state.dialogs.correction.previousPlayerName">
                  目前整個 GID 綁定「{{
                    assignment.state.dialogs.correction.previousPlayerName
                  }}」。
                </template>
                請區分整個 GID 配錯，或只有目前 Local ID 被分到錯的 GID。
              </p>
              <p v-if="assignment.state.dialogs.correction.occupiedGidLabel" class="swap-warning">
                「{{ assignment.state.dialogs.correction.playerName }}」目前由
                {{ assignment.state.dialogs.correction.occupiedGidLabel }}
                使用；確認第一項會交換兩個 GID 的球員綁定，不會解除另一邊的其他 Local ID。
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
                  @click="workstation.actions.execute('identity.swap-gid-binding', candidate.gidId)"
                >
                  <b>與 {{ candidate.gidLabel }} 交換球員</b
                  ><small
                    >該 GID 最近出現在第 {{ candidate.setNumber }} 局 · 回合
                    {{ candidate.rallyOrdinal }}；兩邊從目前片段起原子交換</small
                  >
                </button>
              </template>
              <button
                v-if="!assignment.state.dialogs.correction.occupiedGidLabel"
                type="button"
                @click="workstation.actions.execute('identity.apply-correction', 'split_identity')"
              >
                <b>只有這個 Local ID 的 GID 判錯</b
                ><small>只拆這個 Local；原 GID 的其他 Local 維持原球員</small>
              </button>
              <button
                type="button"
                @click="workstation.actions.execute('identity.apply-correction', 'clip_only')"
              >
                <b>只改這個 Local 的顯示</b><small>不改 GID 關聯，也不把這次修正加入特徵庫</small>
              </button>
              <button type="button" class="cancel" @click="assignment.actions.closeCorrection">
                取消
              </button>
            </div>
          </template>
        </section>
      </template>
      <template v-else>
        <p v-if="!gidGroups.length" class="identity-empty">
          此片段尚無可用的人員群組，請改用 Local 分派。
        </p>
        <section v-for="group in gidGroups" :key="group.teamId ?? 'unknown'" class="gid-section">
          <header>
            <span>{{ group.label }}</span
            ><b>{{ group.rows.length }}</b>
          </header>
          <div v-for="row in group.rows" :key="row.gidId" class="gid-row">
            <div class="gid-identity">
              <div class="gid-heading">
                <strong>{{ row.gidCode }}</strong>
                <span>{{ row.trackIds.length }} 個 Local ID</span>
              </div>
              <span v-if="row.rosterEntryId" class="gid-player">
                球員 · {{ assignment.view.model.players.byRosterEntry(row.rosterEntryId)?.name }}
              </span>
              <span v-else class="gid-player unassigned">尚未指派球員</span>
              <small class="gid-tids"
                ><span v-for="tid in row.tidLabels" :key="tid">{{ tid }}</span></small
              >
            </div>
            <span class="identity-control">
              <span class="identity-state" :data-tone="row.status.tone"
                ><ShieldCheck
                  v-if="['manual', 'propagated'].includes(row.status.tone)"
                  :size="11"
                /><CircleHelp v-else :size="11" />{{ row.status.label
                }}<small v-if="row.confidence != null"
                  >{{ Math.round(row.confidence * 100) }}%</small
                ></span
              >
              <span class="identity-select">
                <UiPlayerCombobox
                  :model-value="row.rosterEntryId ?? ''"
                  :options="row.options"
                  :disabled="!workstation.actions.state('identity.assign-gid').value.enabled"
                  :aria-label="`依 ${row.gidCode} 批次指派 ${row.trackIds.length} 個 Local ID`"
                  @update:model-value="
                    requestGroupAssignment(row.representativeTrackId, row.trackIds, $event)
                  "
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
                      :track-id="row.representativeTrackId"
                  /></template>
                </UiPlayerCombobox>
                <LoaderCircle
                  v-if="assignment.state.savingTrackId === row.representativeTrackId"
                  class="spin"
                  :size="14"
                />
              </span>
            </span>
          </div>
        </section>
        <p v-if="assignment.view.model.ungroupedTrackCount" class="identity-required">
          <CircleHelp :size="13" />另有 {{ assignment.view.model.ungroupedTrackCount }} 個 Local ID
          尚無人員群組，請在 Local 分派中處理。
        </p>
      </template>
      <p
        v-if="assignment.state.automaticAssignmentResult"
        class="identity-auto-result"
        role="status"
      >
        {{ assignment.state.automaticAssignmentResult }}
      </p>
      <p v-if="assignment.state.reidJobResult" class="identity-auto-result" role="status">
        {{ assignment.state.reidJobResult }}
      </p>
      <p v-if="assignment.state.jerseySuggestionResult" class="identity-auto-result" role="status">
        {{ assignment.state.jerseySuggestionResult }}
      </p>
      <p v-if="assignment.state.error" class="identity-error" role="alert">
        {{ assignment.state.error }}
      </p>
    </template>
    <IdentityJerseySuggestionDialog
      v-if="assignment.state.jerseySuggestionRun"
      :open="assignment.state.dialogs.jerseySuggestions"
      :run="assignment.state.jerseySuggestionRun"
      :applying-ids="assignment.state.jerseySuggestionApplyingIds"
      @close="assignment.actions.closeJerseySuggestions"
      @apply="workstation.actions.execute('identity.apply-jersey-suggestions', $event)"
    />
  </div>
</template>

<style scoped>
.identity-panel {
  display: grid;
  gap: 16px;
  color: #e2e8ed;
}
.identity-toolbar {
  display: grid;
  gap: 8px;
}
.identity-view-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border: 1px solid #2b343c;
  border-radius: 9px;
  background: #1a2025;
}
.identity-view-switch button {
  min-height: 34px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  padding: 5px 8px !important;
  border: 0 !important;
  border-radius: 6px !important;
  background: transparent !important;
  color: #8e9aa4 !important;
  font-size: 0.62rem !important;
  font-weight: 650;
}
.identity-view-switch button.active {
  background: #35424c !important;
  color: #f2f6f8 !important;
}
.identity-view-switch button:focus-visible,
.identity-row:focus-visible {
  outline: 2px solid #9fc7eb;
  outline-offset: 1px;
}
.identity-view-switch b {
  min-width: 19px;
  color: inherit;
  font-size: 0.55rem;
  font-variant-numeric: tabular-nums;
}
.identity-job-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.identity-auto {
  min-height: 32px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  min-width: 92px;
  padding: 5px 9px !important;
  border: 1px solid transparent !important;
  border-radius: 6px !important;
  background: #20272d !important;
  color: #b9c5cc !important;
  font-size: 0.59rem !important;
  white-space: nowrap;
}
.identity-progress {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 1px 2px;
  color: #b8c3ca;
  font-size: 0.59rem;
}
.identity-progress b {
  color: #f0f5f7;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}
.identity-progress small {
  color: #7f8b94;
  font-size: 0.52rem;
  text-align: right;
}
.identity-jersey {
  min-height: 46px !important;
  display: grid !important;
  grid-template-columns: 18px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 9px;
  padding: 7px 10px !important;
  border: 1px solid #386c52 !important;
  border-radius: 8px !important;
  background: #183026 !important;
  color: #b9e8cf !important;
  text-align: left;
}
.identity-jersey:hover:not(:disabled) {
  border-color: #559d77 !important;
  background: #1d3b2e !important;
}
.identity-jersey > span {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.identity-jersey b {
  font-size: 0.66rem;
}
.identity-jersey small {
  overflow: hidden;
  color: #8fbda4;
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity-jersey:disabled {
  opacity: 0.45;
}
.identity-auto:hover:not(:disabled) {
  border-color: #3b4852 !important;
  background: #283139 !important;
  color: #ecf2f5 !important;
}
.identity-auto:focus-visible {
  outline: 2px solid #9fc7eb;
  outline-offset: 1px;
}
.identity-auto:disabled {
  opacity: 0.48;
}
.mapping-hint {
  margin: 0;
  padding: 0 2px;
  color: #9aa6b1;
  font-size: 0.6rem;
  line-height: 1.55;
}
.identity-panel section {
  display: grid;
  gap: 0;
}
.identity-panel section header {
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #303941;
  color: #dce3e8;
  font-size: 0.69rem;
  font-weight: 700;
}
.identity-panel section header b {
  min-width: 21px;
  padding: 2px 5px;
  border-radius: 999px;
  background: #2a333b;
  color: #b8c3cb;
  font-size: 0.57rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.identity-panel section > p,
.identity-empty {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #7f8b96;
  font-size: 0.66rem;
}
.identity-row {
  min-height: 68px;
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 7px 4px;
  border-bottom: 1px solid #252d34;
  cursor: pointer;
  transition: background-color 140ms ease-out;
}
.identity-row:hover {
  background: #171e23;
}
.identity-row__meta {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 5px;
}
.identity-row__idline {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.identity-row__idline code {
  color: #edf2f5;
  font-size: 0.7rem;
  font-weight: 700;
}
.identity-presence {
  color: #6f7b85;
  font-size: 0.51rem;
  white-space: nowrap;
}
.identity-presence.active {
  color: #7bd5a0;
}
.identity-group-code {
  overflow: hidden;
  color: #85929c;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.53rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity-control {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 4px 0;
}
.identity-state {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #a5b0b8;
  font-size: 0.56rem;
}
.identity-state[data-tone='manual'],
.identity-state[data-tone='propagated'] {
  color: #91d9b1;
}
.identity-state[data-tone='required'] {
  color: #e9c17f;
}
.identity-state small {
  margin-left: auto;
  color: inherit;
  font-size: 0.52rem;
  font-variant-numeric: tabular-nums;
}
.identity-select {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
}
.identity-select :deep(.player-combobox__anchor) {
  height: 36px;
  border-color: #39444d;
  border-radius: 7px;
  background: #191f24;
}
.identity-select :deep(.player-combobox__anchor:hover) {
  border-color: #56636d;
  background: #20272d;
}
.identity-select :deep(.player-combobox__anchor:focus-within) {
  border-color: #9fc7eb;
  box-shadow: 0 0 0 2px #9fc7eb2b;
}
.identity-select > .spin {
  position: absolute;
  right: 9px;
  z-index: 2;
  color: #82d5a7;
  pointer-events: none;
}
.identity-choice {
  display: grid;
  gap: 6px;
  margin: 0 4px 8px 92px;
  padding: 10px 9px 11px;
  border: 1px solid #35414a;
  border-radius: 8px;
  background: #1a2126;
}
.identity-choice strong {
  color: #f2f5f7;
  font-size: 0.68rem;
}
.identity-choice > p {
  min-height: 0 !important;
  display: block !important;
  margin: 0 0 2px !important;
  color: #aeb7bf !important;
  font-size: 0.58rem !important;
  line-height: 1.45;
}
.identity-choice > p.swap-warning {
  padding: 6px 7px;
  border: 1px solid #6b572d;
  border-radius: 6px;
  background: #2c2518;
  color: #f4cf82 !important;
}
.identity-choice button {
  min-height: 42px !important;
  display: grid !important;
  justify-items: start;
  padding: 7px 9px !important;
  border: 1px solid #3d4852 !important;
  border-radius: 7px !important;
  background: #20272d !important;
  text-align: left;
}
.identity-choice button:hover {
  border-color: #60707d !important;
  background: #283139 !important;
}
.identity-choice button:focus-visible {
  outline: 2px solid #9fc7eb;
  outline-offset: 1px;
}
.identity-choice button b {
  color: #eef2f5;
  font-size: 0.63rem;
}
.identity-choice button small {
  color: #a6b0b8;
  font-size: 0.54rem;
}
.identity-choice button.cancel {
  min-height: 30px !important;
  display: block !important;
  background: transparent !important;
  color: #b9c1c8 !important;
  text-align: center;
}
.identity-required {
  min-height: 32px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: 6px !important;
  margin: 0 !important;
  padding: 6px 8px !important;
  color: #e9c17f !important;
  font-size: 0.58rem !important;
}
.identity-auto-result {
  margin: 0;
  padding: 8px 9px;
  border: 1px solid #315344;
  border-radius: 7px;
  background: #192720;
  color: #aee6c8;
  font-size: 0.58rem;
  line-height: 1.45;
}
.identity-error {
  margin: 0;
  padding: 8px;
  border: 1px solid #7f3e43;
  border-radius: 6px;
  background: #321a1d;
  color: #ffb4b9;
  font-size: 0.67rem;
}
.gid-section header b {
  min-width: 24px;
}
.gid-row {
  display: grid;
  gap: 9px;
  padding: 12px 4px;
  border-bottom: 1px solid #252d34;
}
.gid-identity {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.gid-heading {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.gid-heading strong {
  color: #e8eef2;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.68rem;
}
.gid-heading span {
  color: #7f8c96;
  font-size: 0.53rem;
}
.gid-player {
  color: #b7c5cd;
  font-size: 0.61rem;
}
.gid-player.unassigned {
  color: #d6b472;
}
.gid-tids {
  display: flex !important;
  flex-wrap: wrap;
  gap: 3px;
  overflow: visible !important;
  text-overflow: clip !important;
}
.gid-tids span {
  padding: 1px 4px;
  border-radius: 4px;
  background: #29323a;
  color: #aeb9c2;
  font-size: 0.49rem;
}
.gid-row .identity-control {
  width: 100%;
  padding: 0;
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
  .identity-row,
  .spin {
    animation: none;
    transition: none;
  }
}
</style>
