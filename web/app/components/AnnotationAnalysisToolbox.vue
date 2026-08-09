<script setup lang="ts">
import {
   ANALYSIS_REVIEW_ACTIONS,
   type AnalysisReviewAction,
} from "@volleyball-monitoring/contracts";
import { usePreferredReducedMotion } from "@vueuse/core";
import {
   Ban,
   Check,
   CircleDotDashed,
   LoaderCircle,
   MousePointer2,
   RotateCcw,
   ScanLine,
   UserRoundX,
   X,
} from "lucide-vue-next";
import { AnimatePresence, Motion } from "motion-v";

const props = defineProps<{
   mode: "ball" | "bbox" | "actor" | "track" | null;
   frameIndex: number;
   selectedTrackId: number | null;
   selectedAction: string | null;
   selectedHitLabel: string | null;
   hasBallOverride: boolean;
   hasBboxOverride: boolean;
   hasActorOverride: boolean;
   saving: boolean;
}>();

const emit = defineEmits<{
   close: [];
   markBallMissing: [];
   clearBall: [];
   startBBox: [];
   clearBBox: [];
   markNoActor: [];
   clearActor: [];
   setAction: [action: AnalysisReviewAction];
   clearAction: [];
}>();

const reducedMotion = usePreferredReducedMotion();
const initial = computed(() =>
   reducedMotion.value === "reduce"
      ? { opacity: 0 }
      : { opacity: 0, y: -8, scaleX: 0.86, filter: "blur(7px)" },
);
const animate = computed(() =>
   reducedMotion.value === "reduce"
      ? { opacity: 1 }
      : { opacity: 1, y: 0, scaleX: 1, filter: "blur(0px)" },
);
const exit = computed(() =>
   reducedMotion.value === "reduce"
      ? { opacity: 0 }
      : { opacity: 0, y: -5, scaleX: 0.92, filter: "blur(4px)" },
);
const transition = computed(() => ({
   duration: reducedMotion.value === "reduce" ? 0.01 : 0.24,
   ease: [0.16, 1, 0.3, 1],
}));

function handleAction(event: Event) {
   const value = (event.target as HTMLSelectElement).value;
   if (!value) emit("clearAction");
   else emit("setAction", value as AnalysisReviewAction);
}
</script>

<template>
   <div class="toolbox-anchor">
      <AnimatePresence mode="wait">
         <Motion
            v-if="mode"
            :key="`${mode}:${selectedHitLabel ?? selectedTrackId ?? frameIndex}`"
            class="analysis-toolbox"
            role="toolbar"
            :aria-label="
               mode === 'actor' ? '擊球球員指派工具' : '分析結果修改工具'
            "
            :initial="initial"
            :animate="animate"
            :exit="exit"
            :transition="transition"
         >
            <template v-if="mode === 'ball'">
               <span class="toolbox-title"
                  ><CircleDotDashed :size="15" /><b>球點</b
                  ><code>F{{ frameIndex }}</code></span
               >
               <span class="toolbox-instruction">點一下影片放置球心</span>
               <button
                  type="button"
                  @click="emit('markBallMissing')"
               >
                  <Ban :size="14" />此幀無球
               </button>
               <button
                  type="button"
                  :disabled="!hasBallOverride"
                  @click="emit('clearBall')"
               >
                  <RotateCcw :size="14" />恢復 AI
               </button>
            </template>
            <template v-else-if="mode === 'bbox'">
               <span class="toolbox-title"
                  ><ScanLine :size="15" /><b>球員框</b
                  ><code>T{{ selectedTrackId }}</code></span
               >
               <span class="toolbox-instruction">在影片上拖曳新的外框</span>
               <button
                  type="button"
                  :disabled="!hasBboxOverride"
                  @click="emit('clearBBox')"
               >
                  <RotateCcw :size="14" />恢復 AI
               </button>
            </template>
            <template v-else-if="mode === 'actor'">
               <span class="toolbox-title"
                  ><MousePointer2 :size="15" /><b>{{
                     selectedHitLabel
                  }}</b></span
               >
               <span class="toolbox-instruction">點擊畫面中的球員框</span>
               <button
                  type="button"
                  @click="emit('markNoActor')"
               >
                  <UserRoundX :size="14" />沒人打
               </button>
               <button
                  type="button"
                  :disabled="!hasActorOverride"
                  @click="emit('clearActor')"
               >
                  <RotateCcw :size="14" />恢復自動
               </button>
            </template>
            <template v-else>
               <span class="toolbox-title"
                  ><MousePointer2 :size="15" /><b>Track {{ selectedTrackId }}</b
                  ><code>F{{ frameIndex }}</code></span
               >
               <label class="action-select"
                  >動作<select
                     :value="selectedAction ?? ''"
                     @change="handleAction"
                  >
                     <option value="">自動</option>
                     <option
                        v-for="action in ANALYSIS_REVIEW_ACTIONS"
                        :key="action"
                        :value="action"
                     >
                        {{ action }}
                     </option>
                  </select></label
               >
               <button
                  type="button"
                  @click="emit('startBBox')"
               >
                  <ScanLine :size="14" />調整外框
               </button>
            </template>
            <LoaderCircle
               v-if="saving"
               class="spin"
               :size="14"
               aria-label="儲存中"
            />
            <Check
               v-else
               :size="14"
               class="saved"
               aria-label="已儲存"
            />
            <button
               type="button"
               class="close"
               aria-label="關閉修改工具"
               @click="emit('close')"
            >
               <X :size="15" />
            </button>
         </Motion>
      </AnimatePresence>
   </div>
