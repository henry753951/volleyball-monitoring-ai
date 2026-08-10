<script setup lang="ts">
import { toast } from "vue-sonner";
import type {
   AnalysisFrameBBox,
   AnalysisReviewAction,
   AnnotationRallyProcessingUpdate,
} from "@volleyball-monitoring/contracts";
import { createMediaClient } from "~/lib/mediaClient";
import {
   useAuthoritativeDvrWindow,
   seekVideoToCanonicalFrame,
   authoritativeControlsEnabled,
} from "~/composables/useAuthoritativeDvrWindow";
import {
   createCoreDomainClient,
   createGraphQLTransport,
   GraphQLRequestError,
   type Match,
   type CaptureSession,
} from "~/lib/coreDomain";
import {
   ANNOTATION_COMMANDS,
   formatBindingForDisplay,
   type AnnotationAction,
   type HotkeyCommand,
   type MediaAction,
} from "~/utils/annotationHotkeys";
import {
   draftCommandAvailability,
   openDraftBlocksNewRally,
} from "~/utils/annotationCommandAvailability";
import type { PlaybackCursorInput } from "~/lib/mediaModel";
import {
   createCoachDomainClient,
   type CoachRally,
   type CoachRallyReplay,
} from "~/lib/coachDomain";
import {
   DEFAULT_TIMELINE_SCALE,
   clipRangeOverlaps,
   formatTimelinePosition,
   paddedClipRange,
   resolveSegmentSelection,
   segmentAtCaptureTime,
} from "~/lib/dvrTimeline";
import { capturePlaybackMode } from "~/lib/mediaTimeline";
import { decidePlaybackContinuation } from "~/lib/playbackContinuation";
import {
   bufferedSecondsAhead,
   type CanonicalMediaRange,
} from "~/utils/mediaBuffer";
import type { TimelineSelectionItem } from "~/utils/timelineSelection";
import {
   captureNeedsPolling,
   hasActiveRallyProcessing,
} from "~/utils/annotationPolling";
import {
   replayEventFrame,
   resolveEffectiveHitPosition,
   resolveEventActorFromResult,
   type OverlayBallOverride,
} from "~/utils/volleyballOverlayRenderer";

definePageMeta({ layout: "annotation" });
const route = useRoute();
const matchId = String(route.params.matchId);
const match = ref<Match | null>(null);
const loadError = ref<string | null>(null);
const media = createMediaClient();
const core = createCoreDomainClient(createGraphQLTransport("/graphql"));
const coachDomain = createCoachDomainClient(createGraphQLTransport("/graphql"));
const dvr = useAuthoritativeDvrWindow(media);
const descriptor = computed(() => dvr.current.value);
const { profile: mediaBufferProfile } = useMediaPlaybackPreferences();
const video = ref<HTMLVideoElement | null>(null);
const overlayPlayer = ref<{
   recoverPlayback: () => boolean;
   seekCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean;
   previewCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean;
   overlayFrameCaptureTime: (frame: number) => string | null;
   seekOverlayFrameIfBuffered: (frame: number) => boolean;
} | null>(null);
const playing = ref(false);
const muted = ref(false);
const playerBufferedRanges = shallowRef<CanonicalMediaRange[]>([]);
const captureTarget = ref("");
const mediaError = ref<string | null>(null);
const authoritativeAnchor = computed(() => dvr.anchor.value);
const observedCursor = shallowRef<PlaybackCursorInput | null>(null);
const cursorStatus = ref<"ready" | "stale" | "seeking" | "gap">("stale");
const annotation = useAnnotationRoom();
const coach = useCoachMatchState(matchId, { refreshIntervalMs: 0 });
const optimisticKeyPointMoves = shallowRef<Record<string, string>>({});
const displayAnnotation = computed(() => {
   const source = annotation.viewSnapshot.value;
   if (!source || !Object.keys(optimisticKeyPointMoves.value).length)
      return source;
   const projected = structuredClone(source);
   projected.snapshot.key_points = projected.snapshot.key_points.map(
      (point) => {
         const captureTimeUs =
            optimisticKeyPointMoves.value[point.key_point_id];
         return captureTimeUs
            ? {
                 ...point,
                 capture_time_us: captureTimeUs,
                 timing_precision: "estimated" as const,
              }
            : point;
      },
   );
   return projected;
});
const state = annotation.viewState;
const currentLastKeyPointId = computed(
   () =>
      displayAnnotation.value?.snapshot.key_points.at(-1)?.key_point_id ?? null,
);
const selectedKeyPointId = ref<string | null>(null);
const selectedTimelineItem = ref<TimelineSelectionItem>(null);
const selectedKeyPoint = computed(
   () =>
      annotation.snapshot.value?.snapshot.key_points.find(
         (point) => point.key_point_id === selectedKeyPointId.value,
      ) ?? null,
);
const pendingTimelineMove = shallowRef<{
   keyPointId: string;
   playbackWindowId: string | null;
} | null>(null);
const frameQueueRunning = ref(false);
const seekPreviewActive = ref(false);
const canMark = computed(() =>
   authoritativeControlsEnabled({
      cursorReady: cursorStatus.value === "ready",
      status: dvr.status.value,
      busy: dvr.busy.value,
      descriptor: descriptor.value,
      anchor: authoritativeAnchor.value,
   }),
);
const commandReady = computed(() => !annotation.outboxNeedsConfirmation.value);
const editReady = computed(
   () =>
      commandReady.value &&
      !annotation.busy.value &&
      !pendingTimelineMove.value &&
      annotation.pendingCount.value === 0,
);
const { bindings } = useAnnotationHotkeys();
const annotationScope = useTemplateRef<HTMLElement>("annotationScope");
const videoStage = useTemplateRef<HTMLElement>("videoStage");
const timelineDock = useTemplateRef<{ resetView: () => void }>("timelineDock");
const timelineScale = ref(DEFAULT_TIMELINE_SCALE);
const hotkeyTarget = computed(() =>
   import.meta.client ? document.body : annotationScope.value,
);
const settingsOpen = ref(false);
const settingsInitialPage = ref<"root" | "media" | "clip" | "hotkeys">("root");
const clipPolicySaving = ref(false);
const clipPolicyError = ref<string | null>(null);
const captureDialogOpen = ref(false);
const connectionDialogOpen = ref(false);
const rosterDialogOpen = ref(false);
const confirmAction = ref<
   "rally-delete" | "correction" | "next-left" | "next-right" | null
>(null);
const confirmTitle = computed(() =>
   confirmAction.value === "rally-delete"
      ? "永久刪除片段"
      : confirmAction.value === "correction"
        ? "建立修正版草稿"
        : "開啟新一局",
);
const confirmMessage = computed(() =>
   confirmAction.value === "rally-delete"
      ? "片段、裁切媒體與分析結果會永久刪除；若仍在處理，工作會先中止。此動作無法復原。"
      : confirmAction.value === "correction"
        ? "會複製目前已送出的片段，建立可編輯、可重新送出的草稿；草稿期間不顯示舊分析結果。"
        : `${confirmAction.value === "next-left" ? (leftTeam.value?.name ?? "左隊") : (rightTeam.value?.name ?? "右隊")}取得本局，比分歸零並開始下一局。`,
);
const confirmLabel = computed(() =>
   confirmAction.value === "rally-delete"
      ? "永久刪除"
      : confirmAction.value === "correction"
        ? "建立修正版草稿"
        : "確認並開始",
);
const correctionSubmissionId = ref<string | null>(null);
const correctionCancelling = ref(false);
let correctionOperationGeneration = 0;
const processingRetrying = ref(false);
const deleteRallyId = ref<string | null>(null);
const rallyDeletePending = ref(false);
const placementSaving = ref(false);
const matchInspector = useTemplateRef<{ closePlacement: () => void }>(
   "matchInspector",
);
const inspectorTab = ref<"match" | "mapping" | "analysis">("match");
const analysisPanelPage = ref<"root" | "hits" | "ball" | "players">("root");
const pinnedRallyId = ref<string | null>(null);
const cursorRallyId = ref<string | null>(null);
const currentOverlayFrame = ref(-1);
const ballRelabelEnabled = ref(false);
const bboxRelabelEnabled = ref(false);
const selectedOverlayTrackId = ref<number | null>(null);
const selectedOverlayTrackAction = ref<string | null>(null);
const selectedAnalysisHitId = ref<string | null>(null);
const actorAssignmentMode = ref(false);
const overlayVideoSize = shallowRef<{ width: number; height: number } | null>(
   null,
);
const trackPopover = reactive({
   open: false,
   trackId: null as number | null,
   x: 0,
   y: 0,
});
const mappingRefreshToken = ref(0);
// An explicit click is sticky. Cursor-derived selection is only a fallback when
// the operator has not selected a segment themselves.
const selectedRallyId = computed(() =>
   resolveSegmentSelection(pinnedRallyId.value, cursorRallyId.value),
);
const processingByRally = computed<
   Record<string, AnnotationRallyProcessingUpdate>
>(() => {
   const merged: Record<string, AnnotationRallyProcessingUpdate> = {};
   for (const rally of coach.data.value?.match.rallies ?? [])
      merged[rally.id] = rally.submission.processing;
   for (const [rallyId, update] of Object.entries(
      annotation.processing.value,
   )) {
      const current = merged[rallyId];
      const currentAt = current?.updated_at
         ? Date.parse(current.updated_at)
         : 0;
      const updateAt = update.updated_at
         ? Date.parse(update.updated_at)
         : Number.MAX_SAFE_INTEGER;
      if (!current || updateAt >= currentAt) merged[rallyId] = update;
   }
   return merged;
});
const activeProcessing = computed(() => {
   const rallyId = selectedRallyId.value ?? displayAnnotation.value?.rally_id;
   return rallyId ? (processingByRally.value[rallyId] ?? null) : null;
});
const notifiedProcessingFailures = new Set<string>();
let processingFailureWatchReady = false;
let timelineRefreshTimer: ReturnType<typeof setInterval> | null = null;
let timelineMoveTimeout: ReturnType<typeof setTimeout> | null = null;
let cursorResolveTimer: ReturnType<typeof setTimeout> | null = null;
let seekPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let seekPreviewTarget: string | null = null;
let cursorResolveInFlight = false;
let pendingCursorResolve: PlaybackCursorInput | null = null;
let lastCursorResolveAt = 0;
let lastResolvedCursorKey = "";
let lastAutomaticCursorResolveKey = "";
let matchRefreshInFlight = false;
let windowRecoveryInFlight = false;
let playbackContinuationInFlight = false;
let playbackHasStarted = false;
let continuationWindowId: string | null = null;
let continuationRequestedAt = 0;
let continuationRetryDelayMs = 500;
let continuationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let windowCreatePromise: ReturnType<typeof dvr.create> | null = null;
let windowCreateTarget: string | undefined;
let windowCreateMode: "live" | "archive" | undefined;
let queuedFrameDelta = 0;
let framePreviewTargetSeconds: number | null = null;
let estimatedFrameSeconds = 1 / 60;

const controls = computed(() =>
   ANNOTATION_COMMANDS.map((command) => ({
      ...command,
      key: formatBindingForDisplay(bindings.value[command.action]),
      ...commandAvailability(command.action),
   })),
);
const commandAvailabilityMap = computed(() =>
   Object.fromEntries(
      controls.value.map((control) => [
         control.action,
         { enabled: control.enabled, reason: control.reason },
      ]),
   ),
);

