<script setup lang="ts">
import { CircleAlert, LoaderCircle, UserRoundCheck } from 'lucide-vue-next'
import { useIdentityAssignmentController } from '~/composables/useIdentityAssignmentController'
import UiSelect from './ui/Select.vue'

const NONE = '__unassigned__'
const props = defineProps<{
  matchId: string
  analysisRunId: string
  trackId: number
  teamId: string | null
}>()
const emit = defineEmits<{ changed: [] }>()
const assignment = useIdentityAssignmentController({
  matchId: () => props.matchId,
  analysisRunId: () => props.analysisRunId,
  refreshKey: () => props.trackId,
  refreshAfterCommit: true,
  onChanged: () => emit('changed'),
})
const track = computed(() => assignment.view.model.track.byId(props.trackId))
const status = computed(() =>
  track.value ? assignment.view.model.track.status(track.value) : null,
)
const options = computed(() =>
  assignment.view.model.options
    .forTrack({ teamId: props.teamId, trackId: props.trackId })
    .map(option => ({
      value: option.value || NONE,
      label: option.value ? option.label : '未分配球員（清除綁定）',
    })),
)
const selected = computed({
  get: () => track.value?.roster_entry_id ?? NONE,
  set: value =>
    assignment.actions.requestAssignment({
      trackId: props.trackId,
      rosterEntryId: value === NONE ? '' : value,
    }),
})
</script>

<template>
  <section class="track-identity-editor" aria-label="片段人物綁定">
    <header>
      <div>
        <UserRoundCheck :size="17" /><span
          ><strong>人物綁定</strong><small>修改後會同步到標註端與其他教練畫面</small></span
        >
      </div>
      <span v-if="status" :data-tone="status.tone">{{ status.label }}</span>
    </header>
    <div class="track-identity-editor__control">
      <UiSelect
        v-model="selected"
        :options="options"
        :disabled="assignment.view.busy"
        :aria-label="`指派 ID ${trackId} 的球員`"
      />
      <LoaderCircle v-if="assignment.state.savingTrackId === trackId" class="spin" :size="16" />
    </div>
    <div
      v-if="assignment.state.dialogs.correction"
      class="track-identity-editor__choice"
      role="dialog"
      aria-label="選擇球員修正方式"
    >
      <strong>為什麼要改成「{{ assignment.state.dialogs.correction.playerName }}」？</strong>
      <p v-if="assignment.state.dialogs.correction.previousPlayerName">
        目前整個 GID 綁定「{{ assignment.state.dialogs.correction.previousPlayerName }}」。
      </p>
      <p v-if="assignment.state.dialogs.correction.occupiedGidLabel">
        所選球員目前屬於
        {{ assignment.state.dialogs.correction.occupiedGidLabel }}；第一項會原子交換 兩個 GID
        的球員綁定。
      </p>
      <button type="button" @click="assignment.actions.applyCorrection('from_here')">
        <b>{{
          assignment.state.dialogs.correction.occupiedGidLabel
            ? '交換兩個 GID 的球員綁定'
            : '只重綁目前 GID'
        }}</b
        ><small>保留其他 GID；從這段起生效，不回寫過去片段</small>
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
        @click="assignment.actions.applyCorrection('split_identity')"
      >
        <b>只有這個 Local 的 GID 判錯</b><small>只拆目前 Local，原 GID 不變</small>
      </button>
      <button type="button" @click="assignment.actions.applyCorrection('clip_only')">
        <b>只改目前顯示</b><small>不改 GID，也不進入後續特徵庫</small>
      </button>
      <button type="button" class="cancel" @click="assignment.actions.closeCorrection">取消</button>
    </div>
    <p v-if="assignment.state.error" class="track-identity-editor__error" role="alert">
      <CircleAlert :size="14" />{{ assignment.state.error }}
    </p>
  </section>
</template>

<style scoped>
.track-identity-editor {
  display: grid;
  gap: 12px;
  padding-block: 18px;
  border-block: 1px solid #dfe4e8;
}
.track-identity-editor > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.track-identity-editor > header > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.track-identity-editor > header > div > span {
  display: grid;
  gap: 2px;
}
.track-identity-editor header strong {
  font-size: 0.76rem;
}
.track-identity-editor header small {
  color: #77818b;
  font-size: 0.6rem;
}
.track-identity-editor > header > span {
  padding: 4px 7px;
  border-radius: 6px;
  background: #edf1f4;
  color: #68727d;
  font-size: 0.58rem;
  font-weight: 700;
}
.track-identity-editor > header > span[data-tone='manual'],
.track-identity-editor > header > span[data-tone='propagated'] {
  background: #e6f5ec;
  color: #237847;
}
.track-identity-editor > header > span[data-tone='required'] {
  background: #fff3db;
  color: #8a5a08;
}
.track-identity-editor__control {
  position: relative;
  max-width: 420px;
}
.track-identity-editor__control :deep(.ui-select__trigger) {
  height: 42px;
  border-color: #cdd4db;
  background: #fff;
  color: #20252b;
}
.track-identity-editor__control > .spin {
  position: absolute;
  right: 38px;
  top: 13px;
  color: #237847;
}
.track-identity-editor__choice {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  max-width: 760px;
}
.track-identity-editor__choice > strong {
  grid-column: 1/-1;
  font-size: 0.68rem;
}
.track-identity-editor__choice > p {
  grid-column: 1/-1;
  margin: 0;
  color: #735b2a;
  font-size: 0.6rem;
}
.track-identity-editor__choice button {
  min-height: 54px;
  display: grid;
  justify-items: start;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid #d4dae0;
  border-radius: 9px;
  background: #fff;
  text-align: left;
}
.track-identity-editor__choice button:hover {
  border-color: #9ba8b4;
  background: #f5f7f9;
}
.track-identity-editor__choice b {
  font-size: 0.65rem;
}
.track-identity-editor__choice small {
  color: #7a848e;
  font-size: 0.56rem;
}
.track-identity-editor__choice .cancel {
  min-height: 34px;
  display: block;
  grid-column: 1/-1;
  background: transparent;
  text-align: center;
}
.track-identity-editor__error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: #b4232c;
  font-size: 0.64rem;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 760px) {
  .track-identity-editor__choice {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
