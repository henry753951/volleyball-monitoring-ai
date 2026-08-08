<script setup lang="ts">
import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'
import { Activity, Bot, Check, CircleDotDashed } from 'lucide-vue-next'
import { AnimatePresence, Motion } from 'motion-v'
import { computed, ref } from 'vue'

const props = defineProps<{
  label: string
  processing?: AnnotationRallyProcessingUpdate | null
}>()

const open = ref(false)
const stages = [
  ['assigned', '已分配'],
  ['downloading_clip', '下載片段'],
  ['loading_reference_data', '讀取追蹤資料'],
  ['court_projection', '場地轉換'],
  ['player_tracking', '人物追蹤'],
  ['reidentification', '身份合併'],
  ['hit_association', '擊球者關聯'],
  ['building_artifacts', '建立分析資產'],
  ['callback', '回傳中央系統'],
  ['completed', '分析完成'],
] as const
const stageIndex = computed(() => {
  if (props.processing?.processing_status === 'completed') return stages.length - 1
  const found = stages.findIndex(([key]) => key === props.processing?.stage)
  return found < 0 ? 0 : found
})
const percentage = computed(() => Math.round((props.processing?.progress ?? 0) * 100))
const active = computed(() => Boolean(props.processing && !['completed', 'failed', 'superseded'].includes(props.processing.processing_status)))
const updatedLabel = computed(() => {
  const value = props.processing?.updated_at
  if (!value) return '等待即時進度'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  return seconds < 2 ? '剛剛更新' : `${seconds} 秒前更新`
})
</script>

<template>
  <span class="processing-anchor" @mouseenter="open = true" @mouseleave="open = false" @focusin="open = true" @focusout="open = false">
    <button type="button" class="processing-badge" :class="{ active }" :aria-expanded="open">
      <Activity v-if="active" :size="11" />
      <Check v-else-if="processing?.processing_status === 'completed'" :size="11" />
      <CircleDotDashed v-else :size="11" />
      {{ label }}
    </button>
    <AnimatePresence>
      <Motion
        v-if="open && processing"
        class="processing-card"
        :initial="{ opacity: 0, y: 5, scale: 0.985 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 3, scale: 0.99 }"
        :transition="{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }"
      >
        <header>
          <span><Bot :size="14" /></span>
          <div><strong>{{ processing.worker_instance_key ?? '等待 AI worker' }}</strong><small>{{ processing.provider_build_id ?? '尚未分配' }}</small></div>
          <b>{{ percentage }}%</b>
        </header>
        <div class="progress"><Motion :animate="{ width: `${percentage}%` }" :transition="{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }" /></div>
        <ol>
          <li v-for="([key, name], index) in stages" :key="key" :class="{ done: index < stageIndex, current: index === stageIndex }">
            <i><Check v-if="index < stageIndex" :size="9" /><span v-else /></i>
            <span>{{ name }}</span>
          </li>
        </ol>
        <footer><code>{{ processing.ai_job_id?.slice(0, 8) ?? '—' }}</code><span>{{ updatedLabel }}</span></footer>
      </Motion>
    </AnimatePresence>
  </span>
</template>

<style scoped>
.processing-anchor{position:relative;display:inline-flex}.processing-badge{min-height:23px!important;display:inline-flex!important;align-items:center;gap:4px;padding:3px 7px!important;border:0!important;border-radius:999px!important;background:#27272a!important;color:#d4d4d8!important;font-size:.56rem!important;font-weight:750;white-space:nowrap}.processing-badge.active{background:#3f3218!important;color:#f8d58b!important}.processing-card{position:absolute;z-index:50;left:50%;bottom:calc(100% + 10px);width:292px;padding:12px;border:1px solid #34343a;border-radius:12px;background:#121214;color:#f4f4f5;box-shadow:0 18px 55px #000a;transform-origin:bottom center}.processing-card::after{position:absolute;left:50%;bottom:-5px;width:9px;height:9px;border-right:1px solid #34343a;border-bottom:1px solid #34343a;background:#121214;content:"";transform:translateX(-50%) rotate(45deg)}header{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:8px}header>span{width:30px;height:30px;display:grid;place-items:center;border-radius:8px;background:#242428;color:#d8d8dc}header>div{min-width:0;display:grid;gap:2px}header strong,header small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}header strong{font-size:.67rem}header small{color:#85858e;font-size:.54rem}header b{font:700 .66rem "Cascadia Mono",Consolas,monospace}.progress{height:3px;margin:10px 0;overflow:hidden;border-radius:999px;background:#2b2b30}.progress>div{height:100%;border-radius:inherit;background:#d2aa58}ol{max-height:190px;display:grid;grid-template-columns:1fr 1fr;gap:7px 10px;margin:0;padding:0;list-style:none}li{display:flex;align-items:center;gap:6px;color:#686870;font-size:.56rem}li i{width:13px;height:13px;display:grid;place-items:center;border:1px solid #3a3a40;border-radius:50%}li i span{width:4px;height:4px;border-radius:50%;background:#55555d}li.done{color:#a6a6ad}li.done i{border-color:#456652;background:#203328;color:#8bd0a5}li.current{color:#f0d79e}li.current i{border-color:#806735}li.current i span{background:#e2b963}footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px solid #29292e;color:#71717a;font-size:.53rem}footer code{font-size:.53rem}@media(prefers-reduced-motion:reduce){.processing-card,.progress>div{transition:none!important}}
</style>
