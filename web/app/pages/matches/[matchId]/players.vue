<script setup lang="ts">
import { CircleAlert, UserRound } from "lucide-vue-next";
import {
   createCoachDomainClient,
   type CoachMatchAnalytics,
} from "~/lib/coachDomain";
import { createGraphQLTransport } from "~/lib/coreDomain";
import { rosterPositionLabel } from "~/lib/rosterPositions";

const route = useRoute();
const matchId = computed(() => String(route.params.matchId));
const analytics = shallowRef<CoachMatchAnalytics | null>(null);
const pending = ref(true);
const error = shallowRef<Error | null>(null);
let refreshing = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const selectedPlayerId = ref<string | null>(null);
const selectedPlayer = computed(
   () =>
      analytics.value?.players.find(
         (player) => player.roster_entry_id === selectedPlayerId.value,
      ) ??
      analytics.value?.players[0] ??
      null,
);
const selectedTeam = computed(
   () =>
      analytics.value?.teams.find(
         (team) => team.id === selectedPlayer.value?.team_id,
      ) ?? null,
);
const selectedSamples = computed(() => selectedPlayer.value?.heatmap_samples ?? []);
const actionLabels: Record<string, string> = { attack: "進攻", set: "傳球", defense: "防守", block: "攔網", other: "其他" };

async function load() {
   if (refreshing) return;
   refreshing = true;
   try {
      analytics.value = await createCoachDomainClient(
         createGraphQLTransport("/graphql"),
      ).analytics(matchId.value);
      if (!selectedPlayerId.value)
         selectedPlayerId.value =
            analytics.value?.players[0]?.roster_entry_id ?? null;
      error.value = null;
   } catch (cause) {
      error.value =
         cause instanceof Error ? cause : new Error("無法載入球員資料");
   } finally {
      pending.value = false;
      refreshing = false;
   }
}
onMounted(() => {
   void load();
   refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
   }, 2_000);
});
onUnmounted(() => {
   if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
   <section class="players-view">
      <div
         v-if="pending"
         class="players-loading"
         aria-busy="true"
      />
      <div
         v-else-if="error && !analytics"
         class="players-state"
         role="alert"
      >
         <CircleAlert :size="22" /><strong>球員資料載入失敗</strong
         ><span>{{ error.message }}</span
         ><button
            type="button"
            @click="load"
         >
            重試
         </button>
      </div>
      <div
         v-else-if="analytics"
         class="players-layout"
      >
         <aside class="player-list">
            <UiScrollArea class="player-list__scroll">
               <div>
                  <div
                     class="player-list__team"
                     v-for="team in analytics.teams"
                     :key="team.id"
                  >
                     <strong>{{ team.name }}</strong>
                     <button
                        v-for="player in analytics.players.filter(
                           (item) => item.team_id === team.id,
                        )"
                        :key="player.roster_entry_id"
                        type="button"
                        :class="{
                           active:
                              selectedPlayer?.roster_entry_id ===
                              player.roster_entry_id,
                        }"
                        @click="selectedPlayerId = player.roster_entry_id"
                     >
                        <span>#{{ player.jersey_number }}</span
                        ><b>{{ player.name }}</b
                        ><small>{{ player.contact_count }}</small>
                     </button>
                  </div>
                  <p v-if="!analytics.players.length">尚無球員資料</p>
               </div>
            </UiScrollArea>
         </aside>

         <UiScrollArea
            v-if="selectedPlayer"
            class="player-detail-scroll"
         >
            <main class="player-detail">
               <header>
                  <div class="player-avatar"><UserRound :size="30" /></div>
                  <div>
                     <span>{{ selectedTeam?.name }} · {{ rosterPositionLabel(selectedPlayer.position) }}</span>
                     <h1>
                        <small>#{{ selectedPlayer.jersey_number }}</small
                        >{{ selectedPlayer.name }}
                     </h1>
                  </div>
               </header>
               <div class="player-measures">
                  <div>
                     <strong>{{ selectedPlayer.contact_count }}</strong
                     ><span>擊球</span>
                  </div>
                  <div>
                     <strong>{{ selectedPlayer.sample_count }}</strong
                     ><span>分析樣本</span>
                  </div>
                  <div>
                     <strong>{{ selectedPlayer.rally_count }}</strong><span>參與回合</span>
                  </div>
               </div>
               <section class="player-analysis">
                  <article class="player-heatmap">
                     <header><strong>觸球位置</strong><span>已依換場方向統一</span></header>
                     <div class="court-map" aria-label="球員觸球位置熱圖">
                        <i class="net" />
                        <span v-for="(sample, index) in selectedSamples" :key="`${sample.rally_id}:${index}`" :class="sample.action || 'other'" :style="{ left: `${Math.max(0, Math.min(100, sample.x * 100))}%`, top: `${Math.max(0, Math.min(100, sample.y * 100))}%` }" :title="`第 ${sample.set_number} 局 · ${actionLabels[sample.action || 'other']}`" />
                        <p v-if="!selectedSamples.length">尚無可用的場地位置</p>
                     </div>
                  </article>
                  <article class="action-summary">
                     <header><strong>擊球分類</strong><span>依模型動作與人工校正</span></header>
                     <div v-for="(label, key) in actionLabels" :key="key"><span>{{ label }}</span><strong>{{ selectedPlayer.action_counts[key] ?? 0 }}</strong></div>
                     <p v-if="selectedPlayer.error_count === null">失誤需有明確事件結果後才列入統計。</p>
                  </article>
               </section>
            </main>
         </UiScrollArea>
         <main
            v-else
            class="players-state"
         >
            尚無球員資料。
         </main>
      </div>
   </section>
