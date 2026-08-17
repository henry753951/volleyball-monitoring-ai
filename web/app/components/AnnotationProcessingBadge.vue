<script setup lang="ts">
import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'
import { AlertTriangle, Bot, Check, Clock3, RotateCcw, Scissors } from 'lucide-vue-next'
import { AnimatePresence, Motion } from 'motion-v'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  label: string
  processing?: AnnotationRallyProcessingUpdate | null
  retrying?: boolean
}>()
const emit = defineEmits<{ retry: [] }>()

type PhaseKey = 'clip' | 'assign' | 'analyze'
const phases = [
  { key: 'clip' as const, label: '剪切', icon: Scissors },
  { key: 'assign' as const, label: '分配', icon: Clock3 },
  { key: 'analyze' as const, label: '分析', icon: Bot },
]

const root = ref<HTMLElement | null>(null)
const hovered = ref(false)
const pinned = ref(false)
const open = computed(() => hovered.value || pinned.value)
const failed = computed(() => props.processing?.processing_status === 'failed')
const completed = computed(() => props.processing?.processing_status === 'completed')
const active = computed(() =>
  Boolean(
    props.processing &&
    !failed.value &&
    !completed.value &&
    props.processing.processing_status !== 'superseded',
  ),
)

const analysisStages = new Set([
  'analysis_bundle_ready',
  'analysis_data_ready',
  'building_artifacts',
  'building_wire_artifacts',
  'callback',
  'completed',
  'court_projection',
  'court_reidentification',
  'hit_association',
  'loading_court_keypose',
  'loading_models',
  'loading_osnet',
  'loading_reference_data',
  'loading_rtv4_x3d',
  'player_tracking',
  'reidentification',
  'rtv4_x3d_tracking',
  'writing_visual_v5_artifacts',
])
const assignmentStages = new Set([
  'accepted',
  'ai_queued',
  'assigned',
  'clip_ready',
  'downloading_clip',
  'waiting_worker',
])
const activePhaseKey = computed<PhaseKey>(() => {
  const stage = props.processing?.stage ?? ''
  const status = props.processing?.processing_status
  const providerAnalysisFailed = props.processing?.error?.code === 'PROVIDER_ANALYSIS_FAILED'
  if (
    completed.value ||
    providerAnalysisFailed ||
    status === 'ai_processing' ||
    status === 'artifact_ingesting' ||
    analysisStages.has(stage)
  )
    return 'analyze'
  if (
    status === 'ai_queued' &&
    props.processing?.worker_instance_key &&
    stage.length > 0 &&
    !assignmentStages.has(stage)
  )
    return 'analyze'
  if (status === 'ai_queued' || assignmentStages.has(stage)) return 'assign'
  return 'clip'
})
const activePhaseIndex = computed(() =>
  phases.findIndex(phase => phase.key === activePhaseKey.value),
)
const phaseState = (index: number) =>
  completed.value || index < activePhaseIndex.value
    ? 'done'
    : index === activePhaseIndex.value
      ? failed.value
        ? 'failed'
        : 'current'
      : 'pending'

const detailTitle = computed(() => {
  if (completed.value) return '分析結果已完成'
  const phase = phases[activePhaseIndex.value]!
  return failed.value ? `${phase.label}階段失敗` : `${phase.label}階段進行中`
})
const detailDescription = computed(() => {
  const stage = props.processing?.stage ?? ''
  if (activePhaseKey.value === 'clip')
    return '依標記的起訖畫格建立標準化片段，並檢查 frame sequence 是否連續。'
  if (activePhaseKey.value === 'assign') {
    if (stage === 'downloading_clip' || stage === 'clip_ready')
      return 'Worker 已接手工作，正在下載標準化片段。'
    if (props.processing?.worker_instance_key)
      return `已分配給 ${props.processing.worker_instance_key}，等待 Worker 開始分析。`
    return '中央系統正在等待可用的 AI Worker。'
  }
  if (stage.startsWith('loading_')) return 'Worker 正在載入球場、追蹤與 ReID 模型。'
  if (stage.includes('tracking') || stage === 'player_tracking')
    return '正在辨識球場關鍵點並追蹤場上球員。'
  if (stage === 'court_projection') return '正在將畫面位置轉換到標準球場座標。'
  if (stage === 'court_reidentification' || stage === 'reidentification')
    return '正在合併跨畫格的球員身份。'
  if (stage === 'hit_association') return '正在將擊球標記與球員、球路事件建立關聯。'
  if (stage === 'callback' || props.processing?.processing_status === 'artifact_ingesting')
    return '分析已完成，正在回傳並寫入中央系統。'
  if (completed.value) return '中央系統已收到完整分析結果。'
  return 'AI 正在產生球場、球員與擊球事件分析。'
})
const percentage = computed(() => {
  if (completed.value) return 100
  const raw = Math.max(0, Math.min(1, props.processing?.progress ?? 0))
  if (activePhaseKey.value === 'clip') return Math.max(3, Math.round(raw * 10))
  if (activePhaseKey.value === 'assign') return Math.max(34, Math.round(34 + raw * 10))
  return Math.max(67, Math.round(67 + raw * 32))
})
const errorCode = computed(() =>
  typeof props.processing?.error?.code === 'string' ? props.processing.error.code : null,
)
const errorMessage = computed(() =>
  typeof props.processing?.error?.message === 'string' ? props.processing.error.message : null,
)
const attemptLabel = computed(() => {
  const attempt = props.processing?.error?.attempt_count
  const maximum = props.processing?.error?.max_attempts
  return typeof attempt === 'number' && typeof maximum === 'number'
    ? `已嘗試 ${attempt} / ${maximum} 次`
    : null
})
const workerBuildLabel = computed(() => {
  if (activePhaseKey.value === 'clip') return failed.value ? '剪切工作未完成' : '剪切 Worker 處理中'
  if (!props.processing?.worker_instance_key)
    return activePhaseKey.value === 'assign' ? '等待可用 AI Worker' : 'Worker 資訊尚未回報'
  return props.processing.provider_build_id
    ? `${props.processing.worker_instance_key} · ${props.processing.provider_build_id}`
    : props.processing.worker_instance_key
})
const updatedLabel = computed(() => {
  const value = props.processing?.updated_at
  if (!value) return '等待進度回報'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 2) return '剛剛更新'
  if (seconds < 60) return `${seconds} 秒前更新`
  return `${Math.floor(seconds / 60)} 分鐘前更新`
})

