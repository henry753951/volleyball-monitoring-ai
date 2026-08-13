<script setup lang="ts">
import { DialogDescription } from 'reka-ui'
import { Download, FileArchive, Film } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import UiButton from '~/components/ui/Button.vue'

const props = defineProps<{
  open: boolean
  rallyId: string | null
  analysisRunId: string | null
  title: string
}>()
const emit = defineEmits<{ close: [] }>()
const mode = ref<'video' | 'dataset'>('video')

watch(() => props.open, open => { if (open) mode.value = 'video' })

function download() {
  if (!props.rallyId) return
  const href = mode.value === 'dataset' && props.analysisRunId
    ? `/api/v1/analysis-runs/${encodeURIComponent(props.analysisRunId)}/dataset.zip`
    : `/api/v1/analysis/rallies/${encodeURIComponent(props.rallyId)}/clip`
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = ''
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  emit('close')
}
</script>

<template>
  <UiAnimatedModal :open="open" title="下載片段" width="compact" @close="emit('close')">
    <div class="download-dialog">
      <DialogDescription>選擇要下載「{{ title }}」的原始片段，或可直接交給 ML 工程師使用的完整資料集。</DialogDescription>
      <label :class="{ selected: mode === 'video' }"><input v-model="mode" type="radio" value="video"><Film :size="18" /><span><strong>只下載影片</strong><small>原始 canonical clip，不重新編碼。</small></span></label>
      <label :class="{ selected: mode === 'dataset', disabled: !analysisRunId }"><input v-model="mode" type="radio" value="dataset" :disabled="!analysisRunId"><FileArchive :size="18" /><span><strong>ML 實驗資料集 ZIP</strong><small>{{ analysisRunId ? '含原始片段、來源與裁切資訊、影片與 PTS 時間軸、AnalysisData、分開的球員／球／場地／動作／擊球 JSONL、人工修正、ReID、模型版本與逐檔 checksum。' : '此片段尚未完成 AI 分析。' }}</small></span></label>
    </div>
    <template #footer><UiButton variant="ghost" @click="emit('close')">取消</UiButton><UiButton :disabled="!rallyId || (mode === 'dataset' && !analysisRunId)" @click="download"><Download :size="15" />開始下載</UiButton></template>
  </UiAnimatedModal>
</template>

<style scoped>
.download-dialog{display:grid;gap:8px;padding:18px}.download-dialog>p{margin:0 0 5px;color:#a1a1aa;font-size:.7rem;line-height:1.55}.download-dialog label{min-height:64px;display:grid;grid-template-columns:auto 22px minmax(0,1fr);align-items:center;gap:10px;padding:10px;border:1px solid #34383d;border-radius:10px;background:#15181b;color:#b9c0c7;cursor:pointer}.download-dialog label.selected{border-color:#7794aa;background:#1b252d;color:#f1f5f8}.download-dialog label.disabled{cursor:not-allowed;opacity:.48}.download-dialog label>span{display:grid;gap:3px}.download-dialog strong{font-size:.7rem}.download-dialog small{color:#858e97;font-size:.58rem;line-height:1.4;overflow-wrap:anywhere}
</style>
