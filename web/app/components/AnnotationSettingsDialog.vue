<script setup lang="ts">
import { RotateCcw } from 'lucide-vue-next'
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

</script>

<template>
  <UiAnimatedModal :open="open" title="按鍵設定" description="點選按鍵後直接輸入新的組合" @close="close">
    <UiScrollArea class="annotation-settings__scroll">
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
    </UiScrollArea>
    <template #footer><button type="button" @click="restoreAllDefaults"><RotateCcw :size="15" />還原預設值</button><button type="button" class="primary" @click="close">完成</button></template>
  </UiAnimatedModal>
</template>

<style scoped>
.annotation-settings__scroll{height:min(620px,calc(86dvh - 104px))}.annotation-settings__body{padding:12px 16px 18px}.annotation-settings__body section+section{margin-top:14px}.annotation-settings__body h3{margin:0 0 5px;color:#cdd4db;font-size:.67rem}.annotation-settings__body ul{margin:0;padding:0;border-top:1px solid #30363d;list-style:none}.annotation-settings__body li{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:8px 0;border-bottom:1px solid #262c32}.annotation-settings__body li div{display:grid;gap:2px}.annotation-settings__body li strong{font-size:.72rem}.annotation-settings__body li small{color:#8f99a3;font-size:.62rem}.annotation-settings__body button,:deep(.animated-modal__footer button){min-height:32px;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #4a535d;border-radius:8px;background:#20252b;color:#edf1f4;cursor:pointer}.annotation-settings__body li button{min-width:118px;justify-content:center;font:700 .66rem "Cascadia Mono",Consolas,monospace}.annotation-settings__body li button.recording{border-color:#62a9ff;background:#192b3b}.annotation-settings__error{padding:8px;border:1px solid #8e4146;border-radius:7px;background:#351a1c;color:#ffb7bb;font-size:.68rem}:deep(.animated-modal__footer .primary){border-color:#299c64;background:#17643f}
</style>
