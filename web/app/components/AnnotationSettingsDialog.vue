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
  { label: '標註命令', commands: ANNOTATION_COMMANDS },
  { label: '播放器與逐幀', commands: MEDIA_COMMANDS },
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
}, { flush: 'post' })
</script>

<template>
  <dialog ref="dialog" class="annotation-settings" aria-labelledby="annotation-settings-title" @cancel.prevent="close" @click.self="close">
    <header>
      <div><p>ANNOTATION WORKSTATION</p><h2 id="annotation-settings-title">快捷鍵設定</h2></div>
      <button type="button" aria-label="關閉設定" @click="close"><X :size="18" /></button>
    </header>
    <div class="annotation-settings__body">
      <p class="annotation-settings__hint">操作語意固定；實體按鍵可重新綁定。按鍵顯示使用 TanStack Hotkeys 的 FormatForDisplay。</p>
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
    <footer><button type="button" @click="restoreAllDefaults"><RotateCcw :size="15" />還原所有預設值</button><button type="button" class="primary" @click="close">完成</button></footer>
  </dialog>
</template>

<style scoped>
.annotation-settings{width:min(720px,calc(100vw - 40px));max-height:calc(100dvh - 40px);padding:0;overflow:hidden;border:1px solid #4a535d;border-radius:9px;background:#121519;color:#edf1f4;box-shadow:0 24px 80px #000c}.annotation-settings::backdrop{background:#050607b8;backdrop-filter:blur(3px)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid #30363d;background:#101317}header p{margin:0;color:#98a2ad;font-size:.62rem;letter-spacing:.08em}header h2{margin:2px 0 0;font-size:1rem}header button{width:34px;padding:0}button{min-height:34px;padding:7px 11px;border:1px solid #4a535d;border-radius:6px;background:#20252b;color:inherit;cursor:pointer}button:hover{border-color:#6b7681;background:#282e35}.annotation-settings__body{max-height:calc(100dvh - 170px);padding:14px 16px;overflow:auto}.annotation-settings__hint{margin:0 0 14px;color:#98a2ad;font-size:.75rem}.annotation-settings section+section{margin-top:18px}.annotation-settings h3{margin:0 0 6px;color:#cdd4db;font-size:.72rem}.annotation-settings ul{margin:0;padding:0;border-top:1px solid #30363d;list-style:none}.annotation-settings li{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:9px 0;border-bottom:1px solid #262c32}.annotation-settings li div{display:grid;gap:3px}.annotation-settings li strong{font-size:.78rem}.annotation-settings li small{color:#98a2ad;font-size:.67rem}.annotation-settings li button{min-width:128px;font:700 .7rem "Cascadia Mono",Consolas,monospace}.annotation-settings li button.recording{border-color:#62a9ff;background:#192b3b}.annotation-settings__error{padding:9px;border:1px solid #8e4146;border-radius:5px;background:#351a1c;color:#ffb7bb;font-size:.72rem}footer{border-top:1px solid #30363d;border-bottom:0}footer button{display:flex;align-items:center;gap:6px}.primary{border-color:#299c64;background:#17643f}
</style>
