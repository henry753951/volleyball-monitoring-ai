<script setup lang="ts">
import { Settings2 } from 'lucide-vue-next'
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
  if (action === 'service' && (!['IDLE', 'SUBMITTED', 'VOIDED'].includes(props.state) || !props.canMark)) return !['IDLE', 'SUBMITTED', 'VOIDED'].includes(props.state) ? '目前片段尚未關閉' : '游標尚未確認'
  if (action === 'contact' && (props.state !== 'OPEN' || !props.canMark)) return props.state !== 'OPEN' ? '尚未開始片段' : '游標尚未確認'
  if (action.startsWith('close_') && (props.state !== 'OPEN' || !props.lastKeyPoint)) return props.state !== 'OPEN' ? '尚未開始片段' : '沒有可結束的擊球點'
  return ''
}
</script>

<template>
  <div class="command-strip" aria-label="標記工具列">
    <template v-for="command in visibleCommands" :key="command.action">
      <i v-if="command.action === 'close_left'" class="command-divider" aria-hidden="true" />
      <button type="button" :disabled="Boolean(reason(command.action))" :title="reason(command.action) || command.label" @click="emit('action', command.action)">
        <kbd>{{ formatBindingForDisplay(bindings[command.action] ?? '') }}</kbd>
        <span>{{ command.label }}</span>
      </button>
    </template>
    <i class="command-divider" aria-hidden="true" />
    <button type="button" class="settings-command" @click="emit('settings')">
      <Settings2 :size="15" />
      <span>按鍵設定</span>
    </button>
  </div>
</template>

<style scoped>
.command-strip{display:grid;grid-template-columns:.7fr .78fr 1px 1fr 1fr .9fr 1px 1fr;gap:6px;align-items:center;padding:7px 12px;border-top:1px solid #292f35;background:#111419}.command-strip button{min-width:0;min-height:38px;display:flex;align-items:center;justify-content:center;gap:7px;padding:5px 8px;border:1px solid #3d464f;border-radius:7px;background:#1c2127;color:#edf1f4;cursor:pointer}.command-strip button:not(:disabled):hover{border-color:#66717c;background:#252b32}.command-strip button:active:not(:disabled){transform:scale(.985)}.command-strip button:focus-visible{outline:2px solid #62a9ff;outline-offset:2px}.command-strip button:disabled{opacity:.32;cursor:not-allowed}.command-strip button span{overflow:hidden;font-size:.69rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.command-strip kbd{min-width:23px;padding:2px 5px;border:1px solid #555f69;border-bottom-width:2px;border-radius:4px;background:#101418;color:#fff;font:700 .66rem "Cascadia Mono",Consolas,monospace;text-align:center}.command-divider{width:1px;height:24px;background:#30363d}.settings-command{color:#c5ccd4!important}@media(max-width:1050px){.command-strip button span{font-size:.62rem}}
</style>
