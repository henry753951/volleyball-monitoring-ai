<script setup lang="ts">
import { ChevronRight, CircleAlert, Radio } from "lucide-vue-next";
import { coachMatchStatus } from "~/utils/coachMatchStatus";

definePageMeta({ layout: "coach" });

const route = useRoute();
const viewerState = useViewerState();
const matchState = useMatches();
type MatchListItem = (typeof matchState.matches.value)[number];
const authRequired = computed(() => route.query.auth === "required");
const authUnavailable = computed(
   () => route.query.auth === "unavailable" || Boolean(viewerState.error.value),
);

function currentSet(match: MatchListItem) {
   return (
      match.sets.find((set) => set.status.toLowerCase() === "live") ??
      match.sets.at(-1) ??
      null
   );
}

function matchTeams(match: MatchListItem) {
   const set = currentSet(match);
   const assignment = set?.sideAssignments.at(-1);
   const byId = new Map(match.teams.map((team) => [team.id, team]));
   return {
      left: byId.get(assignment?.leftTeamId ?? "") ?? match.teams[0],
      right: byId.get(assignment?.rightTeamId ?? "") ?? match.teams[1],
   };
}

onMounted(async () => {
   await viewerState.refresh();
   if (viewerState.viewer.value) await matchState.refresh();
});
</script>

<template>
   <section
      class="match-browser"
      aria-labelledby="match-browser-title"
   >
      <div class="match-browser__heading">
         <div>
            <h1 id="match-browser-title">場次</h1>
         </div>
         <span class="match-browser__count"
            >{{ matchState.matches.value.length }} 場</span
         >
      </div>

      <div
         v-if="authUnavailable"
         class="state-panel state-panel--error"
         role="alert"
      >
         <CircleAlert :size="20" />
         <div>
            <strong>連線失敗</strong>
            <p>
               {{ viewerState.error.value?.message || "暫時無法取得場次。" }}
            </p>
         </div>
         <button
            type="button"
            @click="viewerState.refresh"
         >
            重試
         </button>
      </div>
      <div
         v-else-if="
            authRequired ||
            (viewerState.checked.value && !viewerState.viewer.value)
         "
         class="state-panel"
         role="status"
      >
         請先登入以查看場次。
      </div>
      <div
         v-else-if="viewerState.pending.value || matchState.pending.value"
         class="match-list"
         aria-busy="true"
      >
         <div
            v-for="n in 3"
            :key="n"
            class="match-row match-row--skeleton"
         />
      </div>
      <div
         v-else-if="matchState.error.value"
         class="state-panel state-panel--error"
         role="alert"
      >
         <CircleAlert :size="20" />
         <div>
            <strong>場次載入失敗</strong>
            <p>{{ matchState.error.value.message }}</p>
         </div>
         <button
            type="button"
            @click="matchState.refresh"
         >
            重試
         </button>
      </div>
      <div
         v-else-if="!matchState.matches.value.length"
         class="state-panel"
      >
         <p>目前沒有場次。</p>
      </div>
      <ol
         v-else
         class="match-list"
      >
         <li
            v-for="match in matchState.matches.value"
            :key="match.id"
         >
            <NuxtLink
               :to="`/matches/${match.id}/live`"
               class="match-row"
            >
               <div class="match-row__meta">
                  <span
                     class="match-status"
                     :class="`match-status--${coachMatchStatus(match).kind}`"
                     ><Radio
                        v-if="coachMatchStatus(match).kind === 'live'"
                        :size="12"
                     />{{ coachMatchStatus(match).label }}</span
                  >
                  <strong>{{ match.title }}</strong>
                  <small>{{
                     match.venue ||
                     (match.scheduledAt
                        ? new Intl.DateTimeFormat("zh-TW", {
                             month: "numeric",
                             day: "numeric",
                             hour: "2-digit",
                             minute: "2-digit",
                          }).format(new Date(match.scheduledAt))
                        : "—")
                  }}</small>
               </div>
               <div
                  class="match-score"
                  aria-label="目前比分"
               >
                  <div>
                     <span>{{
                        matchTeams(match).left?.shortName ||
                        matchTeams(match).left?.name ||
                        "左隊"
                     }}</span
                     ><b>{{ currentSet(match)?.leftScore ?? 0 }}</b>
                  </div>
                  <i>:</i>
                  <div>
                     <b>{{ currentSet(match)?.rightScore ?? 0 }}</b
                     ><span>{{
                        matchTeams(match).right?.shortName ||
                        matchTeams(match).right?.name ||
                        "右隊"
                     }}</span>
                  </div>
               </div>
               <div class="match-row__set">
                  <span>第 {{ currentSet(match)?.setNumber ?? 1 }} 局</span
                  ><ChevronRight :size="20" />
               </div>
            </NuxtLink>
         </li>
      </ol>
   </section>
</template>

