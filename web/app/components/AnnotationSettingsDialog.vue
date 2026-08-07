<script setup lang="ts">
import { RotateCcw, X } from 'lucide-vue-next'
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  HOTKEY_COMMANDS,
  MEDIA_COMMANDS,
  type HotkeyCommand,
  type HotkeyCommandDefinition,
} from '~/utils/annotationHotkeys'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const { bindings, rebind, restoreDefaults } = useAnnotationHotkeys()
const recording = ref<HotkeyCommand | null>(null)
const recordingError = ref<string | null>(null)
const commandGroups: ReadonlyArray<{ label: string; commands: ReadonlyArray<HotkeyCommandDefinition> }> = [
  { label: '標記', commands: ANNOTATION_COMMANDS },
  { label: '播放', commands: MEDIA_COMMANDS },
]

const recorder = useAnnotationHotkeyRecorder(() => ({
  ignoreInputs: true,
  onCancel: () => { recording.value = null },
  onRecord: (hotkey) => {
    const action = recording.value
    if (!action) return
    const result = rebind(action, hotkey)
    recording.value = null
    if (result.ok) { recordingError.value = null; return }
    if (result.reason === 'conflict') {
      const conflict = HOTKEY_COMMANDS.find(command => command.action === result.conflictWith)
      recordingError.value = `此按鍵已綁定到「${conflict?.label ?? result.conflictWith}」，原綁定保持不變。`
    }
    else if (result.reason === 'reserved') recordingError.value = '此按鍵組合由瀏覽器保留，原綁定保持不變。'
    else recordingError.value = '此按鍵無法用於快捷鍵，原綁定保持不變。'
  },
}))

function beginRecording(action: HotkeyCommand) {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = action
  recordingError.value = null
  recorder.startRecording()
}

function restoreAllDefaults() {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = null
  recordingError.value = null
  restoreDefaults()
}

function close() {
  if (recorder.isRecording.value) recorder.cancelRecording()
  emit('close')
}

watch(() => props.open, (open) => {
  const element = dialog.value
  if (!element) return
  if (open && !element.open) element.showModal()
  if (!open && element.open) element.close()
}, { flush: 'post', immediate: true })
onMounted(() => {
  if (props.open && dialog.value && !dialog.value.open) dialog.value.showModal()
})
</script>

<template>
  <dialog ref="dialog" class="annotation-settings" aria-labelledby="annotation-settings-title" @cancel.prevent="close" @click.self="close">
    <header>
      <div><h2 id="annotation-settings-title">按鍵設定</h2></div>
      <button type="button" aria-label="關閉設定" @click="close"><X :size="18" /></button>
    </header>
    <div class="annotation-settings__body">
      <section v-for="group in commandGroups" :key="group.label">
        <h3>{{ group.label }}</h3>
        <ul>
          <li v-for="command in group.commands" :key="command.action">
            <div><strong>{{ command.label }}</strong><small>{{ command.description }}</small></div>
            <button type="button" :class="{ recording: recording === command.action }" @click="beginRecording(command.action)">
              {{ recording === command.action ? '請按新按鍵…' : formatBindingForDisplay(bindings[command.action]) }}
            </button>
          </li>
        </ul>
      </section>
      <p v-if="recordingError" class="annotation-settings__error" role="alert">{{ recordingError }}</p>
    </div>
    <footer><button type="button" @click="restoreAllDefaults"><RotateCcw :size="15" />還原預設值</button><button type="button" class="primary" @click="close">完成</button></footer>
  </dialog>
</template>

<style scoped>
.annotation-settings{width:min(620px,calc(100vw - 40px));max-height:calc(100dvh - 40px);padding:0;overflow:hidden;border:1px solid #4a535d;border-radius:12px;background:#121519;color:#edf1f4;box-shadow:0 24px 80px #000c}.annotation-settings::backdrop{background:#050607b8;backdrop-filter:blur(6px)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-bottom:1px solid #30363d;background:#101317}header h2{margin:0;font-size:.86rem}header button{width:32px;padding:0}button{min-height:32px;padding:6px 10px;border:1px solid #4a535d;border-radius:7px;background:#20252b;color:inherit;cursor:pointer}button:hover{border-color:#6b7681;background:#282e35}.annotation-settings__body{max-height:calc(100dvh - 150px);padding:12px 14px;overflow:auto}.annotation-settings section+section{margin-top:14px}.annotation-settings h3{margin:0 0 5px;color:#cdd4db;font-size:.67rem}.annotation-settings ul{margin:0;padding:0;border-top:1px solid #30363d;list-style:none}.annotation-settings li{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:7px 0;border-bottom:1px solid #262c32}.annotation-settings li div{display:grid;gap:2px}.annotation-settings li strong{font-size:.72rem}.annotation-settings li small{color:#8f99a3;font-size:.62rem}.annotation-settings li button{min-width:118px;font:700 .66rem "Cascadia Mono",Consolas,monospace}.annotation-settings li button.recording{border-color:#62a9ff;background:#192b3b}.annotation-settings__error{padding:8px;border:1px solid #8e4146;border-radius:6px;background:#351a1c;color:#ffb7bb;font-size:.68rem}footer{border-top:1px solid #30363d;border-bottom:0}footer button{display:flex;align-items:center;gap:6px}.primary{border-color:#299c64;background:#17643f}
</style>