</template>

<style scoped>
.toolbox-anchor {
   position: absolute;
   z-index: 30;
   left: 50%;
   top: 12px;
   width: max-content !important;
   height: auto !important;
   max-width: calc(100% - 160px);
   transform: translateX(-50%);
   pointer-events: none;
}
.analysis-toolbox {
   display: flex;
   width: max-content;
   max-width: 100%;
   min-height: 42px;
   align-items: center;
   gap: 6px;
   padding: 6px 7px 6px 10px;
   border: 1px solid #ffffff2b;
   border-radius: 10px;
   background: #111418e8;
   color: #f4f4f5;
   box-shadow: 0 12px 32px 5px #0008;
   transform-origin: top center;
   backdrop-filter: blur(12px) saturate(130%);
   pointer-events: auto;
}
.toolbox-title {
   display: flex;
   align-items: center;
   gap: 6px;
   padding-right: 5px;
   white-space: nowrap;
}
.toolbox-title b {
   font-size: 0.68rem;
}
.toolbox-title code {
   color: #9fc7eb;
   font-size: 0.57rem;
}
.toolbox-instruction {
   max-width: 230px;
   overflow: hidden;
   padding: 0 7px;
   color: #a1aab3;
   font-size: 0.62rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
button {
   min-height: 29px !important;
   display: inline-flex !important;
   align-items: center;
   gap: 5px;
   padding: 4px 8px !important;
   border: 0 !important;
   border-radius: 7px !important;
   background: #272b30 !important;
   color: #d6dbe0 !important;
   font-size: 0.6rem !important;
   white-space: nowrap;
}
button:hover:not(:disabled) {
   background: #343a40 !important;
   color: #fff !important;
}
button:disabled {
   opacity: 0.35;
}
.close {
   width: 29px;
   padding: 0 !important;
   justify-content: center !important;
   background: transparent !important;
   color: #969fa8 !important;
}
.action-select {
   display: flex;
   align-items: center;
   gap: 6px;
   color: #8f99a3;
   font-size: 0.58rem;
}
.action-select select {
   height: 29px;
   padding: 0 25px 0 8px;
   border: 1px solid #3a424a;
   border-radius: 7px;
   outline: 0;
   background: #20252a;
   color: #eef2f5;
   font-size: 0.61rem;
}
.action-select select:focus-visible {
   outline: 2px solid #b9d8f2;
   outline-offset: 1px;
}
.saved {
   color: #76c99a;
}
.spin {
   color: #d8b56d;
   animation: spin 0.8s linear infinite;
}
@keyframes spin {
   to {
      transform: rotate(360deg);
   }
}
@media (max-width: 900px) {
   .toolbox-anchor {
      max-width: calc(100% - 24px);
   }
   .toolbox-instruction {
      display: none;
   }
}
@media (prefers-reduced-motion: reduce) {
   .spin {
      animation: none;
   }
}
</style>