const selectedCapture = computed<CaptureSession | null>(() => {
   const sessions = (match.value?.captureSessions ?? [])
      .slice()
      .sort(
         (a, b) =>
            Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "") ||
            a.id.localeCompare(b.id),
      );
   return (
      sessions.find((session) =>
         ["STARTING", "LIVE", "STOPPING"].includes(
            session.status.toUpperCase(),
         ),
      ) ??
      sessions.find((session) => session.timeline?.availableRanges.length) ??
      sessions[0] ??
      null
   );
});
const timeline = computed(() => selectedCapture.value?.timeline ?? null);
const workstation = useAnnotationWorkstationModel({
   coachData: coach.data,
   match,
   timeline,
   displayAnnotation,
   confirmedAnnotation: annotation.snapshot,
   state,
   selectedRallyId,
   selectedKeyPoint,
   selectedTimelineItem,
   cursorRallyId,
});
const {
   submittedRallies,
   annotationDrafts,
   visibleSubmittedRallies,
   selectedSubmittedRally,
   selectedRally,
   mappingAvailable,
   selectedAnalysisRunId,
   currentSet,
   leftTeamId,
   rightTeamId,
   leftSetWins,
   rightSetWins,
   leftTeam,
   rightTeam,
   clipPreRollUs,
   clipPostRollUs,
   clipPreRollSeconds,
   clipPostRollSeconds,
   rallyDisplayDuration,
   timelineSegments,
   currentMaskRange,
   selectableSegmentRanges,
   selectedCurrentMask,
   currentMaskStatus,
   currentMaskLabel,
   currentMaskOutcome,
   activeOverlayAnalysisRunId,
   activeOverlayClipStart,
   selectedEditableDraft,
   correctionActive,
   correctionRallyId,
   selectedDeletablePoint,
   activeContextTitle,
   activeContextHits,
   activeContextDuration,
   activeContextState,
   displayRallyOrdinal,
   displaySetNumber,
} = workstation;
const clipSelected = computed(() =>
   Boolean(
      selectedRallyId.value &&
      (selectedTimelineItem.value === "segment" ||
         selectedTimelineItem.value === "mask" ||
         selectedTimelineItem.value === "point"),
   ),
);
const displayedCorrectionDraft = computed(() =>
   Boolean(
      ["OPEN", "READY"].includes(state.value) &&
      displayAnnotation.value?.snapshot.active_submission_id,
   ),
);
const selectedCorrectionDraft = computed(() =>
   Boolean(
      clipSelected.value &&
      displayedCorrectionDraft.value &&
      selectedRallyId.value ===
         (correctionRallyId.value ?? displayAnnotation.value?.rally_id),
   ),
);
const editorSelectedAnalysisRunId = computed(() =>
   displayedCorrectionDraft.value ? null : selectedAnalysisRunId.value,
);
const editorOverlayAnalysisRunId = computed(
   () =>
      displayedCorrectionDraft.value
         ? null
         : (activeOverlayAnalysisRunId.value ?? selectedAnalysisRunId.value),
);
const editorOverlayClipStart = computed(
   () =>
      activeOverlayClipStart.value ??
      submittedRallies.value.find(
         (rally) => rally.id === selectedRallyId.value,
      )?.submission.clip?.start_capture_time_us ??
      null,
);
const editorMappingAvailable = computed(
   () => !displayedCorrectionDraft.value && mappingAvailable.value,
);
const overlayReplay = shallowRef<CoachRallyReplay | null>(null);
let overlayReplayGeneration = 0;
async function refreshOverlayReplay() {
   const generation = ++overlayReplayGeneration;
   const rallyId = selectedRallyId.value;
   const analysisId = editorOverlayAnalysisRunId.value;
   if (!rallyId || !analysisId) {
      overlayReplay.value = null;
      return;
   }
   try {
      const replay = await coachDomain.rallyReplay(rallyId);
      const replayAnalysisId = replay?.analysis?.id ?? null;
      if (generation === overlayReplayGeneration)
         overlayReplay.value =
            replay && replayAnalysisId === analysisId ? replay : null;
   } catch {
      if (generation === overlayReplayGeneration) overlayReplay.value = null;
   }
}
watch(
   [selectedRallyId, editorOverlayAnalysisRunId],
   () => {
      void refreshOverlayReplay();
   },
   { immediate: true },
);
const overlayEvents = computed(
   () => overlayReplay.value?.analysis?.contact_events ?? [],
);
const overlayTracks = computed(
   () =>
      overlayReplay.value?.analysis?.tracks.map((track) => ({
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
const overlayTeamLabels = computed(() => ({
   left:
      overlayReplay.value?.rally.left_team.shortName ||
      overlayReplay.value?.rally.left_team.name ||
      leftTeam.value?.shortName ||
      leftTeam.value?.name ||
      "左隊",
   right:
      overlayReplay.value?.rally.right_team.shortName ||
      overlayReplay.value?.rally.right_team.name ||
      rightTeam.value?.shortName ||
      rightTeam.value?.name ||
      "右隊",
}));
const analysisReview = useAnalysisReview(editorSelectedAnalysisRunId);
const analysisOverlayActive = computed(() =>
   Boolean(
      editorSelectedAnalysisRunId.value &&
      editorSelectedAnalysisRunId.value === editorOverlayAnalysisRunId.value &&
      currentOverlayFrame.value >= 0,
   ),
);
const currentBallOverride = computed(
   () =>
      analysisReview.ballCorrections.value.get(
         String(currentOverlayFrame.value),
      ) ?? null,
);
const currentBallPosition = computed(() =>
   currentBallOverride.value?.state === "position"
      ? currentBallOverride.value.position
      : null,
);
const allBallCorrections = computed<Record<number, OverlayBallOverride>>(() =>
   Object.fromEntries(
      [...analysisReview.ballCorrections.value].map(([frame, correction]) => [
         Number(frame),
         correction,
      ]),
   ),
);
const currentActionCorrections = computed<Record<number, string>>(() => {
   const values: Record<number, string> = {};
   const prefix = `${currentOverlayFrame.value}:`;
   for (const [key, action] of analysisReview.actionCorrections.value)
      if (key.startsWith(prefix))
         values[Number(key.slice(prefix.length))] = action;
   return values;
});
const allPlayerBBoxCorrections = computed<
   Record<number, Record<number, AnalysisFrameBBox>>
>(() => {
   const values: Record<number, Record<number, AnalysisFrameBBox>> = {};
   for (const [key, bbox] of analysisReview.playerBBoxCorrections.value) {
      const [frameText, trackText] = key.split(":");
      const frame = Number(frameText);
      const track = Number(trackText);
      values[frame] = { ...values[frame], [track]: bbox };
   }
   return values;
});
const contactActorCorrections = computed<Record<string, number | null>>(() =>
   Object.fromEntries(analysisReview.contactActorCorrections.value),
);
const selectedOverlayAction = computed(() =>
   selectedOverlayTrackId.value === null
      ? null
      : (currentActionCorrections.value[selectedOverlayTrackId.value] ??
        selectedOverlayTrackAction.value),
);
const currentActionHasOverride = computed(
   () =>
      selectedOverlayTrackId.value !== null &&
      analysisReview.actionCorrections.value.has(
         `${currentOverlayFrame.value}:${selectedOverlayTrackId.value}`,
      ),
);
const currentBBoxHasOverride = computed(
   () =>
      selectedOverlayTrackId.value !== null &&
      analysisReview.playerBBoxCorrections.value.has(
         `${currentOverlayFrame.value}:${selectedOverlayTrackId.value}`,
      ),
);
const selectedAnalysisHit = computed(
   () =>
      overlayEvents.value.find(
         (event) => event.key_point_id === selectedAnalysisHitId.value,
      ) ?? null,
);
const selectedAnalysisHitHasOverride = computed(() =>
   Boolean(
      selectedAnalysisHitId.value &&
      analysisReview.contactActorCorrections.value.has(
         selectedAnalysisHitId.value,
      ),
   ),
);
const analysisHitItems = computed(() =>
   overlayEvents.value.map((event) => {
      const frameIndex = replayEventFrame(event);
      const manual = analysisReview.contactActorCorrections.value.has(
         event.key_point_id,
      );
      const position = overlayVideoSize.value
         ? resolveEffectiveHitPosition(
              {
                 ballCorrections: allBallCorrections.value,
                 chunk: null,
                 videoWidth: overlayVideoSize.value.width,
                 videoHeight: overlayVideoSize.value.height,
              },
              event,
           )
         : null;
      const trackId = manual
         ? (analysisReview.contactActorCorrections.value.get(
              event.key_point_id,
           ) ?? null)
         : overlayVideoSize.value
           ? resolveEventActorFromResult(
                event,
                position,
                overlayVideoSize.value.width,
                overlayVideoSize.value.height,
             )
           : ((event.actors[0] ?? event.candidates[0])?.track_id ?? null);
      const exactBall = analysisReview.ballCorrections.value.get(
         String(frameIndex),
      );
      return {
         keyPointId: event.key_point_id,
         sequenceIndex: event.sequence_index,
         frameIndex,
         actorTrackId: trackId,
         actorLabel:
            trackId === null
               ? "沒人打"
               : (overlayIdentityLabels.value[trackId] ?? `Track ${trackId}`),
         actorSource: manual
            ? trackId === null
               ? ("none" as const)
               : ("manual" as const)
            : ("auto" as const),
         ballLabel:
            exactBall?.state === "position"
               ? "人工球點"
               : exactBall?.state === "missing"
                 ? position
                    ? "回溯球點"
                    : "無球點"
                 : event.ball.frame_pos
                   ? "AI 球點"
                   : position
                     ? "回溯球點"
                     : "無球點",
      };
   }),
);
const analysisToolboxMode = computed<
   "ball" | "bbox" | "actor" | "track" | null
>(() => {
   if (!analysisOverlayActive.value || inspectorTab.value !== "analysis")
      return null;
   if (analysisPanelPage.value === "hits" && selectedAnalysisHit.value)
      return "actor";
   if (analysisPanelPage.value === "ball") return "ball";
   if (analysisPanelPage.value !== "players") return null;
   return bboxRelabelEnabled.value && selectedOverlayTrackId.value !== null
      ? "bbox"
      : "track";
});
watch(editorSelectedAnalysisRunId, () => {
   analysisPanelPage.value = "root";
   ballRelabelEnabled.value = false;
   bboxRelabelEnabled.value = false;
   actorAssignmentMode.value = false;
   selectedOverlayTrackId.value = null;
   selectedAnalysisHitId.value = null;
});
watch(overlayEvents, (events) => {
   if (
      selectedAnalysisHitId.value &&
      events.some((event) => event.key_point_id === selectedAnalysisHitId.value)
   )
      return;
   selectedAnalysisHitId.value = events[0]?.key_point_id ?? null;
});
watch(inspectorTab, (tab) => {
   if (tab === "analysis") return;
   analysisPanelPage.value = "root";
   ballRelabelEnabled.value = false;
   bboxRelabelEnabled.value = false;
   actorAssignmentMode.value = false;
   if (tab !== "mapping") trackPopover.open = false;
});
watch(analysisPanelPage, (page) => {
   ballRelabelEnabled.value = page === "ball";
   actorAssignmentMode.value = page === "hits";
   bboxRelabelEnabled.value = false;
   if (page !== "players") selectedOverlayTrackId.value = null;
});
const selectedHistoricalSegmentId = computed(() =>
   selectedCurrentMask.value ? null : selectedRallyId.value,
);
const selectedCaptureId = computed(() => selectedCapture.value?.id ?? null);
const playbackMode = computed(() =>
   capturePlaybackMode({
      endedAt: selectedCapture.value?.endedAt,
      sourceKind: selectedCapture.value?.sourceKind,
      status: selectedCapture.value?.status,
   }),
);
const liveCapture = computed(() => playbackMode.value === "active_live");
const timelineEndTarget = computed(
   () =>
      timeline.value?.liveEdgeCaptureTimeUs ??
      timeline.value?.availableRanges.at(-1)?.endUs ??
      null,
);
const liveTarget = computed(() =>
   liveCapture.value ? timelineEndTarget.value : null,
);
const visualPlayhead = computed(() => {
   const cursor = observedCursor.value;
   const window = descriptor.value;
   if (
      !cursor ||
      !window ||
      cursor.playback_window_id !== window.playback_window_id ||
      cursor.mapping_version !== window.mapping_version
   )
      return authoritativeAnchor.value?.capture_time_us ?? null;
   const projected =
      BigInt(window.presentation_origin_capture_us) +
      BigInt(cursor.player_media_time_us);
   const start = BigInt(window.window_capture_start_us);
   const end = BigInt(window.window_capture_end_us);
   return (
      projected < start ? start : projected > end ? end : projected
   ).toString();
});
const navigableKeyPoints = computed(() => {
   const currentRallyId = displayAnnotation.value?.rally_id ?? null;
   const submitted = submittedRallies.value.flatMap((rally) =>
      rally.id === currentRallyId
         ? []
         : rally.submission.key_points.map((point) => ({
              id: point.id,
              captureTimeUs: point.capture_time_us,
              rallyId: rally.id,
              editable: false,
           })),
   );
   const drafts = annotationDrafts.value.flatMap((draft) =>
      draft.id === currentRallyId
         ? []
         : draft.key_points.map((point) => ({
              id: point.id,
              captureTimeUs: point.capture_time_us,
              rallyId: draft.id,
              editable: draft.annotation_status === "open",
           })),
   );
   const current = (displayAnnotation.value?.snapshot.key_points ?? []).map(
      (point) => ({
         id: point.key_point_id,
         captureTimeUs: point.capture_time_us,
         rallyId: currentRallyId,
         editable: state.value === "OPEN",
      }),
   );
   return [...submitted, ...drafts, ...current].sort((left, right) => {
      const difference =
         BigInt(left.captureTimeUs) - BigInt(right.captureTimeUs);
      return difference < 0n
         ? -1
         : difference > 0n
           ? 1
           : left.id.localeCompare(right.id);
   });
});
const selectedEditableKeyPoint = computed(() =>
   Boolean(
      selectedTimelineItem.value === "point" &&
      selectedKeyPoint.value &&
      state.value === "OPEN",
   ),
);
const defaultPlaybackTarget = computed(() => {
   if (liveCapture.value) return timelineEndTarget.value;

   const earliestKeyPoint = navigableKeyPoints.value[0]?.captureTimeUs;
   if (earliestKeyPoint) return earliestKeyPoint;

   return timeline.value?.availableRanges[0]?.startUs ?? null;
});
const syncLabel = computed(() =>
   annotation.error.value || annotation.outboxNeedsConfirmation.value
      ? "WS 需注意"
      : annotation.pendingCount.value || annotation.busy.value
        ? "WS 同步中"
        : annotation.connection.value === "ready"
          ? "WS 正常"
          : "WS 離線",
);
const displayTimecode = computed(() =>
   formatTimelinePosition(
      visualPlayhead.value,
      timeline.value?.captureStartTimeUs,
   ),
);
const mediaEmptyLabel = computed(() => {
   if (!selectedCapture.value) return "尚未加入媒體";
   if (playbackMode.value === "failed") return "影音來源無法使用";
   if (playbackMode.value === "starting") return "正在連接影音來源";
   if (playbackMode.value === "progressive_vod") return "影片載入中";
   return "媒體緩衝中";
});
function openSettings(page: "root" | "media" | "clip" | "hotkeys" = "root") {
   settingsInitialPage.value = page;
   settingsOpen.value = true;
}

function previewKeyPointMove(keyPointId: string, captureTimeUs: string) {
   optimisticKeyPointMoves.value = {
      ...optimisticKeyPointMoves.value,
      [keyPointId]: captureTimeUs,
   };
}

function clearKeyPointMovePreview(keyPointId: string) {
   const next = { ...optimisticKeyPointMoves.value };
   delete next[keyPointId];
   optimisticKeyPointMoves.value = next;
}

function movedPointWouldOverlap(
   keyPointId: string,
   targetCaptureTimeUs: string,
) {
   const snapshot = annotation.snapshot.value;
   if (!snapshot) return true;
   const range = paddedClipRange(
      snapshot.snapshot.key_points.map((point) =>
         point.key_point_id === keyPointId
            ? targetCaptureTimeUs
            : point.capture_time_us,
      ),
      clipPreRollUs.value,
      clipPostRollUs.value,
   );
   return (
      !range ||
      clipRangeOverlaps(range, selectableSegmentRanges.value, snapshot.rally_id)
   );
}

function commandAvailability(action: AnnotationAction) {
   if (!commandReady.value) return { enabled: false, reason: "標記同步中" };
   if (action === "submit")
      return state.value === "READY" ||
         (state.value === "OPEN" && correctionActive.value)
         ? { enabled: true, reason: "" }
         : { enabled: false, reason: "片段尚未完成" };
   if (action === "service") {
      const cursor = visualPlayhead.value;
      if (!cursor || !canMark.value)
         return { enabled: false, reason: "播放游標尚未確認" };
      const cursorValue = BigInt(cursor);
      if (
         openDraftBlocksNewRally(
            state.value,
            displayAnnotation.value?.snapshot.active_submission_id,
         )
      )
         return { enabled: false, reason: "目前仍有正在編輯的片段" };
      const start =
         cursorValue > clipPreRollUs.value
            ? cursorValue - clipPreRollUs.value
            : 0n;
      const end = cursorValue + clipPostRollUs.value;
      const overlap = selectableSegmentRanges.value.some(
         (range) =>
            start < BigInt(range.endCaptureTimeUs) &&
            end > BigInt(range.startCaptureTimeUs),
      );
      return overlap
         ? { enabled: false, reason: "片段延展範圍會與既有片段重疊" }
         : { enabled: true, reason: "" };
   }
   const service = displayAnnotation.value?.snapshot.key_points.find(
      (point) => point.marker_kind === "service",
   );
   return draftCommandAvailability({
      action,
      state: state.value,
      canMark: canMark.value,
      cursorCaptureTimeUs: visualPlayhead.value,
      serviceCaptureTimeUs: service?.capture_time_us ?? null,
      confirmedLastKeyPointId:
         annotation.lastKeyPoint.value?.key_point_id ?? null,
   });
}

function formatDuration(value?: string | null) {
   if (!value) return "—";
   const seconds = Number(BigInt(value)) / 1_000_000;
   return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} 秒`;
}

async function loadMatch(options: { silent?: boolean } = {}) {
   if (matchRefreshInFlight) return;
   matchRefreshInFlight = true;
   try {
      const nextMatch = await core.match(matchId);
      if (!nextMatch) {
         if (!options.silent)
            loadError.value = "找不到此場次，請返回賽事列表。";
         return;
      }
      match.value = nextMatch;
      loadError.value = null;
   } catch (error) {
      if (!options.silent)
         loadError.value =
            error instanceof Error ? error.message : "場次資料載入失敗";
   } finally {
      matchRefreshInFlight = false;
   }
}

async function refreshSelectedCapture() {
   const captureId = selectedCaptureId.value;
   if (!captureId || document.visibilityState !== "visible") return;
   try {
      const capture = await core.captureSession(captureId);
      if (!capture || !match.value?.captureSessions) return;
      match.value = {
         ...match.value,
         captureSessions: match.value.captureSessions.map((current) =>
            current.id === capture.id ? capture : current,
         ),
      };
   } catch {
      /* The existing descriptor remains usable; retry on the next media tick. */
   }
}

async function updateClipPolicy(
   preRollSeconds: number,
   postRollSeconds: number,
) {
   clipPolicySaving.value = true;
   clipPolicyError.value = null;
   try {
      match.value = await core.updateMatchClipPolicy({
         matchId,
         preRollSeconds,
         postRollSeconds,
      });
      await coach.refresh();
      toast.success("片段範圍已更新");
   } catch (error) {
      clipPolicyError.value =
         error instanceof Error ? error.message : "片段範圍儲存失敗";
   } finally {
      clipPolicySaving.value = false;
   }
}

async function resolveLatestCursor() {
   cursorResolveTimer = null;
   if (cursorResolveInFlight || !pendingCursorResolve) return;
   const cursor = pendingCursorResolve;
   pendingCursorResolve = null;
   cursorResolveInFlight = true;
   lastCursorResolveAt = performance.now();
   try {
      const resolved = await dvr.resolve(cursor);
      if (resolved)
         lastResolvedCursorKey = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}:${cursor.player_media_time_us}`;
      const timelineMove = pendingTimelineMove.value;
      if (
         resolved &&
         timelineMove &&
         timelineMove.playbackWindowId === cursor.playback_window_id
      ) {
         pendingTimelineMove.value = null;
         if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout);
         timelineMoveTimeout = null;
         try {
            if (
               state.value === "OPEN" &&
               selectedKeyPointId.value === timelineMove.keyPointId &&
               editReady.value
            ) {
               await annotation.edit("MOVE_KEY_POINT", {
                  keyPointId: timelineMove.keyPointId,
                  cursor,
               });
            }
         } finally {
            clearKeyPointMovePreview(timelineMove.keyPointId);
            releaseEditingIntent();
         }
         return;
      }
   } catch (error) {
      mediaError.value =
         error instanceof Error ? error.message : "游標解析失敗";
   } finally {
      cursorResolveInFlight = false;
      scheduleCursorResolve();
   }
}

function scheduleCursorResolve(force = false) {
   if (!pendingCursorResolve || cursorResolveInFlight || cursorResolveTimer)
      return;
   if (!force && !pendingTimelineMove.value) return;
   const interval = 0;
   const delay = Math.max(
      0,
      interval - (performance.now() - lastCursorResolveAt),
   );
   cursorResolveTimer = setTimeout(resolveLatestCursor, delay);
}

function handleCursor(cursor: PlaybackCursorInput) {
   const previousSeekGeneration = observedCursor.value?.seek_generation;
   observedCursor.value = cursor;
   cursorStatus.value = cursor.cursor_status;
   // Frame stepping owns the player position until its authoritative queue has
   // drained. Browser seek callbacks are observations of the optimistic preview,
   // not new commands that should race the canonical sample-index resolver.
   if (seekPreviewActive.value || frameQueueRunning.value) return;
   if (cursor.cursor_status !== "ready") {
      pendingCursorResolve = null;
      return;
   }
   const key = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}:${cursor.player_media_time_us}`;
   if (key === lastResolvedCursorKey) return;
   const automaticKey = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}`;
   if (
      !pendingTimelineMove.value &&
      automaticKey === lastAutomaticCursorResolveKey
   )
      return;
   const anchorNeedsRefresh =
      authoritativeAnchor.value?.playback_window_id !==
         cursor.playback_window_id ||
      authoritativeAnchor.value.mapping_version !== cursor.mapping_version;
   const shouldResolve =
      anchorNeedsRefresh ||
      cursor.seek_generation !== previousSeekGeneration ||
      Boolean(pendingTimelineMove.value);
   if (!shouldResolve) return;
   if (!pendingTimelineMove.value) lastAutomaticCursorResolveKey = automaticKey;
   pendingCursorResolve = cursor;
   scheduleCursorResolve(true);
}

