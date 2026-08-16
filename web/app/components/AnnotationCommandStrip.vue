<script setup lang="ts">
import { Check, Settings2, UserRoundCheck } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { BallEventResult, BallEventValue } from '@volleyball-monitoring/contracts'
import UiButton from '~/components/ui/Button.vue'
import UiPopover from '~/components/ui/Popover.vue'
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  type AnnotationAction,
} from '~/utils/annotationHotkeys'

const props = withDefaults(
  defineProps<{
    bindings: Record<string, string>
    state: 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'
    canMark: boolean
    lastKeyPoint: boolean
    commandReady?: boolean
    pendingCommand?: boolean
    serviceMode?: 'start' | 'end'
    leftTeamLabel?: string | null
    rightTeamLabel?: string | null
    availability?: Partial<Record<AnnotationAction, { enabled: boolean; reason: string }>>
    selectedBallEvent?: BallEventValue | null
    selectedKeyPoint?: boolean
    selectedActorId?: string | null
    actorOptions?: ReadonlyArray<{ id: string; label: string }>
    eventEditReady?: boolean
  }>(),
  {
    commandReady: true,
    pendingCommand: false,
    serviceMode: 'start',
    selectedActorId: null,
    actorOptions: () => [],
    eventEditReady: true,
  },
)
const emit = defineEmits<{
  action: [AnnotationAction]
  settings: []
  setBallEvent: [BallEventValue]
  setBallEventActor: [string | null]
}>()
const segmentCommand = ANNOTATION_COMMANDS.find(command => command.action === 'service')!
const pointCommands = ANNOTATION_COMMANDS.filter(command =>
  ['contact', 'spike', 'receive_success', 'receive_error'].includes(command.action),
)
const outcomeCommands = ANNOTATION_COMMANDS.filter(command => command.action.startsWith('close_'))
const resultOpen = ref(false)
const actorOpen = ref(false)

