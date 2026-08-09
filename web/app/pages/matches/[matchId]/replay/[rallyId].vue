<script setup lang="ts">
import {
   ChevronDown,
   Maximize,
   Pause,
   Play,
   SlidersHorizontal,
   Volume2,
   VolumeX,
   X,
} from "lucide-vue-next";
import {
   createCoachDomainClient,
   type CoachRallyReplay,
   type ReplayContactEvent,
} from "~/lib/coachDomain";
import { createGraphQLTransport } from "~/lib/coreDomain";
import {
   resolveFrameFromRate,
   resolveFrameFromTimeline,
} from "~/utils/overlayFrameTimeline";

const route = useRoute();
const matchId = computed(() => String(route.params.matchId));
const rallyId = computed(() => String(route.params.rallyId));
const replay = shallowRef<CoachRallyReplay | null>(null);
const pending = ref(true);
const error = shallowRef<Error | null>(null);
const video = useTemplateRef<HTMLVideoElement>("video");
const playerShell = useTemplateRef<HTMLElement>("playerShell");
const playing = ref(false);
const muted = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const currentFrame = ref(0);
const videoWidth = ref(0);
const videoHeight = ref(0);
const settingsOpen = ref(false);
const layersOpen = ref(false);
const overlayMode = ref<"off" | "tracking" | "coach" | "tactical">("coach");
const overlayEnabled = computed(() => overlayMode.value !== "off");
const overlayLayers = reactive({
   bbox: true,
   trackId: true,
   action: true,
   ball: true,
   trail: true,
   footprint: false,
   confidence: false,
   court: true,
   nextHit: true,
});
const overlay = useOverlayChunks(
   computed(() => replay.value?.analysis?.id ?? null),
   currentFrame,
   overlayEnabled,
);
const overlayModes = [
   { id: "off", label: "關閉" },
   { id: "coach", label: "教練" },
   { id: "tracking", label: "追蹤" },
   { id: "tactical", label: "戰術" },
] as const;
const overlayLayerOptions = [
   ["bbox", "球員框"],
   ["trackId", "Track ID"],
   ["action", "動作"],
   ["ball", "球"],
   ["trail", "球軌跡"],
   ["nextHit", "下一擊提示"],
   ["court", "場地指示器"],
   ["footprint", "腳點"],
   ["confidence", "信心值"],
] as const;

const clipDurationUs = computed(() =>
   replay.value?.clip?.duration_us ? BigInt(replay.value.clip.duration_us) : 0n,
);
const timelineEvents = computed(
   () => replay.value?.analysis?.contact_events ?? [],
);
const leftTeamLabel = computed(
   () =>
      replay.value?.rally.left_team.shortName ||
      replay.value?.rally.left_team.name ||
      "左隊",
);
const rightTeamLabel = computed(
   () =>
      replay.value?.rally.right_team.shortName ||
      replay.value?.rally.right_team.name ||
      "右隊",
);
const overlayTracks = computed(
   () =>
      replay.value?.analysis?.tracks.map((track) => ({
         trackId: track.track_id,
         courtSide: track.court_side,
         label: track.identity?.name ?? null,
      })) ?? [],
);
const overlayIdentityLabels = computed(() =>
   Object.fromEntries(
      overlayTracks.value.flatMap((track) =>
         track.label ? [[track.trackId, track.label]] : [],
      ),
   ),
);
const terminalEvent = computed(
   () =>
      timelineEvents.value.find((event) => event.is_terminal) ??
      timelineEvents.value.at(-1) ??
      null,
);
const scoringTeam = computed(() => {
   const outcome = replay.value?.rally.outcome;
   if (!outcome) return null;
   if (outcome.scoring_team) return outcome.scoring_team;
   return outcome.scoring_court_side === "left"
      ? replay.value?.rally.left_team
      : outcome.scoring_court_side === "right"
        ? replay.value?.rally.right_team
        : null;
});
const scoreConfirmed = computed(
   () =>
      replay.value?.rally.outcome.score_resolution === "resolved" &&
      !!scoringTeam.value,
);
const scoringPlayerNames = computed(() => {
   const analysis = replay.value?.analysis;
   const event = terminalEvent.value;
   if (!analysis || !event) return [];
   const actorIds = new Set(
      (event.actors.length ? event.actors : event.candidates).map(
         (actor) => actor.track_id,
      ),
   );
   const side = replay.value?.rally.outcome.scoring_court_side;
   return analysis.tracks
      .filter(
         (track) =>
            actorIds.has(track.track_id) &&
            (!side || track.court_side === side) &&
            track.identity,
      )
      .map((track) => track.identity!.name)
      .filter((name, index, names) => names.indexOf(name) === index);
});
const scoringPlayerLabel = computed(() =>
   scoringPlayerNames.value.length
      ? scoringPlayerNames.value.join("、")
      : "尚未完成球員指派",
);
let videoFrameCallbackId: number | null = null;