async function createWindow(
   target = captureTarget.value || undefined,
   requestedMode?: "live" | "archive",
) {
   const mode =
      requestedMode ?? (target === liveTarget.value ? "live" : "archive");
   if (
      windowCreatePromise &&
      target === windowCreateTarget &&
      mode === windowCreateMode
   )
      return windowCreatePromise;
   mediaError.value = null;
   const request = (async () => {
      try {
         const session = selectedCapture.value;
         if (!session || !target)
            throw new Error("目前沒有可播放的 capture range");
         captureTarget.value = target;
         return await dvr.create({
            schema_version: "1.0.0",
            capture_session_id: session.id,
            mode,
            target_capture_time_us: target,
            requested_back_us: mediaBufferProfile.value.requestedBackUs,
            requested_forward_us: mediaBufferProfile.value.requestedForwardUs,
         });
      } catch (error) {
         mediaError.value =
            error instanceof Error ? error.message : "播放視窗建立失敗";
         return null;
      } finally {
         mediaError.value =
            dvr.error.value instanceof Error
               ? dvr.error.value.message
               : mediaError.value;
      }
   })();
   windowCreatePromise = request;
   windowCreateTarget = target;
   windowCreateMode = mode;
   try {
      return await request;
   } finally {
      if (windowCreatePromise === request) {
         windowCreatePromise = null;
         windowCreateTarget = undefined;
         windowCreateMode = undefined;
      }
   }
}

async function seekTimeline(targetCaptureTimeUs: string) {
   seekPreviewActive.value = false;
   seekPreviewTarget = null;
   if (seekPreviewTimer) clearTimeout(seekPreviewTimer);
   seekPreviewTimer = null;
   captureTarget.value = targetCaptureTimeUs;
   if (overlayPlayer.value?.seekCaptureTimeIfBuffered(targetCaptureTimeUs))
      return;
   await createWindow(targetCaptureTimeUs);
}

function previewTimelineSeek(targetCaptureTimeUs: string | null) {
   seekPreviewActive.value = Boolean(targetCaptureTimeUs);
   seekPreviewTarget = targetCaptureTimeUs;
   if (seekPreviewTimer) clearTimeout(seekPreviewTimer);
   seekPreviewTimer = null;
   if (
      !targetCaptureTimeUs ||
      overlayPlayer.value?.previewCaptureTimeIfBuffered(targetCaptureTimeUs)
   )
      return;
   seekPreviewTimer = setTimeout(() => {
      seekPreviewTimer = null;
      const target = seekPreviewTarget;
      if (!target || !seekPreviewActive.value) return;
      void createWindow(target);
   }, 140);
}

function dispatchAnnotationAction(action: AnnotationAction) {
   const control = controls.value.find((item) => item.action === action);
   if (!control?.enabled) return;
   const captureTimeUs = visualPlayhead.value;
   try {
      annotation.dispatch(
         action,
         observedCursor.value,
         captureTimeUs
            ? {
                 capture_time_us: captureTimeUs,
                 capture_frame_index:
                    authoritativeAnchor.value?.capture_frame_index ?? null,
              }
            : undefined,
      );
   } catch {
      /* the composable exposes the actionable error state */
   }
}

function editKeyPoint(kind: "MOVE_KEY_POINT" | "DELETE_KEY_POINT") {
   if (!selectedKeyPointId.value || state.value !== "OPEN" || !editReady.value)
      return;
   if (kind === "MOVE_KEY_POINT" && !canMark.value) return;
   if (kind === "MOVE_KEY_POINT")
      annotation.setEditingKeyPoint(selectedKeyPointId.value);
   void annotation
      .edit(kind, {
         keyPointId: selectedKeyPointId.value,
         cursor: observedCursor.value,
      })
      .then(() => {
         if (kind === "DELETE_KEY_POINT")
            selectedKeyPointId.value =
               annotation.lastKeyPoint.value?.key_point_id ?? null;
      })
      .catch(() => undefined)
      .finally(() => {
         if (kind === "MOVE_KEY_POINT") releaseEditingIntent();
      });
}

function selectTimelineKeyPoint(keyPointId: string) {
   pinnedRallyId.value = displayAnnotation.value?.rally_id ?? null;
   selectedKeyPointId.value = keyPointId;
   selectedTimelineItem.value = "point";
}

function selectTimelineMask() {
   pinnedRallyId.value = displayAnnotation.value?.rally_id ?? null;
   selectedTimelineItem.value = "mask";
   selectedKeyPointId.value = null;
}

function clearTimelineSelection() {
   pinnedRallyId.value = null;
   selectedTimelineItem.value = cursorRallyId.value ? "segment" : null;
   selectedKeyPointId.value = null;
}

async function selectHistoricalSegment(
   segmentId: string,
   targetCaptureTimeUs: string,
) {
   const draft = annotationDrafts.value.find(
      (candidate) => candidate.id === segmentId,
   );
   if (draft) {
      await annotation.selectRally(draft.id);
      pinnedRallyId.value = draft.id;
      selectedTimelineItem.value = "mask";
      selectedKeyPointId.value = null;
      if (targetCaptureTimeUs !== "0") await seekTimeline(targetCaptureTimeUs);
      return;
   }
   pinnedRallyId.value = segmentId;
   selectedTimelineItem.value = "segment";
   selectedKeyPointId.value = null;
}

function selectTimelineAnalysis(segmentId: string) {
   pinnedRallyId.value = segmentId;
   selectedTimelineItem.value = "segment";
   selectedKeyPointId.value = null;
   inspectorTab.value = "analysis";
}

function selectRally(rally: CoachRally) {
   pinnedRallyId.value = rally.id;
   selectedTimelineItem.value = "segment";
   selectedKeyPointId.value = null;
   if (rally.submission.clip)
      void seekTimeline(rally.submission.clip.start_capture_time_us);
}

function releaseEditingIntent() {
   annotation.setEditingKeyPoint(null);
}

function beginTimelineKeyPointEdit(keyPointId: string) {
   if (state.value !== "OPEN" || !editReady.value) return;
   selectTimelineKeyPoint(keyPointId);
   annotation.setEditingKeyPoint(keyPointId);
}

function cancelTimelineKeyPointEdit(keyPointId: string) {
   if (pendingTimelineMove.value?.keyPointId === keyPointId) return;
   releaseEditingIntent();
}

async function moveTimelineKeyPoint(
   keyPointId: string,
   targetCaptureTimeUs: string,
) {
   if (state.value !== "OPEN" || !editReady.value || !selectedCapture.value) {
      releaseEditingIntent();
      return;
   }
   if (movedPointWouldOverlap(keyPointId, targetCaptureTimeUs)) {
      toast.error("移動後的片段範圍會與其他片段重疊");
      releaseEditingIntent();
      return;
   }
   previewKeyPointMove(keyPointId, targetCaptureTimeUs);
   selectedKeyPointId.value = keyPointId;
   annotation.setEditingKeyPoint(keyPointId);
   pendingTimelineMove.value = { keyPointId, playbackWindowId: null };
   try {
      if (
         descriptor.value &&
         overlayPlayer.value?.seekCaptureTimeIfBuffered(targetCaptureTimeUs)
      ) {
         pendingTimelineMove.value = {
            keyPointId,
            playbackWindowId: descriptor.value.playback_window_id,
         };
         timelineMoveTimeout = setTimeout(() => {
            if (pendingTimelineMove.value?.keyPointId !== keyPointId) return;
            pendingTimelineMove.value = null;
            timelineMoveTimeout = null;
            clearKeyPointMovePreview(keyPointId);
            toast.error("無法解析拖曳位置，擊球點未變更");
            releaseEditingIntent();
         }, 8_000);
         return;
      }
      const created = await dvr.create({
         schema_version: "1.0.0",
         capture_session_id: selectedCapture.value.id,
         mode: "archive",
         target_capture_time_us: targetCaptureTimeUs,
      });
      if (!created || pendingTimelineMove.value?.keyPointId !== keyPointId)
         throw new Error("拖曳播放視窗已被較新的操作取代");
      pendingTimelineMove.value = {
         keyPointId,
         playbackWindowId: created.playback_window_id,
      };
      timelineMoveTimeout = setTimeout(() => {
         if (pendingTimelineMove.value?.keyPointId !== keyPointId) return;
         pendingTimelineMove.value = null;
         timelineMoveTimeout = null;
         clearKeyPointMovePreview(keyPointId);
         toast.error("無法解析拖曳位置，擊球點未變更");
         releaseEditingIntent();
      }, 8_000);
   } catch (error) {
      pendingTimelineMove.value = null;
      if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout);
      timelineMoveTimeout = null;
      clearKeyPointMovePreview(keyPointId);
      toast.error(error instanceof Error ? error.message : "拖曳擊球點失敗");
      releaseEditingIntent();
   }
}

async function nudgeSelectedKeyPoint(
   direction: "previous" | "next",
   count = 1,
) {
   const point = selectedKeyPoint.value;
   const capture = selectedCapture.value;
   if (!point || !capture || state.value !== "OPEN" || !editReady.value) return;
   annotation.setEditingKeyPoint(point.key_point_id);
   try {
      let window = descriptor.value;
      if (
         !window ||
         BigInt(point.capture_time_us) <
            BigInt(window.window_capture_start_us) ||
         BigInt(point.capture_time_us) >= BigInt(window.window_capture_end_us)
      ) {
         window = await dvr.create({
            schema_version: "1.0.0",
            capture_session_id: capture.id,
            mode: "archive",
            target_capture_time_us: point.capture_time_us,
         });
      }
      if (!window) throw new Error("無法建立擊球點微調視窗");
      let playbackWindowId = window.playback_window_id;
      let mappingVersion = window.mapping_version;
      let captureFrameIndex = point.capture_frame_index;
      let frame: Awaited<ReturnType<typeof media.frameStep>> | null = null;
      for (let index = 0; index < Math.max(1, count); index += 1) {
         frame = await media.frameStep({
            schema_version: "1.0.0",
            capture_session_id: capture.id,
            playback_window_id: playbackWindowId,
            mapping_version: mappingVersion,
            capture_frame_index: captureFrameIndex,
            direction,
         });
         playbackWindowId = frame.playback_window_id;
         mappingVersion = frame.mapping_version;
         captureFrameIndex = frame.capture_frame_index;
      }
      if (!frame) throw new Error("伺服器沒有回傳可用畫格");
      const cursor: PlaybackCursorInput = {
         schema_version: "1.0.0",
         playback_window_id: frame.playback_window_id,
         mapping_version: frame.mapping_version,
         player_media_time_us: frame.player_media_time_us,
         observation_source: "current_time_fallback",
         presented_frames: null,
         seek_generation: (observedCursor.value?.seek_generation ?? 0) + 1,
         cursor_status: "ready",
      };
      observedCursor.value = cursor;
      cursorStatus.value = "ready";
      const resolved = await dvr.resolve(cursor);
      if (!resolved) throw new Error("伺服器無法解析微調畫格");
      if (movedPointWouldOverlap(point.key_point_id, resolved.capture_time_us))
         throw new Error("移動後的片段範圍會與其他片段重疊");
      previewKeyPointMove(point.key_point_id, frame.capture_time_us);
      if (video.value) seekVideoToCanonicalFrame(video.value, frame);
      await annotation.edit("MOVE_KEY_POINT", {
         keyPointId: point.key_point_id,
         cursor,
      });
   } catch (error) {
      toast.error(error instanceof Error ? error.message : "擊球點微調失敗");
   } finally {
      clearKeyPointMovePreview(point.key_point_id);
      releaseEditingIntent();
   }
}