<style scoped>
.match-browser {
   width: min(100%, 1080px);
   margin: 0 auto;
}
.match-browser__heading {
   display: flex;
   align-items: end;
   justify-content: space-between;
   margin: 2px 2px 18px;
}
.match-browser__eyebrow {
   margin: 0 0 5px;
   color: #697687;
   font-size: 0.7rem;
   font-weight: 700;
   letter-spacing: 0.08em;
}
.match-browser__heading h1 {
   margin: 0;
   font-size: 1.7rem;
   line-height: 1.05;
   letter-spacing: -0.035em;
}
.match-browser__count {
   padding-bottom: 3px;
   color: #6c7785;
   font-size: 0.75rem;
   font-weight: 650;
}
.match-list {
   margin: 0;
   padding: 0;
   overflow: hidden;
   border: 1px solid #dfe5eb;
   border-radius: 16px;
   background: #fff;
   box-shadow: 0 12px 34px #1822300d;
   list-style: none;
}
.match-list li + li {
   border-top: 1px solid #e8ebef;
}
.match-row {
   min-height: 104px;
   display: grid;
   grid-template-columns: minmax(220px, 1fr) minmax(260px, 0.82fr) 100px;
   align-items: center;
   gap: 18px;
   padding: 16px 20px;
   color: inherit;
   text-decoration: none;
   transition: background 120ms ease-out;
}
.match-row:hover {
   background: #f8fafc;
}
.match-row:active {
   background: #eef4fb;
}
.match-row__meta {
   min-width: 0;
   display: grid;
   grid-template-columns: auto 1fr;
   align-items: center;
   gap: 5px 8px;
}
.match-row__meta strong {
   overflow: hidden;
   font-size: 0.98rem;
   letter-spacing: -0.01em;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.match-row__meta small {
   grid-column: 1/-1;
   color: #687383;
   font-size: 0.74rem;
}
.match-status {
   display: inline-flex;
   width: max-content;
   align-items: center;
   gap: 4px;
   color: #737985;
   font-size: 0.67rem;
   font-weight: 700;
}
.match-status--live {
   color: #16734a;
}
.match-status--ready {
   color: #1767ae;
}
.match-status--processing {
   color: #8a6219;
}
.match-status--failed {
   color: #a3323a;
}
.match-score {
   display: grid;
   grid-template-columns: 1fr auto 1fr;
   align-items: center;
   gap: 12px;
   font-variant-numeric: tabular-nums;
}
.match-score div {
   display: flex;
   align-items: baseline;
   justify-content: flex-end;
   gap: 9px;
}
.match-score div:last-child {
   justify-content: flex-start;
}
.match-score span {
   max-width: 8rem;
   overflow: hidden;
   color: #5f6672;
   font-size: 0.77rem;
   font-weight: 650;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.match-score b {
   font-size: 2rem;
   line-height: 1;
   letter-spacing: -0.035em;
}
.match-score i {
   color: #a3a9b2;
   font-style: normal;
}
.match-row__set {
   display: flex;
   align-items: center;
   justify-content: flex-end;
   gap: 5px;
   color: #777e89;
   font-size: 0.74rem;
}
.match-row--skeleton {
   height: 104px;
   background: #edf1f4;
   animation: pulse 1.1s ease-in-out infinite alternate;
}
.state-panel {
   min-height: 108px;
   display: flex;
   align-items: center;
   justify-content: center;
   gap: 12px;
   padding: 20px;
   border: 1px solid #dfe5eb;
   border-radius: 16px;
   background: #fff;
   color: #626975;
}
.state-panel--error {
   justify-content: flex-start;
   color: #a3262e;
}
.state-panel p {
   margin: 2px 0 0;
   font-size: 0.78rem;
}
.state-panel button {
   margin-left: auto;
   min-height: 44px;
   padding: 0 14px;
   border: 0;
   border-radius: 10px;
   background: #e9eef5;
   color: #17202b;
   font-weight: 700;
}
@keyframes pulse {
   to {
      opacity: 0.55;
   }
}
@media (max-width: 760px) {
   .match-row {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 14px;
   }
   .match-score {
      grid-row: 2;
      grid-column: 1/-1;
   }
   .match-row__set {
      grid-row: 1/3;
      grid-column: 2;
   }
   .match-row__meta {
      padding-right: 24px;
   }
}
@media (prefers-reduced-motion: reduce) {
   .match-row,
   .match-row--skeleton {
      transition: none;
      animation: none;
   }
}
</style>

<style scoped>
.match-browser{width:100%}.match-browser__heading{margin:4px 2px 13px;padding-bottom:12px;border-bottom:1px solid #dfe4e8}.match-list{border:0;border-radius:0;background:transparent;box-shadow:none}.match-row{min-height:96px;border-bottom:1px solid #e1e5e9}.match-list li+li{border-top:0}.state-panel{border-width:1px 0;border-radius:0;background:transparent}.match-row--skeleton{border-bottom:1px solid #dfe4e8}
</style>