onMounted(async () => {
   try {
      replay.value = await createCoachDomainClient(
         createGraphQLTransport("/graphql"),
      ).rallyReplay(rallyId.value);
   } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error("無法載入回合");
   } finally {
      pending.value = false;
   }
});

function updateVideoState(presentedMediaTime?: number | Event) {
   const element = video.value;
   const fps = replay.value?.clip?.fps;
   if (!element) return;
   playing.value = !element.paused;
   muted.value = element.muted;
   currentTime.value = element.currentTime || 0;
   duration.value = Number.isFinite(element.duration)
      ? element.duration
      : Number(clipDurationUs.value) / 1_000_000;
   videoWidth.value = element.videoWidth;
   videoHeight.value = element.videoHeight;
   const mediaTimeUs = String(
      Math.round(
         (typeof presentedMediaTime === "number"
            ? presentedMediaTime
            : currentTime.value) * 1_000_000,
      ),
   );
   if (!overlayEnabled.value) return;
   const timing = overlay.manifest.value?.frame_timing;
   if (timing)
      currentFrame.value = resolveFrameFromTimeline(
         mediaTimeUs,
         timing.clip_time_us,
         timing.clip_end_time_us,
      );
   else if (fps && overlay.manifest.value)
      currentFrame.value = resolveFrameFromRate(
         mediaTimeUs,
         fps,
         overlay.manifest.value.video.total_frames,
      );
}
function scheduleVideoFrameCallback(element: HTMLVideoElement) {
   if (typeof element.requestVideoFrameCallback !== "function") return;
   videoFrameCallbackId = element.requestVideoFrameCallback(
      (_now, metadata) => {
         updateVideoState(metadata.mediaTime);
         scheduleVideoFrameCallback(element);
      },
   );
}
function togglePlayback() {
   const element = video.value;
   if (!element) return;
   if (element.paused) void element.play();
   else element.pause();
}
function seekSeconds(value: number) {
   if (!video.value || !Number.isFinite(value)) return;
   video.value.currentTime = Math.max(
      0,
      Math.min(duration.value || value, value),
   );
   updateVideoState();
}
function handleSeekInput(event: Event) {
   seekSeconds(Number((event.target as HTMLInputElement).value));
}
function seekTimeUs(value: string) {
   seekSeconds(Number(BigInt(value)) / 1_000_000);
}
function seekFrame(value: string | null) {
   const timing = overlay.manifest.value?.frame_timing;
   if (value && timing) {
      const frame = BigInt(value);
      if (frame >= 0n && frame < BigInt(timing.clip_time_us.length))
         seekTimeUs(timing.clip_time_us[Number(frame)]!);
      return;
   }
   const fps = replay.value?.clip?.fps;
   if (!value || !fps) return;
   seekSeconds(Number(BigInt(value) * BigInt(fps.den)) / fps.num);
}
function pointPercent(event: ReplayContactEvent) {
   const total = clipDurationUs.value;
   if (total <= 0n) return 0;
   return Math.max(
      0,
      Math.min(
         100,
         Number((BigInt(event.anchor_time_us) * 10_000n) / total) / 100,
      ),
   );
}
function formatClock(value: number) {
   if (!Number.isFinite(value)) return "0:00";
   const seconds = Math.max(0, Math.floor(value));
   return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function eventLabel(event: ReplayContactEvent) {
   if (event.marker_kind === "service") return "發球";
   return event.is_terminal
      ? "最後觸球"
      : `第 ${event.sequence_index + 1} 次擊球`;
}
function selectOverlayMode(mode: (typeof overlayModes)[number]["id"]) {
   overlayMode.value = mode;
   Object.assign(
      overlayLayers,
      mode === "off"
         ? {
              bbox: false,
              trackId: false,
              action: false,
              ball: false,
              trail: false,
              footprint: false,
              confidence: false,
              court: false,
              nextHit: false,
           }
         : mode === "tracking"
           ? {
                bbox: true,
                trackId: true,
                action: false,
                ball: true,
                trail: true,
                footprint: false,
                confidence: false,
                court: false,
                nextHit: false,
             }
           : mode === "tactical"
             ? {
                  bbox: false,
                  trackId: false,
                  action: false,
                  ball: true,
                  trail: true,
                  footprint: true,
                  confidence: false,
                  court: true,
                  nextHit: true,
               }
             : {
                  bbox: true,
                  trackId: true,
                  action: true,
                  ball: true,
                  trail: true,
                  footprint: false,
                  confidence: false,
                  court: true,
                  nextHit: true,
               },
   );
}
function toggleMute() {
   if (video.value) {
      video.value.muted = !video.value.muted;
      updateVideoState();
   }
}
function toggleFullscreen() {
   if (playerShell.value?.requestFullscreen)
      void playerShell.value.requestFullscreen();
}

watch(video, (element, previous) => {
   if (
      previous &&
      videoFrameCallbackId !== null &&
      typeof previous.cancelVideoFrameCallback === "function"
   )
      previous.cancelVideoFrameCallback(videoFrameCallbackId);
   videoFrameCallbackId = null;
   if (element) scheduleVideoFrameCallback(element);
});
watch(
   () => overlay.manifest.value,
   () => updateVideoState(),
);
onBeforeUnmount(() => {
   if (
      video.value &&
      videoFrameCallbackId !== null &&
      typeof video.value.cancelVideoFrameCallback === "function"
   )
      video.value.cancelVideoFrameCallback(videoFrameCallbackId);
});
</script>

<template>
   <section class="replay-workspace">
      <div
         v-if="pending"
         class="replay-loading"
         aria-busy="true"
      />
      <div
         v-else-if="error"
         class="replay-state"
         role="alert"
      >
         <strong>回合載入失敗</strong><span>{{ error.message }}</span>
      </div>
      <div
         v-else-if="!replay"
         class="replay-state"
      >
         找不到回合。
      </div>
      <template v-else>
         <div class="replay-titlebar">
            <div>
               <strong>第 {{ replay.rally.set.number }} 局</strong
               ><span>回合 {{ replay.rally.ordinal }}</span>
            </div>
            <div class="replay-titlebar__teams">
               <span>得分隊伍</span
               ><b>{{
                  scoreConfirmed
                     ? scoringTeam?.shortName
                     : replay.rally.outcome.score_resolution === "unknown"
                       ? "結果未知"
                       : "待確認"
               }}</b>
            </div>
         </div>

         <div class="replay-grid">
            <section
               ref="playerShell"
               class="replay-player"
            >
               <div
                  v-if="replay.clip"
                  class="replay-player__media"
               >
                  <video
                     ref="video"
                     :src="replay.clip.url"
                     playsinline
                     preload="metadata"
                     @click="togglePlayback"
                     @loadedmetadata="updateVideoState"
                     @timeupdate="updateVideoState"
                     @play="updateVideoState"
                     @pause="updateVideoState"
                     @volumechange="updateVideoState"
                  />
                  <VolleyballOverlayCanvas
                     v-if="replay.analysis && overlayEnabled"
                     :events="replay.analysis.contact_events"
                     :frame="currentFrame"
                     :video-width="videoWidth"
                     :video-height="videoHeight"
                     :chunk="overlay.currentChunk.value"
                     :action-labels="overlay.actionLabels.value"
                     :mode="overlayMode"
                     :layers="overlayLayers"
                     :tracks="overlayTracks"
                     :team-labels="{
                        left: leftTeamLabel,
                        right: rightTeamLabel,
                     }"
                     :identity-labels="overlayIdentityLabels"
                  />
                  <button
                     v-if="!playing"
                     type="button"
                     class="replay-player__center"
                     aria-label="播放"
                     @click.stop="togglePlayback"
                  >
                     <Play
                        :size="28"
                        fill="currentColor"
                     />
                  </button>
               </div>
               <div
                  v-else
                  class="replay-player__empty"
               >
                  影片處理中
               </div>

               <div class="replay-controls">
                  <div class="replay-track">
                     <input
                        type="range"
                        min="0"
                        :max="Math.max(duration, 0.001)"
                        step="0.001"
                        :value="currentTime"
                        aria-label="影片進度"
                        @input="handleSeekInput"
                     />
                     <button
                        v-for="event in timelineEvents"
                        :key="event.key_point_id"
                        type="button"
                        class="replay-point"
                        :class="{
                           service: event.marker_kind === 'service',
                           terminal: event.is_terminal,
                        }"
                        :style="{ left: `${pointPercent(event)}%` }"
                        :aria-label="eventLabel(event)"
                        :title="eventLabel(event)"
                        @click="seekTimeUs(event.anchor_time_us)"
                     />
                  </div>
                  <div class="replay-transport">
                     <button
                        type="button"
                        :aria-label="playing ? '暫停' : '播放'"
                        @click="togglePlayback"
                     >
                        <Pause
                           v-if="playing"
                           :size="19"
                           fill="currentColor"
                        /><Play
                           v-else
                           :size="19"
                           fill="currentColor"
                        />
                     </button>
                     <code
                        >{{ formatClock(currentTime) }}
                        <span>/ {{ formatClock(duration) }}</span></code
                     >
                     <div class="replay-transport__spacer" />
                     <button
                        type="button"
                        :aria-label="muted ? '開啟聲音' : '靜音'"
                        @click="toggleMute"
                     >
                        <VolumeX
                           v-if="muted"
                           :size="19"
                        /><Volume2
                           v-else
                           :size="19"
                        />
                     </button>
                     <button
                        type="button"
                        aria-label="顯示設定"
                        :aria-expanded="settingsOpen"
                        @click="settingsOpen = !settingsOpen"
                     >
                        <SlidersHorizontal :size="19" />
                     </button>
                     <button
                        type="button"
                        aria-label="全螢幕"
                        @click="toggleFullscreen"
                     >
                        <Maximize :size="18" />
                     </button>
                  </div>
               </div>

               <aside
                  v-if="settingsOpen"
                  class="overlay-drawer"
               >
                  <header>
                     <strong>顯示設定</strong
                     ><button
                        type="button"
                        aria-label="關閉"
                        @click="settingsOpen = false"
                     >
                        <X :size="17" />
                     </button>
                  </header>
                  <div class="overlay-drawer__modes">
                     <button
                        v-for="mode in overlayModes"
                        :key="mode.id"
                        type="button"
                        :class="{ active: overlayMode === mode.id }"
                        @click="selectOverlayMode(mode.id)"
                     >
                        {{ mode.label }}
                     </button>
                  </div>
                  <button
                     type="button"
                     class="overlay-drawer__submenu"
                     :aria-expanded="layersOpen"
                     @click="layersOpen = !layersOpen"
                  >
                     <span>顯示項目</span
                     ><ChevronDown
                        :size="16"
                        :class="{ open: layersOpen }"
                     />
                  </button>
                  <div
                     v-if="layersOpen"
                     class="overlay-drawer__layers"
                  >
                     <label
                        v-for="option in overlayLayerOptions"
                        :key="option[0]"
                        ><span>{{ option[1] }}</span
                        ><input
                           v-model="overlayLayers[option[0]]"
                           type="checkbox"
                           :disabled="overlayMode === 'off'"
                     /></label>
                  </div>
               </aside>
            </section>

            <CourtPathView
               class="replay-court"
               :paths="replay.analysis?.paths ?? []"
               :left-team="leftTeamLabel"
               :right-team="rightTeamLabel"
               :active-frame="currentFrame"
               @seek="seekFrame"
            />
         </div>

         <section
            class="replay-result"
            :class="{ confirmed: scoreConfirmed }"
            aria-label="回合結果"
         >
            <div class="replay-result__winner">
               <span>本回合得分隊伍</span
               ><strong>{{
                  scoreConfirmed
                     ? scoringTeam?.name || scoringTeam?.shortName
                     : "結果未知"
               }}</strong
               ><small>{{
                  replay.rally.outcome.scoring_court_side
                     ? `從${replay.rally.outcome.scoring_court_side === "left" ? "左側" : "右側"}場邊判定`
                     : "尚無已確認的得分側"
               }}</small>
            </div>
            <div class="replay-result__divider" />
            <div class="replay-result__scorer">
               <span>最後觸球球員</span><strong>{{ scoringPlayerLabel }}</strong
               ><small>{{
                  terminalEvent
                     ? `第 ${terminalEvent.sequence_index + 1} 次擊球 · ${terminalEvent.association_state === "resolved" ? "已完成辨識" : "等待辨識"}`
                     : "尚無終點事件"
               }}</small>
            </div>
         </section>

         <div class="replay-summary">
            <div>
               <span>持續時間</span><strong>{{ formatClock(duration) }}</strong>
            </div>
            <div>
               <span>擊球</span><strong>{{ timelineEvents.length }}</strong>
            </div>
            <div>
               <span>追蹤球員</span
               ><strong>{{ replay.analysis?.tracks.length ?? 0 }}</strong>
            </div>
            <div>
               <span>球路</span
               ><strong>{{ replay.analysis?.paths.length ?? 0 }}</strong>
            </div>
         </div>
      </template>
   </section>
