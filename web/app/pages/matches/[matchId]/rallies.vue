<script setup lang="ts">
import { ChevronRight, RotateCcw } from "lucide-vue-next";

const route = useRoute();
const matchId = computed(() => String(route.params.matchId));
const coach = useCoachMatchState(matchId);
const match = computed(() => coach.data.value?.match ?? null);
const selectedSet = ref<number | "all">("all");
const teamById = computed(
   () => new Map((match.value?.teams ?? []).map((team) => [team.id, team])),
);
const rallies = computed(() =>
   (match.value?.rallies ?? []).filter((rally) => {
      if (rally.submission.analysis?.status !== "completed") return false;
      return (
         selectedSet.value === "all" || rally.set_number === selectedSet.value
      );
   }),
);

function outcomeLabel(rally: (typeof rallies.value)[number]) {
   if (rally.submission.score_resolution === "unknown") return "結果待確認";
   return (
      teamById.value.get(rally.submission.scoring_team_id ?? "")?.name ??
      "未計分"
   );
}

function durationLabel(value?: string | null) {
   if (!value) return "—";
   const milliseconds = Number(BigInt(value) / 1_000n);
   return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)} 秒`;
}
</script>

<template>
   <section class="rally-browser">
      <div class="rally-browser__bar">
         <UiScrollArea horizontal class="rally-browser__set-scroll">
            <div
               class="rally-browser__sets"
               role="group"
               aria-label="局數"
            >
               <button
                  type="button"
                  :class="{ active: selectedSet === 'all' }"
                  @click="selectedSet = 'all'"
               >
                  全部
               </button>
               <button
                  v-for="set in match?.sets"
                  :key="set.id"
                  type="button"
                  :class="{ active: selectedSet === set.set_number }"
                  @click="selectedSet = set.set_number"
               >
                  第 {{ set.set_number }} 局
               </button>
            </div>
         </UiScrollArea>
         <strong>{{ rallies.length }} 回合</strong>
      </div>

      <div
         v-if="coach.pending.value"
         class="rally-list rally-list--loading"
         aria-busy="true"
      />
      <div
         v-else-if="!rallies.length"
         class="rally-empty"
      >
         <RotateCcw :size="24" /><span>目前沒有已完成的回合</span>
      </div>
      <UiScrollArea v-else class="rally-list-scroll">
         <ol class="rally-list">
            <li
               v-for="rally in rallies"
               :key="rally.id"
            >
               <NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`">
                  <div class="rally-index">
                     <strong>{{ rally.ordinal }}</strong
                     ><span>第 {{ rally.set_number }} 局</span>
                  </div>
                  <div class="rally-result">
                     <strong>{{ outcomeLabel(rally) }}</strong
                     ><span>{{
                        new Intl.DateTimeFormat("zh-TW", {
                           hour: "2-digit",
                           minute: "2-digit",
                           second: "2-digit",
                        }).format(new Date(rally.submission.submitted_at))
                     }}</span>
                  </div>
                  <dl>
                     <div>
                        <dt>持續時間</dt>
                        <dd>
                           {{ durationLabel(rally.submission.clip?.duration_us) }}
                        </dd>
                     </div>
                     <div>
                        <dt>擊球</dt>
                        <dd>{{ rally.submission.contact_count }}</dd>
                     </div>
                  </dl>
                  <ChevronRight :size="20" />
               </NuxtLink>
            </li>
         </ol>
      </UiScrollArea>
   </section>
</template>

<style scoped>
.rally-browser {
   width: min(100%, 1060px);
   height: 100%;
   min-height: 0;
   display: grid;
   grid-template-rows: auto minmax(0, 1fr);
   margin: 0 auto;
   overflow: hidden;
}
.rally-browser__bar {
   position: sticky;
   top: 0;
   z-index: 3;
   min-height: 46px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   gap: 12px;
   margin-bottom: 10px;
   background: #edf1f5;
}
.rally-browser__bar > strong {
   color: #737a85;
   font-size: 0.72rem;
}
.rally-browser__sets {
   width: max-content;
   min-width: 100%;
   display: flex;
   gap: 4px;
   padding: 3px;
   border-radius: 11px;
   background: #e5e9ee;
}
.rally-browser__set-scroll {
   width: min(100%, 720px);
   height: 38px;
}
.rally-browser__sets button {
   min-height: 32px;
   padding: 0 12px;
   border: 0;
   border-radius: 8px;
   background: transparent;
   color: #68707b;
   font-size: 0.72rem;
   font-weight: 700;
}
.rally-browser__sets button.active {
   background: #fff;
   color: #171a1f;
   box-shadow: 0 1px 4px #11182717;
}
.rally-list {
   margin: 0;
   padding: 0;
   overflow: hidden;
   border-radius: 18px;
   background: #fff;
   box-shadow: 0 12px 34px #1822300d;
   list-style: none;
}
.rally-list-scroll {
   height: 100%;
   min-height: 0;
   border-radius: 18px;
   background: #fff;
   box-shadow: 0 12px 34px #1822300d;
}
.rally-list li + li {
   border-top: 1px solid #e9ecf0;
}
.rally-list li a {
   min-height: 82px;
   display: grid;
   grid-template-columns: 86px minmax(0, 1fr) minmax(180px, 0.6fr) 20px;
   align-items: center;
   gap: 16px;
   padding: 10px 16px;
   color: inherit;
   text-decoration: none;
}
.rally-list li a:hover {
   background: #f8fafc;
}
.rally-list li a:active {
   background: #eef4fb;
}
.rally-index {
   display: flex;
   align-items: baseline;
   gap: 7px;
}
.rally-index strong {
   font-size: 1.6rem;
   letter-spacing: -0.03em;
   font-variant-numeric: tabular-nums;
}
.rally-index span,
.rally-result span {
   color: #7b828d;
   font-size: 0.66rem;
}
.rally-result {
   min-width: 0;
   display: grid;
   gap: 3px;
}
.rally-result strong {
   overflow: hidden;
   font-size: 0.85rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.rally-list dl {
   display: grid;
   grid-template-columns: repeat(2, 1fr);
   gap: 14px;
   margin: 0;
}
.rally-list dl div {
   display: grid;
   gap: 2px;
}
.rally-list dt {
   color: #858c96;
   font-size: 0.62rem;
}
.rally-list dd {
   margin: 0;
   font-size: 0.8rem;
   font-weight: 700;
   font-variant-numeric: tabular-nums;
}
.rally-list--loading {
   min-height: 320px;
   background: linear-gradient(100deg, #f1f3f5 20%, #e7ebef 40%, #f1f3f5 60%);
   background-size: 200% 100%;
   animation: shimmer 1.2s linear infinite;
}
.rally-empty {
   min-height: 240px;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 9px;
   border-radius: 18px;
   background: #fff;
   color: #7b828d;
   font-size: 0.8rem;
}
@keyframes shimmer {
   to {
      background-position: -200% 0;
   }
}
@media (max-width: 680px) {
   .rally-list li a {
      grid-template-columns: 70px 1fr 20px;
   }
   .rally-list dl {
      grid-column: 2;
      grid-row: 2;
   }
   .rally-list li svg {
      grid-row: 1/3;
      grid-column: 3;
   }
   .rally-browser__bar {
      align-items: flex-start;
   }
   .rally-browser__sets {
      min-width: max-content;
   }
   .rally-browser__set-scroll { max-width: calc(100vw - 100px); }
}
@media (prefers-reduced-motion: reduce) {
   .rally-list--loading {
      animation: none;
   }
}
</style>
