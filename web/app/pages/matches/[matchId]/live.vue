<script setup lang="ts">
import type { PlaybackWindowDescriptor } from "@volleyball-monitoring/contracts";
import { ExternalLink, Radio, RotateCcw, X } from "lucide-vue-next";
import { createMediaClient } from "~/lib/mediaClient";
import { coachRallyContactCount } from "~/utils/coachPresentation";
import { youtubeEmbedUrl } from "~/utils/youtubeEmbed";

const route = useRoute();
const config = useRuntimeConfig();
const matchId = computed(() => String(route.params.matchId));
const coach = useCoachMatchState(matchId);
const match = computed(() => coach.data.value?.match ?? null);
const activeSet = computed(
   () =>
      match.value?.sets.find((set) => set.status.toLowerCase() === "live") ??
      match.value?.sets.at(-1) ??
      null,
);
const latestRally = computed(() => match.value?.rallies[0] ?? null);
const teamById = computed(
   () => new Map((match.value?.teams ?? []).map((team) => [team.id, team])),
);
const leftTeam = computed(
   () =>
      teamById.value.get(
         activeSet.value?.side_assignment?.left_team_id ?? "",
      ) ??
      match.value?.teams[0] ??
      null,
);
const rightTeam = computed(
   () =>
      teamById.value.get(
         activeSet.value?.side_assignment?.right_team_id ?? "",
      ) ??
      match.value?.teams[1] ??
      null,
);
const activeCapture = computed(
   () =>
      match.value?.captures.find(
         (capture) => capture.status === "live" && capture.health === "healthy",
      ) ??
      match.value?.captures[0] ??
      null,
);
const publicSourceUrl = computed(() =>
   String(config.public.coachEmbedUrl || ""),
);
const embedUrl = computed(() => youtubeEmbedUrl(publicSourceUrl.value));
const shouldEmbed = computed(
   () =>
      activeCapture.value?.source_kind === "youtube" && Boolean(embedUrl.value),
);
const dvrDescriptor = shallowRef<PlaybackWindowDescriptor | null>(null);
const dvrError = shallowRef<Error | null>(null);
const announcedRally = shallowRef<typeof latestRally.value>(null);
let initialRallyId: string | null = null;

watch(
   () => activeCapture.value?.id ?? null,
   async (captureId) => {
      dvrDescriptor.value = null;
      dvrError.value = null;
      if (!captureId || shouldEmbed.value) return;
      try {
         dvrDescriptor.value = await createMediaClient().createPlaybackWindow({
            schema_version: "1.0.0",
            capture_session_id: captureId,
            mode: "live",
            requested_back_us: "90000000",
         });
      } catch (cause) {
         dvrError.value =
            cause instanceof Error ? cause : new Error("無法載入直播");
      }
   },
   { immediate: true },
);

watch(
   () => latestRally.value?.id ?? null,
   (id, previous) => {
      if (!id) return;
      if (initialRallyId === null) {
         initialRallyId = id;
         return;
      }
      if (previous && id !== previous) announcedRally.value = latestRally.value;
   },
);

function scoreLabel() {
   const set = activeSet.value;
   return `${leftTeam.value?.shortName || leftTeam.value?.name || "左隊"} ${set?.left_score ?? 0} 比 ${set?.right_score ?? 0} ${rightTeam.value?.shortName || rightTeam.value?.name || "右隊"}`;
}

function handleDvrError(error: Error) {
   dvrError.value = error;
}
</script>

