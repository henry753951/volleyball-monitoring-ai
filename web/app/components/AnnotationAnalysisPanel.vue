<script setup lang="ts">
import {
  ChevronLeft,
  ChevronRight,
  CircleDotDashed,
  Cloud,
  CloudOff,
  Crosshair,
  LoaderCircle,
  ScanSearch,
  UserRoundCheck,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'

type AnalysisPanelPage = 'root' | 'hits' | 'ball' | 'players'
type PageDirection = 'forward' | 'back'

export interface AnalysisHitListItem {
  keyPointId: string
  sequenceIndex: number
  frameIndex: number
  actorTrackId: number | null
  actorLabel: string
  actorSource: 'auto' | 'manual' | 'none'
  ballLabel: string
  anchorSource: 'human' | 'ai'
  anchorConfidence: number | null
  timeAdjusted: boolean
}

const props = defineProps<{
  analysisRunId: string | null
  page: AnalysisPanelPage
  frameIndex: number
  ballOverride: 'position' | 'missing' | null
  ballPosition: { x: number; y: number } | null
  selectedTrackId: number | null
  selectedTrackAction: string | null
  selectedHitId: string | null
  hasActionOverride: boolean
  hasBboxOverride: boolean
  hits: AnalysisHitListItem[]
  saving: boolean
  connection: 'idle' | 'connecting' | 'ready' | 'offline'
}>()

const emit = defineEmits<{
  'update:page': [page: AnalysisPanelPage]
  selectHit: [keyPointId: string]
  adjustHitTime: [keyPointId: string, deltaFrames: number]
  resetHitTime: [keyPointId: string]
}>()

const pageDirection = ref<PageDirection>('forward')
const selectedHit = computed(() => props.hits.find(hit => hit.keyPointId === props.selectedHitId) ?? null)
const ballStateLabel = computed(() => props.ballOverride === 'missing' ? '人工標記無球' : props.ballOverride === 'position' ? '人工位置' : 'AI 自動')
const playerStateLabel = computed(() => props.selectedTrackId === null ? '尚未選取' : `Track ${props.selectedTrackId}`)

function changePage(next: AnalysisPanelPage) {
  if (next === props.page) return
  pageDirection.value = next === 'root' ? 'back' : 'forward'
  emit('update:page', next)
}
</script>

<template>
  <div class="analysis-panel">
    <div v-if="!analysisRunId" class="analysis-empty"><ScanSearch :size="18" />選取已完成分析的片段</div>
    <template v-else>
      <header class="review-status">
        <span><Cloud v-if="connection === 'ready'" :size="14" /><CloudOff v-else :size="14" />{{ connection === 'ready' ? '分析修正已連線' : '重新連線中' }}</span>
        <span class="save-state"><LoaderCircle v-if="saving" class="spin" :size="14" />{{ saving ? '儲存中' : '即時同步' }}</span>
      </header>

      <div class="analysis-page-viewport">
        <Transition :name="`analysis-${pageDirection}`">
          <div :key="page" class="analysis-page" :data-page="page">
            <nav v-if="page === 'root'" class="analysis-menu" aria-label="分析結果修改功能">
              <button type="button" class="analysis-menu__item" @click="changePage('hits')">
                <span class="analysis-menu__icon"><Crosshair :size="17" /></span>
                <span><strong>擊球時間線</strong><small>檢查每一球與擊球球員</small></span>
                <b>{{ hits.length }}</b><ChevronRight :size="16" />
              </button>
              <button type="button" class="analysis-menu__item" @click="changePage('ball')">
                <span class="analysis-menu__icon"><CircleDotDashed :size="17" /></span>
                <span><strong>球點</strong><small>{{ ballStateLabel }} · Frame {{ frameIndex >= 0 ? frameIndex : '—' }}</small></span>
                <ChevronRight :size="16" />
              </button>
              <button type="button" class="analysis-menu__item" @click="changePage('players')">
                <span class="analysis-menu__icon"><UserRoundCheck :size="17" /></span>
                <span><strong>球員結果</strong><small>{{ playerStateLabel }} · 動作與球員外框</small></span>
                <ChevronRight :size="16" />
              </button>
            </nav>

            <template v-else>
              <header class="analysis-page__header">
                <button type="button" class="analysis-back" aria-label="返回分析功能" @click="changePage('root')"><ChevronLeft :size="18" /></button>
                <span>
                  <strong>{{ page === 'hits' ? '擊球時間線' : page === 'ball' ? '球點' : '球員結果' }}</strong>
                  <small>{{ page === 'hits' ? '從清單切換球次，直接在播放器指派' : page === 'ball' ? '修改目前畫格的球心或無球狀態' : '點播放器中的球員框開始修改' }}</small>
                </span>
                <b v-if="page === 'hits'" class="analysis-count">{{ hits.length }}</b>
                <code v-else>F{{ frameIndex >= 0 ? frameIndex : '—' }}</code>
              </header>

              <section v-if="page === 'hits'" class="hit-page">
                <p v-if="!hits.length" class="empty-row">此分析沒有擊球事件。</p>
                <ol v-else class="hit-list">
                  <li v-for="hit in hits" :key="hit.keyPointId" :class="{ selected: selectedHitId === hit.keyPointId }">
                    <button type="button" class="hit-main" :aria-current="selectedHitId === hit.keyPointId ? 'true' : undefined" @click="emit('selectHit', hit.keyPointId)">
                      <i>{{ hit.sequenceIndex + 1 }}</i>
                      <span><strong>{{ hit.actorLabel }}</strong><small>{{ hit.anchorSource === 'ai' ? `AI 擊球建議${hit.anchorConfidence === null ? '' : ` ${Math.round(hit.anchorConfidence * 100)}%`}` : '人工邊界' }}{{ hit.timeAdjusted ? ' · 已微調' : '' }} · Frame {{ hit.frameIndex }} · {{ hit.ballLabel }}</small></span>
                      <em :class="hit.actorSource">{{ hit.actorSource === 'manual' ? '人工' : hit.actorSource === 'none' ? '無人' : '自動' }}</em>
                    </button>
                  </li>
                </ol>
                <div v-if="selectedHit?.anchorSource === 'ai'" class="hit-time-editor" aria-label="微調 AI 擊球時間">
                  <button type="button" title="往前一格" @click="emit('adjustHitTime', selectedHit.keyPointId, -1)">−1 格</button>
                  <span>擊球時間 · F{{ selectedHit.frameIndex }}</span>
                  <button type="button" title="往後一格" @click="emit('adjustHitTime', selectedHit.keyPointId, 1)">+1 格</button>
                  <button v-if="selectedHit.timeAdjusted" type="button" class="hit-time-editor__reset" @click="emit('resetHitTime', selectedHit.keyPointId)">恢復 AI</button>
                </div>
                <p v-if="selectedHit" class="dependency-note">{{ selectedHit.anchorSource === 'ai' ? '可逐格微調 AI 建議；修正會維持前後擊球順序。' : '發球與結束是人工邊界，不在此修改。' }} 播放器上的人工擊球者指派永遠優先。</p>
              </section>

              <section v-else-if="page === 'ball'" class="summary-page">
                <dl class="summary-list">
                  <div><dt>目前畫格</dt><dd>F{{ frameIndex >= 0 ? frameIndex : '—' }}</dd></div>
                  <div><dt>球點來源</dt><dd>{{ ballStateLabel }}</dd></div>
                  <div v-if="ballPosition"><dt>球心座標</dt><dd>X {{ ballPosition.x.toFixed(1) }} · Y {{ ballPosition.y.toFixed(1) }}</dd></div>
                </dl>
                <p>修改工具已顯示在播放器上。點一下影片放置球心，也可標記此幀無球或恢復 AI。</p>
              </section>

              <section v-else class="summary-page">
                <p v-if="selectedTrackId === null" class="player-empty">點擊播放器中的球員框，選取要修改的追蹤球員。</p>
                <dl v-else class="summary-list">
                  <div><dt>追蹤球員</dt><dd>Track {{ selectedTrackId }}</dd></div>
                  <div><dt>逐幀動作</dt><dd>{{ selectedTrackAction || 'AI 自動' }}<small v-if="hasActionOverride">人工</small></dd></div>
                  <div><dt>球員外框</dt><dd>{{ hasBboxOverride ? '人工外框' : 'AI 自動' }}</dd></div>
                </dl>
                <p>選取球員後，使用播放器上的工具修改逐幀動作或重畫外框。</p>
              </section>
            </template>
          </div>
        </Transition>
      </div>
    </template>
  </div>
</template>

<style scoped>
.analysis-panel{display:grid;min-height:0}.analysis-empty{min-height:120px;display:grid;place-content:center;justify-items:center;gap:8px;color:#8f99a3;font-size:.68rem}.review-status{height:34px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2c3238;color:#b7c0c9;font-size:.62rem}.review-status span{display:flex;align-items:center;gap:6px}.review-status .save-state{color:#8b96a0}.analysis-page-viewport{position:relative;min-height:0;overflow:hidden;isolation:isolate}.analysis-page{width:100%;min-height:0;background:#111317}.analysis-menu{display:grid}.analysis-menu__item{width:100%;min-height:70px;display:grid;grid-template-columns:34px minmax(0,1fr) auto auto;align-items:center;gap:9px;padding:10px 4px;border:0;border-bottom:1px solid #292f35;border-radius:0;background:transparent;color:#e6eaed;text-align:left}.analysis-menu__item:hover{background:#191e23}.analysis-menu__item:active{background:#20262c}.analysis-menu__item>span:nth-child(2){display:grid;gap:4px}.analysis-menu__item strong{font-size:.7rem}.analysis-menu__item small{overflow:hidden;color:#8f99a3;font-size:.58rem;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.analysis-menu__item>b,.analysis-count{min-width:21px;padding:2px 6px;border-radius:999px;background:#293039;color:#cbd2d8;font-size:.58rem;text-align:center}.analysis-menu__icon{display:grid;width:32px;height:32px;place-items:center;border-radius:8px;background:#20252a;color:#d7dde3}.analysis-page__header{min-height:62px;display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:8px;border-bottom:1px solid #2c3238}.analysis-page__header>span{display:grid;gap:3px}.analysis-page__header strong{font-size:.7rem}.analysis-page__header small{overflow:hidden;color:#8f99a3;font-size:.56rem;text-overflow:ellipsis;white-space:nowrap}.analysis-page__header code{color:#9fc7eb;font-size:.57rem}.analysis-back{width:30px;min-height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:#aeb8c2}.analysis-back:hover{background:#272d33;color:#fff}.hit-list{margin:0;padding:0;list-style:none}.hit-list li{border-bottom:1px solid #262c32}.hit-list li.selected{background:#1d252c}.hit-main{width:100%;min-height:52px;display:grid;grid-template-columns:26px minmax(0,1fr) auto;align-items:center;gap:9px;padding:6px 5px;border:0;border-radius:0;background:transparent;color:#e9edf0;text-align:left}.hit-main:hover{background:#20272d}.hit-main>i{display:grid;width:24px;height:24px;place-items:center;border:1px solid #58636d;border-radius:50%;font-size:.59rem;font-style:normal;font-weight:800}.hit-main>span{min-width:0;display:grid;gap:3px}.hit-main strong,.hit-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hit-main strong{font-size:.67rem}.hit-main small{color:#8f99a3;font:500 .55rem "Cascadia Mono",Consolas,monospace}.hit-main em{padding:2px 5px;border-radius:4px;background:#27303a;color:#b9d8ee;font-size:.52rem;font-style:normal}.hit-main em.manual{background:#42351d;color:#f0cf8e}.hit-main em.none{background:#3b292b;color:#e0b5b8}.hit-time-editor{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:6px;padding:9px 4px;border-bottom:1px solid #262c32}.hit-time-editor span{color:#dce4ea;font:700 .58rem "Cascadia Mono",Consolas,monospace;text-align:center}.hit-time-editor button{min-height:28px;padding:4px 8px;border:1px solid #46515b;border-radius:6px;background:#20262c;color:#d9e1e7;font-size:.56rem;font-weight:750}.hit-time-editor button:hover{background:#2a3239}.hit-time-editor .hit-time-editor__reset{border-color:#6b5631;color:#e8c983}.dependency-note,.summary-page>p{margin:0;padding:12px 4px;color:#8b96a0;font-size:.59rem;line-height:1.55}.empty-row,.player-empty{min-height:92px;display:grid;place-items:center;margin:0;padding:16px;color:#8f99a3;font-size:.64rem;text-align:center}.summary-list{display:grid;margin:0}.summary-list>div{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #262c32}.summary-list dt{color:#929ca6;font-size:.61rem}.summary-list dd{display:flex;align-items:center;gap:6px;margin:0;color:#e2e7eb;font:700 .62rem "Cascadia Mono",Consolas,monospace}.summary-list dd small{padding:2px 5px;border-radius:4px;background:#42351d;color:#f0cf8e;font:700 .49rem system-ui,sans-serif}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.analysis-forward-enter-active,.analysis-forward-leave-active,.analysis-back-enter-active,.analysis-back-leave-active{transition:transform 280ms cubic-bezier(.16,1,.3,1);will-change:transform}.analysis-forward-leave-active,.analysis-back-leave-active{position:absolute;inset:0;z-index:1;pointer-events:none}.analysis-forward-enter-active,.analysis-back-enter-active{position:relative;z-index:2}.analysis-forward-enter-from{transform:translateX(44px)}.analysis-forward-leave-to{transform:translateX(-28px)}.analysis-back-enter-from{transform:translateX(-44px)}.analysis-back-leave-to{transform:translateX(28px)}
@media(prefers-reduced-motion:reduce){.spin{animation:none}.analysis-forward-enter-active,.analysis-forward-leave-active,.analysis-back-enter-active,.analysis-back-leave-active{transition-duration:120ms;transition-property:opacity}.analysis-forward-enter-from,.analysis-forward-leave-to,.analysis-back-enter-from,.analysis-back-leave-to{opacity:0;transform:none}}
</style>
