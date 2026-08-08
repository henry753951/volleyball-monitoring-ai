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
}>(), { commandReady: true, pendingCommand: false })
const emit = defineEmits<{ action: [AnnotationAction]; settings: [] }>()
const visibleCommands = ANNOTATION_COMMANDS.filter(command => command.action !== 'submit')

function reason(action: AnnotationAction) {
  if (props.pendingCommand) return '已有待送出操作'
  if (props.commandReady === false) return '標記暫時不可用'
  if (action === 'service' && (!['IDLE', 'READY', 'SUBMITTED', 'VOIDED'].includes(props.state) || !props.canMark)) return !['IDLE', 'READY', 'SUBMITTED', 'VOIDED'].includes(props.state) ? '目前片段尚未關閉' : '游標尚未確認'
  if (action === 'contact' && (props.state !== 'OPEN' || !props.canMark)) return props.state !== 'OPEN' ? '尚未開始片段' : '游標尚未確認'
  if (action.startsWith('close_') && (props.state !== 'OPEN' || !props.lastKeyPoint)) return props.state !== 'OPEN' ? '尚未開始片段' : '沒有可結束的擊球點'
  return ''
}
</script>

<template>
  <div class="command-strip" aria-label="標記工具列">
    <template v-for="command in visibleCommands" :key="command.action">
      <i v-if="command.action === 'close_left'" class="command-divider" aria-hidden="true" />
      <UiButton variant="secondary" :disabled="Boolean(reason(command.action))" :title="reason(command.action) || command.label" @click="emit('action', command.action)">
        <UiKbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</UiKbd>
        <span>{{ command.label }}</span>
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
</style>