<template>
   <section
      class="live-board"
      :aria-label="scoreLabel()"
   >
      <div
         v-if="coach.pending.value"
         class="live-board__loading"
         aria-busy="true"
      />
      <div
         v-else-if="coach.error.value && !match"
         class="live-board__state"
         role="alert"
      >
         <strong>無法載入場次</strong
         ><span>{{ coach.error.value.message }}</span
         ><button
            type="button"
            @click="coach.refresh"
         >
            重試
         </button>
      </div>
      <div
         v-else-if="!match"
         class="live-board__state"
      >
         找不到場次。
      </div>
      <template v-else>
         <div class="score-ribbon">
            <div class="score-ribbon__team">
               <span>{{ leftTeam?.name || "左隊" }}</span
               ><b>{{ activeSet?.left_score ?? 0 }}</b>
            </div>
            <div class="score-ribbon__set">
               <span>第 {{ activeSet?.set_number ?? 1 }} 局</span
               ><i><Radio :size="12" />LIVE</i>
            </div>
            <div class="score-ribbon__team score-ribbon__team--right">
               <b>{{ activeSet?.right_score ?? 0 }}</b
               ><span>{{ rightTeam?.name || "右隊" }}</span>
            </div>
         </div>

         <div class="live-stage">
            <div class="live-video">
               <iframe
                  v-if="shouldEmbed"
                  :src="embedUrl ?? undefined"
                  :title="`${match.title} 直播`"
                  allow="
                     autoplay;
                     encrypted-media;
                     picture-in-picture;
                     fullscreen;
                  "
               />
               <VideoOverlayPlayer
                  v-else-if="dvrDescriptor"
                  class="live-video__dvr"
                  :descriptor="dvrDescriptor"
                  @error="handleDvrError"
               />
               <div
                  v-else
                  class="live-video__empty"
               >
                  <Radio :size="28" /><strong>{{
                     dvrError ? "直播載入失敗" : "直播尚未連結"
                  }}</strong>
               </div>
               <a
                  v-if="shouldEmbed && publicSourceUrl"
                  class="live-video__source"
                  :href="publicSourceUrl"
                  target="_blank"
                  rel="noopener"
                  >影音來源<ExternalLink :size="12"
               /></a>
            </div>

            <aside
               class="live-feed"
               aria-label="最近回合"
            >
               <div class="live-feed__header">
                  <strong>最近回合</strong
                  ><NuxtLink :to="`/matches/${matchId}/rallies`">全部</NuxtLink>
               </div>
               <UiScrollArea class="live-feed__scroll">
                  <div>
                     <ol>
                        <li
                           v-for="rally in match.rallies"
                           :key="rally.id"
                        >
                           <NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`">
                              <span><b>回合 {{ rally.ordinal }}</b><small>第 {{ rally.set_number }} 局</small></span>
                              <span class="live-feed__result"><strong>{{
                                 teamById.get(rally.submission.scoring_team_id ?? "")?.shortName ||
                                 (rally.submission.score_resolution === "unknown" ? "結果待確認" : "—")
                              }}</strong><small>{{ coachRallyContactCount(rally) }} 擊球</small></span>
                              <i :class="`state-${rally.processing_status}`" />
                           </NuxtLink>
                        </li>
                     </ol>
                     <p v-if="!match.rallies.length">尚無回合</p>
                  </div>
               </UiScrollArea>
            </aside>
         </div>
      </template>

      <div
         v-if="announcedRally"
         class="rally-toast"
         role="status"
      >
         <RotateCcw :size="18" />
         <div>
            <strong>新回合已完成</strong
            ><span
               >第 {{ announcedRally.set_number }} 局 · #{{
                  announcedRally.ordinal
               }}</span
            >
         </div>
         <NuxtLink :to="`/matches/${matchId}/replay/${announcedRally.id}`"
            >查看</NuxtLink
         >
         <button
            type="button"
            aria-label="關閉通知"
            @click="announcedRally = null"
         >
            <X :size="16" />
         </button>
      </div>
   </section>
</template>

<style scoped>
.live-board {
   height: 100%;
   min-height: 0;
   display: grid;
   grid-template-rows: auto minmax(0, 1fr);
   gap: 12px;
   overflow: hidden;
}
.score-ribbon {
   min-height: clamp(84px, 14dvh, 112px);
   display: grid;
   grid-template-columns: 1fr 100px 1fr;
   align-items: center;
   overflow: hidden;
   border-radius: 18px;
   background: #11151b;
   color: #fff;
   box-shadow: 0 16px 36px #1118271f;
}
.score-ribbon__team {
   min-width: 0;
   display: flex;
   align-items: center;
   justify-content: flex-end;
   gap: 20px;
   padding: 12px 24px;
}
.score-ribbon__team--right {
   justify-content: flex-start;
}
.score-ribbon__team span {
   overflow: hidden;
   color: #d6d9df;
   font-size: clamp(0.9rem, 1.7vw, 1.25rem);
   font-weight: 650;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.score-ribbon__team b {
   font-size: clamp(3.5rem, 8vw, 6.5rem);
   line-height: 0.85;
   letter-spacing: -0.045em;
   font-variant-numeric: tabular-nums;
}
.score-ribbon__set {
   display: grid;
   justify-items: center;
   gap: 8px;
}
.score-ribbon__set > span {
   color: #aeb4bd;
   font-size: 0.78rem;
   font-weight: 700;
}
.score-ribbon__set i {
   display: inline-flex;
   align-items: center;
   gap: 4px;
   color: #61d89a;
   font-size: 0.64rem;
   font-style: normal;
   font-weight: 800;
}
.live-stage {
   min-height: 0;
   display: grid;
   grid-template-columns: minmax(0, 1fr) clamp(230px, 24vw, 330px);
   gap: 12px;
}
.live-video {
   position: relative;
   min-width: 0;
   overflow: hidden;
   border-radius: 18px;
   background: #050608;
   box-shadow: 0 18px 44px #0f172a24;
}
.live-video iframe {
   width: 100%;
   height: 100%;
   border: 0;
}
.live-video__dvr {
   width: 100%;
   height: 100%;
   border-radius: 0;
}
.live-video__dvr :deep(video) {
   width: 100%;
   height: 100%;
   object-fit: contain;
}
.live-video__empty {
   height: 100%;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 10px;
   color: #aab0b8;
}
.live-video__source {
   position: absolute;
   right: 10px;
   bottom: 10px;
   display: inline-flex;
   min-height: 28px;
   align-items: center;
   gap: 5px;
   padding: 0 9px;
   border-radius: 8px;
   background: #080a0dc7;
   color: #d9dde2;
   font-size: 0.67rem;
   text-decoration: none;
   backdrop-filter: blur(12px);
}
.live-feed {
   min-height: 0;
   display: grid;
   grid-template-rows: 48px minmax(0, 1fr);
   overflow: hidden;
   border-radius: 18px;
   background: #fff;
   box-shadow: 0 12px 34px #1822300d;
}
.live-feed__header {
   height: 48px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 0 14px;
   border-bottom: 1px solid #e8ebef;
}
.live-feed__header strong {
   font-size: 0.86rem;
}
.live-feed__header a {
   color: #0a66d8;
   font-size: 0.72rem;
   font-weight: 700;
   text-decoration: none;
}
.live-feed ol {
   margin: 0;
   padding: 0;
   list-style: none;
}
.live-feed__scroll {
   height: 100%;
   min-height: 0;
}
.live-feed li + li {
   border-top: 1px solid #edf0f2;
}
.live-feed li a {
   min-height: 62px;
   display: grid;
   grid-template-columns: 72px 1fr 8px;
   align-items: center;
   gap: 9px;
   padding: 7px 14px;
   color: inherit;
   text-decoration: none;
}
.live-feed li a:active {
   background: #f2f6fb;
}
.live-feed li span {
   display: flex;
   align-items: baseline;
   gap: 7px;
}
.live-feed li b {
   font-size: 1.12rem;
   font-variant-numeric: tabular-nums;
}
.live-feed li small {
   color: #828995;
   font-size: 0.62rem;
}
.live-feed li strong {
   overflow: hidden;
   font-size: 0.76rem;
   text-align: right;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.live-feed li i {
   width: 7px;
   height: 7px;
   border-radius: 50%;
   background: #2b74d6;
}
.live-feed li i[class*="processing"],
.live-feed li i[class*="queued"],
.live-feed li i[class*="clipping"] {
   background: #e0a126;
}
.live-feed li i[class*="failed"] {
   background: #d13b46;
}
.live-feed__scroll p {
   padding: 20px;
   color: #858c96;
   font-size: 0.76rem;
   text-align: center;
}
.live-board__loading {
   height: 100%;
   min-height: 0;
   grid-row: 1 / -1;
   border-radius: 18px;
   background: linear-gradient(100deg, #eef1f4 20%, #e2e6ea 40%, #eef1f4 60%);
   background-size: 200% 100%;
   animation: shimmer 1.2s linear infinite;
}
.live-board__state {
   height: 100%;
   min-height: 0;
   grid-row: 1 / -1;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 8px;
   border-radius: 18px;
   background: #fff;
}
.live-board__state span {
   color: #747b86;
   font-size: 0.78rem;
}
.live-board__state button {
   min-height: 38px;
   padding: 0 14px;
   border: 0;
   border-radius: 10px;
   background: #e8edf4;
   font-weight: 700;
}
.rally-toast {
   position: fixed;
   right: max(18px, env(safe-area-inset-right));
   bottom: calc(82px + env(safe-area-inset-bottom));
   z-index: 50;
   min-width: 290px;
   display: grid;
   grid-template-columns: auto 1fr auto auto;
   align-items: center;
   gap: 10px;
   padding: 11px 12px;
   border-radius: 14px;
   background: rgba(26, 30, 37, 0.94);
   color: #fff;
   box-shadow: 0 16px 42px #11182745;
   backdrop-filter: blur(18px);
}
.rally-toast div {
   display: grid;
   gap: 1px;
}
.rally-toast strong {
   font-size: 0.78rem;
}
.rally-toast span {
   color: #b7bec8;
   font-size: 0.67rem;
}
.rally-toast a {
   color: #79b6ff;
   font-size: 0.74rem;
   font-weight: 750;
   text-decoration: none;
}
.rally-toast button {
   width: 30px;
   height: 30px;
   display: grid;
   place-items: center;
   border: 0;
   border-radius: 8px;
   background: transparent;
   color: #bec5ce;
}
@keyframes shimmer {
   to {
      background-position: -200% 0;
   }
}
@media (max-width: 820px) {
   .score-ribbon {
      min-height: 92px;
      grid-template-columns: 1fr 76px 1fr;
   }
   .score-ribbon__team {
      gap: 12px;
      padding: 10px 14px;
   }
   .live-stage {
      min-height: 0;
      grid-template-columns: 1fr;
   }
   .live-video {
      aspect-ratio: 16/9;
   }
   .live-feed {
      min-height: 180px;
   }
}
@media (prefers-reduced-motion: reduce) {
   .live-board__loading {
      animation: none;
   }
}
</style>

<style scoped>
.live-board{gap:1px;background:#dce1e6}.score-ribbon{min-height:clamp(78px,13dvh,106px);border-radius:0;box-shadow:none}.live-stage{gap:1px}.live-video{border-radius:0;box-shadow:none}.live-feed{border-radius:0;box-shadow:none}.live-feed li a{grid-template-columns:minmax(92px,1fr) minmax(70px,.72fr) 8px}.live-feed li b{font-size:.74rem}.live-feed__result{display:grid!important;justify-items:end;gap:2px!important}.live-feed__result strong{font-size:.72rem}.live-feed__result small{font-size:.58rem}.live-board__loading,.live-board__state{border-radius:0}
</style>