function deleteSelectedKeyPoint() {
   if (selectedDeletablePoint.value) editKeyPoint("DELETE_KEY_POINT");
}

function deleteSelectedClip() {
   if (!clipSelected.value || !selectedRallyId.value) return;
   deleteRallyId.value = selectedRallyId.value;
   confirmAction.value = "rally-delete";
}

function startCorrection() {
   const submissionId = selectedSubmittedRally.value?.submission.id;
   if (!submissionId || !editReady.value) return;
   correctionSubmissionId.value = submissionId;
   confirmAction.value = "correction";
}

async function cancelCorrection() {
   if (!correctionActive.value || correctionCancelling.value) return;
   const rallyId = correctionRallyId.value ?? displayAnnotation.value?.rally_id;
   if (!rallyId) return;
   correctionOperationGeneration++;
   correctionCancelling.value = true;
   try {
      const restored = await annotation.cancelCorrection(rallyId);
      pinnedRallyId.value = restored ? rallyId : null;
      selectedTimelineItem.value = restored ? "segment" : null;
      selectedKeyPointId.value = null;
      await coach.refresh();
      toast.success(
         restored
            ? "已取消修正，原送出版本維持有效"
            : "草稿已不存在，已清除本機殘留",
      );
   } catch (error) {
      toast.error(
         error instanceof Error ? error.message : "無法取消修正版草稿，請重試",
      );
   } finally {
      correctionCancelling.value = false;
   }
}

function resetTimelineZoom() {
   timelineDock.value?.resetView();
}

function requestNextSet(side: "left" | "right") {
   if (!currentSet.value || !editReady.value) return;
   confirmAction.value = side === "left" ? "next-left" : "next-right";
}

async function updateRallyPlacement(input: {
   rallyId: string;
   setNumber: number;
   ordinal: number;
}) {
   if (placementSaving.value) return;
   placementSaving.value = true;
   try {
      await coachDomain.updateRallyPlacement(input);
      await coach.refresh();
      matchInspector.value?.closePlacement();
      toast.success(`已調整為第 ${input.setNumber} 局 · 回合 ${input.ordinal}`);
   } catch (error) {
      toast.error(error instanceof Error ? error.message : "無法調整局與回合");
   } finally {
      placementSaving.value = false;
   }
}

function closeConfirmAction() {
   confirmAction.value = null;
   correctionSubmissionId.value = null;
   deleteRallyId.value = null;
}

function clearDeletedRallySelection(rallyId: string) {
   annotation.forgetRally(rallyId);
   if (pinnedRallyId.value === rallyId) pinnedRallyId.value = null;
   selectedTimelineItem.value = null;
   selectedKeyPointId.value = null;
}

async function purgeRally(rallyId: string) {
   if (rallyDeletePending.value) return;
   rallyDeletePending.value = true;
   try {
      const receipt = await coachDomain.deleteRally(rallyId);
      clearDeletedRallySelection(rallyId);
      await Promise.all([loadMatch({ silent: true }), coach.refresh()]);
      toast.success(
         receipt.abortedJobCount > 0
            ? "片段已刪除，處理工作已中止"
            : "片段與分析資料已刪除",
      );
      for (const warning of receipt.cleanupWarnings) toast.warning(warning);
   } catch (error) {
      await Promise.all([loadMatch({ silent: true }), coach.refresh()]);
      if (error instanceof GraphQLRequestError && error.code === "NOT_FOUND") {
         clearDeletedRallySelection(rallyId);
         toast.success("片段已刪除，已清除本機殘留");
      } else {
         toast.error(error instanceof Error ? error.message : "無法刪除片段");
      }
   } finally {
      rallyDeletePending.value = false;
   }
}

function confirmPendingAction() {
   const action = confirmAction.value;
   const submissionId = correctionSubmissionId.value;
   const targetRallyId = deleteRallyId.value;
   confirmAction.value = null;
   correctionSubmissionId.value = null;
   deleteRallyId.value = null;
   if (action === "rally-delete" && targetRallyId) {
      void purgeRally(targetRallyId);
      return;
   }
   if (action === "next-left" || action === "next-right") {
      const winningTeamId =
         action === "next-left" ? leftTeamId.value : rightTeamId.value;
      if (!winningTeamId) return;
      void core
         .startNextSet({ matchId, winningTeamId })
         .then(async () => {
            await Promise.all([loadMatch({ silent: true }), coach.refresh()]);
            toast.success("新一局已開始");
         })
         .catch((error) =>
            toast.error(
               error instanceof Error ? error.message : "無法開始新一局",
            ),
         );
      return;
   }
   if (!submissionId) return;
   const correctionOperation = ++correctionOperationGeneration;
   void annotation
      .createCorrection(submissionId)
      .then(async () => {
         if (correctionOperation !== correctionOperationGeneration) return;
         if (state.value !== "OPEN") {
            const reopenError =
               annotation.error.value || "修正版草稿無法進入編輯狀態";
            await annotation.cancelCorrection().catch(() => undefined);
            await coach.refresh();
            throw new Error(reopenError);
         }
         pinnedRallyId.value = displayAnnotation.value?.rally_id ?? null;
         selectedTimelineItem.value = "mask";
         selectedKeyPointId.value =
            annotation.lastKeyPoint.value?.key_point_id ?? null;
         await coach.refresh();
         if (correctionOperation !== correctionOperationGeneration) return;
         toast.success("修正版草稿已建立，可直接送出或開始編輯");
      })
      .catch((error) => {
         if (correctionOperation === correctionOperationGeneration)
            toast.error(
               error instanceof Error ? error.message : "無法建立修正版草稿",
            );
      });
}

type PlayerAction = MediaAction | "mute";
function updatePlaybackState() {
   playing.value = Boolean(video.value && !video.value.paused);
   if (playing.value) playbackHasStarted = true;
   muted.value = Boolean(video.value?.muted);
   if (playing.value) maintainPlaybackWindow();
}
function detachVideoState(element: HTMLVideoElement | null) {
   element?.removeEventListener("play", updatePlaybackState);
   element?.removeEventListener("pause", updatePlaybackState);
   element?.removeEventListener("volumechange", updatePlaybackState);
   element?.removeEventListener("timeupdate", maintainPlaybackWindow);
   element?.removeEventListener("progress", maintainPlaybackWindow);
   element?.removeEventListener("waiting", maintainPlaybackWindow);
   element?.removeEventListener("ended", maintainPlaybackWindow);
}
function schedulePlaybackContinuation(delayMs = continuationRetryDelayMs) {
   if (continuationRetryTimer || !playbackHasStarted) return;
   continuationRetryTimer = setTimeout(() => {
      continuationRetryTimer = null;
      maintainPlaybackWindow();
   }, delayMs);
}
function retryableContinuationError(error: unknown) {
   const code =
      error && typeof error === "object" && "code" in error
         ? String(error.code)
         : "";
   return [
      "MEDIA_NOT_READY",
      "PLAYBACK_CONTINUATION_NO_PROGRESS",
      "PLAYBACK_WINDOW_NOT_FOUND",
      "WINDOW_EXPIRED",
      "MAPPING_STALE",
   ].includes(code);
}
function maintainPlaybackWindow() {
   const element = video.value;
   const window = descriptor.value;
   if (
      !element ||
      !window ||
      seekPreviewActive.value ||
      playbackContinuationInFlight
   )
      return;
   const leaseRenewalDue = Date.parse(window.expires_at) <= Date.now() + 60_000;
   if (!playbackHasStarted && !leaseRenewalDue) return;
   const observedCapture =
      BigInt(window.presentation_origin_capture_us) +
      BigInt(Math.max(0, Math.round(element.currentTime * 1_000_000)));
   const windowEnd = BigInt(window.window_capture_end_us);
   const target = (
      observedCapture > windowEnd ? windowEnd : observedCapture
   ).toString();
   const decision = leaseRenewalDue
      ? "extend-window"
      : decidePlaybackContinuation({
           availabilityComplete:
              Boolean(timeline.value?.availabilityComplete) ||
              ["complete_vod", "ended_live", "failed"].includes(
                 playbackMode.value,
              ),
           browserBufferedSeconds: bufferedSecondsAhead(element),
           currentCaptureTimeUs: target,
           ended: element.ended,
           paused: element.paused,
           playbackHasStarted,
           refreshLeadSeconds: mediaBufferProfile.value.refreshLeadSeconds,
           seekPreviewActive: seekPreviewActive.value,
           windowEndCaptureTimeUs: window.window_capture_end_us,
        });
   if (decision === "idle" || decision === "terminal") return;
   if (performance.now() - continuationRequestedAt < 500) {
      schedulePlaybackContinuation(500);
      return;
   }
   continuationRequestedAt = performance.now();
   if (decision === "recover-buffer") {
      overlayPlayer.value?.recoverPlayback();
      schedulePlaybackContinuation(650);
      return;
   }
   if (continuationWindowId === window.playback_window_id) return;

   const sourceWindowId = window.playback_window_id;
   playbackContinuationInFlight = true;
   continuationWindowId = sourceWindowId;
   void media
      .extendPlaybackWindow(sourceWindowId, {
         schema_version: "1.0.0",
         target_capture_time_us: target,
         requested_forward_us: mediaBufferProfile.value.requestedForwardUs,
      })
      .then(async (created) => {
         if (descriptor.value?.playback_window_id !== sourceWindowId) return;
         if (
            created.mapping_version !== window.mapping_version ||
            created.window_capture_end_us !== window.window_capture_end_us ||
            created.window_capture_start_us !==
               window.window_capture_start_us ||
            created.expires_at !== window.expires_at
         ) {
            continuationRetryDelayMs = 500;
            dvr.refresh(created);
         } else {
            continuationRetryDelayMs = Math.min(
               4_000,
               Math.round(continuationRetryDelayMs * 1.6),
            );
         }
      })
      .catch((error) => {
         const code =
            error && typeof error === "object" && "code" in error
               ? String(error.code)
               : "";
         if (["PLAYBACK_WINDOW_NOT_FOUND", "WINDOW_EXPIRED"].includes(code)) {
            dvr.clear();
            void createWindow(target, liveCapture.value ? "live" : "archive");
            return;
         }
         if (!retryableContinuationError(error)) {
            mediaError.value =
               error instanceof Error ? error.message : "背景載入播放視窗失敗";
         }
         continuationRetryDelayMs = Math.min(
            4_000,
            Math.round(continuationRetryDelayMs * 1.6),
         );
      })
      .finally(() => {
         continuationWindowId = null;
         playbackContinuationInFlight = false;
         if (
            !timeline.value?.availabilityComplete &&
            !["complete_vod", "ended_live", "failed"].includes(
               playbackMode.value,
            ) &&
            playbackHasStarted
         ) {
            schedulePlaybackContinuation();
         }
      });
}
function handleVideoReady(element: HTMLVideoElement) {
   if (video.value !== element) {
      detachVideoState(video.value);
      video.value = element;
      element.addEventListener("play", updatePlaybackState);
      element.addEventListener("pause", updatePlaybackState);
      element.addEventListener("volumechange", updatePlaybackState);
      element.addEventListener("timeupdate", maintainPlaybackWindow);
      element.addEventListener("progress", maintainPlaybackWindow);
      element.addEventListener("waiting", maintainPlaybackWindow);
      element.addEventListener("ended", maintainPlaybackWindow);
   }
   updatePlaybackState();
}
function handleBufferState(value: {
   buffered: CanonicalMediaRange[];
   mappingVersion: number | null;
   playbackWindowId: string | null;
}) {
   const window = descriptor.value;
   playerBufferedRanges.value =
      window &&
      value.playbackWindowId === window.playback_window_id &&
      value.mappingVersion === window.mapping_version
         ? value.buffered
         : [];
}
function dispatchMediaAction(action: PlayerAction, frameCount = 1) {
   const element = video.value;
   if (!element) return;
   if (action === "play_pause") {
      if (element.paused)
         void element.play().catch((error) => {
            mediaError.value =
               error instanceof Error ? error.message : "播放器無法開始播放";
         });
      else element.pause();
   }
   if (action === "mute") element.muted = !element.muted;
   if (action === "frame_previous" || action === "frame_next")
      queueFrameStep(action === "frame_next" ? "next" : "previous", frameCount);
   if (action === "key_point_previous" || action === "key_point_next")
      navigateKeyPoint(action === "key_point_next" ? "next" : "previous");
}

function queueFrameStep(direction: "previous" | "next", count = 1) {
   const delta = direction === "next" ? count : -count;
   queuedFrameDelta = Math.max(-60, Math.min(60, queuedFrameDelta + delta));
   previewFrameStep(delta);
   if (!frameQueueRunning.value) void drainFrameQueue();
}

function previewFrameStep(delta: number) {
   const element = video.value;
   const window = descriptor.value;
   if (!element || !window) return;
   if (!element.paused) element.pause();
   const windowDuration =
      Number(
         BigInt(window.window_capture_end_us) -
            BigInt(window.presentation_origin_capture_us),
      ) / 1_000_000;
   const mediaEnd = Number.isFinite(element.duration)
      ? Math.min(element.duration, windowDuration)
      : windowDuration;
   const base = framePreviewTargetSeconds ?? element.currentTime;
   framePreviewTargetSeconds = Math.max(
      0,
      Math.min(mediaEnd, base + delta * estimatedFrameSeconds),
   );
   element.currentTime = framePreviewTargetSeconds;
}

