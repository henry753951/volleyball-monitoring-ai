<script setup lang="ts">
import { ANALYSIS_REVIEW_ACTIONS, type AnalysisReviewAction } from '@volleyball-monitoring/contracts'
import { CircleDotDashed, Cloud, CloudOff, LoaderCircle, MousePointer2, ScanSearch } from 'lucide-vue-next'

const props = defineProps<{
  analysisRunId: string | null
  frameIndex: number
  ballRelabel: boolean
  ballPosition: { x: number; y: number } | null
  selectedTrackId: number | null
  selectedTrackAction: string | null
  revision: string
  saving: boolean
  connection: 'idle' | 'connecting' | 'ready' | 'offline'
}>()
const emit = defineEmits<{
  toggleBallRelabel: []
  setAction: [action: AnalysisReviewAction]
}>()
</script>

<template>
  <div class="analysis-panel">
    <div v-if="!analysisRunId" class="analysis-empty"><ScanSearch :size="18" />選取已完成分析的片段</div>
    <template v-else>
      <header class="review-status">
        <span><Cloud v-if="connection === 'ready'" :size="14" /><CloudOff v-else :size="14" />修正版本 {{ revision }}</span>
        <LoaderCircle v-if="saving" class="spin" :size="14" />
        <small v-else>{{ connection === 'ready' ? '即時同步' : '重新連線中' }}</small>
      </header>

      <section class="review-tool">
        <div>
          <CircleDotDashed :size="17" />
          <span><strong>球座標重標</strong><small>Frame {{ frameIndex >= 0 ? frameIndex : '—' }}</small></span>
        </div>
        <button type="button" role="switch" :aria-checked="ballRelabel" :class="{ active: ballRelabel }" :disabled="frameIndex < 0" @click="emit('toggleBallRelabel')"><i /></button>
      </section>
      <p class="tool-hint">{{ ballRelabel ? '點擊影片即可改寫此幀球座標；連續點擊會合併成一次短批次儲存。' : '開啟後，影片上的點擊會改為球座標重標。' }}</p>
      <dl v-if="ballPosition" class="position-readout"><div><dt>X</dt><dd>{{ ballPosition.x.toFixed(1) }}</dd></div><div><dt>Y</dt><dd>{{ ballPosition.y.toFixed(1) }}</dd></div></dl>

      <section class="action-editor" :class="{ disabled: ballRelabel }">
        <header><MousePointer2 :size="15" /><span>逐幀動作</span><code>{{ selectedTrackId === null ? '未選球員' : `Track ${selectedTrackId}` }}</code></header>
        <p v-if="selectedTrackId === null">關閉球重標後，直接點擊影片中的球員框。</p>
        <div v-else class="action-grid">
          <button v-for="action in ANALYSIS_REVIEW_ACTIONS" :key="action" type="button" :class="{ active: selectedTrackAction === action }" :disabled="ballRelabel || frameIndex < 0" @click="emit('setAction', action)">{{ action }}</button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analysis-panel{display:grid;gap:12px}.analysis-empty{min-height:120px;display:grid;place-content:center;justify-items:center;gap:8px;color:#7f8994;font-size:.68rem}.review-status{height:31px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2c3238;color:#aeb8c2;font-size:.62rem}.review-status span{display:flex;align-items:center;gap:6px}.review-status small{color:#6f7b86}.review-tool{display:flex;align-items:center;justify-content:space-between;gap:10px}.review-tool>div{display:flex;align-items:center;gap:8px}.review-tool span{display:grid;gap:2px}.review-tool strong{font-size:.69rem}.review-tool small{color:#7f8994;font:600 .57rem "Cascadia Mono",Consolas,monospace}.review-tool button{position:relative;width:34px;min-height:19px!important;padding:0!important;border:0!important;border-radius:999px!important;background:#343a40!important}.review-tool button i{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#aab2ba;transition:transform 140ms ease,background 140ms ease}.review-tool button.active{background:#365f4b!important}.review-tool button.active i{transform:translateX(15px);background:#e5fff1}.tool-hint{margin:0;color:#7d8791;font-size:.61rem;line-height:1.45}.position-readout{display:grid;grid-template-columns:1fr 1fr;margin:0;border:1px solid #292f35;border-radius:6px;overflow:hidden}.position-readout div{display:flex;align-items:center;justify-content:space-between;padding:6px 8px}.position-readout div+div{border-left:1px solid #292f35}.position-readout dt{color:#77828d;font-size:.57rem}.position-readout dd{margin:0;font:700 .63rem "Cascadia Mono",Consolas,monospace}.action-editor{display:grid;gap:9px;padding-top:10px;border-top:1px solid #292f35}.action-editor.disabled{opacity:.42}.action-editor header{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:7px}.action-editor header span{font-size:.68rem;font-weight:700}.action-editor code{color:#9fc7eb;font-size:.57rem}.action-editor>p{margin:0;padding:12px 6px;color:#7f8994;font-size:.62rem;text-align:center}.action-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.action-grid button{min-height:29px!important;padding:4px!important;border-color:#2f363d!important;background:#171b1f!important;color:#aab3bc!important;font-size:.57rem}.action-grid button.active{border-color:#6b879b!important;background:#243440!important;color:#edf7ff!important}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}.review-tool button i{transition:none}}
</style>
