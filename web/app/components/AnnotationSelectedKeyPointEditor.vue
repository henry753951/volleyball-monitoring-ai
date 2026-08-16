<script setup lang="ts">
import type { BallEventResult, BallEventValue } from '@volleyball-monitoring/contracts'
import { Check, UserRoundCheck } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import UiButton from '~/components/ui/Button.vue'
import UiPopover from '~/components/ui/Popover.vue'
import {
  BALL_EVENT_TONE_COLORS,
  ballEventKindLabel,
  ballEventLabel,
  ballEventTone,
} from '~/utils/annotationBallEventPresentation'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'

const props = withDefaults(
  defineProps<{
    selectedBallEvent?: BallEventValue | null
    previousBallEvent?: BallEventValue | null
    selectedActorId?: string | null
    actorOptions?: ReadonlyArray<{ id: string; label: string }>
  }>(),
  {
    selectedBallEvent: null,
    previousBallEvent: null,
    selectedActorId: null,
    actorOptions: () => [],
  },
)

const workstation = useAnnotationWorkstationService()
const resultOpen = ref(false)
const actorOpen = ref(false)
const tone = computed(() => ballEventTone(props.selectedBallEvent))
const accent = computed(() => BALL_EVENT_TONE_COLORS[tone.value])
const selectedActorLabel = computed(
  () =>
    props.actorOptions.find(option => option.id === props.selectedActorId)?.label ?? '未指定球員',
)
const resultOptions = computed<Array<{ result: BallEventResult; label: string }>>(() => {
  if (props.selectedBallEvent?.kind === 'SERVE')
    return [
      { result: 'POINT_SCORED', label: '得分' },
      { result: 'SUCCESS', label: '成功' },
      { result: 'ERROR', label: '失敗' },
    ]
  if (props.selectedBallEvent?.kind === 'RECEIVE')
    return [
      { result: 'SUCCESS', label: '成功' },
      { result: 'ERROR', label: '失誤' },
      { result: 'POINT_LOST', label: '失分' },
    ]
  if (props.selectedBallEvent?.kind === 'SPIKE')
    return [
      { result: 'SUCCESS', label: '成功' },
      { result: 'FAILURE', label: '失敗' },
    ]
  return []
})

function chooseResult(result: BallEventResult) {
  const event = props.selectedBallEvent
  if (!event) return
  void workstation.actions.execute('mark.set-event', { kind: event.kind, result })
  resultOpen.value = false
}

function chooseActor(actorRosterEntryId: string | null) {
  void workstation.actions.execute('mark.set-actor', actorRosterEntryId)
  actorOpen.value = false
}
</script>

<template>
  <div class="selected-point-editor" :style="{ '--point-accent': accent }">
    <i aria-hidden="true" />
    <UiPopover
      v-if="resultOptions.length"
      :open="resultOpen"
      side="bottom"
      align="start"
      content-class="ball-event-result-popover"
      aria-label="修改球點結果"
      @update:open="resultOpen = $event"
    >
      <template #trigger>
        <UiButton
          variant="secondary"
          class="point-detail-button event"
          :disabled="!workstation.actions.state('mark.set-event').value.enabled"
          :title="
            workstation.actions.state('mark.set-event').value.reason ||
            ballEventLabel(selectedBallEvent, { previousEvent: previousBallEvent })
          "
        >
          <span class="event-swatch" />
          <span>{{ ballEventLabel(selectedBallEvent, { previousEvent: previousBallEvent }) }}</span>
        </UiButton>
      </template>
      <div class="point-detail-options">
        <strong
          >{{
            ballEventKindLabel(selectedBallEvent, { previousEvent: previousBallEvent })
          }}結果</strong
        >
        <button
          v-for="option in resultOptions"
          :key="option.result"
          type="button"
          :aria-pressed="selectedBallEvent?.result === option.result"
          @click="chooseResult(option.result)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="selectedBallEvent?.result === option.result" :size="14" />
        </button>
      </div>
    </UiPopover>
    <UiButton v-else variant="secondary" class="point-detail-button event" disabled>
      <span class="event-swatch" />
      <span>{{ ballEventLabel(selectedBallEvent, { previousEvent: previousBallEvent }) }}</span>
    </UiButton>

    <UiPopover
      :open="actorOpen"
      side="bottom"
      align="end"
      content-class="ball-event-actor-popover"
      aria-label="修改擊球球員"
      @update:open="actorOpen = $event"
    >
      <template #trigger>
        <UiButton
          variant="secondary"
          class="point-detail-button actor"
          :disabled="!workstation.actions.state('mark.set-actor').value.enabled"
          :title="workstation.actions.state('mark.set-actor').value.reason || selectedActorLabel"
        >
          <UserRoundCheck :size="13" />
          <span>{{ selectedActorLabel }}</span>
        </UiButton>
      </template>
      <div class="point-detail-options actor-options">
        <strong>擊球球員</strong>
        <button type="button" :aria-pressed="selectedActorId === null" @click="chooseActor(null)">
          <span>未指定／使用 Pose 關聯</span>
          <Check v-if="selectedActorId === null" :size="14" />
        </button>
        <button
          v-for="option in actorOptions"
          :key="option.id"
          type="button"
          :aria-pressed="selectedActorId === option.id"
          @click="chooseActor(option.id)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="selectedActorId === option.id" :size="14" />
        </button>
      </div>
    </UiPopover>
  </div>
</template>

<style scoped>
.selected-point-editor {
  position: relative;
  width: min(430px, calc(100vw - 190px));
  height: 40px;
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.2fr);
  gap: 5px;
  padding: 4px;
  border: 1px solid color-mix(in srgb, var(--point-accent) 45%, #343b43);
  border-radius: 9px;
  background: rgb(10 13 16 / 96%);
  box-shadow: 0 8px 24px #0009;
  pointer-events: auto;
}
.selected-point-editor > i {
  position: absolute;
  left: 50%;
  top: -7px;
  width: 11px;
  height: 11px;
  transform: translateX(-50%) rotate(45deg);
  border-left: 1px solid var(--point-accent);
  border-top: 1px solid var(--point-accent);
  background: #0a0d10;
}
.selected-point-editor :deep(.point-detail-button) {
  min-width: 0;
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-color: #343b43;
  background: #171b20;
  color: #e8edf2;
}
.selected-point-editor :deep(.point-detail-button span:last-child) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-swatch {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--point-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--point-accent) 65%, transparent);
}
.point-detail-options {
  display: grid;
  gap: 4px;
  min-width: 180px;
}
.point-detail-options strong {
  padding: 4px 7px 7px;
  color: #f4f4f5;
  font-size: 0.72rem;
}
.point-detail-options button {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #d4d4d8;
  font-size: 0.72rem;
  cursor: pointer;
}
.point-detail-options button:hover,
.point-detail-options button[aria-pressed='true'] {
  background: #27272a;
  color: #fff;
}
.actor-options {
  width: min(320px, 75vw);
  max-height: 360px;
  overflow: auto;
}
</style>