async function drainFrameQueue() {
   if (!descriptor.value || frameQueueRunning.value) return;
   frameQueueRunning.value = true;
   let finalStepAnchor: Awaited<ReturnType<typeof dvr.step>> = null;
   try {
      if (observedCursor.value?.cursor_status === "ready") {
         const observedKey = `${observedCursor.value.playback_window_id}:${observedCursor.value.mapping_version}:${observedCursor.value.seek_generation}:${observedCursor.value.player_media_time_us}`;
         if (observedKey !== lastResolvedCursorKey) {
            const resolved = await dvr.resolve(observedCursor.value);
            if (resolved) lastResolvedCursorKey = observedKey;
         }
      }
      while (
         queuedFrameDelta !== 0 &&
         descriptor.value &&
         authoritativeAnchor.value
      ) {
         const direction = queuedFrameDelta > 0 ? "next" : "previous";
         queuedFrameDelta += direction === "next" ? -1 : 1;
         const previousCaptureUs = BigInt(
            authoritativeAnchor.value.capture_time_us,
         );
         const anchor = await dvr.step(direction, (target) => ({
            schema_version: "1.0.0",
            capture_session_id: descriptor.value!.capture_session_id,
            mode: descriptor.value!.mode,
            target_capture_time_us: target,
         }));
         if (!anchor) {
            queuedFrameDelta = 0;
            break;
         }
         finalStepAnchor = anchor;
         const localUs = BigInt(anchor.player_media_time_us);
         if (localUs < 0n || localUs > 86_400_000_000n)
            throw new RangeError(
               "frame-step returned an unbounded player time",
            );
         const anchorCaptureUs = BigInt(anchor.capture_time_us);
         const measuredFrameUs =
            anchorCaptureUs >= previousCaptureUs
               ? anchorCaptureUs - previousCaptureUs
               : previousCaptureUs - anchorCaptureUs;
         if (measuredFrameUs > 0n && measuredFrameUs <= 200_000n)
            estimatedFrameSeconds = Number(measuredFrameUs) / 1_000_000;
      }
      if (video.value && finalStepAnchor)
         seekVideoToCanonicalFrame(video.value, finalStepAnchor);
   } catch (error) {
      queuedFrameDelta = 0;
      mediaError.value =
         error instanceof Error ? error.message : "逐幀請求失敗";
   } finally {
      framePreviewTargetSeconds = null;
      frameQueueRunning.value = false;
      if (queuedFrameDelta !== 0) queueMicrotask(() => void drainFrameQueue());
   }
}

function navigateKeyPoint(direction: "previous" | "next") {
   const points = navigableKeyPoints.value;
   if (!points.length) return;
   const selectedIndex = selectedKeyPointId.value
      ? points.findIndex((point) => point.id === selectedKeyPointId.value)
      : -1;
   const reference =
      selectedKeyPoint.value?.capture_time_us ?? visualPlayhead.value;
   const target =
      selectedIndex >= 0
         ? points[selectedIndex + (direction === "next" ? 1 : -1)]
         : direction === "next"
           ? points.find(
                (point) =>
                   !reference ||
                   BigInt(point.captureTimeUs) > BigInt(reference),
             )
           : points.findLast(
                (point) =>
                   !reference ||
                   BigInt(point.captureTimeUs) < BigInt(reference),
             );
   if (!target) {
      toast.info(
         direction === "next" ? "已到最後一個擊球點" : "已到第一個擊球點",
      );
      return;
   }
   if (target.rallyId === displayAnnotation.value?.rally_id) {
      selectedKeyPointId.value = target.id;
      selectedTimelineItem.value = "point";
   } else if (
      target.rallyId &&
      annotationDrafts.value.some((draft) => draft.id === target.rallyId)
   ) {
      void selectHistoricalSegment(target.rallyId, target.captureTimeUs);
      return;
   } else {
      pinnedRallyId.value = target.rallyId;
      selectedTimelineItem.value = "segment";
      selectedKeyPointId.value = null;
   }
   void seekTimeline(target.captureTimeUs);
}

function handleOverlayFrame(frame: number) {
   currentOverlayFrame.value = frame;
}

function handleOverlayVideo(value: { width: number; height: number } | null) {
   overlayVideoSize.value = value;
}

function handleBallPosition(position: { x: number; y: number }) {
   if (!analysisOverlayActive.value || !ballRelabelEnabled.value) return;
   analysisReview.setBallPosition(currentOverlayFrame.value, position);
}

function handlePlayerBBox(selection: {
   trackId: number;
   frameBBox: AnalysisFrameBBox;
}) {
   if (
      !analysisOverlayActive.value ||
      !bboxRelabelEnabled.value ||
      selectedOverlayTrackId.value !== selection.trackId
   )
      return;
   analysisReview.setPlayerBBox(
      currentOverlayFrame.value,
      selection.trackId,
      selection.frameBBox,
   );
   bboxRelabelEnabled.value = false;
}

function handleOverlayTrack(selection: {
   trackId: number;
   clientX: number;
   clientY: number;
   action: string | null;
}) {
   if (
      !analysisOverlayActive.value ||
      ballRelabelEnabled.value ||
      bboxRelabelEnabled.value
   )
      return;
   selectedOverlayTrackId.value = selection.trackId;
   selectedOverlayTrackAction.value = selection.action;
   if (inspectorTab.value === "analysis") {
      if (actorAssignmentMode.value && selectedAnalysisHitId.value) {
         analysisReview.setContactActor(
            selectedAnalysisHitId.value,
            selection.trackId,
         );
      }
      return;
   }
   inspectorTab.value = "mapping";
   const stage = videoStage.value;
   const rect = stage?.getBoundingClientRect();
   trackPopover.open = true;
   trackPopover.trackId = selection.trackId;
   trackPopover.x = rect
      ? Math.max(120, Math.min(rect.width - 120, selection.clientX - rect.left))
      : 180;
   trackPopover.y = rect
      ? Math.max(20, Math.min(rect.height - 250, selection.clientY - rect.top))
      : 80;
}

function markBallMissing() {
   if (!analysisOverlayActive.value) return;
   analysisReview.markBallMissing(currentOverlayFrame.value);
}

function clearBallOverride() {
   if (!analysisOverlayActive.value) return;
   analysisReview.clearBallOverride(currentOverlayFrame.value);
}

function toggleBBoxRelabel() {
   if (!analysisOverlayActive.value || selectedOverlayTrackId.value === null)
      return;
   bboxRelabelEnabled.value = !bboxRelabelEnabled.value;
   if (bboxRelabelEnabled.value) {
      ballRelabelEnabled.value = false;
      actorAssignmentMode.value = false;
   }
}

function clearBBoxOverride() {
   if (!analysisOverlayActive.value || selectedOverlayTrackId.value === null)
      return;
   analysisReview.clearPlayerBBoxOverride(
      currentOverlayFrame.value,
      selectedOverlayTrackId.value,
   );
}

function setAnalysisAction(action: AnalysisReviewAction) {
   if (!analysisOverlayActive.value || selectedOverlayTrackId.value === null)
      return;
   selectedOverlayTrackAction.value = action;
   analysisReview.setAction(
      currentOverlayFrame.value,
      selectedOverlayTrackId.value,
      action,
   );
}

function clearAnalysisAction() {
   if (!analysisOverlayActive.value || selectedOverlayTrackId.value === null)
      return;
   analysisReview.clearActionOverride(
      currentOverlayFrame.value,
      selectedOverlayTrackId.value,
   );
   selectedOverlayTrackAction.value = null;
}

function selectAnalysisHit(keyPointId: string) {
   const event = overlayEvents.value.find(
      (candidate) => candidate.key_point_id === keyPointId,
   );
   if (!event) return;
   selectedAnalysisHitId.value = keyPointId;
   const captureTime = overlayPlayer.value?.overlayFrameCaptureTime(
      replayEventFrame(event),
   );
   if (captureTime) void seekTimeline(captureTime);
   else
      overlayPlayer.value?.seekOverlayFrameIfBuffered(replayEventFrame(event));
}

function markAnalysisHitNoActor(keyPointId: string) {
   analysisReview.setContactActor(keyPointId, null);
   selectedAnalysisHitId.value = keyPointId;
}

function clearAnalysisHitActor(keyPointId: string) {
   analysisReview.clearContactActorOverride(keyPointId);
   selectedAnalysisHitId.value = keyPointId;
}

function closeAnalysisToolbox() {
   if (analysisToolboxMode.value === "bbox") {
      bboxRelabelEnabled.value = false;
      return;
   }
   analysisPanelPage.value = "root";
}

function handleMappingChanged() {
   trackPopover.open = false;
   mappingRefreshToken.value += 1;
   void coach.refresh();
   void refreshOverlayReplay();
}

function dispatchHotkeyCommand(action: HotkeyCommand, event: KeyboardEvent) {
   const frameCount = event.ctrlKey ? 5 : 1;
   if (
      (action === "frame_previous" || action === "frame_next") &&
      selectedEditableKeyPoint.value
   ) {
      void nudgeSelectedKeyPoint(
         action === "frame_next" ? "next" : "previous",
         frameCount,
      );
      return;
   }
   if (
      action === "play_pause" ||
      action.startsWith("frame_") ||
      action.startsWith("key_point_")
   )
      dispatchMediaAction(action as MediaAction, frameCount);
   else dispatchAnnotationAction(action as AnnotationAction);
}

async function retrySelectedProcessing() {
   const rallyId = selectedRallyId.value ?? displayAnnotation.value?.rally_id;
   if (
      !rallyId ||
      processingRetrying.value ||
      activeProcessing.value?.processing_status !== "failed"
   )
      return;
   processingRetrying.value = true;
   try {
      const result = await core.retryProcessing(rallyId);
      await coach.refresh();
      toast.success(
         result.retriedStage === "clip"
            ? "已重新排程剪切片段"
            : "已重新排程 AI 分析",
      );
   } catch (error) {
      toast.error(error instanceof Error ? error.message : "無法重新處理片段");
   } finally {
      processingRetrying.value = false;
   }
}
function commandEnabled(action: HotkeyCommand) {
   if (action === "play_pause") return Boolean(descriptor.value);
   if (action.startsWith("key_point_"))
      return navigableKeyPoints.value.length > 0;
   if (action.startsWith("frame_") && selectedEditableKeyPoint.value) {
      return Boolean(
         selectedCapture.value && state.value === "OPEN" && editReady.value,
      );
   }
   return action.startsWith("frame_")
      ? Boolean(
           descriptor.value &&
           authoritativeAnchor.value &&
           (cursorStatus.value === "ready" || frameQueueRunning.value),
        )
      : controls.value.some(
           (control) => control.action === action && control.enabled,
        );
}
useAnnotationHotkeyRuntime({
   target: hotkeyTarget,
   dispatch: dispatchHotkeyCommand,
   commandEnabled,
});

watch(
   selectedCaptureId,
   (captureId, previousCaptureId) => {
      if (captureId !== previousCaptureId) {
         playbackHasStarted = false;
         continuationRetryDelayMs = 500;
         playerBufferedRanges.value = [];
         if (continuationRetryTimer) clearTimeout(continuationRetryTimer);
         continuationRetryTimer = null;
         if (
            descriptor.value &&
            descriptor.value.capture_session_id !== captureId
         )
            dvr.clear();
      }
      if (captureId)
         annotation.connect(
            `match:${matchId.toLowerCase()}:capture:${captureId.toLowerCase()}`,
         );
   },
   { immediate: true },
);
watch(
   [selectedCaptureId, defaultPlaybackTarget, playbackMode],
   ([captureId, target, mode]) => {
      if (
         !captureId ||
         !target ||
         dvr.busy.value ||
         descriptor.value?.capture_session_id === captureId
      )
         return;
      void createWindow(target, mode === "active_live" ? "live" : "archive");
   },
   { immediate: true },
);
watch(
   [timelineEndTarget, () => timeline.value?.timelineVersion, playbackMode],
   maintainPlaybackWindow,
);
watch(
   () => displayAnnotation.value?.rally_id,
   () => {
      selectedKeyPointId.value = null;
      if (selectedTimelineItem.value === "point") {
         selectedTimelineItem.value = pinnedRallyId.value
            ? "mask"
            : cursorRallyId.value
              ? "segment"
              : null;
      }
   },
   { flush: "sync" },
);
watch(
   () =>
      [
         annotation.snapshot.value?.rally_id,
         annotation.snapshot.value?.snapshot.annotation_status,
         annotation.snapshot.value?.revision,
      ] as const,
   ([, status], previous) => {
      if (
         previous &&
         (status === "submitted" || status === "voided") &&
         status !== previous[1]
      )
         void coach.refresh();
   },
);
watch(
   [visualPlayhead, selectableSegmentRanges],
   ([cursor, segments]) => {
      cursorRallyId.value = segmentAtCaptureTime(cursor, segments)?.id ?? null;
   },
   { immediate: true },
);
watch(
   cursorRallyId,
   (rallyId) => {
      if (pinnedRallyId.value) return;
      selectedTimelineItem.value = rallyId ? "segment" : null;
      selectedKeyPointId.value = null;
   },
   { immediate: true },
);
watch([submittedRallies, annotationDrafts], ([submitted, drafts]) => {
   if (!pinnedRallyId.value) return;
   if (
      [...submitted, ...drafts].some(
         (rally) => rally.id === pinnedRallyId.value,
      )
   )
      return;
   pinnedRallyId.value = null;
   selectedTimelineItem.value = cursorRallyId.value ? "segment" : null;
});
watch(editorMappingAvailable, (available) => {
   if (
      !available &&
      (inspectorTab.value === "mapping" || inspectorTab.value === "analysis")
   )
      inspectorTab.value = "match";
});
watch(editorSelectedAnalysisRunId, () => {
   currentOverlayFrame.value = -1;
   ballRelabelEnabled.value = false;
   selectedOverlayTrackId.value = null;
   selectedOverlayTrackAction.value = null;
   trackPopover.open = false;
});
watch([state, selectedKeyPointId], () => {
   queuedFrameDelta = 0;
   releaseEditingIntent();
});
watch(loadError, (value) => {
   if (value)
      toast.error(value, {
         action: { label: "重試", onClick: () => void loadMatch() },
      });
});
watch(mediaError, (value) => {
   if (value) toast.error(value);
});
watch(
   () => annotation.error.value,
   (value) => {
      if (value)
         toast.error(value, {
            action: {
               label: "重新同步",
               onClick: () => void annotation.refreshActive(),
            },
         });
   },
);
watch(
   () => annotation.outboxNeedsConfirmation.value,
   (value) => {
      if (value)
         toast.warning("場次狀態已更新，請重新操作", {
            action: { label: "重新同步", onClick: annotation.discardPending },
         });
   },
);
watch(
   processingByRally,
   (updates) => {
      const failures = Object.values(updates).filter(
         (update) => update.processing_status === "failed",
      );
      for (const update of failures) {
         const signature = `${update.submission_id}:${update.updated_at ?? ""}`;
         const shouldNotify =
            processingFailureWatchReady ||
            update.rally_id ===
               (selectedRallyId.value ?? displayAnnotation.value?.rally_id);
         if (notifiedProcessingFailures.has(signature)) continue;
         notifiedProcessingFailures.add(signature);
         if (!shouldNotify) continue;
         const rally = coach.data.value?.match.rallies.find(
            (item) => item.id === update.rally_id,
         );
         const title = rally
            ? `第 ${rally.display_set_number} 局 · 回合 ${rally.display_ordinal} 處理失敗`
            : "片段處理失敗";
         const description =
            typeof update.error?.message === "string"
               ? update.error.message
               : "請點擊「處理失敗」查看工作流程與錯誤詳情。";
         toast.error(title, { description });
      }
      processingFailureWatchReady = true;
   },
   { deep: true, immediate: true },
);
watch(
   () => activeProcessing.value?.updated_at,
   () => {
      if (
         activeProcessing.value &&
         ["completed", "failed"].includes(
            activeProcessing.value.processing_status,
         )
      )
         void coach.refresh();
   },
);
watch(
   () => dvr.error.value,
   (error) => {
      if (!error || windowRecoveryInFlight) return;
      const code =
         "code" in error && typeof error.code === "string" ? error.code : "";
      if (
         ![
            "PLAYBACK_WINDOW_NOT_FOUND",
            "WINDOW_EXPIRED",
            "MAPPING_STALE",
         ].includes(code)
      )
         return;
      const target =
         authoritativeAnchor.value?.capture_time_us ??
         captureTarget.value ??
         timelineEndTarget.value;
      if (!target) return;
      windowRecoveryInFlight = true;
      void createWindow(target)
         .then((created) => {
            if (created) toast.info("播放視窗已自動重新連線");
         })
         .finally(() => {
            windowRecoveryInFlight = false;
         });
   },
);
onMounted(() => {
    annotationScope.value?.focus({ preventScroll: true });
    void loadMatch();
    timelineRefreshTimer = setInterval(() => {
      if (captureNeedsPolling(selectedCapture.value?.status))
         void refreshSelectedCapture();
      if (hasActiveRallyProcessing(coach.data.value?.match.rallies))
         void coach.refresh();
      maintainPlaybackWindow();
    }, 2_500);
});
onBeforeUnmount(() => {
   if (timelineRefreshTimer) clearInterval(timelineRefreshTimer);
   if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout);
   if (cursorResolveTimer) clearTimeout(cursorResolveTimer);
   if (seekPreviewTimer) clearTimeout(seekPreviewTimer);
   if (continuationRetryTimer) clearTimeout(continuationRetryTimer);
   annotation.setEditingKeyPoint(null);
   detachVideoState(video.value);
});
</script>