</template>

<style scoped>
.replay-workspace {
   display: grid;
   gap: 10px;
}
.replay-titlebar {
   min-height: 42px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   gap: 18px;
   padding: 0 4px;
}
.replay-titlebar > div {
   display: flex;
   align-items: baseline;
   gap: 8px;
}
.replay-titlebar strong {
   font-size: 0.88rem;
}
.replay-titlebar span {
   color: #777f8a;
   font-size: 0.7rem;
}
.replay-titlebar__teams {
   padding: 5px 9px;
   border: 1px solid #e5e8ec;
   border-radius: 9px;
   background: #fff;
}
.replay-titlebar__teams b {
   color: #bd6d2e;
   font-size: 0.78rem;
}
.replay-grid {
   min-height: min(66dvh, 760px);
   display: grid;
   grid-template-columns: minmax(0, 1.7fr) minmax(250px, 0.55fr);
   gap: 10px;
}
.replay-player {
   position: relative;
   min-width: 0;
   min-height: 0;
   display: grid;
   grid-template-rows: minmax(0, 1fr) 72px;
   overflow: hidden;
   border-radius: 16px;
   background: #07090c;
   box-shadow: 0 18px 44px #0f172a24;
   color: #fff;
}
.replay-player__media {
   position: relative;
   min-height: 0;
   display: grid;
   place-items: center;
   overflow: hidden;
}
.replay-player video {
   width: 100%;
   height: 100%;
   object-fit: contain;
}
.replay-player__center {
   position: absolute;
   left: 50%;
   top: 50%;
   width: 58px;
   height: 58px;
   display: grid;
   place-items: center;
   transform: translate(-50%, -50%);
   border: 0;
   border-radius: 50%;
   background: #080a0dc7;
   color: #fff;
   backdrop-filter: blur(14px);
}
.replay-player__center:active {
   transform: translate(-50%, -50%) scale(0.95);
}
.replay-player__empty {
   display: grid;
   place-items: center;
   color: #9ba3ad;
   font-size: 0.78rem;
}
.replay-controls {
   display: grid;
   grid-template-rows: 24px 48px;
   padding: 0 12px;
   background: #11151a;
}
.replay-track {
   position: relative;
   align-self: center;
   height: 16px;
}
.replay-track input {
   position: absolute;
   inset: 5px 0 auto;
   width: 100%;
   height: 4px;
   margin: 0;
   accent-color: #bd6d2e;
   cursor: pointer;
}
.replay-point {
   position: absolute;
   z-index: 2;
   top: 2px;
   width: 11px;
   height: 11px;
   padding: 0;
   transform: translateX(-50%);
   border: 2px solid #f2f6fa;
   border-radius: 50%;
   background: #d8e3ed;
   box-shadow: 0 1px 4px #0008;
}
.replay-point.service {
   background: #f1c98a;
}
.replay-point.terminal {
   border-radius: 2px;
   transform: translateX(-50%) rotate(45deg);
   background: #ef8b62;
}
.replay-transport {
   display: flex;
   align-items: center;
   gap: 5px;
}
.replay-transport button,
.overlay-drawer button {
   border: 0;
   background: transparent;
   color: inherit;
}
.replay-transport > button {
   width: 36px;
   height: 36px;
   display: grid;
   place-items: center;
   border-radius: 9px;
}
.replay-transport > button:active {
   background: #ffffff14;
   transform: scale(0.94);
}
.replay-transport code {
   margin-left: 5px;
   color: #e5e9ee;
   font-size: 0.7rem;
   font-variant-numeric: tabular-nums;
}
.replay-transport code span {
   color: #858e99;
}
.replay-transport__spacer {
   flex: 1;
}
.replay-result {
   display: grid;
   grid-template-columns: 1fr auto 1fr;
   align-items: center;
   gap: 20px;
   padding: 13px 18px;
   border: 1px solid #e4e7eb;
   border-radius: 14px;
   background: #fff;
   box-shadow: 0 8px 24px #1822300a;
}
.replay-result__winner,
.replay-result__scorer {
   display: grid;
   gap: 3px;
}
.replay-result span {
   color: #7d858f;
   font-size: 0.66rem;
}
.replay-result strong {
   color: #252a30;
   font-size: 1rem;
}
.replay-result small {
   color: #9aa1aa;
   font-size: 0.62rem;
}
.replay-result.confirmed .replay-result__winner strong {
   color: #bd6d2e;
}
.replay-result__divider {
   width: 1px;
   height: 38px;
   background: #e7eaee;
}
.overlay-drawer {
   position: absolute;
   z-index: 12;
   right: 8px;
   bottom: 64px;
   width: min(280px, calc(100% - 16px));
   max-height: calc(100% - 80px);
   overflow: auto;
   border: 1px solid #ffffff1a;
   border-radius: 14px;
   background: rgba(30, 35, 42, 0.94);
   box-shadow: 0 18px 52px #0008;
   backdrop-filter: blur(24px) saturate(150%);
}
.overlay-drawer header {
   height: 44px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 0 12px;
   border-bottom: 1px solid #ffffff14;
}
.overlay-drawer header strong {
   font-size: 0.78rem;
}
.overlay-drawer header button {
   width: 30px;
   height: 30px;
   display: grid;
   place-items: center;
   border-radius: 8px;
}
.overlay-drawer__modes {
   display: grid;
   grid-template-columns: repeat(4, 1fr);
   gap: 5px;
   padding: 10px;
}
.overlay-drawer__modes button {
   min-height: 34px;
   border-radius: 8px;
   background: #ffffff0b;
   color: #b9c1ca;
   font-size: 0.68rem;
}
.overlay-drawer__modes button.active {
   background: #bd6d2e;
   color: #fff;
}
.overlay-drawer__submenu {
   width: 100%;
   min-height: 42px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 0 12px;
   border-top: 1px solid #ffffff14 !important;
   color: #d8dde3 !important;
   font-size: 0.72rem;
}
.overlay-drawer__submenu svg {
   transition: transform 160ms ease;
}
.overlay-drawer__submenu svg.open {
   transform: rotate(180deg);
}
.overlay-drawer__layers {
   padding: 0 12px 10px;
}
.overlay-drawer__layers label {
   min-height: 36px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   color: #b9c1ca;
   font-size: 0.68rem;
}
.replay-summary {
   display: grid;
   grid-template-columns: repeat(4, 1fr);
   overflow: hidden;
   border-radius: 14px;
   background: #fff;
   box-shadow: 0 10px 28px #1822300b;
}
.replay-summary > div {
   min-height: 56px;
   display: flex;
   align-items: center;
   justify-content: center;
   gap: 9px;
}
.replay-summary > div + div {
   border-left: 1px solid #e8ebef;
}
.replay-summary span {
   color: #808792;
   font-size: 0.66rem;
}
.replay-summary strong {
   font-size: 0.92rem;
   font-variant-numeric: tabular-nums;
}
.replay-loading {
   min-height: 70dvh;
   border-radius: 18px;
   background: linear-gradient(100deg, #f1f3f5 20%, #e7ebef 40%, #f1f3f5 60%);
   background-size: 200% 100%;
   animation: shimmer 1.2s linear infinite;
}
.replay-state {
   min-height: 240px;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 6px;
   border-radius: 18px;
   background: #fff;
   color: #707782;
}
.replay-state span {
   font-size: 0.72rem;
}
@keyframes shimmer {
   to {
      background-position: -200% 0;
   }
}
@media (max-width: 880px) {
   .replay-grid {
      min-height: 0;
      grid-template-columns: minmax(0, 1fr) 230px;
   }
   .replay-player {
      aspect-ratio: 16/10;
   }
   .replay-court {
      min-height: 420px;
   }
}
@media (max-width: 700px) {
   .replay-grid {
      grid-template-columns: 1fr;
   }
   .replay-court {
      min-height: 420px;
   }
   .replay-result {
      grid-template-columns: 1fr;
      gap: 10px;
   }
   .replay-result__divider {
      width: 100%;
      height: 1px;
   }
   .replay-summary {
      grid-template-columns: repeat(2, 1fr);
   }
   .replay-summary > div:nth-child(3) {
      border-left: 0;
      border-top: 1px solid #e8ebef;
   }
   .replay-summary > div:nth-child(4) {
      border-top: 1px solid #e8ebef;
   }
}
@media (prefers-reduced-motion: reduce) {
   .replay-loading {
      animation: none;
   }
   .overlay-drawer__submenu svg {
      transition: none;
   }
}
</style>
