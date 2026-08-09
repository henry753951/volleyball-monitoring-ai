<script setup lang="ts">
import { CircleAlert, UserRound } from "lucide-vue-next";
import {
   createCoachDomainClient,
   type CoachMatchAnalytics,
} from "~/lib/coachDomain";
import { createGraphQLTransport } from "~/lib/coreDomain";

const route = useRoute();
const matchId = computed(() => String(route.params.matchId));
const analytics = shallowRef<CoachMatchAnalytics | null>(null);
const pending = ref(true);
const error = shallowRef<Error | null>(null);
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

async function load() {
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
   }
}
onMounted(load);
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
         </aside>

         <main
            v-if="selectedPlayer"
            class="player-detail"
         >
            <header>
               <div class="player-avatar"><UserRound :size="30" /></div>
               <div>
                  <span>{{ selectedTeam?.name }}</span>
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
                  <strong
                     >{{
                        selectedPlayer.sample_count
                           ? Math.round(
                                (selectedPlayer.contact_count /
                                   selectedPlayer.sample_count) *
                                   100,
                             )
                           : 0
                     }}%</strong
                  ><span>事件覆蓋</span>
               </div>
            </div>
            <section class="player-evidence">
               <div>
                  <span>球員 ID</span
                  ><code>{{ selectedPlayer.roster_entry_id }}</code>
               </div>
               <div>
                  <span>球員識別覆蓋</span
                  ><strong>{{
                     analytics.metrics.identity_coverage
                        ? `${(analytics.metrics.identity_coverage.value * 100).toFixed(1)}%`
                        : "—"
                  }}</strong>
               </div>
               <div>
                  <span>球場座標樣本</span
                  ><strong>{{
                     analytics.metrics.court_position_samples?.value ?? 0
                  }}</strong>
               </div>
            </section>
         </main>
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
   margin: 0 auto;
}
.players-layout {
   min-height: calc(100dvh - 152px);
   display: grid;
   grid-template-columns: 300px minmax(0, 1fr);
   overflow: hidden;
   border-radius: 18px;
   background: #fff;
   box-shadow: 0 14px 38px #1822300f;
}
.player-list {
   min-height: 0;
   overflow: auto;
   border-right: 1px solid #e6e9ed;
   background: #f8f9fb;
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
   min-height: 60dvh;
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
}
@media (prefers-reduced-motion: reduce) {
   .players-loading {
      animation: none;
   }
}
</style>