<template>
   <section
      ref="annotationScope"
      tabindex="-1"
      class="editor-shell"
      @keydown.delete.prevent="deleteSelectedKeyPoint"
      @pointerdown.capture="annotationScope?.focus({ preventScroll: true })"
   >
      <AnnotationWorkstationHeader
         :title="match?.title ?? matchId"
         :sync-label="syncLabel"
         :latency-ms="annotation.latencyMs.value"
         :busy="
            annotation.busy.value ||
            annotation.pendingCount.value > 0 ||
            annotation.connection.value !== 'ready'
         "
         :error="
            Boolean(
               annotation.error.value ||
               annotation.outboxNeedsConfirmation.value,
            )
         "
         :connection-title="`${annotation.connection.value} · ${annotation.latencyMs.value ?? '—'} ms · ${selectedCapture?.health ?? 'unknown'}`"
         @media="captureDialogOpen = true"
         @connection="connectionDialogOpen = true"
         @roster="rosterDialogOpen = true"
         @settings="openSettings('root')"
      />

      <UiResizablePanelGroup
         id="annotation-workspace"
         class="editor-body"
      >
         <UiResizablePanel
            id="annotation-video"
            :default-size="78"
            :min-size="55"
         >
            <main class="viewer-panel">
               <div
                  ref="videoStage"
                  class="video-stage"
               >
                  <VideoOverlayPlayer
                     ref="overlayPlayer"
                     :descriptor="descriptor"
                     :controls="false"
                     :toggle-on-click="
                        !analysisOverlayActive ||
                        (inspectorTab !== 'mapping' &&
                           inspectorTab !== 'analysis')
                     "
                     :analysis-run-id="editorOverlayAnalysisRunId"
                     :overlay-capture-time-us="visualPlayhead"
                     :overlay-clip-start-capture-time-us="
                        editorOverlayClipStart
                     "
                     :overlay-interactive="
                        analysisOverlayActive &&
                        (inspectorTab === 'mapping' ||
                           inspectorTab === 'analysis')
                     "
                     :ball-relabel="
                        inspectorTab === 'analysis' && ballRelabelEnabled
                     "
                     :bbox-relabel="
                        inspectorTab === 'analysis' && bboxRelabelEnabled
                     "
                     :selected-track-id="
                        inspectorTab === 'analysis' || inspectorTab === 'mapping'
                           ? selectedOverlayTrackId
                           : null
                     "
                     :ball-correction="
                        analysisOverlayActive ? currentBallOverride : null
                     "
                     :ball-corrections="
                        analysisOverlayActive ? allBallCorrections : {}
                     "
                     :action-corrections="
                        analysisOverlayActive ? currentActionCorrections : {}
                     "
                     :player-bbox-corrections="
                        analysisOverlayActive ? allPlayerBBoxCorrections : {}
                     "
                     :contact-actor-corrections="
                        analysisOverlayActive ? contactActorCorrections : {}
                     "
                     :identity-labels="overlayIdentityLabels"
                     :overlay-events="overlayEvents"
                     :overlay-tracks="overlayTracks"
                     :overlay-team-labels="overlayTeamLabels"
                     :overlay-layers="{
                        bbox: true,
                        trackId: true,
                        action: true,
                        ball: true,
                        trail: true,
                        footprint: true,
                        confidence: false,
                        court: true,
                        nextHit: true,
                     }"
                     @cursor="handleCursor"
                     @ready="handleVideoReady"
                     @buffer-activity="maintainPlaybackWindow"
                     @buffer-state="handleBufferState"
                     @overlay-frame="handleOverlayFrame"
                     @overlay-video="handleOverlayVideo"
                     @ball-position="handleBallPosition"
                     @player-bbox="handlePlayerBBox"
                     @track-select="handleOverlayTrack"
                     @toggle="dispatchMediaAction('play_pause')"
                     @error="mediaError = $event.message"
                  />
                  <AnnotationAnalysisToolbox
                     :mode="analysisToolboxMode"
                     :frame-index="currentOverlayFrame"
                     :selected-track-id="selectedOverlayTrackId"
                     :selected-action="selectedOverlayAction"
                     :selected-hit-label="
                        selectedAnalysisHit
                           ? `第 ${selectedAnalysisHit.sequence_index + 1} 球`
                           : null
                     "
                     :has-ball-override="Boolean(currentBallOverride)"
                     :has-bbox-override="currentBBoxHasOverride"
                     :has-actor-override="selectedAnalysisHitHasOverride"
                     :saving="analysisReview.pending.value"
                     @close="closeAnalysisToolbox"
                     @mark-ball-missing="markBallMissing"
                     @clear-ball="clearBallOverride"
                     @start-bbox="toggleBBoxRelabel"
                     @clear-bbox="clearBBoxOverride"
                     @mark-no-actor="
                        selectedAnalysisHitId &&
                        markAnalysisHitNoActor(selectedAnalysisHitId)
                     "
                     @clear-actor="
                        selectedAnalysisHitId &&
                        clearAnalysisHitActor(selectedAnalysisHitId)
                     "
                     @set-action="setAnalysisAction"
                     @clear-action="clearAnalysisAction"
                  />
                  <div
                     class="viewer-frame-index"
                     aria-label="目前畫格索引"
                  >
                     <span>FRAME IDX</span>
                     <code>{{
                        authoritativeAnchor?.capture_frame_index ?? "—"
                     }}</code>
                  </div>
                  <div
                     v-if="!descriptor"
                     class="stage-empty"
                  >
                     <strong>{{ mediaEmptyLabel }}</strong
                     ><button
                        v-if="defaultPlaybackTarget"
                        type="button"
                        @click="
                           createWindow(
                              defaultPlaybackTarget,
                              liveCapture ? 'live' : 'archive',
                           )
                        "
                     >
                        {{ liveCapture ? "LIVE" : "開啟影片" }}
                     </button>
                  </div>
                  <AnnotationTrackAssignmentPopover
                     :open="trackPopover.open"
                     :match-id="matchId"
                     :analysis-run-id="editorSelectedAnalysisRunId"
                     :track-id="trackPopover.trackId"
                     :current-frame="currentOverlayFrame"
                     :left-team-id="leftTeamId"
                     :right-team-id="rightTeamId"
                     :x="trackPopover.x"
                     :y="trackPopover.y"
                     @close="trackPopover.open = false"
                     @changed="handleMappingChanged"
                  />
               </div>
            </main>
         </UiResizablePanel>
         <UiResizableHandle id="annotation-inspector-handle" />
         <UiResizablePanel
            id="annotation-inspector"
            :default-size="22"
            :min-size="18"
            :max-size="45"
         >
            <AnnotationMatchInspector
               ref="matchInspector"
               v-model:tab="inspectorTab"
               :mapping-available="editorMappingAvailable"
               :analysis-available="editorMappingAvailable"
               :match-id="matchId"
               :left-team="leftTeam"
               :right-team="rightTeam"
               :left-score="currentSet?.left_score ?? 0"
               :right-score="currentSet?.right_score ?? 0"
               :left-set-wins="leftSetWins"
               :right-set-wins="rightSetWins"
               :set-number="displaySetNumber"
               :rally-ordinal="displayRallyOrdinal"
               :left-team-id="leftTeamId"
               :right-team-id="rightTeamId"
               :drafts="annotationDrafts"
               :rallies="visibleSubmittedRallies"
               :selected-rally-id="selectedRallyId"
               :analysis-run-id="editorSelectedAnalysisRunId"
               :mapping-completed="
                  Boolean(
                     selectedRally?.submission.analysis
                        ?.identity_mapping_completed,
                  )
               "
               :current-frame="currentOverlayFrame"
               :set-numbers="
                  coach.data.value?.match.sets.map((set) => set.set_number) ?? [
                     1,
                  ]
               "
               :placement-saving="placementSaving"
               :focused-track-id="selectedOverlayTrackId"
               :mapping-refresh-token="mappingRefreshToken"
               :teams="coach.data.value?.match.teams ?? []"
               :can-start-next-set="state !== 'OPEN' && editReady"
               :format-rally-duration="
                  (rally) => formatDuration(rallyDisplayDuration(rally))
               "
               @select-draft="selectHistoricalSegment"
               @select-rally="selectRally"
               @next-set="requestNextSet"
               @mapping-changed="handleMappingChanged"
               @update-placement="updateRallyPlacement"
            >
               <template #analysis>
                  <AnnotationAnalysisPanel
                     v-model:page="analysisPanelPage"
                     :analysis-run-id="editorSelectedAnalysisRunId"
                     :frame-index="
                        analysisOverlayActive ? currentOverlayFrame : -1
                     "
                     :ball-override="currentBallOverride?.state ?? null"
                     :ball-position="currentBallPosition"
                     :selected-track-id="selectedOverlayTrackId"
                     :selected-track-action="selectedOverlayAction"
                     :selected-hit-id="selectedAnalysisHitId"
                     :has-action-override="currentActionHasOverride"
                     :has-bbox-override="currentBBoxHasOverride"
                     :hits="analysisHitItems"
                     :saving="analysisReview.pending.value"
                     :connection="analysisReview.connection.value"
                     @select-hit="selectAnalysisHit"
                  />
               </template>
            </AnnotationMatchInspector>
         </UiResizablePanel>
      </UiResizablePanelGroup>

      <footer class="timeline-footer">
         <AnnotationTransportBar
            :playing="playing"
            :player-ready="Boolean(descriptor)"
            :frame-ready="Boolean(authoritativeAnchor)"
            :frame-move-pending="Boolean(pendingTimelineMove)"
            :timecode="displayTimecode"
            :live-active="
               playbackMode === 'active_live' && descriptor?.mode === 'live'
            "
            :live-available="Boolean(liveTarget)"
            :terminal-label="playbackMode === 'ended_live' ? 'END' : null"
            :context-title="activeContextTitle"
            :context-hits="activeContextHits"
            :context-duration="formatDuration(activeContextDuration)"
            :context-state="activeContextState"
            :processing="activeProcessing"
            :processing-retrying="processingRetrying"
            :correction-active="selectedCorrectionDraft"
            :correction-cancelling="correctionCancelling"
            :submitted-selected="
               Boolean(selectedSubmittedRally) && !selectedCorrectionDraft
            "
            :clip-selected="clipSelected"
            :draft-selected="selectedEditableDraft"
            :submit-enabled="
               selectedEditableDraft &&
               commandAvailability('submit').enabled &&
               editReady
            "
            :navigable="navigableKeyPoints.length > 0"
            :selected-point="Boolean(selectedKeyPoint)"
            :editable="state === 'OPEN'"
            :edit-ready="editReady"
            :point-delete-enabled="Boolean(selectedDeletablePoint)"
            :muted="muted"
            :timeline-scale="timelineScale"
            :shortcuts="{
               play: formatBindingForDisplay(bindings.play_pause),
               previousFrame: formatBindingForDisplay(bindings.frame_previous),
               nextFrame: formatBindingForDisplay(bindings.frame_next),
               previousPoint: formatBindingForDisplay(
                  bindings.key_point_previous,
               ),
               nextPoint: formatBindingForDisplay(bindings.key_point_next),
            }"
            @play-pause="dispatchMediaAction('play_pause')"
            @frame-previous="dispatchMediaAction('frame_previous')"
            @frame-next="dispatchMediaAction('frame_next')"
            @live="liveTarget && createWindow(liveTarget, 'live')"
            @cancel-correction="cancelCorrection"
            @start-correction="startCorrection"
            @submit="dispatchAnnotationAction('submit')"
            @retry-processing="retrySelectedProcessing"
            @key-point-previous="dispatchMediaAction('key_point_previous')"
            @key-point-next="dispatchMediaAction('key_point_next')"
            @nudge-previous="nudgeSelectedKeyPoint('previous')"
            @nudge-next="nudgeSelectedKeyPoint('next')"
            @delete-clip="deleteSelectedClip"
            @delete-point="deleteSelectedKeyPoint"
            @toggle-mute="dispatchMediaAction('mute')"
            @reset-timeline-zoom="resetTimelineZoom"
         />
         <DvrTimelineDock
            ref="timelineDock"
            :timeline="timeline"
            :playhead="visualPlayhead"
            :playback-mode="playbackMode"
            :buffered-window="
               descriptor
                  ? {
                       startCaptureTimeUs: descriptor.window_capture_start_us,
                       endCaptureTimeUs: descriptor.window_capture_end_us,
                    }
                  : null
            "
            :buffered-ranges="playerBufferedRanges"
            :annotation="displayAnnotation"
            :editable="state === 'OPEN' && editReady && !pendingTimelineMove"
            :selected-key-point-id="selectedKeyPointId"
            :mask-selected="selectedCurrentMask"
            :mask-range="currentMaskRange"
            :current-mask-status="currentMaskStatus"
            :current-mask-label="currentMaskLabel"
            :current-mask-outcome="currentMaskOutcome"
            :segments="timelineSegments"
            :selected-segment-id="selectedHistoricalSegmentId"
            :soft-locks="annotation.remoteEditorsByKeyPoint.value"
            @scale-change="timelineScale = $event"
            @preview="previewTimelineSeek"
            @seek="seekTimeline"
            @clear-selection="clearTimelineSelection"
            @select="selectTimelineKeyPoint"
            @select-mask="selectTimelineMask"
            @select-segment="selectHistoricalSegment"
            @select-analysis="selectTimelineAnalysis"
            @edit-start="beginTimelineKeyPointEdit"
            @edit-cancel="cancelTimelineKeyPointEdit"
            @move="moveTimelineKeyPoint"
         />
         <AnnotationCommandStrip
            :bindings="bindings"
            :state="state"
            :can-mark="canMark"
            :last-key-point="Boolean(annotation.lastKeyPoint.value)"
            :command-ready="commandReady"
            :pending-command="annotation.pendingCount.value > 0"
            :availability="commandAvailabilityMap"
            @action="dispatchAnnotationAction"
            @settings="openSettings('hotkeys')"
         />
      </footer>

      <LazyAnnotationSettingsDialog
         :open="settingsOpen"
         :initial-page="settingsInitialPage"
         :clip-pre-roll-seconds="clipPreRollSeconds"
         :clip-post-roll-seconds="clipPostRollSeconds"
         :clip-policy-saving="clipPolicySaving"
         :clip-policy-error="clipPolicyError"
         @update-clip-policy="updateClipPolicy"
         @close="settingsOpen = false"
      />
      <LazyCaptureControlDialog
         :open="captureDialogOpen"
         :match-id="matchId"
         :captures="match?.captureSessions ?? []"
         @close="captureDialogOpen = false"
         @changed="loadMatch"
      />
      <LazyAnnotationConnectionDialog
         :open="connectionDialogOpen"
         :connection="annotation.connection.value"
         :capture="selectedCapture"
         :descriptor="descriptor"
         :pending="annotation.pendingCount.value"
         :editors="annotation.presence.value.length"
         @close="connectionDialogOpen = false"
      />
      <LazyRosterEditorDialog
         v-if="match"
         :open="rosterDialogOpen"
         :match="match"
         @close="rosterDialogOpen = false"
         @changed="loadMatch"
      />
      <LazyConfirmActionDialog
         :open="Boolean(confirmAction)"
         :title="confirmTitle"
         :message="confirmMessage"
         :confirm-label="confirmLabel"
         :danger="confirmAction === 'rally-delete'"
         @close="closeConfirmAction"
         @confirm="confirmPendingAction"
      />
   </section>
