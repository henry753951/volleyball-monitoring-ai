<script setup lang="ts">
import { Settings2 } from 'lucide-vue-next'
import UiButton from '~/components/ui/Button.vue'
import { ANNOTATION_COMMANDS, formatBindingForDisplay, type AnnotationAction } from '~/utils/annotationHotkeys'

const props = withDefaults(defineProps<{
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
}>(), { commandReady: true, pendingCommand: false, serviceMode: 'start' })
const emit = defineEmits<{ action: [AnnotationAction]; settings: [] }>()
const visibleCommands = ANNOTATION_COMMANDS.filter(command => command.action !== 'submit')

function reason(action: AnnotationAction) {
  const availability = props.availability?.[action]
  if (availability) return availability.enabled ? '' : availability.reason
  if (props.pendingCommand) return '已有待送出操作'
  if (props.commandReady === false) return '標記暫時不可用'
  if (action === 'service' && !props.canMark) return '游標尚未確認'
  if (action === 'contact' && (props.state !== 'OPEN' || !props.canMark)) return props.state !== 'OPEN' ? '尚未開始片段' : '游標尚未確認'
  if (action.startsWith('close_') && !['OPEN', 'READY'].includes(props.state)) return '目前沒有可設定結果的片段'
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
    <template v-for="command in visibleCommands" :key="command.action">
      <i v-if="command.action === 'close_left'" class="command-divider" aria-hidden="true" />
      <UiButton variant="secondary" :class="[`command-${command.action}`, { 'command-primary': command.action === 'service', 'command-mark': command.action === 'contact', 'command-outcome': command.action.startsWith('close_') }]" :disabled="Boolean(reason(command.action))" :title="reason(command.action) || label(command.action, command.label)" @click="emit('action', command.action)">
        <UiKbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</UiKbd>
        <span>{{ label(command.action, command.label) }}</span>
      </UiButton>
    </template>
    <i class="command-divider" aria-hidden="true" />
    <UiButton variant="secondary" class="settings-command" @click="emit('settings')">
      <Settings2 :size="15" />
      <span>按鍵設定</span>
    </UiButton>
  </div>
</template>

<style scoped>
.command-strip{display:grid;grid-template-columns:.7fr .78fr 1px 1fr 1fr .9fr 1px 1fr;gap:6px;align-items:center;padding:7px 12px;border-top:1px solid #27272a;background:#09090b}.command-strip :deep(button){min-width:0;min-height:38px;padding:5px 8px;background:#18181b;color:#e4e4e7}.command-strip :deep(button:hover:not(:disabled)){background:#27272a}.command-strip :deep(button:disabled){opacity:.28}.command-strip :deep(button span){overflow:hidden;font-size:.69rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.command-divider{width:1px;height:24px;background:#27272a}.settings-command{color:#d4d4d8!important}@media(max-width:1050px){.command-strip :deep(button span){font-size:.62rem}}
.command-strip :deep(.command-primary){border-color:#d4d4d8;background:#f4f4f5;color:#09090b}.command-strip :deep(.command-primary:hover:not(:disabled)){background:#d4d4d8}.command-strip :deep(.command-mark){border-color:#52525b;background:#27272a}.command-strip :deep(.command-outcome){border-color:#3f3f46;background:#141416}
</style>
