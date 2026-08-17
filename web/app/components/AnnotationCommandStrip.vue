<script setup lang="ts">
import { Settings2 } from 'lucide-vue-next'
import UiButton from '~/components/ui/Button.vue'
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  type AnnotationAction,
} from '~/utils/annotationHotkeys'
import { annotationWorkstationActionId } from '~/services/annotation-workstation/annotation-action.service'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'

const props = withDefaults(
  defineProps<{
    bindings: Record<string, string>
    serviceMode?: 'start' | 'end'
    leftTeamLabel?: string | null
    rightTeamLabel?: string | null
  }>(),
  {
    serviceMode: 'start',
  },
)
const workstation = useAnnotationWorkstationService()
const segmentCommand = ANNOTATION_COMMANDS.find(command => command.action === 'service')!
const pointCommands = ANNOTATION_COMMANDS.filter(command =>
  ['contact', 'spike'].includes(command.action),
)
const outcomeCommands = ANNOTATION_COMMANDS.filter(command => command.action.startsWith('close_'))
function reason(action: AnnotationAction) {
  return workstation.actions.state(annotationWorkstationActionId[action]).value.reason ?? ''
}

function execute(action: AnnotationAction) {
  void workstation.actions.execute(annotationWorkstationActionId[action])
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
      @click="execute(segmentCommand.action)"
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
          @click="execute(command.action)"
        >
          <UiKbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</UiKbd>
          <span>{{ label(command.action, command.label) }}</span>
        </UiButton>
      </div>
    </div>

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
          @click="execute(command.action)"
        >
          <UiKbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</UiKbd>
          <span>{{ label(command.action, command.label) }}</span>
        </UiButton>
      </div>
    </div>
    <i class="command-divider" aria-hidden="true" />
    <UiButton
      variant="secondary"
      class="settings-command"
      @click="workstation.actions.execute('visualization.open-settings', 'hotkeys')"
    >
      <Settings2 :size="15" />
      <span>按鍵設定</span>
    </UiButton>
  </div>
</template>

<style scoped>
.command-strip {
  box-sizing: border-box;
  min-height: 64px;
  display: grid;
  grid-template-columns:
    minmax(116px, 0.62fr) minmax(220px, 1.35fr) 1px minmax(300px, 1.9fr) 1px
    minmax(110px, 0.65fr);
  gap: 8px;
  align-items: end;
  padding: 6px 10px 8px;
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
  padding-inline: 2px;
  color: #b4b4bd;
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 1;
}
.cluster-buttons {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.point-buttons {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.outcome-buttons {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.command-strip :deep(button) {
  min-width: 0;
  min-height: 36px;
  padding: 5px 9px;
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
  height: 32px;
  margin-bottom: 2px;
  background: #27272a;
}
.settings-command {
  align-self: end;
  color: #d4d4d8 !important;
}
.command-primary {
  align-self: end;
}
@media (max-width: 1380px) {
  .command-strip {
    grid-template-columns:
      minmax(110px, 0.62fr) minmax(210px, 1.25fr) 1px minmax(290px, 1.8fr)
      1px minmax(104px, 0.62fr);
  }
  .command-strip :deep(button span) {
    font-size: 0.65rem;
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
.command-strip :deep(.command-contact) {
  border-color: #4f91d4;
  background: #18334f;
  color: #cce7ff;
}
.command-strip :deep(.command-spike) {
  border-color: #c65b78;
  background: #4a2130;
  color: #ffd4df;
}
.command-strip :deep(.command-outcome) {
  border-color: #3f3f46;
  background: #141416;
}
</style>