</template>

<style scoped>
:global(html),
:global(body),
:global(#__nuxt) {
   width: 100%;
   height: 100%;
   margin: 0;
   overflow: hidden;
}
:global(body) {
   background: #0b0d0f;
}
.editor-shell {
   --surface-0: #0b0d0f;
   --surface-1: #121519;
   --line: #30363d;
   --line-strong: #4a535d;
   --muted: #98a2ad;
   --green: #49d88a;
   --amber: #f5b84b;
   --blue: #62a9ff;
   --red: #ff6b72;
   width: 100vw;
   height: 100dvh;
   display: grid;
   grid-template-rows: 54px minmax(0, 1fr) 238px;
   overflow: hidden;
   background: var(--surface-0);
   color: #edf1f4;
   font-family: "Segoe UI Variable Text", Aptos, "Segoe UI", sans-serif;
}
.editor-shell button,
.editor-shell a {
   min-height: 34px;
   padding: 7px 11px;
   border: 1px solid var(--line-strong);
   border-radius: 6px;
   background: #20252b;
   color: inherit;
   cursor: pointer;
   text-decoration: none;
}
.editor-shell button:not(:disabled):hover,
.editor-shell a:hover {
   border-color: #6b7681;
   background: #282e35;
}
.editor-shell button:disabled {
   opacity: 0.35;
   cursor: not-allowed;
}
.app-bar {
   min-width: 0;
   display: grid;
   grid-template-columns: minmax(280px, auto) minmax(220px, 1fr) minmax(
         300px,
         auto
      );
   align-items: center;
   gap: 18px;
   padding: 0 16px;
   border-bottom: 1px solid var(--line);
   background: #101317;
}
.brand-block {
   min-width: 0;
}
.brand-block h1 {
   margin: 0;
   font-size: 0.98rem;
   font-weight: 720;
}
.brand-block p {
   margin: 2px 0 0;
   color: var(--muted);
   font-size: 0.69rem;
}
.session-status {
   min-width: 0;
   display: flex;
   justify-content: center;
   align-items: center;
   gap: 8px;
   color: #c4ccd4;
   font-size: 0.78rem;
}
.status-dot {
   width: 7px;
   height: 7px;
   border-radius: 50%;
   background: var(--green);
}
.status-dot.busy {
   background: var(--amber);
}
.status-dot.error {
   background: var(--red);
}
.app-actions {
   min-width: 0;
   display: flex;
   justify-content: flex-end;
   align-items: center;
   gap: 7px;
}
.app-actions > a,
.app-actions > button {
   width: 34px;
   padding: 0;
   display: grid;
   place-items: center;
}
.media-name {
   max-width: 340px;
   overflow: hidden;
   color: var(--muted);
   font-size: 0.73rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.editor-body {
   min-height: 0;
   display: grid;
   grid-template-columns: minmax(0, 1fr) clamp(288px, 24vw, 350px);
   overflow: hidden;
}
.viewer-panel {
   min-width: 0;
   min-height: 0;
   display: grid;
   place-items: center;
   padding: 10px;
   overflow: hidden;
   background: #050607;
}
.video-stage {
   position: relative;
   width: 100%;
   height: 100%;
   display: grid;
   place-items: center;
   overflow: hidden;
   background: #000;
   box-shadow: 0 12px 38px #0006;
}
.video-stage :deep(> div) {
   width: 100%;
   height: 100%;
   border-radius: 0;
}
.video-stage :deep(video) {
   width: 100%;
   height: 100%;
   object-fit: contain;
   cursor: pointer;
}
.stage-mask {
   position: absolute;
   inset: 0;
   pointer-events: none;
}
.stage-mask.draft {
   background: #9ba4ae1a;
}
.stage-mask.submitted {
   background: #2dcd7b14;
}
.viewer-badges {
   position: absolute;
   top: 8px;
   right: 8px;
   display: flex;
   gap: 5px;
   pointer-events: none;
}
.viewer-badges span {
   padding: 3px 6px;
   border: 1px solid #ffffff2b;
   border-radius: 4px;
   background: #050709c2;
   color: #d9e0e6;
   font:
      600 0.66rem "Cascadia Mono",
      Consolas,
      monospace;
}
.stage-empty {
   position: absolute;
   inset: 0;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 9px;
   color: #edf1f4;
   text-align: center;
}
.stage-empty span {
   color: var(--muted);
   font-size: 0.75rem;
}
.stage-error,
.global-error,
.outbox-banner {
   position: absolute;
   z-index: 8;
   padding: 9px;
   border-radius: 5px;
   font-size: 0.72rem;
}
.stage-error,
.global-error {
   border: 1px solid #8e4146;
   background: #351a1cee;
   color: #ffb7bb;
}
.stage-error {
   left: 12px;
   bottom: 12px;
}
.global-error {
   left: 12px;
   top: 64px;
}
.outbox-banner {
   left: 50%;
   top: 64px;
   display: flex;
   align-items: center;
   gap: 10px;
   transform: translateX(-50%);
   border: 1px solid #856424;
   background: #302611ee;
   color: #ffd987;
}
.outbox-banner.confirm {
   border-color: #8e4146;
   background: #351a1cee;
   color: #ffb7bb;
}
.outbox-banner button {
   min-height: 28px;
   padding: 4px 7px;
}
.inspector {
   min-height: 0;
   padding: 12px;
   overflow-y: auto;
   border-left: 1px solid var(--line);
   background: var(--surface-1);
   font-size: 0.77rem;
   scrollbar-width: none;
}
.mode-switch {
   display: grid;
   grid-template-columns: 1fr 1fr;
   margin-bottom: 12px;
   border: 1px solid var(--line);
   border-radius: 7px;
   overflow: hidden;
}
.mode-switch button {
   min-height: 34px;
   border: 0;
   border-radius: 0;
   background: transparent;
   color: var(--muted);
}
.mode-switch button + button {
   border-left: 1px solid var(--line);
}
.mode-switch button.active {
   background: #273039;
   color: #fff;
}
.inspector-heading {
   display: flex;
   align-items: flex-start;
   justify-content: space-between;
   gap: 12px;
   padding-bottom: 10px;
   border-bottom: 1px solid var(--line);
}
.inspector-heading div {
   display: grid;
   gap: 2px;
}
.inspector-heading strong {
   font-size: 0.88rem;
}
.inspector-heading span {
   color: var(--muted);
   font-size: 0.69rem;
}
.section-title {
   display: flex;
   align-items: center;
   justify-content: space-between;
   margin: 14px 0 6px;
   color: #cdd4db;
   font-size: 0.7rem;
}
.section-title b {
   min-width: 22px;
   padding: 2px 5px;
   border-radius: 10px;
   background: #292f36;
   text-align: center;
}
.keypoint-list {
   max-height: 170px;
   margin: 0;
   padding: 0;
   overflow: auto;
   list-style: none;
}
.keypoint-list li {
   min-height: 34px;
   display: grid;
   grid-template-columns: 24px 1fr auto;
   align-items: center;
   gap: 6px;
   padding: 4px 6px;
   border-bottom: 1px solid #262c32;
   cursor: pointer;
}
.keypoint-list li:hover,
.keypoint-list li.selected {
   background: #20262c;
}
.keypoint-list code {
   color: var(--muted);
   font-size: 0.66rem;
}
.point-kind {
   display: grid;
   width: 20px;
   height: 20px;
   place-items: center;
   border-radius: 50%;
   color: #0b0d0f;
   font-size: 0.62rem;
   font-weight: 800;
   background: var(--amber);
}
.point-kind.contact {
   background: var(--blue);
}
.keypoint-list em {
   color: var(--green);
   font-style: normal;
}
.empty-row {
   display: block;
   margin: 0;
   padding: 9px 5px;
   color: var(--muted);
   font-size: 0.7rem;
   overflow-wrap: anywhere;
}
.stack-actions {
   display: grid;
   gap: 6px;
   margin-top: 8px;
}
.stack-actions button {
   min-height: 31px;
   font-size: 0.7rem;
}
.stack-actions button.active {
   border-color: #4d8fc7;
   background: #15324a;
   color: #a9d8ff;
}
.stack-actions .danger {
   color: #ff9ca1;
}
.timeline-footer {
   min-height: 0;
   display: grid;
   grid-template-rows: 43px minmax(0, 1fr) 54px;
   border-top: 1px solid var(--line);
   background: #111419;
}
.transport-bar {
   min-width: 0;
   display: flex;
   align-items: center;
   gap: 6px;
   padding: 5px 12px;
   border-bottom: 1px solid #292f35;
}
.transport-button {
   width: 34px;
   min-height: 31px !important;
   padding: 0 !important;
}
.timecode {
   min-width: 96px;
   margin-left: 4px;
   color: #fff;
   font:
      700 0.78rem "Cascadia Mono",
      Consolas,
      monospace;
}
.transport-help {
   min-width: 0;
   overflow: hidden;
   color: var(--muted);
   font-size: 0.68rem;
   text-overflow: ellipsis;
   white-space: nowrap;
   margin-right: auto;
}
.mode-indicator {
   flex: none;
   padding: 4px 7px;
   border: 1px solid #43515e;
   border-radius: 4px;
   color: #9fc7eb;
   font:
      700 0.63rem "Cascadia Mono",
      Consolas,
      monospace;
}
@media (max-width: 1050px) {
   .app-bar {
      grid-template-columns: 240px 1fr 230px;
   }
   .media-name {
      display: none;
   }
   .editor-body {
      grid-template-columns: minmax(0, 1fr) 288px;
   }
   .mode-indicator {
      display: none;
   }
}
@media (max-height: 760px) {
   .editor-shell {
      grid-template-rows: 48px minmax(0, 1fr) 210px;
   }
   .brand-block p {
      display: none;
   }
   .timeline-footer {
      grid-template-rows: 39px minmax(0, 1fr) 50px;
   }
   .inspector {
      padding: 9px;
   }
   .keypoint-list {
      max-height: 110px;
   }
}
@media (prefers-reduced-motion: reduce) {
   * {
      animation: none !important;
      transition: none !important;
   }
}
.presence-count {
   padding: 2px 6px;
   border: 1px solid #34404a;
   border-radius: 4px;
   color: #9fc7eb;
   font-size: 0.65rem;
}
.correction-button {
   width: 100%;
   border-color: #8c6d2e !important;
   background: #302711 !important;
   color: #ffe0a0 !important;
}
.correction-note {
   margin: 4px 0 0;
   padding: 8px;
   border: 1px solid #64512d;
   border-radius: 5px;
   background: #2a2314;
   color: #f0ce88;
   font-size: 0.68rem;
   line-height: 1.45;
}
.keypoint-list li.remote-editing {
   box-shadow: inset 2px 0 #cf77e6;
   background: #241b2a;
}
.keypoint-list small {
   color: #e3a9f2;
   font-size: 0.62rem;
}

.transport-media-group {
   display: flex;
   align-items: center;
   gap: 6px;
   flex: none;
}
.transport-context {
   margin-left: 0;
   border-left: 0;
   padding-left: 0;
}
.transport-separator {
   flex: none;
   width: 2px;
   height: 24px;
   margin: 0 8px;
   background: #4b5560;
}
@media (max-width: 980px) {
   .context-separator {
      display: none;
   }
}

:global(body) {
   background: #09090b;
}
.editor-shell {
   --surface-0: #09090b;
   --surface-1: #111113;
   --line: #27272a;
   --line-strong: #3f3f46;
   --muted: #a1a1aa;
   background: #09090b;
   color: #f4f4f5;
}
.editor-shell button,
.editor-shell a {
   border-color: transparent;
   background: #18181b;
}
.editor-shell button:not(:disabled):hover,
.editor-shell a:hover {
   border-color: transparent;
   background: #27272a;
}
.editor-shell .app-bar {
   background: #09090b;
}
.editor-shell .window-title svg {
   color: #d4d4d8;
}
.editor-shell .mode-switch {
   border-color: #27272a;
   background: #111113;
}
.editor-shell .mode-switch button + button {
   border-left-color: #27272a;
}
.editor-shell .mode-switch button.active {
   background: #27272a;
   color: #fafafa;
}
.editor-shell .segment-row.active {
   background: #27272a !important;
}
.editor-shell .transport-button {
   border-color: transparent !important;
   background: #18181b !important;
}
.editor-shell .live-badge {
   border-color: transparent !important;
   background: #27272a !important;
   color: #a1a1aa !important;
}
.editor-shell .live-badge.active {
   border-color: transparent !important;
   background: #163c27 !important;
   color: #86efac !important;
}
.editor-shell .tool-button:hover:not(:disabled),
.editor-shell .tool-button.active {
   background: #27272a !important;
}
.editor-shell .transport-context > span {
   background: #27272a;
   color: #d4d4d8;
}

.window-title {
   gap: 6px;
}
.window-home {
   width: 29px !important;
   min-height: 29px !important;
   display: grid !important;
   place-items: center;
   padding: 0 !important;
   border-color: transparent !important;
   border-radius: 8px !important;
   background: transparent !important;
   color: #aeb8c2 !important;
}
.window-home:hover {
   background: #232a31 !important;
   color: #fff !important;
}
.window-title > strong {
   margin-left: 2px;
}
.app-actions {
   min-width: 32px;
}
.inspector {
   display: flex;
   flex-direction: column;
   overflow: hidden;
}
.mode-switch {
   flex: none;
}
.match-inspector,
.mapping-inspector {
   min-height: 0;
   flex: 1;
}
.match-inspector {
   display: grid;
   grid-template-rows: auto 35px minmax(0, 1fr);
}
.mapping-inspector {
   overflow: auto;
}
.score-summary {
   padding-top: 5px;
   border-bottom: 1px solid var(--line);
}
.rally-counter {
   display: block;
   color: #7f8993;
   font-size: 0.6rem;
   font-weight: 750;
   letter-spacing: 0.04em;
   text-align: center;
}
.score-summary .score-board {
   border-bottom: 0;
}
.segment-scroll {
   min-height: 0;
   height: 100%;
}
.segment-list {
   padding-right: 5px;
}
.segment-row {
   min-height: 49px !important;
}
.segment-row > div {
   min-width: 0;
   display: grid;
   gap: 3px;
   text-align: left;
}
.segment-row small {
   color: #77838e;
   font-size: 0.58rem;
   font-weight: 500;
}
.transport-context {
   min-width: 220px;
   max-width: 520px;
   display: grid;
   grid-template-columns: minmax(0, 1fr) auto auto;
   align-items: center;
   gap: 10px;
   margin-left: auto;
   padding: 0 8px;
   border-left: 1px solid #2e353c;
}
.transport-context > div {
   min-width: 0;
   display: grid;
   gap: 1px;
}
.transport-context strong,
.transport-context small {
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.transport-context strong {
   font-size: 0.65rem;
}
.transport-context small {
   color: #7f8a95;
   font-size: 0.56rem;
}
.transport-context > span {
   padding: 3px 7px;
   border-radius: 999px;
   background: #26303a;
   color: #a9c9e2;
   font-size: 0.56rem;
   font-weight: 750;
}
.context-edit {
   width: 28px !important;
   min-height: 28px !important;
   display: grid !important;
   place-items: center;
   padding: 0 !important;
   border-color: transparent !important;
   background: transparent !important;
}
.transport-button svg {
   filter: drop-shadow(0 1px 0 #000);
}
@media (max-width: 1180px) {
   .transport-context {
      max-width: 300px;
   }
   .transport-context small {
      display: none;
   }
}
@media (max-width: 980px) {
   .transport-context {
      display: none;
   }
}

.editor-shell {
   grid-template-rows: 44px minmax(0, 1fr) 230px;
}
.app-bar {
   grid-template-columns: auto minmax(280px, 1fr) auto minmax(220px, auto);
   gap: 12px;
   padding: 0 10px;
   background: #0e1114;
}
.window-title {
   min-width: 0;
   display: flex;
   align-items: center;
   gap: 7px;
}
.window-title svg {
   color: #62a9ff;
}
.window-title strong {
   max-width: 260px;
   overflow: hidden;
   font-size: 0.75rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.window-menu {
   display: flex;
   align-items: center;
   gap: 2px;
}
.window-menu button,
.window-menu a {
   width: auto !important;
   min-height: 27px !important;
   display: flex !important;
   align-items: center;
   gap: 5px;
   padding: 0 8px !important;
   border-color: transparent !important;
   background: transparent !important;
   color: #9da6af;
   font-size: 0.65rem;
}
.window-menu button:hover,
.window-menu a:hover {
   background: #20262c !important;
   color: #eef2f5;
}
.session-status {
   justify-content: flex-start;
   font-size: 0.68rem;
}
.app-actions > a,
.app-actions > button {
   width: 30px !important;
   min-height: 30px !important;
   border-color: transparent !important;
   border-radius: 7px !important;
   background: transparent !important;
}
.media-name {
   max-width: 220px;
   font-size: 0.65rem;
}
.editor-body {
   grid-template-columns: minmax(0, 1fr) clamp(280px, 22vw, 330px);
}
.viewer-panel {
   padding: 0;
   background: #030405;
}
.video-stage {
   box-shadow: none;
}
.viewer-badges span {
   border-radius: 6px;
   font-size: 0.59rem;
}
.inspector {
   padding: 10px;
}
.mode-switch {
   margin-bottom: 10px;
   border-radius: 8px;
}
.mode-switch button {
   min-height: 32px;
   font-size: 0.68rem;
}
.score-board {
   min-height: 62px;
   display: grid;
   grid-template-columns: minmax(0, 1fr) auto auto auto minmax(0, 1fr);
   align-items: center;
   gap: 7px;
   padding: 0 8px;
   border-bottom: 1px solid var(--line);
   font-variant-numeric: tabular-nums;
}
.score-board span {
   overflow: hidden;
   color: #aab2bb;
   font-size: 0.68rem;
   font-weight: 650;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.score-board span:last-child {
   text-align: right;
}
.score-board b {
   font-size: 1.55rem;
}
.score-board i {
   color: #69737d;
   font-style: normal;
}
.current-segment {
   min-height: 52px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   border-bottom: 1px solid #282e34;
}
.current-segment > div {
   display: grid;
   gap: 2px;
}
.current-segment span {
   color: #8d97a1;
   font-size: 0.62rem;
}
.current-segment strong {
   font-size: 0.72rem;
}
.segment-state {
   padding: 3px 7px;
   border-radius: 999px;
   background: #353c44 !important;
   color: #c3c9d0 !important;
   font-weight: 700;
}
.segment-state.open {
   background: #32373d !important;
}
.segment-state.ready {
   background: #5b4519 !important;
   color: #ffd987 !important;
}
.segment-state.submitted {
   background: #173f5f !important;
   color: #a9d7ff !important;
}
.segment-stats {
   display: grid;
   grid-template-columns: repeat(3, 1fr);
   margin: 0;
   border-bottom: 1px solid #282e34;
}
.segment-stats div {
   min-height: 53px;
   display: grid;
   place-content: center;
   justify-items: center;
   gap: 2px;
}
.segment-stats div + div {
   border-left: 1px solid #282e34;
}
.segment-stats dt {
   color: #7e8892;
   font-size: 0.6rem;
}
.segment-stats dd {
   margin: 0;
   font-size: 0.8rem;
   font-weight: 700;
}
.correction-button {
   min-height: 34px !important;
   display: flex;
   align-items: center;
   justify-content: center;
   gap: 7px;
   margin-top: 10px;
}
.segment-list-title {
   height: 35px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   color: #aab2bb;
   font-size: 0.65rem;
   font-weight: 700;
}
.segment-list-title b {
   min-width: 20px;
   padding: 2px 5px;
   border-radius: 999px;
   background: #293039;
   font-size: 0.6rem;
   text-align: center;
}
.segment-row {
   width: 100%;
   min-height: 37px !important;
   display: flex;
   align-items: center;
   justify-content: space-between !important;
   padding: 0 9px !important;
   border: 0 !important;
   border-bottom: 1px solid #242a30 !important;
   border-radius: 0 !important;
   background: transparent !important;
   font-size: 0.66rem;
}
.segment-row.active {
   background: #202830 !important;
}
.segment-row i {
   width: 8px;
   height: 8px;
   border-radius: 50%;
   background: #4295d8;
}
.segment-row i.processing {
   background: #d5a331;
}
.segment-row i.mapped {
   background: #36b878;
}
.segment-picker {
   display: grid;
   grid-template-columns: 42px 1fr;
   align-items: center;
   gap: 6px;
   margin-bottom: 10px;
}
.segment-picker span {
   color: #87919b;
   font-size: 0.64rem;
}
.segment-picker select {
   height: 31px;
   padding: 0 8px;
   border: 1px solid #404951;
   border-radius: 6px;
   outline: 0;
   background: #191e23;
   color: #eef2f5;
   font-size: 0.67rem;
}
.timeline-footer {
   grid-template-rows: 42px minmax(0, 1fr) 53px;
}
.transport-bar {
   gap: 4px;
   padding: 4px 10px;
}
.transport-button {
   display: grid;
   place-items: center;
   border-radius: 7px !important;
}
.timecode {
   min-width: 82px;
   margin-left: 3px;
   font-size: 0.7rem;
}
.live-badge {
   min-height: 22px !important;
   padding: 2px 7px !important;
   border: 1px solid #59636d !important;
   border-radius: 999px !important;
   background: #22272d !important;
   color: #a9b1ba !important;
   font-size: 0.56rem !important;
   font-weight: 800;
}
.live-badge.active {
   border-color: #287a50 !important;
   background: #173c29 !important;
   color: #73dda2 !important;
}
.transport-separator {
   width: 1px;
   height: 23px;
   margin: 0 3px;
   background: #30363d;
}
.tool-button {
   min-height: 30px !important;
   display: flex;
   align-items: center;
   gap: 5px;
   padding: 0 8px !important;
   border-color: transparent !important;
   background: transparent !important;
   color: #aab3bc !important;
   font-size: 0.63rem;
}
.tool-button:hover:not(:disabled),
.tool-button.active {
   background: #252c33 !important;
   color: #fff !important;
}
.tool-button.danger {
   color: #dba1a5 !important;
}
.transport-spacer {
   flex: 1;
}
.global-error,
.outbox-banner {
   top: 52px;
}
.presence-count {
   display: grid;
   min-width: 18px;
   height: 18px;
   place-items: center;
   border-radius: 999px;
}
.stage-empty span {
   display: none;
}
@media (max-width: 1050px) {
   .app-bar {
      grid-template-columns: auto 1fr auto;
   }
   .window-menu {
      display: none;
   }
   .editor-body {
      grid-template-columns: minmax(0, 1fr) 280px;
   }
   .media-name {
      display: none;
   }
}
@media (max-height: 760px) {
   .editor-shell {
      grid-template-rows: 42px minmax(0, 1fr) 204px;
   }
   .timeline-footer {
      grid-template-rows: 39px minmax(0, 1fr) 49px;
   }
   .tool-button span {
      display: none;
   }
}
@media (prefers-reduced-motion: reduce) {
   * {
      animation: none !important;
      transition: none !important;
   }
}

.app-bar {
   grid-template-columns: auto minmax(280px, 1fr) auto;
}
.editor-shell {
   grid-template-rows: 44px minmax(0, 1fr) 260px;
}
.editor-body {
   display: flex !important;
   grid-template-columns: none !important;
}
.viewer-panel,
.inspector {
   width: 100%;
   height: 100%;
}
.viewer-badges {
   top: 10px;
   right: 10px;
   z-index: 6;
   align-items: center;
}
.viewer-badges span {
   min-height: 22px;
   display: inline-flex;
   align-items: center;
   padding: 3px 7px;
   line-height: 1;
}
.transport-context {
   grid-template-columns: minmax(0, 1fr) auto;
}
.segment-row i.draft {
   background: #71717a;
}

.viewer-frame-index {
   position: absolute;
   top: 10px;
   left: 10px;
   z-index: 6;
   display: flex;
   width: max-content !important;
   height: auto !important;
   align-items: baseline;
   gap: 8px;
   pointer-events: none;
   padding: 5px 8px;
   border: 1px solid #ffffff2b;
   border-radius: 5px;
   background: #050709c2;
   color: #d9e0e6;
}
.viewer-frame-index span {
   color: #9da7b1;
   font:
      700 0.55rem/1 "Cascadia Mono",
      Consolas,
      monospace;
   letter-spacing: 0.06em;
}
.viewer-frame-index code {
   color: #f3f5f6;
   font:
      700 0.68rem/1 "Cascadia Mono",
      Consolas,
      monospace;
   font-variant-numeric: tabular-nums;
}

.segment-list-title {
   height: 30px;
}
.match-inspector {
   grid-template-rows: auto 30px minmax(0, 1fr);
}
.segment-list {
   padding-right: 0;
}
.segment-row {
   padding: 0 4px !important;
}

.mapping-inspector {
   overflow: hidden;
}
.mapping-scroll {
   height: 100%;
   min-height: 0;
}
.mapping-scroll-content {
   padding-right: 10px;
   padding-bottom: 10px;
}
.mode-switch button:disabled {
   cursor: not-allowed;
   opacity: 0.42;
}

.set-scoreline {
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 2px 5px;
   color: #8f99a3;
   font-size: 0.58rem;
   font-weight: 650;
}
.set-scoreline b {
   color: #d7dce1;
   font-size: 0.6rem;
}
.next-set-actions {
   display: grid;
   grid-template-columns: 1fr 1fr;
   gap: 4px;
   padding: 5px;
   border-top: 1px solid #282e34;
}
.next-set-actions button {
   min-height: 25px !important;
   padding: 2px 6px !important;
   border-color: #343a40 !important;
   background: #181b1f !important;
   color: #aeb6be !important;
   font-size: 0.58rem;
}
.transport-context {
   flex: 0 1 270px;
   min-width: 150px;
   max-width: 340px;
   margin-left: 0;
}
.tool-button.icon-only {
   width: 28px;
   padding: 0 !important;
   justify-content: center;
}
.transport-bar > :last-child {
   margin-left: auto;
}
@media (max-width: 1280px) {
   .transport-context {
      max-width: 210px;
   }
   .transport-context small {
      display: none;
   }
   .tool-button {
      padding-inline: 5px !important;
   }
}
.transport-media-group {
   padding: 2px 5px;
   border-radius: 8px;
   background: #131519;
}
.transport-context {
   margin-left: 0;
   border-left: 0;
   padding: 3px 10px;
   border-radius: 8px;
   background: #131519;
}
.transport-separator {
   flex: none;
   width: 1px;
   height: 16px;
   margin: 0 10px;
   border-radius: 999px;
   background: #464c55;
   opacity: 0.8;
}
.context-separator {
   margin-inline: 8px;
}
@media (max-width: 980px) {
   .context-separator {
      display: none;
   }
}
</style>
