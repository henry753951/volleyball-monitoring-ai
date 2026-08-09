<script setup lang="ts">
import { ANALYSIS_REVIEW_ACTIONS, type AnalysisReviewAction } from '@volleyball-monitoring/contracts'
import { Ban, CircleDotDashed, Cloud, CloudOff, Crosshair, LoaderCircle, MousePointer2, RotateCcw, ScanLine, ScanSearch, UserRoundCheck, UserRoundX } from 'lucide-vue-next'

export interface AnalysisHitListItem {
  keyPointId: string
  sequenceIndex: number
  frameIndex: number
  actorTrackId: number | null
  actorLabel: string
  actorSource: 'auto' | 'manual' | 'none'
  ballLabel: string
}

const props = defineProps<{
  analysisRunId: string | null
  frameIndex: number
  ballRelabel: boolean
  bboxRelabel: boolean
  ballOverride: 'position' | 'missing' | null
  ballPosition: { x: number; y: number } | null
  selectedTrackId: number | null
  selectedTrackAction: string | null
  selectedHitId: string | null
  selectedHitHasOverride: boolean
  hasActionOverride: boolean
  hasBboxOverride: boolean
  hits: AnalysisHitListItem[]
  saving: boolean
  connection: 'idle' | 'connecting' | 'ready' | 'offline'
}>()

const emit = defineEmits<{
  toggleBallRelabel: []
  markBallMissing: []
  clearBall: []
  setAction: [action: AnalysisReviewAction]
  clearAction: []
  startBBox: []
  clearBBox: []
  selectHit: [keyPointId: string]
  assignHit: [keyPointId: string]
  noHitActor: [keyPointId: string]
  clearHitActor: [keyPointId: string]
}>()

const selectedHit = computed(() => props.hits.find(hit => hit.keyPointId === props.selectedHitId) ?? null)
</script>

