<script setup lang="ts">
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  type AnnotationAction,
  type HotkeyCommand,
  type MediaAction,
} from '~/utils/annotationHotkeys'

definePageMeta({ layout: 'annotation' })

type RallyUiState = 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED'
type ScoreResolution = 'pending' | 'resolved_left' | 'resolved_right' | 'unknown'

const state = ref<RallyUiState>('IDLE')
const score = ref<ScoreResolution>('pending')
const currentLastKeyPointId = ref<string | null>(null)
const canMark = ref(false) // true only when PlaybackCursor.cursor_status === ready
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')

const controls = computed(() => ANNOTATION_COMMANDS.map((command) => {
  const enabled = command.action === 'service'
    ? state.value === 'IDLE' && canMark.value
    : command.action === 'contact'
      ? state.value === 'OPEN' && canMark.value
      : command.action === 'submit'
        ? state.value === 'READY'
        : state.value === 'OPEN' && Boolean(currentLastKeyPointId.value)
  return { ...command, key: formatBindingForDisplay(bindings.value[command.action]), enabled }
}))

const scoreLabel = computed(() => ({
  pending: state.value === 'IDLE' ? '等待發球' : '回合進行中',
  resolved_left: '左側得分',
  resolved_right: '右側得分',
  unknown: '? 得分未知',
}[score.value]))

function dispatchAnnotationAction(action: AnnotationAction) {
  const control = controls.value.find((item) => item.action === action)
  if (!control?.enabled) return

  // Phase 3: this is the single command path used by touch and keyboard.
  // It sends the matching Annotation Realtime 2.0 command and waits for server ACK;
  // do not mutate canonical state optimistically here.
  const closesRally = action === 'close_left' || action === 'close_right' || action === 'close_unknown'
  console.info('annotation command scaffold', {
    action,
    kind: closesRally ? 'CLOSE_RALLY' : undefined,
    payload: closesRally
      ? {
          target_key_point_id: currentLastKeyPointId.value,
          score_resolution: action === 'close_unknown' ? 'unknown' : 'resolved',
          scoring_court_side: action === 'close_left' ? 'left' : action === 'close_right' ? 'right' : null,
        }
      : undefined,
  })
}

function dispatchMediaAction(action: MediaAction) {
  // Phase 3: media commands share the app-owned registry but never create annotations.
  console.info('media command scaffold', { action })
}

function dispatchHotkeyCommand(action: HotkeyCommand) {
  if (action === 'frame_previous' || action === 'frame_next') dispatchMediaAction(action)
  else dispatchAnnotationAction(action)
}

function commandEnabled(action: HotkeyCommand): boolean {
  if (action === 'frame_previous' || action === 'frame_next') return true
  return controls.value.some((control) => control.action === action && control.enabled)
}

useAnnotationHotkeyRuntime({
  target: annotationScope,
  dispatch: dispatchHotkeyCommand,
  commandEnabled,
})

function focusAnnotationScope() {
  annotationScope.value?.focus({ preventScroll: true })
}

onMounted(focusAnnotationScope)

const serviceKey = computed(() => formatBindingForDisplay(bindings.value.service))
const contactKey = computed(() => formatBindingForDisplay(bindings.value.contact))
const shortcutHint = computed(() => {
  const left = formatBindingForDisplay(bindings.value.close_left)
  const right = formatBindingForDisplay(bindings.value.close_right)
  const previous = formatBindingForDisplay(bindings.value.frame_previous)
  const next = formatBindingForDisplay(bindings.value.frame_next)
  return `${left} / ${right} 關閉 rally；${previous} / ${next} 只做逐幀或播放器移動。`
})
</script>

<template>
  <section
    ref="annotationScope"
    class="space-y-4 outline-none"
    tabindex="-1"
    @pointerdown.capture="focusAnnotationScope"
  >
    <header>
      <h1 class="text-2xl font-semibold">標註工作台</h1>
      <p class="mt-1 text-sm text-stone-600">
        伺服器保存整場 DVR；iPad 只 lazy-load 目前數分鐘。{{ serviceKey }} / {{ contactKey }} 只可使用後端解析成功的 presented-frame cursor。
      </p>
    </header>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="grid aspect-video place-items-center rounded-2xl bg-black text-center text-sm text-white/70">
        即時有聲 LL-HLS／歷史 playback window（Phase 2-3 串接）
      </div>
      <aside class="rounded-2xl border bg-white p-4 text-sm shadow-sm">
        <p class="font-medium">操作狀態</p>
        <dl class="mt-3 grid grid-cols-2 gap-2">
          <dt class="text-stone-500">Rally</dt><dd>{{ state }}</dd>
          <dt class="text-stone-500">得分</dt><dd>{{ scoreLabel }}</dd>
          <dt class="text-stone-500">Cursor</dt><dd>{{ canMark ? 'ready' : 'stale' }}</dd>
          <dt class="text-stone-500">Last key point</dt><dd>{{ currentLastKeyPointId ?? '—' }}</dd>
        </dl>
      </aside>
    </div>

    <div class="rounded-2xl border bg-white p-3 shadow-sm">
      <div class="relative h-32 overflow-hidden rounded-xl bg-stone-100">
        <div
          v-if="state !== 'IDLE'"
          class="absolute inset-y-4 left-[8%] right-[12%] rounded-xl border px-3 py-2"
          :class="state === 'SUBMITTED' ? 'border-emerald-300 bg-emerald-100/75' : 'border-stone-300 bg-stone-200/75'"
        >
          <div class="flex justify-between text-xs font-medium">
            <span>{{ scoreLabel }}</span>
            <span>{{ state === 'SUBMITTED' ? '已提交 · AI 狀態另顯示' : '尚未提交 · 可編輯' }}</span>
          </div>
          <div class="mt-10 flex items-center justify-between text-xs">
            <span class="rounded bg-white px-2 py-1">{{ serviceKey }} / service</span>
            <span>• contact</span><span>• contact</span>
            <span class="rounded bg-white px-2 py-1">◆ terminal</span>
          </div>
        </div>
        <div v-else class="grid h-full place-items-center text-sm text-stone-500">等待 {{ serviceKey }} 發球</div>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <button
        v-for="control in controls"
        :key="control.label"
        type="button"
        class="min-h-16 rounded-2xl border bg-white px-3 py-2 text-left shadow-sm active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!control.enabled"
        @click="dispatchAnnotationAction(control.action)"
      >
        <span class="block font-medium">{{ control.key }} {{ control.label }}</span>
        <span class="text-xs text-stone-500">可在設定中重新綁定</span>
      </button>
    </div>

    <div class="grid gap-2 text-sm md:grid-cols-2">
      <p class="rounded-xl bg-amber-50 p-3 text-amber-950">
        左側、右側或未知會以單一 CLOSE_RALLY command，把server-confirmed最後key point標為terminal並保存rally outcome；不建立新時間點。
      </p>
      <p class="rounded-xl bg-sky-50 p-3 text-sky-950">{{ shortcutHint }}</p>
    </div>
  </section>
</template>
