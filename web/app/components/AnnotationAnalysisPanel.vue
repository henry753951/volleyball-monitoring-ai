<script setup lang="ts">
import {
  ChevronLeft,
  ChevronRight,
  CircleDotDashed,
  Cloud,
  CloudOff,
  Crosshair,
  LoaderCircle,
  LockKeyhole,
  PencilLine,
  Plus,
  RotateCcw,
  ScanSearch,
  Send,
  Trash2,
  UserRoundCheck,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { formatTimelinePosition } from '~/lib/dvrTimeline'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'
import type { WorkstationActionId } from '~/services/annotation-workstation/workstation-action.service'

type AnalysisPanelPage = 'root' | 'hits' | 'ball' | 'players'
type PageDirection = 'forward' | 'back'

export interface AnalysisHitListItem {
  keyPointId: string
  sequenceIndex: number
  frameIndex: number
  captureTimeUs: string | null
  actorTrackId: number | null
  actorLabel: string
  actorSource: 'auto' | 'manual' | 'none' | 'pending' | 'failed'
  semanticLabel: string | null
  pathLabel: string | null
  ballLabel: string
  anchorSource: 'human' | 'ai' | 'manual'
  anchorConfidence: number | null
  timeAdjusted: boolean
}

export interface RemovedAnalysisHitListItem {
  keyPointId: string
  frameIndex: number
  label: string
}

const props = defineProps<{
  frameIndex: number
  timelineOriginCaptureTimeUs: string | null
  clipStartCaptureTimeUs: string | null
  ballOverride: 'position' | 'missing' | null
  ballPosition: { x: number; y: number } | null
  selectedTrackAction: string | null
  hasActionOverride: boolean
  hasBboxOverride: boolean
  hits: AnalysisHitListItem[]
  removedHits: RemovedAnalysisHitListItem[]
}>()

const workstation = useAnnotationWorkstationService()
const revision = workstation.analysis.revision
const review = workstation.analysis.review
if (!revision || !review)
  throw new Error('Analysis services were not provided by the annotation route boundary')

const page = revision.panelPage
const analysisRunId = revision.analysisRunId
const selectedTrackId = revision.selectedTrackId
const selectedHitId = revision.selectedHitId
const revisionMode = revision.revisionMode
const dependenciesPending = revision.dependenciesPending
const saving = review.pending
const connection = review.connection
const dirtyCount = review.dirtyCount
const reviewStatus = review.status

const pageDirection = ref<PageDirection>('forward')
const selectedHit = computed(
  () => props.hits.find(hit => hit.keyPointId === selectedHitId.value) ?? null,
)
const ballStateLabel = computed(() =>
  props.ballOverride === 'missing'
    ? '人工標記無球'
    : props.ballOverride === 'position'
      ? '人工位置'
      : 'AI 自動',
)
const playerStateLabel = computed(() =>
  selectedTrackId.value === null ? '尚未選取' : `Track ${selectedTrackId.value}`,
)

function hitTimeLabel(hit: AnalysisHitListItem) {
  if (!hit.captureTimeUs) return `Frame ${hit.frameIndex}`
  const matchTime = formatTimelinePosition(hit.captureTimeUs, props.timelineOriginCaptureTimeUs)
  const clipTime = formatTimelinePosition(hit.captureTimeUs, props.clipStartCaptureTimeUs)
  return `場次 ${matchTime} · 片段 +${clipTime} · F${hit.frameIndex}`
}

function changePage(next: AnalysisPanelPage) {
  if (next === page.value) return
  pageDirection.value = next === 'root' ? 'back' : 'forward'
  page.value = next
}

function execute(actionId: WorkstationActionId, payload?: unknown) {
  void workstation.actions.execute(actionId, payload)
}
</script>

<template>
  <div class="analysis-panel">
    <div v-if="!analysisRunId" class="analysis-empty">
      <ScanSearch :size="18" />選取已完成分析的片段
    </div>
    <template v-else>
      <header class="review-status">
        <span
          ><Cloud v-if="connection === 'ready'" :size="14" /><CloudOff v-else :size="14" />{{
            connection === 'ready' ? '分析修正已連線' : '重新連線中'
          }}</span
        >
        <span class="save-state"
          ><LoaderCircle v-if="saving" class="spin" :size="14" /><LockKeyhole
            v-else-if="!revisionMode"
            :size="13"
          />{{
            saving
              ? '處理中'
              : !revisionMode
                ? '唯讀'
                : dirtyCount
                  ? `${dirtyCount} 項尚未套用`
                  : reviewStatus === 'approved'
                    ? '已審核'
                    : reviewStatus === 'ready'
                      ? '可審核'
                      : '編輯中'
          }}</span
        >
      </header>

      <div v-if="!revisionMode" class="review-workflow review-workflow--locked">
        <button
          type="button"
          class="enter-revision"
          :disabled="!workstation.actions.state('analysis.enter-revision').value.enabled"
          :title="workstation.actions.state('analysis.enter-revision').value.reason ?? undefined"
          @click="execute('analysis.enter-revision')"
        >
          <PencilLine :size="14" />進入修訂模式
        </button>
        <small>只有這個片段進入修訂後，才能修改擊球、球員、球點與動作。</small>
      </div>
      <div v-else class="review-workflow" aria-label="分析審核流程">
        <button
          type="button"
          :disabled="!workstation.actions.state('analysis.apply').value.enabled"
          :title="workstation.actions.state('analysis.apply').value.reason ?? undefined"
          @click="execute('analysis.apply')"
        >
          套用修改
        </button>
        <button
          type="button"
          class="quiet"
          :disabled="!workstation.actions.state('analysis.discard').value.enabled"
          :title="workstation.actions.state('analysis.discard').value.reason ?? undefined"
          @click="execute('analysis.discard')"
        >
          <RotateCcw :size="13" />捨棄
        </button>
        <button
          type="button"
          :disabled="!workstation.actions.state('analysis.recalculate').value.enabled"
          :title="workstation.actions.state('analysis.recalculate').value.reason ?? undefined"
          @click="execute('analysis.recalculate')"
        >
          {{ dependenciesPending ? '等待擊球關聯更新…' : '重建結果（不跑 AI）' }}
        </button>
        <button
          type="button"
          class="quiet"
          :disabled="!workstation.actions.state('analysis.exit-revision').value.enabled"
          :title="workstation.actions.state('analysis.exit-revision').value.reason ?? undefined"
          @click="execute('analysis.exit-revision')"
        >
          <LockKeyhole :size="13" />結束修訂
        </button>
        <button
          type="button"
          class="publish"
          :disabled="!workstation.actions.state('analysis.approve').value.enabled"
          :title="workstation.actions.state('analysis.approve').value.reason ?? undefined"
          @click="execute('analysis.approve')"
        >
          <Send :size="13" />審核發布
        </button>
      </div>

      <div class="analysis-page-viewport">
        <Transition :name="`analysis-${pageDirection}`">
          <div :key="page" class="analysis-page" :data-page="page">
            <nav v-if="page === 'root'" class="analysis-menu" aria-label="分析結果修改功能">
              <button type="button" class="analysis-menu__item" @click="changePage('hits')">
                <span class="analysis-menu__icon"><Crosshair :size="17" /></span>
                <span><strong>擊球時間線</strong><small>檢查每一球與擊球球員</small></span>
                <b>{{ hits.length }}</b
                ><ChevronRight :size="16" />
              </button>
              <button type="button" class="analysis-menu__item" @click="changePage('ball')">
                <span class="analysis-menu__icon"><CircleDotDashed :size="17" /></span>
                <span
                  ><strong>球點</strong
                  ><small
                    >{{ ballStateLabel }} · Frame {{ frameIndex >= 0 ? frameIndex : '—' }}</small
                  ></span
                >
                <ChevronRight :size="16" />
              </button>
              <button type="button" class="analysis-menu__item" @click="changePage('players')">
                <span class="analysis-menu__icon"><UserRoundCheck :size="17" /></span>
                <span
                  ><strong>球員結果</strong
                  ><small>{{ playerStateLabel }} · 動作與球員外框</small></span
                >
                <ChevronRight :size="16" />
              </button>
            </nav>

            <template v-else>
              <header class="analysis-page__header">
                <button
                  type="button"
                  class="analysis-back"
                  aria-label="返回分析功能"
                  @click="changePage('root')"
                >
                  <ChevronLeft :size="18" />
                </button>
                <span>
                  <strong>{{
                    page === 'hits' ? '擊球時間線' : page === 'ball' ? '球點' : '球員結果'
                  }}</strong>
                  <small>{{
                    page === 'hits'
                      ? '從清單切換球次，直接在播放器指派'
                      : page === 'ball'
                        ? '修改目前畫格的球心或無球狀態'
                        : '點播放器中的球員框開始修改'
                  }}</small>
                </span>
                <b v-if="page === 'hits'" class="analysis-count">{{ hits.length }}</b>
                <code v-else>F{{ frameIndex >= 0 ? frameIndex : '—' }}</code>
              </header>

              <section v-if="page === 'hits'" class="hit-page">
                <button
                  v-if="revisionMode"
                  type="button"
                  class="add-hit"
                  :disabled="!workstation.actions.state('analysis.add-contact').value.enabled"
                  :title="
                    workstation.actions.state('analysis.add-contact').value.reason ?? undefined
                  "
                  @click="execute('analysis.add-contact')"
                >
                  <Plus :size="14" />在目前畫格新增擊球點
                </button>
                <p v-if="!hits.length" class="empty-row">此分析沒有擊球事件。</p>
                <ol v-else class="hit-list">
                  <li
                    v-for="hit in hits"
                    :key="hit.keyPointId"
                    :class="{ selected: selectedHitId === hit.keyPointId }"
                  >
                    <button
                      type="button"
                      class="hit-main"
                      :aria-current="selectedHitId === hit.keyPointId ? 'true' : undefined"
                      @click="execute('analysis.select-contact', hit.keyPointId)"
                    >
                      <i>{{ hit.sequenceIndex + 1 }}</i>
                      <span
                        ><strong>{{ hit.actorLabel }}</strong
                        ><b v-if="hit.semanticLabel" class="hit-semantic">{{ hit.semanticLabel }}</b
                        ><small
                          >{{
                            hit.anchorSource === 'ai'
                              ? `AI 擊球建議${hit.anchorConfidence === null ? '' : ` ${Math.round(hit.anchorConfidence * 100)}%`}`
                              : hit.anchorSource === 'manual'
                                ? '人工新增擊球點'
                                : '人工 X 碰撞'
                          }}{{ hit.timeAdjusted ? ' · 已微調' : '' }} · {{ hitTimeLabel(hit) }} ·
                          {{ hit.ballLabel }}</small
                        ><small v-if="hit.pathLabel" class="hit-path">{{
                          hit.pathLabel
                        }}</small></span
                      >
                      <em :class="hit.actorSource">{{
                        hit.actorSource === 'manual'
                          ? '人工'
                          : hit.actorSource === 'none'
                            ? '無人'
                            : hit.actorSource === 'pending'
                              ? '重算中'
                              : hit.actorSource === 'failed'
                                ? '待重試'
                                : '自動'
                      }}</em>
                    </button>
                  </li>
                </ol>
                <div
                  v-if="revisionMode && selectedHit && selectedHit.anchorSource !== 'human'"
                  class="hit-time-editor"
                  aria-label="微調擊球時間"
                >
                  <span>擊球時間 · F{{ selectedHit.frameIndex }}</span>
                  <button
                    type="button"
                    title="往前一格"
                    @click="
                      execute('analysis.adjust-contact-time', {
                        keyPointId: selectedHit.keyPointId,
                        deltaFrames: -1,
                      })
                    "
                  >
                    往前 1 格
                  </button>
                  <button
                    type="button"
                    title="往後一格"
                    @click="
                      execute('analysis.adjust-contact-time', {
                        keyPointId: selectedHit.keyPointId,
                        deltaFrames: 1,
                      })
                    "
                  >
                    +1 格
                  </button>
                  <button
                    v-if="selectedHit.anchorSource === 'ai' && selectedHit.timeAdjusted"
                    type="button"
                    class="hit-time-editor__reset"
                    @click="execute('analysis.reset-contact-time', selectedHit.keyPointId)"
                  >
                    恢復 AI
                  </button>
                </div>
                <button
                  v-if="revisionMode && selectedHit"
                  type="button"
                  class="delete-hit"
                  @click="execute('analysis.delete-contact', selectedHit.keyPointId)"
                >
                  <Trash2 :size="13" />刪除此擊球點
                </button>
                <section v-if="removedHits.length" class="removed-hits" aria-label="已移除的擊球點">
                  <header>
                    <strong>已移除</strong><span>{{ removedHits.length }}</span>
                  </header>
                  <button
                    v-for="hit in removedHits"
                    :key="hit.keyPointId"
                    type="button"
                    :disabled="!revisionMode"
                    @click="execute('analysis.restore-contact', hit.keyPointId)"
                  >
                    <RotateCcw :size="12" /><span>{{ hit.label }}</span
                    ><small>Frame {{ hit.frameIndex }}</small>
                  </button>
                </section>
                <p v-if="selectedHit" class="dependency-note">
                  {{
                    selectedHit.anchorSource === 'ai'
                      ? '可逐格微調 AI 建議；修正後會重新建立事件順序與綁定。'
                      : '人工 X 碰撞可在時間線修改；片段開始與結束不是碰撞事件。'
                  }}
                  {{
                    revisionMode
                      ? '播放器上的人工擊球者指派永遠優先。'
                      : '目前為唯讀；進入修訂模式才會開啟修改工具。'
                  }}
                </p>
              </section>

              <section v-else-if="page === 'ball'" class="summary-page">
                <dl class="summary-list">
                  <div>
                    <dt>目前畫格</dt>
                    <dd>F{{ frameIndex >= 0 ? frameIndex : '—' }}</dd>
                  </div>
                  <div>
                    <dt>球點來源</dt>
                    <dd>{{ ballStateLabel }}</dd>
                  </div>
                  <div v-if="ballPosition">
                    <dt>球心座標</dt>
                    <dd>X {{ ballPosition.x.toFixed(1) }} · Y {{ ballPosition.y.toFixed(1) }}</dd>
                  </div>
                </dl>
                <p>
                  {{
                    revisionMode
                      ? '修改工具已顯示在播放器上。點一下影片放置球心，也可標記此幀無球或恢復 AI。'
                      : '目前為唯讀；進入修訂模式才會開啟播放器修改工具。'
                  }}
                </p>
              </section>

              <section v-else class="summary-page">
                <p v-if="selectedTrackId === null" class="player-empty">
                  點擊播放器中的球員框，選取要修改的追蹤球員。
                </p>
                <dl v-else class="summary-list">
                  <div>
                    <dt>追蹤球員</dt>
                    <dd>Track {{ selectedTrackId }}</dd>
                  </div>
                  <div>
                    <dt>逐幀動作</dt>
                    <dd>
                      {{ selectedTrackAction || 'AI 自動'
                      }}<small v-if="hasActionOverride">人工</small>
                    </dd>
                  </div>
                  <div>
                    <dt>球員外框</dt>
                    <dd>{{ hasBboxOverride ? '人工外框' : 'AI 自動' }}</dd>
                  </div>
                </dl>
                <p>
                  {{
                    revisionMode
                      ? '選取球員後，使用播放器上的工具修改逐幀動作或重畫外框。'
                      : '目前為唯讀；進入修訂模式後才能修改動作或外框。'
                  }}
                </p>
              </section>
            </template>
          </div>
        </Transition>
      </div>
    </template>
  </div>
</template>

<style scoped>
.analysis-panel {
  display: grid;
  min-height: 0;
}
.analysis-empty {
  min-height: 120px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: #8f99a3;
  font-size: 0.68rem;
}
.review-status {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #2c3238;
  color: #b7c0c9;
  font-size: 0.62rem;
}
.review-status span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.review-status .save-state {
  color: #8b96a0;
}
.analysis-page-viewport {
  position: relative;
  min-height: 0;
  overflow: hidden;
  isolation: isolate;
}
.analysis-page {
  width: 100%;
  min-height: 0;
  background: #111317;
}
.analysis-menu {
  display: grid;
}
.analysis-menu__item {
  width: 100%;
  min-height: 70px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 9px;
  padding: 10px 4px;
  border: 0;
  border-bottom: 1px solid #292f35;
  border-radius: 0;
  background: transparent;
  color: #e6eaed;
  text-align: left;
}
.analysis-menu__item:hover {
  background: #191e23;
}
.analysis-menu__item:active {
  background: #20262c;
}
.analysis-menu__item > span:nth-child(2) {
  display: grid;
  gap: 4px;
}
.analysis-menu__item strong {
  font-size: 0.7rem;
}
.analysis-menu__item small {
  overflow: hidden;
  color: #8f99a3;
  font-size: 0.58rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.analysis-menu__item > b,
.analysis-count {
  min-width: 21px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #293039;
  color: #cbd2d8;
  font-size: 0.58rem;
  text-align: center;
}
.analysis-menu__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 8px;
  background: #20252a;
  color: #d7dde3;
}
.analysis-page__header {
  min-height: 62px;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #2c3238;
}
.analysis-page__header > span {
  display: grid;
  gap: 3px;
}
.analysis-page__header strong {
  font-size: 0.7rem;
}
.analysis-page__header small {
  overflow: hidden;
  color: #8f99a3;
  font-size: 0.56rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.analysis-page__header code {
  color: #9fc7eb;
  font-size: 0.57rem;
}
.analysis-back {
  width: 30px;
  min-height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #aeb8c2;
}
.analysis-back:hover {
  background: #272d33;
  color: #fff;
}
.hit-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.hit-list li {
  border-bottom: 1px solid #262c32;
}
.hit-list li.selected {
  background: #1d252c;
}
.hit-main {
  width: 100%;
  min-height: 52px;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 6px 5px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #e9edf0;
  text-align: left;
}
.hit-main:hover {
  background: #20272d;
}
.hit-main > i {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid #58636d;
  border-radius: 50%;
  font-size: 0.59rem;
  font-style: normal;
  font-weight: 800;
}
.hit-main > span {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.hit-main strong,
.hit-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-main strong {
  font-size: 0.67rem;
}
.hit-semantic {
  width: fit-content;
  padding: 2px 5px;
  border: 1px solid #34566f;
  border-radius: 4px;
  background: #182b3a;
  color: #9ed8ff;
  font-size: 0.56rem;
  font-weight: 750;
}
.hit-main small {
  color: #8f99a3;
  font:
    500 0.55rem 'Cascadia Mono',
    Consolas,
    monospace;
}
.hit-main .hit-path {
  color: #77d6a0;
}
.hit-main em {
  padding: 2px 5px;
  border-radius: 4px;
  background: #27303a;
  color: #b9d8ee;
  font-size: 0.52rem;
  font-style: normal;
}
.hit-main em.manual {
  background: #42351d;
  color: #f0cf8e;
}
.hit-main em.none {
  background: #3b292b;
  color: #e0b5b8;
}
.hit-main em.pending {
  background: #25364a;
  color: #a7d8ff;
}
.hit-main em.failed {
  background: #4a2c2c;
  color: #ffb6b6;
}
.hit-time-editor {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  padding: 9px 4px;
  border-bottom: 1px solid #262c32;
}
.hit-time-editor span {
  color: #dce4ea;
  font:
    700 0.58rem 'Cascadia Mono',
    Consolas,
    monospace;
  text-align: center;
}
.hit-time-editor button {
  min-height: 28px;
  padding: 4px 8px;
  border: 1px solid #46515b;
  border-radius: 6px;
  background: #20262c;
  color: #d9e1e7;
  font-size: 0.56rem;
  font-weight: 750;
}
.hit-time-editor button:hover {
  background: #2a3239;
}
.hit-time-editor .hit-time-editor__reset {
  border-color: #6b5631;
  color: #e8c983;
}
.dependency-note,
.summary-page > p {
  margin: 0;
  padding: 12px 4px;
  color: #8b96a0;
  font-size: 0.59rem;
  line-height: 1.55;
}
.empty-row,
.player-empty {
  min-height: 92px;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 16px;
  color: #8f99a3;
  font-size: 0.64rem;
  text-align: center;
}
.summary-list {
  display: grid;
  margin: 0;
}
.summary-list > div {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #262c32;
}
.summary-list dt {
  color: #929ca6;
  font-size: 0.61rem;
}
.summary-list dd {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: #e2e7eb;
  font:
    700 0.62rem 'Cascadia Mono',
    Consolas,
    monospace;
}
.summary-list dd small {
  padding: 2px 5px;
  border-radius: 4px;
  background: #42351d;
  color: #f0cf8e;
  font:
    700 0.49rem system-ui,
    sans-serif;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.analysis-forward-enter-active,
.analysis-forward-leave-active,
.analysis-back-enter-active,
.analysis-back-leave-active {
  transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform;
}
.analysis-forward-leave-active,
.analysis-back-leave-active {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
.analysis-forward-enter-active,
.analysis-back-enter-active {
  position: relative;
  z-index: 2;
}
.analysis-forward-enter-from {
  transform: translateX(44px);
}
.analysis-forward-leave-to {
  transform: translateX(-28px);
}
.analysis-back-enter-from {
  transform: translateX(-44px);
}
.analysis-back-leave-to {
  transform: translateX(28px);
}
.analysis-menu__item small,
.analysis-page__header small,
.hit-main strong,
.hit-main small {
  overflow: visible;
  line-height: 1.4;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}
.hit-time-editor {
  grid-template-columns: 1fr;
}
.hit-time-editor span {
  padding: 2px 0;
  text-align: left;
}
.hit-time-editor button {
  width: 100%;
  min-height: 30px;
}
.review-workflow {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid #2c3238;
}
.review-workflow button,
.add-hit,
.delete-hit {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid #47515a;
  border-radius: 7px;
  background: #232a30;
  color: #e5eaee;
  font-size: 0.58rem;
  font-weight: 750;
}
.review-workflow button:hover:not(:disabled),
.add-hit:hover,
.delete-hit:hover {
  background: #303941;
}
.review-workflow button:disabled {
  opacity: 0.38;
}
.review-workflow--locked {
  grid-template-columns: 1fr;
}
.review-workflow--locked small {
  color: #8f99a3;
  font-size: 0.56rem;
  line-height: 1.45;
}
.review-workflow .enter-revision {
  border-color: #416986;
  background: #1f3443;
  color: #d7eafa;
}
.review-workflow .publish {
  border-color: #34735c;
  background: #214c3e;
  color: #d8f4e8;
}
.review-workflow .quiet {
  background: transparent;
  color: #aeb8c2;
}
.add-hit {
  width: 100%;
  margin: 8px 0;
  border-style: dashed;
  background: #171c20;
}
.delete-hit {
  width: 100%;
  margin: 8px 0;
  border-color: #694044;
  background: #332326;
  color: #efc6ca;
}
.removed-hits {
  display: grid;
  margin: 10px 0;
  border-top: 1px solid #2c3238;
}
.removed-hits header {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #9ba5ae;
  font-size: 0.58rem;
}
.removed-hits header span {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #293039;
  text-align: center;
}
.removed-hits button {
  min-height: 38px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 6px;
  border: 0;
  border-bottom: 1px solid #262c32;
  background: transparent;
  color: #d8dfe4;
  text-align: left;
}
.removed-hits button:hover {
  background: #20272d;
}
.removed-hits button:disabled {
  cursor: default;
  opacity: 0.55;
}
.removed-hits button span,
.removed-hits button small {
  overflow-wrap: anywhere;
}
.removed-hits button small {
  color: #8f99a3;
  font:
    500 0.53rem 'Cascadia Mono',
    Consolas,
    monospace;
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
  .analysis-forward-enter-active,
  .analysis-forward-leave-active,
  .analysis-back-enter-active,
  .analysis-back-leave-active {
    transition-duration: 120ms;
    transition-property: opacity;
  }
  .analysis-forward-enter-from,
  .analysis-forward-leave-to,
  .analysis-back-enter-from,
  .analysis-back-leave-to {
    opacity: 0;
    transform: none;
  }
}
</style>