const resultOptions = computed<Array<{ result: BallEventResult; label: string }>>(() => {
  if (props.selectedBallEvent?.kind === 'SERVE')
    return [
      { result: 'POINT_SCORED', label: '得分' },
      { result: 'SUCCESS', label: '成功' },
      { result: 'ERROR', label: '失誤' },
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

const selectedEventLabel = computed(() => {
  const event = props.selectedBallEvent
  if (!event) return '球點結果'
  const kind = { SERVE: '發球', RECEIVE: '接發', CONTACT: '擊球', SPIKE: '殺球' }[event.kind]
  const result = resultOptions.value.find(option => option.result === event.result)?.label
  return result ? `${kind} · ${result}` : `${kind} · 待選結果`
})
const selectedActorLabel = computed(
  () =>
    props.actorOptions.find(option => option.id === props.selectedActorId)?.label ?? '未指定球員',
)

function chooseResult(result: BallEventResult) {
  const event = props.selectedBallEvent
  if (!event) return
  emit('setBallEvent', { kind: event.kind, result })
  resultOpen.value = false
}

function chooseActor(actorRosterEntryId: string | null) {
  emit('setBallEventActor', actorRosterEntryId)
  actorOpen.value = false
}

function reason(action: AnnotationAction) {
  const availability = props.availability?.[action]
  if (availability) return availability.enabled ? '' : availability.reason
  if (props.pendingCommand) return '已有待送出操作'
  if (props.commandReady === false) return '標記暫時不可用'
  if (action === 'service' && !props.canMark) return '游標尚未確認'
  if (
    ['contact', 'spike', 'receive_success', 'receive_error'].includes(action) &&
    (!['OPEN', 'READY'].includes(props.state) || (!props.selectedKeyPoint && !props.canMark))
  )
    return !['OPEN', 'READY'].includes(props.state) ? '尚未開始片段' : '游標尚未確認'
  if (action.startsWith('close_') && !['OPEN', 'READY'].includes(props.state))
    return '目前沒有可設定結果的片段'
  return ''
}

function label(action: AnnotationAction, fallback: string) {
  if (action === 'service') return props.serviceMode === 'end' ? '結束片段' : '開始片段'
  if (action === 'close_left' && props.leftTeamLabel) return `左側 ${props.leftTeamLabel} 得分`
  if (action === 'close_right' && props.rightTeamLabel) return `右側 ${props.rightTeamLabel} 得分`
  return fallback
}
</script>

<template>
  <div class="command-strip" aria-label="標記工具列">
    <UiButton
      variant="secondary"
      class="command-primary"
      :disabled="Boolean(reason(segmentCommand.action))"
      :title="reason(segmentCommand.action) || label(segmentCommand.action, segmentCommand.label)"
      @click="emit('action', segmentCommand.action)"
    >
      <UiKbd>{{ formatBindingForDisplay(bindings[segmentCommand.action] ?? '') }}</UiKbd>
      <span>{{ label(segmentCommand.action, segmentCommand.label) }}</span>
    </UiButton>

    <div class="command-cluster point-cluster">
      <span class="cluster-label">球點</span>
      <div class="cluster-buttons point-buttons">
        <UiButton
          v-for="command in pointCommands"
          :key="command.action"
          variant="secondary"
          :class="[`command-${command.action}`, 'command-mark']"
          :disabled="Boolean(reason(command.action))"
          :title="reason(command.action) || label(command.action, command.label)"
          @click="emit('action', command.action)"
        >
          <UiKbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</UiKbd>
          <span>{{ label(command.action, command.label) }}</span>
        </UiButton>
      </div>
    </div>

    <div v-if="selectedKeyPoint" class="event-detail-controls">
      <UiPopover
        v-if="resultOptions.length"
        :open="resultOpen"
        side="top"
        align="end"
        content-class="ball-event-result-popover"
        aria-label="修改球點結果"
        @update:open="resultOpen = $event"
      >
        <template #trigger>
          <UiButton
            variant="secondary"
            class="result-command"
            :disabled="!eventEditReady"
            :title="eventEditReady ? selectedEventLabel : '等待目前修改完成'"
          >
            <span>{{ selectedEventLabel }}</span>
          </UiButton>
        </template>
        <div class="result-options">
          <strong>{{ selectedEventLabel.split(' · ')[0] }}結果</strong>
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
      <UiPopover
        :open="actorOpen"
        side="top"
        align="end"
        content-class="ball-event-actor-popover"
        aria-label="修改擊球球員"
        @update:open="actorOpen = $event"
      >
        <template #trigger>
          <UiButton
            variant="secondary"
            class="actor-command"
            :disabled="!eventEditReady"
            :title="eventEditReady ? selectedActorLabel : '等待目前修改完成'"
          >
            <UserRoundCheck :size="13" />
            <span>{{ selectedActorLabel }}</span>
          </UiButton>
        </template>
        <div class="result-options actor-options">
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
    <div v-else class="result-placeholder" aria-hidden="true">選取球點可改結果與球員</div>

    <i class="command-divider" aria-hidden="true" />
    <div class="command-cluster outcome-cluster">
      <span class="cluster-label">回合結果</span>
      <div class="cluster-buttons outcome-buttons">
        <UiButton
          v-for="command in outcomeCommands"
          :key="command.action"
          variant="secondary"
          :class="[`command-${command.action}`, 'command-outcome']"
          :disabled="Boolean(reason(command.action))"
          :title="reason(command.action) || label(command.action, command.label)"
          @click="emit('action', command.action)"
        >
          <UiKbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</UiKbd>
          <span>{{ label(command.action, command.label) }}</span>
        </UiButton>
      </div>
    </div>
    <i class="command-divider" aria-hidden="true" />
    <UiButton variant="secondary" class="settings-command" @click="emit('settings')">
      <Settings2 :size="15" />
      <span>按鍵設定</span>
    </UiButton>
  </div>
</template>

<style scoped>
.command-strip {
  display: grid;
  grid-template-columns:
    minmax(104px, 0.65fr) minmax(390px, 2.4fr) minmax(112px, 0.8fr) 1px minmax(330px, 2fr)
    1px minmax(96px, 0.65fr);
  gap: 6px;
  align-items: center;
  padding: 7px 12px;
  border-top: 1px solid #27272a;
  background: #09090b;
}
.command-cluster {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 3px;
  min-width: 0;
}
.cluster-label {
  color: #a1a1aa;
  font-size: 0.6rem;
  font-weight: 650;
  line-height: 1;
}
.cluster-buttons {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.point-buttons {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.outcome-buttons {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.command-strip :deep(button) {
  min-width: 0;
  min-height: 38px;
  padding: 5px 8px;
  background: #18181b;
  color: #e4e4e7;
}
.command-strip :deep(button:hover:not(:disabled)) {
  background: #27272a;
}
.command-strip :deep(button:disabled) {
  opacity: 0.28;
}
.command-strip :deep(button span) {
  overflow: hidden;
  font-size: 0.69rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.command-divider {
  width: 1px;
  height: 24px;
  background: #27272a;
}
.result-placeholder {
  overflow: hidden;
  color: #71717a;
  font-size: 0.65rem;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.command-strip :deep(.result-command) {
  border-color: #3f3f46;
  background: #141416;
}
.event-detail-controls {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px;
}
.command-strip :deep(.actor-command) {
  border-color: #3f3f46;
  background: #141416;
}
.result-options {
  display: grid;
  gap: 4px;
  min-width: 170px;
}
.result-options strong {
  padding: 4px 7px 7px;
  color: #f4f4f5;
  font-size: 0.72rem;
}
.result-options button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 6px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #d4d4d8;
  font-size: 0.72rem;
  cursor: pointer;
}
.result-options button:hover,
.result-options button[aria-pressed='true'] {
  background: #27272a;
  color: #fff;
}
.actor-options {
  width: min(320px, 75vw);
  max-height: 360px;
  overflow: auto;
}
.settings-command {
  color: #d4d4d8 !important;
}
@media (max-width: 1050px) {
  .command-strip {
    grid-template-columns:
      minmax(94px, 0.6fr) minmax(320px, 2.3fr) 1px minmax(270px, 1.8fr)
      1px 90px;
  }
  .event-detail-controls,
  .result-placeholder {
    display: none;
  }
  .command-strip :deep(button span) {
    font-size: 0.62rem;
  }
}
.command-strip :deep(.command-primary) {
  border-color: #d4d4d8;
  background: #f4f4f5;
  color: #09090b;
}
.command-strip :deep(.command-primary:hover:not(:disabled)) {
  background: #d4d4d8;
}
.command-strip :deep(.command-mark) {
  border-color: #52525b;
  background: #27272a;
}
.command-strip :deep(.command-outcome) {
  border-color: #3f3f46;
  background: #141416;
}
</style>
