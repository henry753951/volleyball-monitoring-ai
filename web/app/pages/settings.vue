<script setup lang="ts">
import {
  ANNOTATION_COMMANDS,
  normalizeAnnotationKey,
  type AnnotationAction,
} from '~/utils/annotationHotkeys'

const { bindings, rebind, restoreDefaults } = useAnnotationHotkeys()
const recording = ref<AnnotationAction | null>(null)
const recordingError = ref<string | null>(null)

function beginRecording(action: AnnotationAction) {
  recording.value = action
  recordingError.value = null
}

function onKeydown(event: KeyboardEvent) {
  if (!recording.value || event.repeat || event.isComposing) return
  event.preventDefault()
  const binding = normalizeAnnotationKey(event)
  if (!binding) {
    recordingError.value = '此按鍵無法用於標註快捷鍵，原綁定保持不變。'
    return
  }

  const result = rebind(recording.value, binding)
  if (!result.ok) {
    const conflict = ANNOTATION_COMMANDS.find(({ action }) => action === result.conflictWith)
    recordingError.value = `「${binding}」已綁定到「${conflict?.label ?? result.conflictWith}」，原綁定保持不變。`
    return
  }

  recording.value = null
  recordingError.value = null
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
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
          <h2 class="font-semibold">標註快捷鍵</h2>
          <p class="mt-1 text-sm text-stone-600">選擇一個 command 後按下新按鍵；衝突時不會覆蓋任何現有綁定。</p>
        </div>
        <button
          type="button"
          class="rounded-xl border px-3 py-2 text-sm font-medium hover:bg-stone-50"
          @click="restoreDefaults"
        >
          還原所有預設快捷鍵
        </button>
      </div>

      <ul class="mt-5 divide-y">
        <li
          v-for="command in ANNOTATION_COMMANDS"
          :key="command.action"
          class="flex items-center justify-between gap-4 py-3"
        >
          <div>
            <p class="font-medium">{{ command.label }}</p>
            <p
              v-if="command.action.startsWith('close_')"
              class="text-xs text-stone-500"
            >
              CLOSE_RALLY：terminalize最後key point並保存rally outcome
            </p>
          </div>
          <button
            type="button"
            class="min-w-28 rounded-xl border px-3 py-2 text-sm"
            :class="recording === command.action ? 'border-sky-500 bg-sky-50 text-sky-900' : 'bg-white'"
            @click="beginRecording(command.action)"
          >
            {{ recording === command.action ? '請按新按鍵…' : bindings[command.action] }}
          </button>
        </li>
      </ul>

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