</template>

<style scoped>
.players-view {
   width: min(100%, 1100px);
   height: 100%;
   min-height: 0;
   margin: 0 auto;
   overflow: hidden;
}
.players-layout {
   height: 100%;
   min-height: 0;
   display: grid;
   grid-template-columns: 300px minmax(0, 1fr);
   overflow: hidden;
   border-radius: 18px;
   background: #fff;
   box-shadow: 0 14px 38px #1822300f;
}
.player-list {
   min-height: 0;
   overflow: hidden;
   border-right: 1px solid #e6e9ed;
   background: #f8f9fb;
}
.player-list__scroll,
.player-detail-scroll {
   height: 100%;
   min-height: 0;
}
.player-list__team > strong {
   position: sticky;
   top: 0;
   z-index: 2;
   display: block;
   padding: 11px 14px 7px;
   background: rgba(248, 249, 251, 0.94);
   color: #767d88;
   font-size: 0.66rem;
   backdrop-filter: blur(12px);
}
.player-list button {
   width: 100%;
   min-height: 50px;
   display: grid;
   grid-template-columns: 42px 1fr auto;
   align-items: center;
   gap: 7px;
   padding: 0 14px;
   border: 0;
   background: transparent;
   color: #20242a;
   text-align: left;
}
.player-list button:hover {
   background: #eef2f7;
}
.player-list button.active {
   background: #e5f0ff;
   color: #075ebc;
}
.player-list button span {
   font-size: 0.7rem;
   font-weight: 700;
}
.player-list button b {
   overflow: hidden;
   font-size: 0.78rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.player-list button small {
   color: #8c929c;
   font-size: 0.66rem;
   font-variant-numeric: tabular-nums;
}
.player-list > p {
   padding: 20px;
   color: #7c838e;
   font-size: 0.76rem;
   text-align: center;
}
.player-detail {
   min-width: 0;
   min-height: 100%;
   box-sizing: border-box;
   padding: clamp(22px, 4vw, 54px);
}
.player-detail > header {
   display: flex;
   align-items: center;
   gap: 17px;
}
.player-avatar {
   width: 62px;
   height: 62px;
   display: grid;
   place-items: center;
   border-radius: 18px;
   background: #e8edf3;
   color: #58616d;
}
.player-detail header span {
   color: #727985;
   font-size: 0.72rem;
   font-weight: 650;
}
.player-detail h1 {
   display: flex;
   align-items: baseline;
   gap: 10px;
   margin: 3px 0 0;
   font-size: clamp(1.55rem, 3vw, 2.3rem);
   line-height: 1;
   letter-spacing: -0.035em;
}
.player-detail h1 small {
   color: #0a66d8;
   font-size: 0.9rem;
}
.player-measures {
   display: grid;
   grid-template-columns: repeat(3, 1fr);
   margin-top: clamp(24px, 5vw, 58px);
   border-block: 1px solid #e5e8ec;
}
.player-measures > div {
   display: grid;
   justify-items: center;
   gap: 5px;
   padding: 24px 10px;
}
.player-measures > div + div {
   border-left: 1px solid #e5e8ec;
}
.player-measures strong {
   font-size: clamp(1.8rem, 4vw, 3.2rem);
   line-height: 1;
   letter-spacing: -0.04em;
   font-variant-numeric: tabular-nums;
}
.player-measures span {
   color: #79808b;
   font-size: 0.68rem;
}
.player-evidence {
   margin-top: 28px;
}
.player-evidence > div {
   min-height: 48px;
   display: grid;
   grid-template-columns: 150px 1fr;
   align-items: center;
   gap: 12px;
   border-bottom: 1px solid #eceef1;
}
.player-evidence span {
   color: #7a818b;
   font-size: 0.72rem;
}
.player-evidence strong,
.player-evidence code {
   justify-self: end;
   overflow: hidden;
   font-size: 0.76rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.player-evidence code {
   max-width: 100%;
   color: #4d5662;
}
.players-loading {
   height: 100%;
   min-height: 0;
   border-radius: 18px;
   background: linear-gradient(100deg, #f1f3f5 20%, #e7ebef 40%, #f1f3f5 60%);
   background-size: 200% 100%;
   animation: shimmer 1.2s linear infinite;
}
.players-state {
   min-height: 240px;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 8px;
   border-radius: 18px;
   background: #fff;
   color: #707782;
}
.players-state span {
   font-size: 0.74rem;
}
.players-state button {
   min-height: 36px;
   padding: 0 13px;
   border: 0;
   border-radius: 10px;
   background: #e8edf4;
   font-weight: 700;
}
@keyframes shimmer {
   to {
      background-position: -200% 0;
   }
}
.player-analysis{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,.65fr);gap:14px}.player-analysis article{overflow:hidden;border:1px solid #e4e7ea;border-radius:14px;background:#fafbfc}.player-analysis header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid #e8ebed}.player-analysis header strong{font-size:.78rem}.player-analysis header span{color:#7e858d;font-size:.62rem}.court-map{position:relative;aspect-ratio:18/9;margin:14px;border:2px solid #8296a4;background:linear-gradient(90deg,#e8c88f 0 49.7%,#d8b97f 49.7% 50.3%,#e8c88f 50.3%)}.court-map::before,.court-map::after{position:absolute;inset-block:0;width:1px;background:#ffffffb0;content:""}.court-map::before{left:16.666%}.court-map::after{right:16.666%}.court-map .net{position:absolute;z-index:1;inset-block:-2px;left:50%;width:2px;background:#f7fafc}.court-map>span{position:absolute;z-index:2;width:10px;height:10px;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:50%;background:#376f9b;box-shadow:0 1px 4px #0006}.court-map>span.attack{background:#c94f56}.court-map>span.set{background:#4a8d69}.court-map>span.defense{background:#3b6fa4}.court-map>span.block{background:#9a6934}.court-map p{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:#6d5c40;font-size:.7rem}.action-summary>div{min-height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid #e8ebed}.action-summary>div span{color:#646c74;font-size:.72rem}.action-summary>div strong{font-size:.92rem}.action-summary>p{margin:0;padding:12px 14px;color:#848b92;font-size:.64rem;line-height:1.5}
@media (max-width: 720px) {
   .players-layout {
      grid-template-columns: 220px minmax(0, 1fr);
   }
   .player-detail {
      padding: 20px;
   }
   .player-measures {
      grid-template-columns: 1fr;
   }
   .player-measures > div {
      grid-template-columns: 1fr auto;
      justify-items: start;
      padding: 14px;
   }
   .player-measures > div + div {
      border-left: 0;
      border-top: 1px solid #e5e8ec;
   }
   .player-evidence > div {
      grid-template-columns: 1fr;
   }
   .player-analysis{grid-template-columns:1fr}
}
@media (prefers-reduced-motion: reduce) {
   .players-loading {
      animation: none;
   }
}
</style>
