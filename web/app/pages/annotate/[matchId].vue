<script setup lang="ts">
definePageMeta({ layout: 'annotation' })

type RallyUiState = 'IDLE' | 'OPEN' | 'AWAITING_SCORE' | 'READY' | 'SUBMITTED'
type ScoreResolution = 'pending' | 'resolved_left' | 'resolved_right' | 'unknown'
type AnnotationAction = 'service' | 'contact' | 'terminal' | 'score_left' | 'score_right' | 'score_unknown' | 'submit'

const state = ref<RallyUiState>('IDLE')
const score = ref<ScoreResolution>('pending')
const currentLastKeyPointId = ref<string | null>(null)
const canMark = ref(false) // true only when PlaybackCursor.cursor_status === ready

const controls = computed(() => [
  { action: 'service' as const, label: 'Z 發球', key: 'Z', enabled: state.value === 'IDLE' && canMark.value },
  { action: 'contact' as const, label: 'Space 擊球', key: 'Space', enabled: state.value === 'OPEN' && canMark.value },
  { action: 'terminal' as const, label: 'X 結束', key: 'X', enabled: state.value === 'OPEN' && Boolean(currentLastKeyPointId.value) },
  { action: 'score_left' as const, label: '< 左側得分', key: '<', enabled: state.value === 'AWAITING_SCORE' },
  { action: 'score_right' as const, label: '> 右側得分', key: '>', enabled: state.value === 'AWAITING_SCORE' },
  { action: 'score_unknown' as const, label: '? 未知', key: '?', enabled: state.value === 'AWAITING_SCORE' },
  { action: 'submit' as const, label: 'Enter 提交', key: 'Enter', enabled: state.value === 'READY' },
])

const scoreLabel = computed(() => ({
  pending: state.value === 'IDLE' || state.value === 'OPEN' ? '回合尚未結束' : '等待得分',
  resolved_left: '左側得分',
  resolved_right: '右側得分',
  unknown: '? 得分未知',
}[score.value]))

function dispatchAnnotationAction(action: AnnotationAction) {
  const control = controls.value.find((item) => item.action === action)
  if (!control?.enabled) return

  // Phase 3: this is the single command path used by touch and keyboard.
  // It sends the matching Annotation Realtime 1.1 command and waits for server ACK;
  // do not mutate canonical state optimistically here.
  console.info('annotation command scaffold', {
    action,
    target_key_point_id: action === 'terminal' ? currentLastKeyPointId.value : undefined,
  })
}

function actionFromKeyboard(event: KeyboardEvent): AnnotationAction | null {
  if (event.repeat || event.isComposing) return null
  const target = event.target as HTMLElement | null
  if (target?.matches('input, textarea, select, [contenteditable="true"]')) return null

  if (event.code === 'Space') return 'contact'
  if (event.key === 'Enter') return 'submit'
  if (event.key === '<') return 'score_left'
  if (event.key === '>') return 'score_right'
  if (event.key === '?') return 'score_unknown'
  if (event.key.toLowerCase() === 'z') return 'service'
  if (event.key.toLowerCase() === 'x') return 'terminal'
  return null
}

function onKeydown(event: KeyboardEvent) {
  const action = actionFromKeyboard(event)
  if (!action) return
  event.preventDefault()
  dispatchAnnotationAction(action)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const shortcutHint = '< / > 使用 Shift + , / Shift + .；方向鍵只做逐幀或播放器移動。'
</script>

<template>
  <section class="space-y-4">
    <header>
      <h1 class="text-2xl font-semibold">標註工作台</h1>
      <p class="mt-1 text-sm text-stone-600">
        伺服器保存整場 DVR；iPad 只 lazy-load 目前數分鐘。Z / Space 只可使用後端解析成功的 presented-frame cursor。
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
            <span class="rounded bg-white px-2 py-1">Z / service</span>
            <span>• contact</span><span>• contact</span>
            <span class="rounded bg-white px-2 py-1">◆ terminal</span>
          </div>
        </div>
        <div v-else class="grid h-full place-items-center text-sm text-stone-500">等待 Z 發球</div>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
      <button
        v-for="control in controls"
        :key="control.label"
        type="button"
        class="min-h-16 rounded-2xl border bg-white px-3 py-2 text-left shadow-sm active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!control.enabled"
        @click="dispatchAnnotationAction(control.action)"
      >
        <span class="block font-medium">{{ control.label }}</span>
        <span class="text-xs text-stone-500">快捷鍵 {{ control.key }}</span>
      </button>
    </div>

    <div class="grid gap-2 text-sm md:grid-cols-2">
      <p class="rounded-xl bg-amber-50 p-3 text-amber-950">
        X 不建立新時間點；client以server-confirmed最後key point作target，由server在base revision再次驗證。
      </p>
      <p class="rounded-xl bg-sky-50 p-3 text-sky-950">{{ shortcutHint }}</p>
    </div>
  </section>
</template>