<template>
  <div class="analysis-panel">
    <div v-if="!analysisRunId" class="analysis-empty"><ScanSearch :size="18" />選取已完成分析的片段</div>
    <template v-else>
      <header class="review-status">
        <span><Cloud v-if="connection === 'ready'" :size="14" /><CloudOff v-else :size="14" />{{ connection === 'ready' ? '分析修正已連線' : '重新連線中' }}</span>
        <span class="save-state"><LoaderCircle v-if="saving" class="spin" :size="14" />{{ saving ? '儲存中' : '即時同步' }}</span>
      </header>

      <section class="hit-editor">
        <header class="section-heading"><span><Crosshair :size="15" />擊球時間線</span><b>{{ hits.length }}</b></header>
        <p v-if="!hits.length" class="empty-row">此分析沒有擊球事件。</p>
        <ol v-else class="hit-list">
          <li v-for="hit in hits" :key="hit.keyPointId" :class="{ selected: selectedHitId === hit.keyPointId }">
            <button type="button" class="hit-main" @click="emit('selectHit', hit.keyPointId)">
              <i>{{ hit.sequenceIndex + 1 }}</i>
              <span><strong>{{ hit.actorLabel }}</strong><small>Frame {{ hit.frameIndex }} · {{ hit.ballLabel }}</small></span>
              <em :class="hit.actorSource">{{ hit.actorSource === 'manual' ? '人工' : hit.actorSource === 'none' ? '無人' : '自動' }}</em>
            </button>
            <div v-if="selectedHitId === hit.keyPointId" class="hit-actions">
              <button type="button" @click="emit('assignHit', hit.keyPointId)"><MousePointer2 :size="13" />點畫面指派</button>
              <button type="button" @click="emit('noHitActor', hit.keyPointId)"><UserRoundX :size="13" />沒人打</button>
              <button type="button" :disabled="!selectedHitHasOverride" @click="emit('clearHitActor', hit.keyPointId)"><RotateCcw :size="13" />恢復自動</button>
            </div>
          </li>
        </ol>
        <p v-if="selectedHit" class="dependency-note">先採用第 {{ selectedHit.sequenceIndex + 1 }} 球的有效球點，再推算最近球員；人工指派永遠優先。</p>
      </section>

      <section class="frame-tools">
        <header class="section-heading"><span><CircleDotDashed :size="15" />目前畫格</span><code>F{{ frameIndex >= 0 ? frameIndex : '—' }}</code></header>
        <div class="tool-row">
          <div><strong>球點</strong><small>{{ ballOverride === 'missing' ? '人工標記無球' : ballOverride === 'position' ? '人工位置' : 'AI 自動' }}</small></div>
          <button type="button" :class="{ active: ballRelabel }" :disabled="frameIndex < 0" @click="emit('toggleBallRelabel')"><Crosshair :size="14" />{{ ballRelabel ? '完成放置' : '放置球心' }}</button>
        </div>
        <div class="inline-actions">
          <button type="button" :disabled="frameIndex < 0" @click="emit('markBallMissing')"><Ban :size="13" />此幀無球</button>
          <button type="button" :disabled="!ballOverride" @click="emit('clearBall')"><RotateCcw :size="13" />恢復 AI</button>
        </div>
        <dl v-if="ballPosition" class="position-readout"><div><dt>X</dt><dd>{{ ballPosition.x.toFixed(1) }}</dd></div><div><dt>Y</dt><dd>{{ ballPosition.y.toFixed(1) }}</dd></div></dl>
      </section>

      <section class="track-editor" :class="{ disabled: ballRelabel }">
        <header class="section-heading"><span><UserRoundCheck :size="15" />球員結果</span><code>{{ selectedTrackId === null ? '未選球員' : `T${selectedTrackId}` }}</code></header>
        <p v-if="selectedTrackId === null" class="empty-row">點擊播放器中的球員框，修改外框與逐幀動作。</p>
        <template v-else>
          <div class="inline-actions bbox-actions">
            <button type="button" :class="{ active: bboxRelabel }" :disabled="ballRelabel" @click="emit('startBBox')"><ScanLine :size="13" />{{ bboxRelabel ? '完成框選' : '重畫外框' }}</button>
            <button type="button" :disabled="!hasBboxOverride" @click="emit('clearBBox')"><RotateCcw :size="13" />恢復 AI 框</button>
          </div>
          <div class="action-grid">
            <button v-for="action in ANALYSIS_REVIEW_ACTIONS" :key="action" type="button" :class="{ active: selectedTrackAction === action }" :disabled="ballRelabel || bboxRelabel || frameIndex < 0" @click="emit('setAction', action)">{{ action }}</button>
          </div>
          <button type="button" class="restore-action" :disabled="!hasActionOverride" @click="emit('clearAction')"><RotateCcw :size="13" />動作恢復自動</button>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analysis-panel{display:grid;gap:0;min-height:0}.analysis-empty{min-height:120px;display:grid;place-content:center;justify-items:center;gap:8px;color:#7f8994;font-size:.68rem}.review-status{height:34px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2c3238;color:#aeb8c2;font-size:.62rem}.review-status span{display:flex;align-items:center;gap:6px}.review-status .save-state{color:#77828c}
.hit-editor,.frame-tools,.track-editor{display:grid;gap:9px;padding:13px 0;border-bottom:1px solid #292f35}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.section-heading>span{display:flex;align-items:center;gap:7px;font-size:.68rem;font-weight:750}.section-heading b{min-width:21px;padding:2px 6px;border-radius:999px;background:#282e34;color:#cbd2d8;font-size:.58rem;text-align:center}.section-heading code{color:#9fc7eb;font-size:.57rem}
.hit-list{max-height:246px;margin:0;padding:0;overflow:auto;list-style:none;scrollbar-width:thin}.hit-list li{border-bottom:1px solid #242a30}.hit-list li.selected{background:#1c2329}.hit-main{width:100%;min-height:47px!important;display:grid!important;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:8px;padding:5px 6px!important;border:0!important;border-radius:0!important;background:transparent!important;text-align:left}.hit-main>i{display:grid;width:22px;height:22px;place-items:center;border:1px solid #4e5963;border-radius:50%;color:#dce3e9;font-size:.59rem;font-style:normal;font-weight:800}.hit-main>span{min-width:0;display:grid;gap:3px}.hit-main strong,.hit-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hit-main strong{font-size:.66rem}.hit-main small{color:#7f8993;font:500 .55rem "Cascadia Mono",Consolas,monospace}.hit-main em{padding:2px 5px;border-radius:4px;background:#27303a;color:#a9c9e2;font-size:.52rem;font-style:normal}.hit-main em.manual{background:#42351d;color:#f0cf8e}.hit-main em.none{background:#3b292b;color:#d8aaad}.hit-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:0 6px 8px}.hit-actions button,.inline-actions button,.restore-action{min-height:28px!important;display:flex!important;align-items:center;justify-content:center;gap:4px;padding:3px 5px!important;border-color:#303840!important;background:#171b1f!important;color:#aeb7c0!important;font-size:.54rem!important}.dependency-note{margin:0;color:#75818c;font-size:.58rem;line-height:1.45}
.tool-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.tool-row>div{display:grid;gap:2px}.tool-row strong{font-size:.66rem}.tool-row small{color:#7e8993;font-size:.56rem}.tool-row button{min-height:29px!important;display:flex;align-items:center;gap:5px;padding:4px 8px!important;font-size:.58rem}.tool-row button.active,.inline-actions button.active{border-color:#567c99!important;background:#203747!important;color:#d9efff!important}.inline-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.position-readout{display:grid;grid-template-columns:1fr 1fr;margin:0;border:1px solid #292f35;border-radius:6px;overflow:hidden}.position-readout div{display:flex;align-items:center;justify-content:space-between;padding:6px 8px}.position-readout div+div{border-left:1px solid #292f35}.position-readout dt{color:#77828d;font-size:.57rem}.position-readout dd{margin:0;font:700 .63rem "Cascadia Mono",Consolas,monospace}
.track-editor.disabled{opacity:.48}.empty-row{margin:0;padding:10px 5px;color:#7f8994;font-size:.62rem;text-align:center}.bbox-actions{margin-bottom:1px}.action-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.action-grid button{min-height:29px!important;padding:4px!important;border-color:#2f363d!important;background:#171b1f!important;color:#aab3bc!important;font-size:.57rem}.action-grid button.active{border-color:#6b879b!important;background:#243440!important;color:#edf7ff!important}.restore-action{width:100%}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
