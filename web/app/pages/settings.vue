<script setup lang="ts">
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  HOTKEY_COMMANDS,
  MEDIA_COMMANDS,
  type HotkeyCommand,
  type HotkeyCommandDefinition,
} from '~/utils/annotationHotkeys'

const { bindings, rebind, restoreDefaults } = useAnnotationHotkeys()
const recording = ref<HotkeyCommand | null>(null)
const recordingError = ref<string | null>(null)
const commandGroups: ReadonlyArray<{
  label: string
  commands: ReadonlyArray<HotkeyCommandDefinition>
}> = [
  { label: '標註 commands', commands: ANNOTATION_COMMANDS },
  { label: '播放器 commands', commands: MEDIA_COMMANDS },
]

const recorder = useAnnotationHotkeyRecorder(() => ({
  ignoreInputs: true,
  onCancel: () => {
    recording.value = null
  },
  onRecord: (hotkey) => {
    const action = recording.value
    if (!action) return

    const result = rebind(action, hotkey)
    recording.value = null
    if (result.ok) {
      recordingError.value = null
      return
    }

    if (result.reason === 'conflict') {
      const conflict = HOTKEY_COMMANDS.find((command) => command.action === result.conflictWith)
      recordingError.value = `此按鍵已綁定到「${conflict?.label ?? result.conflictWith}」，原綁定保持不變。`
    }
    else if (result.reason === 'reserved') {
      recordingError.value = '此按鍵組合由瀏覽器保留，原綁定保持不變。'
    }
    else {
      recordingError.value = '此按鍵無法用於快捷鍵，原綁定保持不變。'
    }
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

function displayBinding(action: HotkeyCommand): string {
  return formatBindingForDisplay(bindings.value[action])
}
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">設定</h1>
      <p class="mt-2 text-gray-600">
        實體鍵可重新綁定；六個觸控 command 的語意固定，左右側得分與未知都會直接關閉 rally。
      </p>
    </header>

    <div class="rounded-2xl border bg-white p-5 shadow-sm">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="font-semibold">快捷鍵</h2>
          <p class="mt-1 text-sm text-stone-600">選擇一個 command 後按下新按鍵；衝突或瀏覽器保留組合不會覆蓋現有綁定。</p>
        </div>
        <button
          type="button"
          class="rounded-xl border px-3 py-2 text-sm font-medium hover:bg-stone-50"
          @click="restoreAllDefaults"
        >
          還原所有預設快捷鍵
        </button>
      </div>

      <div
        v-for="group in commandGroups"
        :key="group.label"
        class="mt-5"
      >
        <h3 class="text-sm font-semibold text-stone-700">{{ group.label }}</h3>
        <ul class="mt-2 divide-y">
          <li
            v-for="command in group.commands"
            :key="command.action"
            class="flex items-center justify-between gap-4 py-3"
          >
            <div>
              <p class="font-medium">{{ command.label }}</p>
              <p
                v-if="command.description"
                class="text-xs text-stone-500"
              >
                {{ command.description }}
              </p>
            </div>
            <button
              type="button"
              class="min-w-28 rounded-xl border px-3 py-2 text-sm"
              :class="recording === command.action ? 'border-sky-500 bg-sky-50 text-sky-900' : 'bg-white'"
              @click="beginRecording(command.action)"
            >
              {{ recording === command.action ? '請按新按鍵…' : displayBinding(command.action) }}
            </button>
          </li>
        </ul>
      </div>

      <p
        v-if="recordingError"
        role="alert"
        class="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-900"
      >
        {{ recordingError }}
      </p>
    </div>

    <p class="text-sm text-gray-600">僅授權角色可操作 integration、retention 與 system profile。</p>
  </section>
</template>