function closeFromOutside(event: PointerEvent) {
  if (root.value?.contains(event.target as Node)) return
  pinned.value = false
}
onMounted(() => document.addEventListener('pointerdown', closeFromOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeFromOutside))
</script>

<template>
  <div
    ref="root"
    class="processing-anchor"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="hovered = true"
    @focusout="hovered = false"
    @keydown.esc="pinned = false"
  >
    <button
      type="button"
      class="processing-badge"
      :class="{ active, failed, completed }"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click.stop="pinned = !pinned"
    >
      <AlertTriangle v-if="failed" :size="13" />
      <Check v-else-if="completed" :size="13" />
      <Scissors v-else-if="activePhaseKey === 'clip'" :size="13" />
      <Clock3 v-else-if="activePhaseKey === 'assign'" :size="13" />
      <Bot v-else :size="13" />
      {{ label }}
    </button>
    <AnimatePresence>
      <Motion
        v-if="open && processing"
        layout
        class="processing-card"
        :class="{ failed }"
        role="dialog"
        aria-label="AI 處理進度"
        :initial="{ opacity: 0, y: 8, scale: 0.985 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 5, scale: 0.99 }"
        :transition="{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }"
      >
        <header class="card-heading">
          <div>
            <strong>{{ detailTitle }}</strong
            ><small>{{ workerBuildLabel }}</small>
          </div>
          <b>{{ percentage }}%</b>
        </header>
        <div class="progress-track">
          <Motion
            :animate="{ width: `${percentage}%` }"
            :transition="{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }"
          />
        </div>
        <ol class="phase-strip">
          <li v-for="(phase, index) in phases" :key="phase.key" :class="phaseState(index)">
            <i
              ><Check v-if="phaseState(index) === 'done'" :size="12" /><AlertTriangle
                v-else-if="phaseState(index) === 'failed'"
                :size="12" /><component :is="phase.icon" v-else :size="12"
            /></i>
            <span>{{ phase.label }}</span>
          </li>
        </ol>
        <AnimatePresence mode="wait">
          <Motion
            :key="`${activePhaseKey}:${failed ? 'failed' : 'active'}`"
            layout
            class="phase-detail"
            :class="{ failed }"
            :initial="{ opacity: 0, y: 7, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -5, filter: 'blur(2px)' }"
            :transition="{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }"
          >
            <div class="phase-title">
              <component :is="phases[activePhaseIndex]?.icon" :size="18" /><strong>{{
                detailTitle
              }}</strong>
            </div>
            <p>{{ detailDescription }}</p>
            <template v-if="failed">
              <div class="error-message">
                {{ errorMessage ?? '中央系統未收到可顯示的錯誤訊息。' }}
              </div>
              <div class="error-meta">
                <code v-if="errorCode">{{ errorCode }}</code
                ><span v-if="attemptLabel">{{ attemptLabel }}</span>
              </div>
              <button
                type="button"
                class="retry-button"
                :disabled="retrying"
                @click.stop="emit('retry')"
              >
                <RotateCcw :size="14" :class="{ spinning: retrying }" />{{
                  retrying ? '重新排程中' : '重新處理'
                }}
              </button>
            </template>
          </Motion>
        </AnimatePresence>
        <footer>
          <code>{{
            processing.ai_job_id?.slice(0, 8) ??
            (typeof processing.error?.job_id === 'string'
              ? processing.error.job_id.slice(0, 8)
              : '—')
          }}</code
          ><span>{{ updatedLabel }}</span>
        </footer>
      </Motion>
    </AnimatePresence>
  </div>
</template>

<style scoped>
.processing-anchor {
  position: relative;
  display: inline-flex;
}
.processing-badge {
  min-height: 26px !important;
  display: inline-flex !important;
  align-items: center;
  gap: 6px;
  padding: 4px 9px !important;
  border: 0 !important;
  border-radius: 999px !important;
  background: #27272a !important;
  color: #d4d4d8 !important;
  font-size: 0.62rem !important;
  font-weight: 750;
  white-space: nowrap;
}
.processing-badge.active {
  background: #3f3218 !important;
  color: #f8d58b !important;
}
.processing-badge.failed {
  background: #4b2025 !important;
  color: #ffb3b8 !important;
}
.processing-badge.completed {
  background: #173c29 !important;
  color: #86efac !important;
}
.processing-badge:focus-visible {
  outline: 2px solid #c6d7e6 !important;
  outline-offset: 2px;
}
.processing-card {
  position: absolute;
  z-index: 50;
  right: 0;
  bottom: calc(100% + 12px);
  width: min(390px, calc(100vw - 28px));
  padding: 18px;
  border-radius: 14px;
  background: #121214;
  color: #f4f4f5;
  box-shadow: 0 20px 58px 8px #000b;
  transform-origin: bottom right;
}
.processing-card::after {
  position: absolute;
  right: 24px;
  bottom: -5px;
  width: 10px;
  height: 10px;
  background: #121214;
  content: '';
  transform: rotate(45deg);
}
.card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}
.card-heading > div {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.card-heading strong {
  font-size: 0.86rem;
  font-weight: 750;
}
.card-heading small {
  overflow: hidden;
  color: #a1a1aa;
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-heading b {
  color: #e4e4e7;
  font:
    750 0.76rem 'Cascadia Mono',
    Consolas,
    monospace;
}
.progress-track {
  height: 5px;
  margin: 15px 0 18px;
  overflow: hidden;
  border-radius: 999px;
  background: #2f2f35;
}
.progress-track > div {
  height: 100%;
  border-radius: inherit;
  background: #d2aa58;
}
.processing-card.failed .progress-track > div {
  background: #e16c74;
}
.phase-strip {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.phase-strip::before {
  position: absolute;
  left: 15%;
  right: 15%;
  top: 15px;
  height: 1px;
  background: #3f3f46;
  content: '';
}
.phase-strip li {
  position: relative;
  z-index: 1;
  display: grid;
  justify-items: center;
  gap: 7px;
  color: #71717a;
  font-size: 0.7rem;
  font-weight: 700;
}
.phase-strip i {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid #414148;
  border-radius: 50%;
  background: #18181b;
}
.phase-strip li.done {
  color: #a7d8b8;
}
.phase-strip li.done i {
  border-color: #456652;
  background: #203328;
  color: #8bd0a5;
}
.phase-strip li.current {
  color: #f3d99f;
}
.phase-strip li.current i {
  border-color: #8a6d36;
  background: #392e18;
  color: #e5bd67;
}
.phase-strip li.failed {
  color: #ffb3b8;
}
.phase-strip li.failed i {
  border-color: #9b454c;
  background: #3b1e22;
  color: #ff9da5;
}
.phase-detail {
  min-height: 118px;
  display: grid;
  align-content: start;
  gap: 9px;
  margin-top: 18px;
  padding: 14px;
  border-radius: 10px;
  background: #1c1c20;
}
.phase-detail.failed {
  background: #2b181b;
}
.phase-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f4f4f5;
}
.phase-title strong {
  font-size: 0.78rem;
}
.phase-detail.failed .phase-title {
  color: #ffb3b8;
}
.phase-detail p {
  margin: 0;
  color: #b4b4bc;
  font-size: 0.7rem;
  line-height: 1.55;
}
.error-message {
  overflow-wrap: anywhere;
  color: #f0c8cb;
  font-size: 0.7rem;
  font-weight: 650;
  line-height: 1.45;
}
.error-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #c39498;
  font-size: 0.62rem;
}
.error-meta code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.retry-button {
  min-height: 34px !important;
  display: flex !important;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 2px;
  padding: 0 12px !important;
  border: 0 !important;
  border-radius: 8px !important;
  background: #f1f1f3 !important;
  color: #202024 !important;
  font-size: 0.7rem !important;
  font-weight: 750;
}
.retry-button:hover:not(:disabled) {
  background: #fff !important;
}
.retry-button:disabled {
  cursor: wait;
  opacity: 0.58;
}
.spinning {
  animation: spin 0.9s linear infinite;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #2f2f34;
  color: #7f7f89;
  font-size: 0.62rem;
}
footer code {
  font-size: 0.62rem;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 520px) {
  .processing-card {
    position: fixed;
    right: 14px;
    bottom: 68px;
  }
  .processing-card::after {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
  .processing-card,
  .progress-track > div,
  .phase-detail {
    transition: none !important;
  }
}
</style>
