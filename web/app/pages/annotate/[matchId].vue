<script setup lang="ts">
import { useThrottleFn } from '@vueuse/core'
import { Eye, EyeOff, LoaderCircle } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  type AnalysisFrameBBox,
  type AnnotationRallyProcessingUpdate,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'
import { isSupersededSourceSubmission } from '~/lib/annotationKeyPointNavigation'
import { createMediaClient } from '~/lib/mediaClient'
import { useAuthoritativeDvrWindow } from '~/composables/useAuthoritativeDvrWindow'
import { createFrameNavigationGestureRouter } from '~/utils/frameNavigationGestureRouter'
import {
  createCoreDomainClient,
  createGraphQLTransport,
  type Match,
  type CaptureSession,
  type CaptureTimeline,
} from '~/lib/coreDomain'
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  shiftedHotkeyBinding,
  type AnnotationAction,
  type HotkeyCommand,
  type MediaAction,
} from '~/utils/annotationHotkeys'
import type { CanonicalFrameAnchor, PlaybackCursorInput } from '~/lib/mediaModel'
import { createCoachDomainClient, type CoachRallyReplay } from '~/lib/coachDomain'
import { provideIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'
import {
  DEFAULT_TIMELINE_SCALE,
  formatTimelinePosition,
  readyAt,
  segmentAtCaptureTime,
  type TimelineViewport,
} from '~/lib/dvrTimeline'
import { useAnnotationWorkstationViewState } from '~/composables/useAnnotationWorkstationViewState'
import { capturePlaybackMode, clampLiveEdgeTarget } from '~/lib/mediaTimeline'
import { deriveSetDisplayProjection } from '~/utils/setDisplayProjection'
import { decidePlaybackContinuation, nextPlayableRangeAfter } from '~/lib/playbackContinuation'
import {
  bufferedSecondsAhead,
  mediaTimeRangeContains,
  type CanonicalMediaRange,
} from '~/utils/mediaBuffer'
import { estimateFrameDurationSeconds } from '~/utils/framePreviewCalibration'
import { requestMediaPause, requestMediaPlay } from '~/utils/mediaPlaybackIntent'
import {
  createPresentedFrameBaseline,
  projectedPresentedFrameIndex,
  type PresentedFrameBaseline,
} from '~/utils/presentedFrameIndex'
import {
  captureNeedsPolling,
  hasActiveRallyProcessing,
  nextCapturePollDelay,
  type CapturePollOutcome,
} from '~/utils/annotationPolling'
import {
  replayEventFrame,
  resolveEffectiveHitPosition,
  resolveEventActorFromResult,
  type OverlayBallOverride,
} from '~/utils/volleyballOverlayRenderer'
import {
  annotationWorkstationActionId,
  createAnnotationActionService,
} from '~/services/annotation-workstation/annotation-action.service'
import {
  createAnnotationWorkstationService,
  provideAnnotationWorkstationService,
} from '~/services/annotation-workstation/annotation-workstation.service'
import {
  createWorkstationActionManager,
  type WorkstationActionId,
} from '~/services/annotation-workstation/workstation-action.service'
import { createWorkstationFeedbackService } from '~/services/annotation-workstation/workstation-feedback.service'
import { createWorkstationSelectionService } from '~/services/annotation-workstation/workstation-selection.service'
import { createTransportActionService } from '~/services/annotation-workstation/transport-action.service'
import { createCorrectionFlowService } from '~/services/annotation-workstation/correction-flow.service'
import { createAnalysisRevisionService } from '~/services/annotation-workstation/analysis-revision.service'
import { createIdentityAssignmentControllerService } from '~/services/annotation-workstation/identity-assignment-controller.service'
import { createTimelineSelectionService } from '~/services/annotation-workstation/timeline-selection.service'
import { createKeyPointEditingService } from '~/services/annotation-workstation/key-point-editing.service'
import { createWorkstationConfirmationService } from '~/services/annotation-workstation/workstation-confirmation.service'
import {
  createSegmentManagementService,
  type SideSwapTarget,
} from '~/services/annotation-workstation/segment-management.service'
import { createSyncRecoveryService } from '~/services/annotation-workstation/sync-recovery.service'
import { createWorkstationPreferencesService } from '~/services/annotation-workstation/workstation-preferences.service'
import { mergeRallyProcessingUpdate } from '~/services/annotation-workstation/processing-state.service'
import { ballEventRepairNotice } from '~/utils/annotationBallEventRepairNotice'
import { captureTimeForIdentityTrackFrame } from '~/utils/identityTrackNavigation'
import {
  captureTimeInTimelineRanges,
  liveMediaBackend,
  omeLiveManifestUrl,
  projectOmeLiveTimelineRanges,
  type OmeLivePlaybackSource,
} from '~/lib/omeLivePlayback'

definePageMeta({ layout: 'annotation' })
const route = useRoute()
const matchId = String(route.params.matchId)
const workstationViewState = useAnnotationWorkstationViewState(matchId)
const match = ref<Match | null>(null)
const loadError = ref<string | null>(null)
const media = createMediaClient()
const publicEndpoints = usePublicEndpoints()
const runtimeConfig = useRuntimeConfig()
const core = createCoreDomainClient(createGraphQLTransport('/graphql'))
const coachDomain = createCoachDomainClient(createGraphQLTransport('/graphql'))
provideIdentityAssignmentService(coachDomain)
const dvr = useAuthoritativeDvrWindow(media)
const descriptor = computed(() => dvr.current.value)
const { profile: mediaBufferProfile } = useMediaPlaybackPreferences()
const video = ref<HTMLVideoElement | null>(null)
const overlayPlayer = ref<{
  recoverPlayback: () => boolean
  seekCanonicalFrame: (
    anchor: Pick<
      CanonicalFrameAnchor,
      'playback_window_id' | 'mapping_version' | 'player_media_time_us'
    >,
  ) => boolean
  seekCaptureTimeInWindow: (targetCaptureTimeUs: string) => boolean
  seekCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean
  previewCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean
  previewPlayerMediaTime: (targetPlayerSeconds: number) => boolean
  overlayFrameCaptureTime: (frame: number) => string | null
  seekOverlayFrameIfBuffered: (frame: number) => boolean
  seekLiveEdge: () => boolean
} | null>(null)
const playing = ref(false)
const muted = ref(false)
const playbackRate = ref(1)
const playerBufferedRanges = shallowRef<CanonicalMediaRange[]>([])
const playerSeekableRanges = shallowRef<CanonicalMediaRange[]>([])
const captureTarget = ref('')
const mediaError = ref<string | null>(null)
const playbackBuffering = ref(false)
const omePlaybackFailed = ref(false)
const omeObservedCaptureTimeUs = ref<string | null>(null)
const omeAtLiveEdge = ref(false)
const omeDirectPlaybackActive = ref(false)
const omeArchivePlaybackActive = ref(false)
const omeSeekLiveOnReady = ref(false)
const omeCanonicalTimeValidated = ref(false)
const authoritativeAnchor = computed(() => dvr.anchor.value)
const observedCursor = shallowRef<PlaybackCursorInput | null>(null)
const cursorStatus = ref<'ready' | 'stale' | 'seeking' | 'gap'>('stale')
const annotation = useAnnotationRoom()
const workstationFeedback = createWorkstationFeedbackService()
const workstationActions = createWorkstationActionManager({ feedback: workstationFeedback })
const workstationConfirmation = createWorkstationConfirmationService({
  feedback: workstationFeedback,
})
const coach = useCoachMatchState(matchId, {
  refreshIntervalMs: 0,
  profile: 'annotation',
})
const workstationPreferences = createWorkstationPreferencesService({
  matchId,
  core,
  feedback: workstationFeedback,
  refreshCoach: coach.refresh,
  onMatchUpdated: updated => {
    match.value = updated
  },
})
const annotationOverlayEnabled = workstationPreferences.overlayEnabled
const analysisDownloadsEnabled = workstationPreferences.analysisDownloadsEnabled
const annotationOverlayLayers = workstationPreferences.overlayLayers
const keyPointEditing = createKeyPointEditingService({
  room: annotation,
  dvr,
  media,
  feedback: workstationFeedback,
  selectedCapture: () => selectedCapture.value,
  descriptor: () => descriptor.value,
  video: () => video.value,
  overlay: () => overlayPlayer.value,
  selectedKeyPointId: () => selectedKeyPointId.value,
  selectKeyPoint: keyPointId => {
    selectedKeyPointId.value = keyPointId
  },
  editable: () => editableDraftState.value,
  commandReady: () => commandReady.value,
  editReady: () => draftMutationReady.value,
  estimatedFrameSeconds: () => estimatedFrameSeconds,
  observedCursor: () => observedCursor.value,
  setObservedCursor: cursor => {
    observedCursor.value = cursor
    settleOptimisticSeekFromCursor(cursor)
  },
  setCursorReady: () => {
    cursorStatus.value = 'ready'
  },
  clipPreRollUs: () => clipPreRollUs.value,
  clipPostRollUs: () => clipPostRollUs.value,
  protectedSegments: () => protectedSegmentRanges.value,
  prepareAuthoritativeSeek,
  clearGestureOwner: () => frameGestureRouter.clear('key-point'),
})
const displayAnnotation = computed(() => {
  const source = annotation.viewSnapshot.value
  return keyPointEditing.projectSnapshot(source)
})
const state = annotation.viewState
const editableDraftState = computed(() => state.value === 'OPEN' || state.value === 'READY')
const hasActiveLocalSegment = computed(() => {
  const snapshot = displayAnnotation.value?.snapshot
  const boundaries = snapshot?.boundaries ?? []
  return Boolean(
    state.value === 'OPEN' &&
    !snapshot?.active_submission_id &&
    boundaries.some(boundary => boundary.kind === 'start') &&
    !boundaries.some(boundary => boundary.kind === 'end'),
  )
})
const correctionDraftContactIds = computed(
  () =>
    displayAnnotation.value?.snapshot.key_points
      .filter(point => point.marker_kind === 'contact')
      .map(point => point.key_point_id) ?? [],
)
const cursorRallyId = ref<string | null>(null)
const selectionRallyIds = computed<ReadonlySet<string>>(() => {
  const ids = new Set<string>()
  for (const rally of coach.data.value?.match.rallies ?? []) ids.add(rally.id)
  for (const draft of coach.data.value?.match.drafts ?? []) ids.add(draft.id)
  if (displayAnnotation.value?.rally_id) ids.add(displayAnnotation.value.rally_id)
  return ids
})
const localDraftRallyId = computed(() =>
  ['open', 'ready'].includes(displayAnnotation.value?.snapshot.annotation_status ?? '')
    ? (displayAnnotation.value?.rally_id ?? null)
    : null,
)
const timelineDock = useTemplateRef<{
  focusRange: (
    startCaptureTimeUs: string,
    endCaptureTimeUs: string,
    seekTarget?: string | null,
  ) => void
  focusCursor: (captureTimeUs: string) => void
  resetView: () => void
}>('timelineDock')
const keyPointEditorPositionMode = ref<'follow' | 'pinned'>('follow')
const workstationSelection = createWorkstationSelectionService({
  localDraftRallyId,
  cursorRallyId,
  availableRallyIds: selectionRallyIds,
})
const selectedKeyPointId = computed<string | null>({
  get: () =>
    workstationSelection.detail.value.kind === 'key-point'
      ? workstationSelection.detail.value.keyPointId
      : null,
  set: keyPointId => {
    if (keyPointId) workstationSelection.selectKeyPoint(keyPointId)
    else workstationSelection.clearDetail()
  },
})
watch(annotation.resolvedKeyPointIds, aliases => {
  const selected = selectedKeyPointId.value
  const resolved = selected ? aliases[selected] : null
  if (resolved) selectedKeyPointId.value = resolved
})
const timelineSelection = createTimelineSelectionService({
  room: annotation,
  selection: workstationSelection,
  feedback: workstationFeedback,
  cursorRallyId,
  displayedRallyId: () => displayAnnotation.value?.rally_id ?? null,
  selectedKeyPointId: () => selectedKeyPointId.value,
  draftRallyIds: () => new Set(annotationDrafts.value.map(draft => draft.id)),
  seek: seekTimeline,
  focusSegment: segment =>
    timelineDock.value?.focusRange(segment.startCaptureTimeUs, segment.endCaptureTimeUs, null),
  openAnalysis: () => {
    inspectorTab.value = 'analysis'
  },
})
const selectedTimelineItem = timelineSelection.selectedItem
const selectedKeyPoint = computed(
  () =>
    displayAnnotation.value?.snapshot.key_points.find(
      point => point.key_point_id === selectedKeyPointId.value,
    ) ?? null,
)
const selectedPreviousBallEvent = computed<BallEventValue | null>(() => {
  const points = displayAnnotation.value?.snapshot.key_points ?? []
  const index = points.findIndex(point => point.key_point_id === selectedKeyPointId.value)
  return index > 0 ? (points[index - 1]?.ball_event ?? null) : null
})
const pendingTimelineMove = keyPointEditing.pendingMove
const frameQueueRunning = ref(false)
const frameQueuePending = ref(false)
const seekPreviewActive = ref(false)
const optimisticSeekCaptureTimeUs = ref<string | null>(null)
const legacyCursorMatchesWindow = computed(() => {
  const cursor = observedCursor.value
  const window = descriptor.value
  return Boolean(
    cursor &&
    cursor.schema_version === '1.0.0' &&
    cursor.cursor_status === 'ready' &&
    window &&
    cursor.playback_window_id === window.playback_window_id &&
    cursor.mapping_version === window.mapping_version,
  )
})
const canMark = computed(() => {
  if (omeDirectPlaybackActive.value)
    return omeCanonicalTimeValidated.value && cursorStatus.value === 'ready'
  // The browser cursor is enough to submit an annotation. The server resolves
  // that cursor authoritatively when the command arrives. Do not couple the
  // marking buttons to background window refreshes or frame-step requests:
  // those can be busy while the visible, paused cursor is still a valid target.
  // The server remains the final authority and will reject an actually stale
  // playback cursor with a recoverable annotation error.
  return legacyCursorMatchesWindow.value || annotationCommandCursor.value?.cursor_status === 'ready'
})
const commandReady = computed(() => !annotation.outboxNeedsConfirmation.value)
const draftMutationReady = computed(
  () => commandReady.value && !annotation.busy.value && !pendingTimelineMove.value,
)
// Annotation mutations are optimistic and ordered by the durable local outbox.
// Do not turn ordinary network latency into a workstation-wide edit lock.
const editReady = computed(() => draftMutationReady.value)
// Set boundaries and court-side metadata do not depend on the media cursor.
// A slow seek must not disable a winner/side-swap operation whose target is
// already selected; the server still validates the selected rally atomically.
const metadataMutationReady = computed(() => commandReady.value && !annotation.busy.value)
const keyPointEditReady = computed(
  () => draftMutationReady.value || keyPointEditing.navigation.active.value,
)
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')
const videoStage = useTemplateRef<HTMLElement>('videoStage')
const timelineScale = ref(DEFAULT_TIMELINE_SCALE)
const hotkeyTarget = computed(() => (import.meta.client ? document.body : annotationScope.value))
const captureDialogOpen = ref(false)
const connectionDialogOpen = ref(false)
const rosterDialogOpen = ref(false)
const downloadDialogOpen = ref(false)
const correctionFlow = createCorrectionFlowService({
  room: annotation,
  feedback: workstationFeedback,
  selectedSubmissionId: () => selectedSubmittedRally.value?.submission.id ?? null,
  pendingTimelineMove: () => Boolean(pendingTimelineMove.value),
  selectedAnalysisRunId: () => editorSelectedAnalysisRunId.value,
  loadedAnalysisRunId: () => analysisReview.loadedAnalysisRunId.value,
  analysisDirtyCount: () => analysisReview.dirtyCount.value,
  overlayContactCount: () => overlayEvents.value.length,
  annotationState: () => state.value,
  displayedCorrectionDraft: () => Boolean(displayedCorrectionDraft.value),
  correctionContactIds: () => correctionDraftContactIds.value,
  correctionActive: () => correctionActive.value,
  correctionRallyId: () => correctionRallyId.value,
  displayedRallyId: () => displayAnnotation.value?.rally_id ?? null,
  selectRally: workstationSelection.selectRally,
  setTimelineSelection: selection => {
    selectedTimelineItem.value = selection
  },
  setKeyPointSelection: keyPointId => {
    selectedKeyPointId.value = keyPointId
  },
  requestCreateConfirmation: submissionId => {
    workstationConfirmation.open({
      id: 'correction-create',
      title: '建立修正版草稿',
      message:
        '會保留片段範圍、得分與目前有效的擊球點，建立可編輯草稿。完成修改並送出時，再決定保留標記或交由 AI 重新產生。',
      confirmLabel: '建立草稿',
      onConfirm: () => correctionFlow.create(submissionId),
    })
  },
  requestSubmitConfirmation: () => {
    workstationConfirmation.open({
      id: 'correction-submit',
      title: '送出修正版',
      message: `草稿目前有 ${correctionDraftContactIds.value.length} 個擊球標記。清除後，系統會重新產生擊球點；保留後，這些標記會作為人工結果，不再加入自動擊球點。只調整球點時間、球種、結果或球員時會重用既有媒體與分析；改變片段邊界或球點數量時才重新處理必要工作。`,
      confirmLabel: '清除並由 AI 重新標記',
      secondaryLabel: '保留目前標記點',
      onConfirm: () => correctionFlow.submit('regenerate'),
      onSecondary: () => correctionFlow.submit('preserve'),
    })
  },
  requestResync: () => syncRecovery.requestResync(),
  refreshCoach: coach.refresh,
})
const correctionCreating = correctionFlow.creating
const correctionSubmitting = correctionFlow.submitting
const correctionCancelling = correctionFlow.cancelling
const matchInspector = useTemplateRef<{ closePlacement: () => void }>('matchInspector')
const inspectorTab = ref<'match' | 'mapping' | 'analysis'>('match')
const pinnedRallyId = workstationSelection.explicitRallyId
const currentOverlayFrame = ref(-1)
const presentedFrameBaseline = shallowRef<PresentedFrameBaseline | null>(null)
const displayFrameIndex = computed(
  () =>
    projectedPresentedFrameIndex(presentedFrameBaseline.value, observedCursor.value) ??
    authoritativeAnchor.value?.capture_frame_index ??
    '—',
)
const overlayVideoSize = shallowRef<{
  width: number
  height: number
} | null>(null)
const trackPopover = reactive({
  open: false,
  trackId: null as number | null,
  x: 0,
  y: 0,
})
const mappingRefreshToken = ref(0)
// An explicit click is sticky. Cursor-derived selection is only a fallback when
// the operator has not selected a segment themselves.
const selectedRallyId = workstationSelection.activeRallyId
const processingByRally = computed<Record<string, AnnotationRallyProcessingUpdate>>(() => {
  const merged: Record<string, AnnotationRallyProcessingUpdate> = {}
  for (const rally of coach.data.value?.match.rallies ?? [])
    merged[rally.id] = rally.submission.processing
  for (const [rallyId, update] of Object.entries(annotation.processing.value)) {
    merged[rallyId] = mergeRallyProcessingUpdate(merged[rallyId], update) ?? update
  }
  return merged
})
const activeProcessing = computed(() => {
  const rallyId = selectedRallyId.value
  return rallyId ? (processingByRally.value[rallyId] ?? null) : null
})
const syncRecovery = createSyncRecoveryService({
  room: annotation,
  core,
  actions: workstationActions,
  confirmation: workstationConfirmation,
  feedback: workstationFeedback,
  selectedRallyId: () => selectedRallyId.value,
  displayedRallyId: () => displayAnnotation.value?.rally_id ?? null,
  activeProcessing: () => activeProcessing.value,
  refreshCoach: coach.refresh,
})
const annotationResyncing = syncRecovery.resyncing
const processingRetrying = syncRecovery.processingRetrying
const notifiedProcessingFailures = new Set<string>()
let processingFailureWatchReady = false
let timelineRefreshTimer: ReturnType<typeof setTimeout> | null = null
let timelinePollDelayMs = 1_000
let lastCoachProcessingReconciliationAt = 0
const COACH_PROCESSING_RECONCILIATION_MS = 30_000
let captureRefreshInFlight = false
let cursorResolveTimer: ReturnType<typeof setTimeout> | null = null
let seekPreviewTimer: ReturnType<typeof setTimeout> | null = null
let optimisticSeekTimer: ReturnType<typeof setTimeout> | null = null
let omePlaybackRetryTimer: ReturnType<typeof setTimeout> | null = null
let cursorResolveInFlight = false
let pendingCursorResolve: PlaybackCursorInput | null = null
let lastCursorResolveAt = 0
let lastResolvedCursorKey = ''
let lastAutomaticCursorResolveKey = ''
let matchRefreshInFlight = false
let windowRecoveryInFlight = false
let playbackContinuationInFlight = false
let playbackHasStarted = false
let resumeAfterBuffering = false
let bufferingTargetCaptureTimeUs: string | null = null
let continuationWindowId: string | null = null
let continuationRequestedAt = 0
let continuationRetryDelayMs = 500
let continuationRetryTimer: ReturnType<typeof setTimeout> | null = null
let gapTransition: {
  sourceWindowId: string
  targetWindowId: string | null
  targetCaptureTimeUs: string
  gapDurationUs: string
  resumePlayback: boolean
} | null = null
let windowCreatePromise: ReturnType<typeof dvr.create> | null = null
let windowCreateTarget: string | undefined
let windowCreateMode: 'live' | 'archive' | undefined
const framePreviewTargetSeconds = ref<number | null>(null)
const framePreviewCaptureTimeUs = ref<string | null>(null)
let framePreviewRaf: number | null = null
let framePreviewWindowKey = ''
let estimatedFrameSeconds: number | null = null
let framePreviewCalibrationGeneration = 0
const framePreviewDurationByContext = new Map<string, number>()

const frameNavigation = useCoalescedFrameNavigation({
  preview: previewFrameStep,
  ready: frameStepReady,
  step: async (direction, count) => {
    if (!descriptor.value || !authoritativeAnchor.value) return null
    const previousCaptureUs = authoritativeAnchor.value.capture_time_us
    const previousContext = currentFramePreviewContext()
    const anchor = await dvr.step(direction, count, target => ({
      schema_version: '1.0.0',
      capture_session_id: descriptor.value!.capture_session_id,
      mode: descriptor.value!.mode,
      target_capture_time_us: target,
    }))
    if (!anchor) {
      if (dvr.error.value) throw dvr.error.value
      return null
    }
    rememberFramePreviewDuration(
      previousCaptureUs,
      anchor.capture_time_us,
      count,
      previousContext,
      currentFramePreviewContext(),
    )
    return anchor
  },
  apply: anchor => {
    overlayPlayer.value?.seekCanonicalFrame(anchor)
  },
  onError: error => {
    const anchor = authoritativeAnchor.value
    if (anchor && 'player_media_time_us' in anchor) overlayPlayer.value?.seekCanonicalFrame(anchor)
    mediaError.value = error instanceof Error ? error.message : '逐幀請求失敗'
  },
  onSettled: () => {
    clearFramePreviewState()
    frameGestureRouter.clear('player')
  },
  settleMs: 80,
  heldFlushMs: 80,
  holdWatchdogMs: 650,
  flushWhileHeld: true,
})
watch(
  currentFramePreviewContext,
  () => {
    void warmFramePreviewDuration()
  },
  { immediate: true },
)
const frameGestureRouter = createFrameNavigationGestureRouter({
  player: frameNavigation,
  'key-point': keyPointEditing.navigation,
})
watchEffect(() => {
  frameQueueRunning.value = frameNavigation.running.value
  frameQueuePending.value = frameNavigation.active.value
})
watch(frameStepReady, ready => {
  if (ready && frameNavigation.active.value) void frameNavigation.flush()
})
watch(
  () => dvr.status.value,
  status => {
    if ((status === 'gap' || status === 'error') && frameNavigation.active.value)
      frameNavigation.cancel()
  },
)

const controls = computed(() =>
  ANNOTATION_COMMANDS.map(command => ({
    ...command,
    key: formatBindingForDisplay(bindings.value[command.action]),
    ...commandAvailability(command.action),
  })),
)
watch(annotation.lastAutoCorrections, repairs => {
  const description = ballEventRepairNotice(repairs)
  if (description) toast.info('已自動校正球點', { description })
})

const selectedCapture = computed<CaptureSession | null>(() => {
  const sessions = (match.value?.captureSessions ?? [])
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '') || a.id.localeCompare(b.id),
    )
  const requestedCaptureId =
    typeof route.query.capture === 'string' ? route.query.capture.toLowerCase() : null
  return (
    sessions.find(session => session.id.toLowerCase() === requestedCaptureId) ??
    sessions.find(session =>
      ['STARTING', 'LIVE', 'STOPPING'].includes(session.status.toUpperCase()),
    ) ??
    sessions.find(session => session.timeline?.availableRanges.length) ??
    sessions[0] ??
    null
  )
})
const timeline = computed<CaptureTimeline | null>(() => {
  const durable = selectedCapture.value?.timeline ?? null
  if (!durable || !omeDirectPlaybackActive.value) return durable
  const availableRanges = projectOmeLiveTimelineRanges(
    durable.availableRanges,
    playerSeekableRanges.value,
    omeObservedCaptureTimeUs.value,
  )
  if (!availableRanges.length) return durable
  return {
    ...durable,
    availableRanges,
    captureStartTimeUs: availableRanges[0]!.startUs,
    liveEdgeCaptureTimeUs: availableRanges.at(-1)!.endUs,
  }
})
const restoredWorkstationState = computed(() => {
  const capture = selectedCapture.value
  if (!capture) return null
  return workstationViewState.restoredStateForCapture(
    capture.id,
    capture.timeline?.availableRanges ?? [],
  )
})
const maskPreviewCursor = ref<string | null>(null)
const workstation = useAnnotationWorkstationModel({
  coachData: coach.data,
  match,
  timeline,
  displayAnnotation,
  confirmedAnnotation: annotation.snapshot,
  roomSnapshots: annotation.activeRoomSnapshots,
  state,
  selectedRallyId,
  selectedKeyPoint,
  selectedTimelineItem,
  cursorRallyId,
  visualPlayhead: maskPreviewCursor,
})
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
  reservationSegmentRanges,
  selectedCurrentMask,
  currentMaskStatus,
  currentMaskLabel,
  currentMaskOutcome,
  currentMaskOutcomeSide,
  currentMaskOutcomeTeamLabel,
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
  displayOrdinalFor,
  displayRallyOrdinal,
  displaySetNumber,
} = workstation
// Reservation conflicts use canonical rally boundaries. Clip pre/post-roll is
// allowed to overlap and must not prevent an adjacent rally from ending.
const protectedSegmentRanges = reservationSegmentRanges
const selectedDraftForSides = computed(
  () => annotationDrafts.value.find(draft => draft.id === selectedRallyId.value) ?? null,
)
const selectedSideLeftTeamId = computed(
  () =>
    selectedSubmittedRally.value?.submission.left_team_id ??
    selectedDraftForSides.value?.left_team_id ??
    leftTeamId.value,
)
const selectedSideRightTeamId = computed(
  () =>
    selectedSubmittedRally.value?.submission.right_team_id ??
    selectedDraftForSides.value?.right_team_id ??
    rightTeamId.value,
)
const selectedSideLeftTeam = computed(
  () =>
    coach.data.value?.match.teams.find(team => team.id === selectedSideLeftTeamId.value) ??
    leftTeam.value,
)
const selectedSideRightTeam = computed(
  () =>
    coach.data.value?.match.teams.find(team => team.id === selectedSideRightTeamId.value) ??
    rightTeam.value,
)
const effectiveSetProjection = computed(() =>
  deriveSetDisplayProjection(coach.data.value?.match.sets ?? []),
)
const effectiveSetNumberFor = (rawSetNumber: number) =>
  effectiveSetProjection.value.rawToEffective.get(rawSetNumber) ?? rawSetNumber
const currentEffectiveSetNumber = computed(() =>
  currentSet.value ? effectiveSetNumberFor(currentSet.value.set_number) : null,
)
const commandDraftForSides = computed(
  () =>
    annotationDrafts.value.find(draft => draft.id === displayAnnotation.value?.rally_id) ?? null,
)
const commandLeftTeam = computed(
  () =>
    coach.data.value?.match.teams.find(
      team => team.id === commandDraftForSides.value?.left_team_id,
    ) ?? leftTeam.value,
)
const commandRightTeam = computed(
  () =>
    coach.data.value?.match.teams.find(
      team => team.id === commandDraftForSides.value?.right_team_id,
    ) ?? rightTeam.value,
)
function compactTeamLabel(team: { name: string; shortName: string | null } | null) {
  return team?.shortName?.trim() || team?.name.trim() || null
}
const commandLeftTeamLabel = computed(() => compactTeamLabel(commandLeftTeam.value))
const commandRightTeamLabel = computed(() => compactTeamLabel(commandRightTeam.value))
const ballEventActorOptions = computed(() => {
  const teams = match.value?.teams ?? []
  const teamOrder = new Map(teams.map((team, index) => [team.id, index]))
  return (match.value?.rosterEntries ?? [])
    .map(entry => {
      const team = teams.find(candidate => candidate.id === entry.teamId)
      const teamLabel = team?.shortName?.trim() || team?.name.trim() || '未分隊'
      return {
        id: entry.id,
        label: `${teamLabel} · #${entry.jerseyNumber} ${entry.name}`,
        teamId: entry.teamId,
        teamLabel,
        jerseyNumber: entry.jerseyNumber,
        playerName: entry.name,
        position: entry.position,
      }
    })
    .sort(
      (left, right) =>
        (teamOrder.get(left.teamId) ?? Number.MAX_SAFE_INTEGER) -
          (teamOrder.get(right.teamId) ?? Number.MAX_SAFE_INTEGER) ||
        Number.parseInt(left.jerseyNumber, 10) - Number.parseInt(right.jerseyNumber, 10) ||
        left.playerName.localeCompare(right.playerName, undefined, { sensitivity: 'base' }),
    )
})
const selectedSideLeftSetWins = computed(
  () =>
    coach.data.value?.match.sets.filter(
      set =>
        set.status.toLowerCase() === 'finished' &&
        set.winning_team_id === selectedSideLeftTeamId.value,
    ).length ?? 0,
)
const selectedSideRightSetWins = computed(
  () =>
    coach.data.value?.match.sets.filter(
      set =>
        set.status.toLowerCase() === 'finished' &&
        set.winning_team_id === selectedSideRightTeamId.value,
    ).length ?? 0,
)
const canReopenLastSet = computed(() => {
  const sets = [...(coach.data.value?.match.sets ?? [])].sort(
    (left, right) => right.set_number - left.set_number,
  )
  return sets.some(set => set.status.toLowerCase() === 'finished' && Boolean(set.winning_team_id))
})
const nextRallyOrdinal = computed(() => {
  const setId = currentSet.value?.id
  if (!setId) return 1
  const ordinals = [
    ...annotationDrafts.value.filter(draft => draft.set_id === setId).map(draft => draft.ordinal),
    ...submittedRallies.value.filter(rally => rally.set_id === setId).map(rally => rally.ordinal),
  ]
  return Math.max(0, ...ordinals) + 1
})
const currentOrdinaryDraft = computed(
  () =>
    [...annotationDrafts.value]
      .filter(
        draft =>
          draft.set_id === currentSet.value?.id &&
          !draft.active_submission_id &&
          (draft.annotation_status === 'open' || draft.annotation_status === 'ready'),
      )
      .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null,
)
const sideSwapEffectiveOrdinal = computed(
  () => currentOrdinaryDraft.value?.ordinal ?? nextRallyOrdinal.value,
)
const operationContextRallyId = computed(() => {
  const explicitId = workstationSelection.explicitRallyId.value
  if (explicitId) return explicitId
  const ordered = [...selectableSegmentRanges.value].sort((left, right) => {
    const difference = BigInt(left.startCaptureTimeUs) - BigInt(right.startCaptureTimeUs)
    return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
  })
  const cursor = visualPlayhead.value ? BigInt(visualPlayhead.value) : null
  const cursorIndex = cursorRallyId.value
    ? ordered.findIndex(item => item.id === cursorRallyId.value)
    : cursor === null
      ? -1
      : ordered.reduce(
          (last, item, index) => (BigInt(item.startCaptureTimeUs) <= cursor ? index : last),
          -1,
        )
  return cursorIndex > 0 ? (ordered[cursorIndex - 1]?.id ?? null) : (ordered[0]?.id ?? null)
})
const operationContextRally = computed(() => {
  const rallyId = operationContextRallyId.value
  if (!rallyId) return null
  return (
    annotationDrafts.value.find(draft => draft.id === rallyId) ??
    submittedRallies.value.find(rally => rally.id === rallyId) ??
    null
  )
})
const selectedSideSwapTarget = computed<SideSwapTarget | null>(() => {
  const selectedDraft =
    operationContextRally.value && 'active_submission_id' in operationContextRally.value
      ? operationContextRally.value
      : null
  if (selectedDraft?.set_id && selectedDraft.left_team_id && selectedDraft.right_team_id) {
    return {
      rallyId: selectedDraft.id,
      effectiveFromRallyOrdinal: selectedDraft.ordinal,
      expectedLeftTeamId: selectedDraft.left_team_id,
      expectedRightTeamId: selectedDraft.right_team_id,
      displaySetNumber: selectedDraft.display_set_number,
      isDraft: true,
      label: `第 ${displayOrdinalFor(selectedDraft.id)} 回合起`,
      setId: selectedDraft.set_id,
    }
  }
  const selectedRally =
    operationContextRally.value && 'submission' in operationContextRally.value
      ? operationContextRally.value
      : null
  if (selectedRally) {
    return {
      rallyId: selectedRally.id,
      effectiveFromRallyOrdinal: selectedRally.ordinal,
      expectedLeftTeamId: selectedRally.submission.left_team_id,
      expectedRightTeamId: selectedRally.submission.right_team_id,
      displaySetNumber: selectedRally.display_set_number,
      isDraft: false,
      label: `第 ${displayOrdinalFor(selectedRally.id)} 回合起`,
      setId: selectedRally.set_id,
    }
  }
  const currentDraft = currentOrdinaryDraft.value
  if (currentDraft?.set_id && currentDraft.left_team_id && currentDraft.right_team_id) {
    return {
      rallyId: currentDraft.id,
      effectiveFromRallyOrdinal: currentDraft.ordinal,
      expectedLeftTeamId: currentDraft.left_team_id,
      expectedRightTeamId: currentDraft.right_team_id,
      displaySetNumber: currentDraft.display_set_number,
      isDraft: true,
      label: `第 ${displayOrdinalFor(currentDraft.id)} 回合起`,
      setId: currentDraft.set_id,
    }
  }
  if (currentSet.value?.id && leftTeamId.value && rightTeamId.value) {
    return {
      rallyId: null,
      effectiveFromRallyOrdinal: sideSwapEffectiveOrdinal.value,
      expectedLeftTeamId: leftTeamId.value,
      expectedRightTeamId: rightTeamId.value,
      displaySetNumber: currentSet.value.set_number,
      isDraft: false,
      label: `第 ${sideSwapEffectiveOrdinal.value} 回合起`,
      setId: currentSet.value.id,
    }
  }
  return null
})
const clipSelected = computed(() =>
  Boolean(
    selectedRallyId.value &&
    (selectedTimelineItem.value === 'segment' ||
      selectedTimelineItem.value === 'mask' ||
      selectedTimelineItem.value === 'point'),
  ),
)
const segmentManagement = createSegmentManagementService({
  matchId,
  core,
  coach: coachDomain,
  room: annotation,
  selection: workstationSelection,
  timeline: timelineSelection,
  actions: workstationActions,
  confirmation: workstationConfirmation,
  feedback: workstationFeedback,
  editReady: () => metadataMutationReady.value,
  canReopenLastSet: () => canReopenLastSet.value,
  currentSet: () => currentSet.value,
  effectiveSetNumberFor,
  currentEffectiveSetNumber: () => currentEffectiveSetNumber.value,
  leftTeam: () => leftTeam.value,
  rightTeam: () => rightTeam.value,
  currentDraft: () => Boolean(currentOrdinaryDraft.value),
  sideSwapEffectiveOrdinal: () => sideSwapEffectiveOrdinal.value,
  sideSwapTarget: () => selectedSideSwapTarget.value,
  displayOrdinalFor,
  selectedRallyId: () => selectedRallyId.value,
  selectedSubmissionId: () => selectedRally.value?.submission.id ?? null,
  clipSelected: () => clipSelected.value,
  teamById: teamId => coach.data.value?.match.teams.find(team => team.id === teamId) ?? null,
  refreshMatch: () => loadMatch({ silent: true }),
  refreshCoach: coach.refresh,
  closePlacement: () => matchInspector.value?.closePlacement(),
})
const displayedCorrectionDraft = computed(() =>
  Boolean(
    ['OPEN', 'READY'].includes(state.value) &&
    displayAnnotation.value?.snapshot.active_submission_id,
  ),
)
const selectedCorrectionDraft = computed(() =>
  Boolean(
    clipSelected.value &&
    displayedCorrectionDraft.value &&
    selectedRallyId.value === (correctionRallyId.value ?? displayAnnotation.value?.rally_id),
  ),
)
const selectedSubmissionPending = computed(() => {
  const rallyId = selectedRallyId.value
  if (!rallyId) return false
  return annotation.pendingCommands.value.some(
    entry =>
      entry.status === 'pending' &&
      entry.command.kind === 'SUBMIT_RALLY' &&
      entry.command.rally_id === rallyId,
  )
})
const correctionBlockReason = computed(() => {
  if (annotation.outboxNeedsConfirmation.value) return '標記狀態有衝突；按下後可先重新同步'
  if (annotation.pendingCount.value > 0) return '前一筆標記操作仍在同步；按下可查看目前狀態'
  if (annotation.busy.value || pendingTimelineMove.value) return '目前操作完成後即可建立修正版'
  return null
})
const editorSelectedAnalysisRunId = computed(() =>
  selectedCorrectionDraft.value ? null : selectedAnalysisRunId.value,
)
// A correction edits human annotation truth, not the predecessor analysis.
// Keep that completed run available as a read-only overlay for visual context;
// only the analysis editor itself is disabled until the correction is sent.
const editorOverlayAnalysisRunId = computed(
  () => activeOverlayAnalysisRunId.value ?? selectedAnalysisRunId.value,
)
const editorOverlayClipStart = computed(
  () =>
    activeOverlayClipStart.value ??
    submittedRallies.value.find(rally => rally.id === selectedRallyId.value)?.submission.clip
      ?.start_capture_time_us ??
    null,
)
const editorMappingAvailable = computed(
  () => !selectedCorrectionDraft.value && mappingAvailable.value,
)
const editorMappingCompleted = computed(() =>
  Boolean(selectedRally.value?.submission.analysis?.identity_mapping_completed),
)
const overlayReplay = shallowRef<CoachRallyReplay | null>(null)
let overlayReplayGeneration = 0
async function refreshOverlayReplay() {
  const generation = ++overlayReplayGeneration
  const rallyId = selectedRallyId.value
  const analysisId = editorOverlayAnalysisRunId.value
  if (!rallyId || !analysisId) {
    overlayReplay.value = null
    return
  }
  // Never keep the previous rally's track metadata visible while the new
  // replay is loading. The selected rally's side projection remains available
  // as the temporary label fallback below.
  overlayReplay.value = null
  try {
    const replay = await coachDomain.rallyReplay(rallyId)
    const replayAnalysisId = replay?.analysis?.id ?? null
    if (generation === overlayReplayGeneration)
      overlayReplay.value = replay && replayAnalysisId === analysisId ? replay : null
  } catch {
    if (generation === overlayReplayGeneration) overlayReplay.value = null
  }
}
watch(
  [selectedRallyId, editorOverlayAnalysisRunId],
  () => {
    void refreshOverlayReplay()
  },
  { immediate: true },
)
const overlayEvents = computed(() =>
  annotationOverlayEnabled.value ? (overlayReplay.value?.analysis?.contact_events ?? []) : [],
)
const overlayTracks = computed(
  () =>
    overlayReplay.value?.analysis?.tracks.map(track => ({
      trackId: track.track_id,
      courtSide: track.court_side,
      label: track.identity?.name ?? null,
      gidLabel: track.global_identity?.label ?? null,
      jerseyNumber: track.identity?.jersey_number ?? null,
    })) ?? [],
)
const overlayIdentityLabels = computed(() =>
  Object.fromEntries(
    overlayTracks.value.flatMap(track => (track.label ? [[track.trackId, track.label]] : [])),
  ),
)
const overlayTeamLabels = computed(() => ({
  left:
    overlayReplay.value?.rally.left_team.shortName ||
    overlayReplay.value?.rally.left_team.name ||
    selectedSideLeftTeam.value?.shortName ||
    selectedSideLeftTeam.value?.name ||
    '左隊',
  right:
    overlayReplay.value?.rally.right_team.shortName ||
    overlayReplay.value?.rally.right_team.name ||
    selectedSideRightTeam.value?.shortName ||
    selectedSideRightTeam.value?.name ||
    '右隊',
}))
const analysisReview = useAnalysisReview(editorSelectedAnalysisRunId)
const confirmSecondaryLabel = computed(
  () => workstationConfirmation.current.value?.secondaryLabel ?? null,
)
const analysisOverlayActive = computed(() =>
  Boolean(
    annotationOverlayEnabled.value &&
    editorSelectedAnalysisRunId.value &&
    editorSelectedAnalysisRunId.value === editorOverlayAnalysisRunId.value &&
    currentOverlayFrame.value >= 0,
  ),
)
const currentBallOverride = computed(
  () => analysisReview.ballCorrections.value.get(String(currentOverlayFrame.value)) ?? null,
)
const currentBallPosition = computed(() =>
  currentBallOverride.value?.state === 'position' ? currentBallOverride.value.position : null,
)
const allBallCorrections = computed<Record<number, OverlayBallOverride>>(() =>
  Object.fromEntries(
    [...analysisReview.ballCorrections.value].map(([frame, correction]) => [
      Number(frame),
      correction,
    ]),
  ),
)
const currentActionCorrections = computed<Record<number, string>>(() => {
  const values: Record<number, string> = {}
  const prefix = `${currentOverlayFrame.value}:`
  for (const [key, action] of analysisReview.actionCorrections.value)
    if (key.startsWith(prefix)) values[Number(key.slice(prefix.length))] = action
  return values
})
const allPlayerBBoxCorrections = computed<Record<number, Record<number, AnalysisFrameBBox>>>(() => {
  const values: Record<number, Record<number, AnalysisFrameBBox>> = {}
  for (const [key, bbox] of analysisReview.playerBBoxCorrections.value) {
    const [frameText, trackText] = key.split(':')
    const frame = Number(frameText)
    const track = Number(trackText)
    values[frame] = { ...values[frame], [track]: bbox }
  }
  return values
})
const contactActorCorrections = computed<Record<string, number | null>>(() =>
  Object.fromEntries(analysisReview.contactActorCorrections.value),
)
const contactActorProjections = computed<Record<string, number | null>>(() =>
  Object.fromEntries(
    [...analysisReview.contactActorProjections.value]
      .filter(([, projection]) => projection.status === 'ready')
      .map(([keyPointId, projection]) => [keyPointId, projection.track_id]),
  ),
)
const analysisDependenciesPending = computed(() =>
  [...analysisReview.contactActorProjections.value.values()].some(
    projection => projection.status === 'pending' || projection.status === 'running',
  ),
)
const contactTimeCorrections = computed<Record<string, number>>(() =>
  Object.fromEntries(analysisReview.contactTimeCorrections.value),
)
function effectiveContactFrame(keyPointId: string, fallbackFrame: number) {
  return analysisReview.contactTimeCorrections.value.get(keyPointId) ?? fallbackFrame
}
const analysisHitItems = computed(() =>
  [
    ...overlayEvents.value
      .filter(event => !analysisReview.contactEdits.value.get(event.key_point_id)?.deleted)
      .map(event => {
        const frameIndex = effectiveContactFrame(event.key_point_id, replayEventFrame(event))
        const manual = analysisReview.contactActorCorrections.value.has(event.key_point_id)
        const projection = analysisReview.contactActorProjections.value.get(event.key_point_id)
        const position = overlayVideoSize.value
          ? resolveEffectiveHitPosition(
              {
                ballCorrections: allBallCorrections.value,
                contactTimeCorrections: contactTimeCorrections.value,
                chunk: null,
                videoWidth: overlayVideoSize.value.width,
                videoHeight: overlayVideoSize.value.height,
              },
              event,
            )
          : null
        const trackId = manual
          ? (analysisReview.contactActorCorrections.value.get(event.key_point_id) ?? null)
          : projection?.status === 'ready'
            ? projection.track_id
            : overlayVideoSize.value
              ? resolveEventActorFromResult(
                  event,
                  position,
                  overlayVideoSize.value.width,
                  overlayVideoSize.value.height,
                )
              : ((event.actors[0] ?? event.candidates[0])?.track_id ?? null)
        const exactBall = analysisReview.ballCorrections.value.get(String(frameIndex))
        return {
          keyPointId: event.key_point_id,
          sequenceIndex: event.sequence_index,
          frameIndex,
          anchorSource:
            event.anchor_origin === 'ai_detected' ? ('ai' as const) : ('human' as const),
          anchorConfidence: event.detection_confidence ?? null,
          timeAdjusted: analysisReview.contactTimeCorrections.value.has(event.key_point_id),
          actorTrackId: trackId,
          actorLabel:
            projection?.status === 'failed' && !manual
              ? '關聯待重試'
              : trackId === null
                ? projection?.status === 'ready'
                  ? '無法判定'
                  : '沒人打'
                : (overlayIdentityLabels.value[trackId] ?? `Track ${trackId}`),
          actorSource: manual
            ? trackId === null
              ? ('none' as const)
              : ('manual' as const)
            : projection?.status === 'pending' || projection?.status === 'running'
              ? ('pending' as const)
              : projection?.status === 'failed'
                ? ('failed' as const)
                : ('auto' as const),
          ballLabel:
            exactBall?.state === 'position'
              ? '人工球點'
              : exactBall?.state === 'missing'
                ? position
                  ? '回溯球點'
                  : '無球點'
                : event.ball.frame_pos
                  ? 'AI 球點'
                  : position
                    ? '回溯球點'
                    : '無球點',
        }
      }),
    ...[...analysisReview.contactEdits.value.values()]
      .filter(edit => !edit.base_key_point_id && !edit.deleted)
      .map(edit => ({
        keyPointId: edit.contact_id,
        sequenceIndex: 0,
        frameIndex: effectiveContactFrame(edit.contact_id, Number(edit.frame_index)),
        anchorSource: 'manual' as const,
        anchorConfidence: null,
        timeAdjusted: analysisReview.contactTimeCorrections.value.has(edit.contact_id),
        actorTrackId: edit.track_id,
        actorLabel:
          edit.track_id === null
            ? '尚未指派'
            : (overlayIdentityLabels.value[edit.track_id] ?? `Track ${edit.track_id}`),
        actorSource: edit.track_id === null ? ('none' as const) : ('manual' as const),
        ballLabel: '人工新增',
      })),
  ]
    .sort((left, right) => left.frameIndex - right.frameIndex)
    .map((hit, sequenceIndex) => ({ ...hit, sequenceIndex })),
)
const removedAnalysisHitItems = computed(() =>
  [...analysisReview.contactEdits.value.values()]
    .filter(edit => edit.deleted)
    .map(edit => {
      const base = edit.base_key_point_id
        ? overlayEvents.value.find(event => event.key_point_id === edit.base_key_point_id)
        : null
      return {
        keyPointId: edit.contact_id,
        frameIndex: Number(edit.frame_index),
        label: edit.base_key_point_id
          ? base?.anchor_origin === 'ai_detected'
            ? 'AI 擊球建議'
            : '人工 X 碰撞'
          : '人工新增擊球點',
      }
    })
    .sort((left, right) => left.frameIndex - right.frameIndex),
)
const analysisRevision = createAnalysisRevisionService({
  manager: workstationActions,
  review: analysisReview,
  feedback: workstationFeedback,
  selectedAnalysisRunId: () => editorSelectedAnalysisRunId.value,
  overlayActive: () => analysisOverlayActive.value,
  currentFrame: currentOverlayFrame,
  hits: () => analysisHitItems.value,
  resolveHitFrame: keyPointId => {
    const event = overlayEvents.value.find(candidate => candidate.key_point_id === keyPointId)
    if (event) return effectiveContactFrame(keyPointId, replayEventFrame(event))
    const manual = analysisReview.contactEdits.value.get(keyPointId)
    return manual && !manual.deleted ? Number(manual.frame_index) : null
  },
  seekFrame: frameIndex => {
    const captureTime = overlayPlayer.value?.overlayFrameCaptureTime(frameIndex)
    if (captureTime) return seekTimeline(captureTime)
    prepareAuthoritativeSeek()
    overlayPlayer.value?.seekOverlayFrameIfBuffered(frameIndex)
  },
  refreshCoach: coach.refresh,
  refreshOverlay: refreshOverlayReplay,
  dependenciesPending: () => analysisDependenciesPending.value,
  hasBallOverride: () => Boolean(currentBallOverride.value),
  hasBBoxOverride: () => currentBBoxHasOverride.value,
  hasActorOverride: () => selectedAnalysisHitHasOverride.value,
  hasActionOverride: () => currentActionHasOverride.value,
})
const identityAssignment = createIdentityAssignmentControllerService(
  {
    matchId,
    analysisRunId: editorSelectedAnalysisRunId,
    currentFrame: currentOverlayFrame,
    enabled: editorMappingAvailable,
    refreshKey: mappingRefreshToken,
    refreshAfterCommit: true,
    onChanged: handleMappingChanged,
    onCommitted: () => {
      trackPopover.open = false
    },
  },
  coachDomain,
  workstationActions,
)
const analysisRevisionMode = analysisRevision.revisionMode
const analysisPanelPage = analysisRevision.panelPage
const ballRelabelEnabled = analysisRevision.ballRelabelEnabled
const bboxRelabelEnabled = analysisRevision.bboxRelabelEnabled
const actorAssignmentMode = analysisRevision.actorAssignmentMode
const selectedOverlayTrackId = analysisRevision.selectedTrackId
const selectedOverlayTrackAction = analysisRevision.selectedTrackAction
const selectedAnalysisHitId = analysisRevision.selectedHitId
const selectedOverlayAction = computed(() =>
  selectedOverlayTrackId.value === null
    ? null
    : (currentActionCorrections.value[selectedOverlayTrackId.value] ??
      selectedOverlayTrackAction.value),
)
const currentActionHasOverride = computed(
  () =>
    selectedOverlayTrackId.value !== null &&
    analysisReview.actionCorrections.value.has(
      `${currentOverlayFrame.value}:${selectedOverlayTrackId.value}`,
    ),
)
const currentBBoxHasOverride = computed(
  () =>
    selectedOverlayTrackId.value !== null &&
    analysisReview.playerBBoxCorrections.value.has(
      `${currentOverlayFrame.value}:${selectedOverlayTrackId.value}`,
    ),
)
const selectedAnalysisHit = computed(
  () =>
    overlayEvents.value.find(event => event.key_point_id === selectedAnalysisHitId.value) ?? null,
)
const selectedAnalysisHitHasOverride = computed(() =>
  Boolean(
    selectedAnalysisHitId.value &&
    analysisReview.contactActorCorrections.value.has(selectedAnalysisHitId.value),
  ),
)
const analysisToolboxMode = computed<'ball' | 'bbox' | 'actor' | 'track' | null>(() => {
  if (
    !analysisRevisionMode.value ||
    !analysisOverlayActive.value ||
    inspectorTab.value !== 'analysis'
  )
    return null
  if (analysisPanelPage.value === 'hits' && selectedAnalysisHitId.value) return 'actor'
  if (analysisPanelPage.value === 'ball') return 'ball'
  if (analysisPanelPage.value !== 'players') return null
  return bboxRelabelEnabled.value && selectedOverlayTrackId.value !== null ? 'bbox' : 'track'
})
watch(analysisHitItems, () => {
  analysisRevision.reconcileHits()
})
watch(inspectorTab, tab => {
  if (tab === 'analysis') return
  analysisRevision.closePanel()
  if (tab !== 'mapping') trackPopover.open = false
})

const displayedTimelineSegments = computed(() => {
  const rallyId = selectedRallyId.value
  if (!analysisRevisionMode.value || !rallyId) return timelineSegments.value
  const points = analysisHitItems.value.flatMap(hit => {
    const captureTimeUs = overlayPlayer.value?.overlayFrameCaptureTime(hit.frameIndex) ?? null
    return captureTimeUs
      ? [
          {
            id: hit.keyPointId,
            markerKind: 'contact',
            isTerminal: false,
            captureTimeUs,
          },
        ]
      : []
  })
  // Do not publish a partially mapped optimistic rail. Once the overlay timing
  // manifest is ready every frame resolves; until then the canonical server rail
  // remains visible.
  if (points.length !== analysisHitItems.value.length) return timelineSegments.value
  return timelineSegments.value.map(segment =>
    segment.id === rallyId ? { ...segment, points } : segment,
  )
})
const timelineCurrentMaskSelected = computed(
  () =>
    selectedRallyId.value !== null &&
    selectedRallyId.value === (displayAnnotation.value?.rally_id ?? null),
)
const selectedHistoricalSegmentId = computed(() =>
  timelineCurrentMaskSelected.value ? null : selectedRallyId.value,
)
const selectedCaptureId = computed(() => selectedCapture.value?.id ?? null)
const playbackMode = computed(() =>
  capturePlaybackMode({
    endedAt: selectedCapture.value?.endedAt,
    sourceKind: selectedCapture.value?.sourceKind,
    status: selectedCapture.value?.status,
  }),
)
const liveCapture = computed(() => playbackMode.value === 'active_live')
const configuredLiveMediaBackend = computed(() =>
  liveMediaBackend(runtimeConfig.public.liveMediaBackend),
)
const omeLiveSourceCandidate = computed<OmeLivePlaybackSource | null>(() => {
  const capture = selectedCapture.value
  if (
    configuredLiveMediaBackend.value !== 'ome_experiment' ||
    !liveCapture.value ||
    !capture?.ingestPath ||
    omePlaybackFailed.value
  )
    return null
  return {
    backend: 'ome_llhls',
    captureSessionId: capture.id,
    manifestUrl: omeLiveManifestUrl(publicEndpoints.liveHlsBaseUrl.value, capture.ingestPath),
    presentationAnchors: (capture.livePresentationAnchors ?? []).map(anchor => ({
      captureTimeOriginUs: anchor.captureTimeOriginUs,
      programDateTime: anchor.programDateTime,
      sequenceIndex: anchor.sequenceIndex,
    })),
  }
})
const omeLiveSource = computed<OmeLivePlaybackSource | null>(() =>
  omeArchivePlaybackActive.value ? null : omeLiveSourceCandidate.value,
)
const omeDirectPlaybackAvailable = computed(() => Boolean(omeLiveSourceCandidate.value))
watch(
  omeLiveSource,
  source => {
    omeDirectPlaybackActive.value = Boolean(source)
    if (!source) {
      omeAtLiveEdge.value = false
      omeCanonicalTimeValidated.value = false
      omeObservedCaptureTimeUs.value = null
    }
  },
  { immediate: true },
)
const timelineEndTarget = computed(
  () =>
    timeline.value?.liveEdgeCaptureTimeUs ?? timeline.value?.availableRanges.at(-1)?.endUs ?? null,
)
const liveTarget = computed(() =>
  liveCapture.value && timelineEndTarget.value
    ? clampLiveEdgeTarget(timelineEndTarget.value, timeline.value?.availableRanges ?? [])
    : null,
)
const visualPlayhead = computed(() => {
  if (omeDirectPlaybackActive.value && omeObservedCaptureTimeUs.value)
    return omeObservedCaptureTimeUs.value
  if (frameNavigation.active.value && framePreviewCaptureTimeUs.value)
    return framePreviewCaptureTimeUs.value
  const selectedPointPreview = selectedKeyPointId.value
    ? keyPointEditing.optimisticMoves.value[selectedKeyPointId.value]
    : null
  if (keyPointEditing.navigation.active.value && selectedPointPreview) return selectedPointPreview
  if (optimisticSeekCaptureTimeUs.value) return optimisticSeekCaptureTimeUs.value
  const cursor = observedCursor.value
  const window = descriptor.value
  if (
    !cursor ||
    cursor.schema_version !== '1.0.0' ||
    !window ||
    cursor.playback_window_id !== window.playback_window_id ||
    cursor.mapping_version !== window.mapping_version
  )
    return authoritativeAnchor.value?.capture_time_us ?? null
  const projected =
    BigInt(window.presentation_origin_capture_us) + BigInt(cursor.player_media_time_us)
  const start = BigInt(window.window_capture_start_us)
  const end = BigInt(window.window_capture_end_us)
  return (projected < start ? start : projected > end ? end : projected).toString()
})
// A paused VOD frame can remain visually stable while the browser cursor
// briefly reports stale/seeking during a window refresh. Reuse the current
// window mapping and canonical visual playhead for commands in that narrow
// state; the server still resolves and validates the cursor.
const annotationCommandCursor = computed<PlaybackCursorInput | null>(() => {
  const cursor = observedCursor.value
  const currentDescriptor = descriptor.value
  const targetCaptureTimeUs = visualPlayhead.value
  if (
    omeDirectPlaybackActive.value ||
    !cursor ||
    cursor.schema_version !== '1.0.0' ||
    !currentDescriptor ||
    cursor.playback_window_id !== currentDescriptor.playback_window_id ||
    cursor.mapping_version !== currentDescriptor.mapping_version ||
    !targetCaptureTimeUs
  )
    return cursor
  try {
    const target = BigInt(targetCaptureTimeUs)
    const windowStart = BigInt(currentDescriptor.window_capture_start_us)
    const windowEnd = BigInt(currentDescriptor.window_capture_end_us)
    if (target < windowStart || target > windowEnd) return cursor
    const playerMediaTimeUs = target - BigInt(currentDescriptor.presentation_origin_capture_us)
    if (playerMediaTimeUs < 0n) return cursor
    return {
      ...cursor,
      player_media_time_us: playerMediaTimeUs.toString(),
      observation_source: 'current_time_fallback',
      presented_frames: null,
      cursor_status: 'ready',
    }
  } catch {
    return cursor
  }
})
const navigableKeyPoints = computed(() => {
  const currentRallyId = displayAnnotation.value?.rally_id ?? null
  const activeSubmissionId = displayAnnotation.value?.snapshot.active_submission_id
  const submitted = submittedRallies.value.flatMap(rally =>
    rally.id === currentRallyId ||
    isSupersededSourceSubmission({
      activeSubmissionId,
      currentRallyId,
      rallyId: rally.id,
      submissionId: rally.submission.id,
    })
      ? []
      : rally.submission.key_points.map(point => ({
          id: point.id,
          captureTimeUs: point.capture_time_us,
          rallyId: rally.id,
          editable: false,
        })),
  )
  const drafts = annotationDrafts.value.flatMap(draft =>
    draft.id === currentRallyId
      ? []
      : draft.key_points.map(point => ({
          id: point.id,
          captureTimeUs: point.capture_time_us,
          rallyId: draft.id,
          editable: ['open', 'ready'].includes(draft.annotation_status),
        })),
  )
  const current = (displayAnnotation.value?.snapshot.key_points ?? []).map(point => ({
    id: point.key_point_id,
    captureTimeUs: point.capture_time_us,
    rallyId: currentRallyId,
    editable: editableDraftState.value,
  }))
  return [...submitted, ...drafts, ...current].sort((left, right) => {
    const difference = BigInt(left.captureTimeUs) - BigInt(right.captureTimeUs)
    return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
  })
})
const selectedEditableKeyPoint = computed(() =>
  Boolean(
    selectedTimelineItem.value === 'point' && selectedKeyPoint.value && editableDraftState.value,
  ),
)
const defaultPlaybackTarget = computed(() => {
  const availableRanges = timeline.value?.availableRanges ?? []
  const restoredCursor = restoredWorkstationState.value?.cursorCaptureTimeUs
  if (restoredCursor && readyAt(restoredCursor, availableRanges)) return restoredCursor
  if (liveCapture.value) return timelineEndTarget.value

  const earliestKeyPoint = navigableKeyPoints.value.find(point =>
    readyAt(point.captureTimeUs, availableRanges),
  )?.captureTimeUs
  if (earliestKeyPoint) return earliestKeyPoint

  return availableRanges[0]?.startUs ?? null
})
const defaultPlaybackWindowMode = computed<'live' | 'archive'>(() =>
  restoredWorkstationState.value?.cursorCaptureTimeUs
    ? 'archive'
    : liveCapture.value
      ? 'live'
      : 'archive',
)
const syncNeedsAttention = computed(
  () =>
    annotation.outboxNeedsConfirmation.value ||
    ['reconnecting', 'closed'].includes(annotation.connection.value),
)
const syncLabel = computed(() =>
  annotationResyncing.value
    ? 'WS 重新同步中'
    : annotation.outboxNeedsConfirmation.value
      ? 'WS 需重新同步'
      : ['connecting', 'reconnecting'].includes(annotation.connection.value)
        ? 'WS 連線中'
        : annotation.connection.value === 'ready'
          ? 'WS 正常'
          : 'WS 離線',
)
const displayTimecode = computed(() =>
  formatTimelinePosition(visualPlayhead.value, timeline.value?.captureStartTimeUs),
)
const mediaEmptyLabel = computed(() => {
  if (!selectedCapture.value) return '尚未加入媒體'
  if (playbackMode.value === 'failed') return '影音來源無法使用'
  if (playbackMode.value === 'starting') return '正在連接影音來源'
  if (playbackMode.value === 'progressive_vod') return '影片載入中'
  return '媒體緩衝中'
})
const annotationActions = createAnnotationActionService({
  manager: workstationActions,
  room: annotation,
  commandReady,
  state,
  correctionActive,
  canMark,
  visualPlayhead,
  authoritativeFrameIndex: computed(() => authoritativeAnchor.value?.capture_frame_index ?? null),
  selectedKeyPointId,
  displayAnnotation,
  observedCursor: annotationCommandCursor,
  clipPreRollUs,
  clipPostRollUs,
  protectedSegments: protectedSegmentRanges,
  incompleteResultsNeedConfirmation,
  requestIncompleteResultsConfirmation,
  correctionSubmitRequired: computed(() => Boolean(displayedCorrectionDraft.value)),
  requestCorrectionSubmit,
  eventEditReady: computed(() => editableDraftState.value && draftMutationReady.value),
  submitReady: computed(
    () => editableDraftState.value && draftMutationReady.value && !correctionSubmitting.value,
  ),
})

function commandAvailability(action: AnnotationAction) {
  return annotationActions.availability(action)
}

function formatDuration(value?: string | null) {
  if (!value) return '—'
  const seconds = Number(BigInt(value)) / 1_000_000
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} 秒`
}

async function loadMatch(options: { silent?: boolean } = {}) {
  if (matchRefreshInFlight) return
  matchRefreshInFlight = true
  try {
    const nextMatch = await core.match(matchId)
    if (!nextMatch) {
      if (!options.silent) loadError.value = '找不到此場次，請返回賽事列表。'
      return
    }
    match.value = nextMatch
    loadError.value = null
  } catch (error) {
    if (!options.silent)
      loadError.value = error instanceof Error ? error.message : '場次資料載入失敗'
  } finally {
    matchRefreshInFlight = false
  }
}

async function refreshSelectedCapture(): Promise<CapturePollOutcome> {
  const captureId = selectedCaptureId.value
  if (!captureId || document.visibilityState !== 'visible' || captureRefreshInFlight)
    return 'skipped'
  captureRefreshInFlight = true
  try {
    const previous = selectedCapture.value
    const capture = await core.captureSession(captureId)
    if (!capture || !match.value?.captureSessions) return 'failed'
    const changed =
      previous?.status !== capture.status ||
      previous?.health !== capture.health ||
      previous?.timeline?.timelineVersion !== capture.timeline?.timelineVersion ||
      previous?.timeline?.liveEdgeCaptureTimeUs !== capture.timeline?.liveEdgeCaptureTimeUs ||
      previous?.timeline?.ingestFrontierCaptureTimeUs !==
        capture.timeline?.ingestFrontierCaptureTimeUs ||
      previous?.timeline?.availabilityComplete !== capture.timeline?.availabilityComplete
    match.value = {
      ...match.value,
      captureSessions: match.value.captureSessions.map(current =>
        current.id === capture.id ? capture : current,
      ),
    }
    return changed ? 'changed' : 'unchanged'
  } catch {
    // Keep the existing descriptor usable. A self-scheduling poller backs off
    // instead of stacking requests while the network is degraded.
    return 'failed'
  } finally {
    captureRefreshInFlight = false
  }
}

function scheduleTimelineRefresh(delayMs = timelinePollDelayMs, replace = false) {
  if (timelineRefreshTimer) {
    if (!replace) return
    clearTimeout(timelineRefreshTimer)
  }
  timelineRefreshTimer = setTimeout(
    () => {
      timelineRefreshTimer = null
      void runTimelineRefreshCycle()
    },
    Math.max(0, delayMs),
  )
}

async function runTimelineRefreshCycle() {
  const online = navigator.onLine
  if (document.visibilityState !== 'visible' || !online) {
    timelinePollDelayMs = nextCapturePollDelay(timelinePollDelayMs, 'skipped', online)
    scheduleTimelineRefresh()
    return
  }

  maintainPlaybackWindow()
  const captureActive = captureNeedsPolling(selectedCapture.value?.status)
  const processingActive = hasActiveRallyProcessing(coach.data.value?.match.rallies)
  const now = Date.now()
  const reconcileCoach =
    processingActive &&
    now - lastCoachProcessingReconciliationAt >= COACH_PROCESSING_RECONCILIATION_MS
  const capturePromise = captureActive
    ? refreshSelectedCapture()
    : Promise.resolve<CapturePollOutcome>('skipped')
  if (reconcileCoach) lastCoachProcessingReconciliationAt = now
  // Processing progress arrives through the annotation WebSocket. This slow
  // reconciliation catches a missed event without downloading the full coach
  // dashboard state on every timeline poll.
  const coachPromise = reconcileCoach
    ? Promise.resolve(coach.refresh()).then(
        () => false,
        () => {
          lastCoachProcessingReconciliationAt = 0
          return true
        },
      )
    : Promise.resolve(false)
  const [captureOutcome, coachFailed] = await Promise.all([capturePromise, coachPromise])
  const outcome: CapturePollOutcome = coachFailed
    ? 'failed'
    : captureOutcome === 'skipped' && processingActive
      ? 'unchanged'
      : captureOutcome
  timelinePollDelayMs = nextCapturePollDelay(timelinePollDelayMs, outcome, true)
  scheduleTimelineRefresh()
}

function resumeTimelineRefresh() {
  if (document.visibilityState !== 'visible' || !navigator.onLine) return
  timelinePollDelayMs = 1_000
  scheduleTimelineRefresh(0, true)
}

async function resolveLatestCursor() {
  cursorResolveTimer = null
  if (cursorResolveInFlight || !pendingCursorResolve) return
  const cursor = pendingCursorResolve
  pendingCursorResolve = null
  if (cursor.schema_version !== '1.0.0') return
  cursorResolveInFlight = true
  lastCursorResolveAt = performance.now()
  try {
    const resolved = await dvr.resolve(cursor)
    if (resolved) {
      lastResolvedCursorKey = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}:${cursor.player_media_time_us}`
      presentedFrameBaseline.value = createPresentedFrameBaseline(resolved, cursor)
    }
    if (await keyPointEditing.completeResolvedMove(cursor, resolved)) return
  } catch (error) {
    mediaError.value = error instanceof Error ? error.message : '游標解析失敗'
  } finally {
    cursorResolveInFlight = false
    scheduleCursorResolve()
  }
}

function scheduleCursorResolve(force = false) {
  if (!pendingCursorResolve || cursorResolveInFlight || cursorResolveTimer) return
  if (!force && !pendingTimelineMove.value) return
  const interval = 0
  const delay = Math.max(0, interval - (performance.now() - lastCursorResolveAt))
  cursorResolveTimer = setTimeout(resolveLatestCursor, delay)
}

function handleCursor(cursor: PlaybackCursorInput) {
  // A frame callback from an old or alternate buffered range must not move the
  // canonical playhead while the requested range is still loading. A
  // current-time observation is safe when it belongs to the active window and
  // the video is already at the requested target; this covers both paused seeks
  // and browsers that continue playback without issuing a frame callback.
  const element = video.value
  const window = descriptor.value
  const currentTimeObservationWhileBuffering = (() => {
    if (cursor.schema_version === '2.0.0')
      return Boolean(
        omeDirectPlaybackActive.value &&
        element &&
        !element.seeking &&
        cursor.cursor_status === 'ready',
      )
    if (
      !element ||
      element.seeking ||
      cursor.schema_version !== '1.0.0' ||
      cursor.observation_source !== 'current_time_fallback' ||
      cursor.cursor_status !== 'ready' ||
      !window ||
      cursor.playback_window_id !== window.playback_window_id ||
      cursor.mapping_version !== window.mapping_version
    )
      return false
    if (!bufferingTargetCaptureTimeUs) return true
    const observedCaptureTimeUs =
      BigInt(window.presentation_origin_capture_us) + BigInt(cursor.player_media_time_us)
    const difference = observedCaptureTimeUs - BigInt(bufferingTargetCaptureTimeUs)
    return (difference < 0n ? -difference : difference) <= 100_000n
  })()
  if (playbackBuffering.value && !currentTimeObservationWhileBuffering) return
  const previousSeekGeneration = observedCursor.value?.seek_generation
  observedCursor.value = cursor
  cursorStatus.value = cursor.cursor_status
  settleOptimisticSeekFromCursor(cursor)
  const remoteCaptureTimeUs =
    cursor.cursor_status === 'gap'
      ? null
      : cursor.schema_version === '2.0.0'
        ? omeObservedCaptureTimeUs.value
        : visualPlayhead.value
  publishRemoteCursor(remoteCaptureTimeUs, cursor.cursor_status)
  if (cursor.schema_version === '2.0.0') return
  // Frame stepping owns the player position until its authoritative queue has
  // drained. Browser seek callbacks are observations of the optimistic preview,
  // not new commands that should race the canonical sample-index resolver.
  if (
    seekPreviewActive.value ||
    ((frameQueueRunning.value || frameQueuePending.value) && frameStepReady()) ||
    keyPointEditing.navigation.active.value
  )
    return
  if (cursor.cursor_status !== 'ready') {
    pendingCursorResolve = null
    return
  }
  const key = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}:${cursor.player_media_time_us}`
  if (key === lastResolvedCursorKey) return
  const automaticKey = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}`
  if (!pendingTimelineMove.value && automaticKey === lastAutomaticCursorResolveKey) return
  const anchorNeedsRefresh =
    authoritativeAnchor.value?.playback_window_id !== cursor.playback_window_id ||
    authoritativeAnchor.value.mapping_version !== cursor.mapping_version
  const shouldResolve =
    anchorNeedsRefresh ||
    cursor.seek_generation !== previousSeekGeneration ||
    Boolean(pendingTimelineMove.value)
  if (!shouldResolve) return
  if (!pendingTimelineMove.value) lastAutomaticCursorResolveKey = automaticKey
  pendingCursorResolve = cursor
  scheduleCursorResolve(true)
}

const publishRemoteCursor = useThrottleFn(
  (captureTimeUs: string | null, status: 'ready' | 'seeking' | 'stale' | 'gap') => {
    annotation.setPlaybackCursor(captureTimeUs, status)
  },
  750,
  true,
  true,
)

async function createWindow(
  target = captureTarget.value || undefined,
  requestedMode?: 'live' | 'archive',
  forceNewWindow = false,
) {
  const mode = requestedMode ?? (target === liveTarget.value ? 'live' : 'archive')
  const safeTarget =
    target && mode === 'live'
      ? clampLiveEdgeTarget(target, timeline.value?.availableRanges ?? [])
      : target
  const current = descriptor.value
  if (
    !forceNewWindow &&
    current &&
    safeTarget &&
    current.capture_session_id === selectedCapture.value?.id &&
    current.mode === mode &&
    Date.parse(current.expires_at) > Date.now() &&
    BigInt(safeTarget) >= BigInt(current.window_capture_start_us) &&
    BigInt(safeTarget) < BigInt(current.window_capture_end_us)
  ) {
    captureTarget.value = safeTarget
    if (video.value) {
      prepareAuthoritativeSeek()
      video.value.currentTime =
        Number(BigInt(safeTarget) - BigInt(current.presentation_origin_capture_us)) / 1_000_000
    }
    maintainPlaybackWindow()
    return current
  }
  if (windowCreatePromise && safeTarget === windowCreateTarget && mode === windowCreateMode)
    return windowCreatePromise
  mediaError.value = null
  const request = (async () => {
    try {
      const session = selectedCapture.value
      if (!session || !safeTarget) throw new Error('目前沒有可播放的 capture range')
      captureTarget.value = safeTarget
      return await dvr.create({
        schema_version: '1.0.0',
        capture_session_id: session.id,
        mode,
        target_capture_time_us: safeTarget,
        requested_back_us: mediaBufferProfile.value.requestedBackUs,
        requested_forward_us: mediaBufferProfile.value.requestedForwardUs,
      })
    } catch (error) {
      mediaError.value = error instanceof Error ? error.message : '播放視窗建立失敗'
      return null
    } finally {
      mediaError.value =
        dvr.error.value instanceof Error ? dvr.error.value.message : mediaError.value
    }
  })()
  windowCreatePromise = request
  windowCreateTarget = safeTarget
  windowCreateMode = mode
  try {
    return await request
  } finally {
    if (windowCreatePromise === request) {
      windowCreatePromise = null
      windowCreateTarget = undefined
      windowCreateMode = undefined
    }
  }
}

async function seekTimeline(targetCaptureTimeUs: string) {
  gapTransition = null
  seekPreviewActive.value = false
  if (seekPreviewTimer) clearTimeout(seekPreviewTimer)
  if (video.value && !video.value.paused) requestMediaPause(video.value)
  prepareAuthoritativeSeek()
  keyPointEditing.navigation.cancel()
  seekPreviewTimer = null
  const target = liveCapture.value
    ? clampLiveEdgeTarget(targetCaptureTimeUs, timeline.value?.availableRanges ?? [])
    : targetCaptureTimeUs
  setOptimisticSeekTarget(target)
  captureTarget.value = target
  if (overlayPlayer.value?.seekCaptureTimeIfBuffered(target)) {
    // A seek that stays inside the current MSE buffer does not replace the
    // playback window, so no later ready event is guaranteed to clear a stale
    // loading gate from an earlier wait/seek.
    clearPlaybackBuffering()
    maintainPlaybackWindow()
    return
  }
  markPlaybackBuffering(false, target)
  if (omeDirectPlaybackActive.value) {
    const durableRanges = selectedCapture.value?.timeline?.availableRanges ?? []
    if (!captureTimeInTimelineRanges(target, durableRanges)) {
      clearPlaybackBuffering()
      if (optimisticSeekCaptureTimeUs.value === target) clearOptimisticSeekTarget()
      mediaError.value = '目前位置尚未完成永久錄影，且已不在 OME DVR 範圍內'
      return
    }
    // OME DVR is the low-latency tier. Once the requested position leaves its
    // seekable range, switch to the finalized recording while keeping the same
    // canonical capture time. The operator returns to OME explicitly via LIVE.
    omeArchivePlaybackActive.value = true
    omeAtLiveEdge.value = false
    omeCanonicalTimeValidated.value = false
    omeObservedCaptureTimeUs.value = null
    const created = await createWindow(target, 'archive', true)
    if (!created) {
      // Archive is a fallback tier. A transient window error must not disable
      // the still-usable OME source; the reactive source watcher will reattach
      // at the canonical live position when this flag is rolled back.
      omeArchivePlaybackActive.value = false
      clearPlaybackBuffering()
      if (optimisticSeekCaptureTimeUs.value === target) clearOptimisticSeekTarget()
    }
    return
  }
  if (overlayPlayer.value?.seekCaptureTimeInWindow(target)) {
    // The target is still listed by the active bounded manifest even though
    // Chromium has evicted its decoded/MSE bytes. Let hls.js fetch that range
    // into the existing MediaSource instead of destroying the whole pipeline.
    maintainPlaybackWindow()
    return
  }
  const created = await createWindow(target, undefined, true)
  if (!created) {
    clearPlaybackBuffering()
    if (optimisticSeekCaptureTimeUs.value === target) clearOptimisticSeekTarget()
  }
}

function setOptimisticSeekTarget(targetCaptureTimeUs: string) {
  optimisticSeekCaptureTimeUs.value = targetCaptureTimeUs
  if (optimisticSeekTimer) clearTimeout(optimisticSeekTimer)
  optimisticSeekTimer = setTimeout(clearOptimisticSeekTarget, 12_000)
}

function clearOptimisticSeekTarget() {
  optimisticSeekCaptureTimeUs.value = null
  if (optimisticSeekTimer) clearTimeout(optimisticSeekTimer)
  optimisticSeekTimer = null
}

function settleOptimisticSeekFromCursor(cursor: PlaybackCursorInput) {
  const target = optimisticSeekCaptureTimeUs.value
  const window = descriptor.value
  if (
    !target ||
    cursor.schema_version !== '1.0.0' ||
    cursor.cursor_status !== 'ready' ||
    !window ||
    cursor.playback_window_id !== window.playback_window_id ||
    cursor.mapping_version !== window.mapping_version
  )
    return
  const observed =
    BigInt(window.presentation_origin_capture_us) + BigInt(cursor.player_media_time_us)
  const difference = observed - BigInt(target)
  if ((difference < 0n ? -difference : difference) <= 100_000n) clearOptimisticSeekTarget()
}

function prepareAuthoritativeSeek() {
  frameNavigation.cancel()
  pendingCursorResolve = null
  lastResolvedCursorKey = ''
  lastAutomaticCursorResolveKey = ''
  cursorStatus.value = 'seeking'
  dvr.invalidateAnchor()
}

function previewTimelineSeek(targetCaptureTimeUs: string | null) {
  const target =
    targetCaptureTimeUs && liveCapture.value
      ? clampLiveEdgeTarget(targetCaptureTimeUs, timeline.value?.availableRanges ?? [])
      : targetCaptureTimeUs
  seekPreviewActive.value = Boolean(target)
  if (seekPreviewTimer) clearTimeout(seekPreviewTimer)
  seekPreviewTimer = null
  if (!target) return
  // Dragging is observational. Preview already-buffered media immediately, but
  // never create a playback window until the user commits the seek. This keeps
  // one gesture from fanning out into many manifests and segment downloads.
  overlayPlayer.value?.previewCaptureTimeIfBuffered(target)
}

let skipIncompleteResultWarningOnce = false

function incompleteBallEventResultLabels() {
  const points = displayAnnotation.value?.snapshot.key_points ?? []
  return points.flatMap((point, index) => {
    const event = point.ball_event
    if (!event || event.kind === 'CONTACT' || event.result !== null) return []
    const label =
      event.kind === 'SERVE'
        ? '發球'
        : event.kind === 'SPIKE'
          ? '殺球'
          : index > 0 && points[index - 1]?.ball_event?.kind === 'SERVE'
            ? '接發'
            : index > 0 && points[index - 1]?.ball_event?.kind === 'SPIKE'
              ? '接殺'
              : '接球'
    return [`第 ${index + 1} 球「${label}」`]
  })
}

function incompleteResultsNeedConfirmation() {
  if (skipIncompleteResultWarningOnce) {
    skipIncompleteResultWarningOnce = false
    return false
  }
  return incompleteBallEventResultLabels().length > 0
}

function requestIncompleteResultsConfirmation() {
  const labels = incompleteBallEventResultLabels()
  if (!labels.length) return
  workstationConfirmation.open({
    id: 'incomplete-ball-event-results',
    title: '仍有球點未標記結果',
    message: `${labels.join('、')}尚未選擇成功或失敗。你可以返回時間軸補充，也可以保留空白直接送出。`,
    confirmLabel: '仍然送出',
    onConfirm: () => {
      skipIncompleteResultWarningOnce = true
      void workstationActions.execute('submission.submit')
    },
  })
}

function startCorrection() {
  correctionFlow.requestCreate()
}

function requestCorrectionSubmit() {
  correctionFlow.requestSubmit()
}

async function cancelCorrection() {
  await correctionFlow.cancel()
}

function resetTimelineZoom() {
  timelineDock.value?.resetView()
}
function focusTimelineCursor() {
  const cursor = visualPlayhead.value
  if (cursor) timelineDock.value?.focusCursor(cursor)
}

type PlayerAction = MediaAction | 'mute'
function updatePlaybackState() {
  playing.value = Boolean(video.value && !video.value.paused)
  if (playing.value && playbackBuffering.value) {
    // Do not allow a manual play click or a browser auto-resume to bypass the
    // buffer gate and continue an old range while the requested range loads.
    if (video.value) requestMediaPause(video.value)
    playing.value = false
    return
  }
  if (playing.value) playbackHasStarted = true
  muted.value = Boolean(video.value?.muted)
  if (playing.value) maintainPlaybackWindow()
}
function markPlaybackBuffering(resumePlayback: boolean, targetCaptureTimeUs: string | null = null) {
  const wasBuffering = playbackBuffering.value
  playbackBuffering.value = true
  cursorStatus.value = 'stale'
  if (targetCaptureTimeUs !== null || !wasBuffering)
    bufferingTargetCaptureTimeUs = targetCaptureTimeUs
  if (resumePlayback) resumeAfterBuffering = true
}
function clearPlaybackBuffering() {
  playbackBuffering.value = false
  resumeAfterBuffering = false
  bufferingTargetCaptureTimeUs = null
}
function finishPlaybackBufferingIfReady() {
  const element = video.value
  if (!playbackBuffering.value || !element || element.seeking) return
  // `canplay`/readyState is a valid readiness signal even when Chromium has
  // not exposed the MSE range through `buffered` yet. Waiting exclusively for
  // that range leaves the loading overlay stuck after the first playable frame.
  const hasPlayableData =
    mediaTimeRangeContains(element.buffered, element.currentTime) ||
    element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
  if (!hasPlayableData) return
  const window = descriptor.value
  if (bufferingTargetCaptureTimeUs && window) {
    const currentCaptureTimeUs =
      BigInt(window.presentation_origin_capture_us) +
      BigInt(Math.round(element.currentTime * 1_000_000))
    const target = BigInt(bufferingTargetCaptureTimeUs)
    const distance = currentCaptureTimeUs - target
    if ((distance < 0n ? -distance : distance) > 100_000n) return
  }
  const shouldResume = resumeAfterBuffering
  clearPlaybackBuffering()
  if (shouldResume && !element.ended)
    void requestMediaPlay(element).catch(error => {
      mediaError.value = error instanceof Error ? error.message : '載入後無法繼續播放'
    })
}
function handleVideoPlaying() {
  if (playbackBuffering.value) {
    finishPlaybackBufferingIfReady()
    if (playbackBuffering.value) {
      video.value?.pause()
      return
    }
  }
  updatePlaybackState()
}
function handleVideoWaiting() {
  const element = video.value
  const shouldResume = Boolean(element && !element.paused && !element.ended)
  markPlaybackBuffering(shouldResume)
  // Playback services own the pause/startLoad/resume sequence. Pausing again
  // here races their play() call and produces the observed half-second stall.
  maintainPlaybackWindow()
  if (omeDirectPlaybackActive.value) overlayPlayer.value?.recoverPlayback()
}
function detachVideoState(element: HTMLVideoElement | null) {
  element?.removeEventListener('play', updatePlaybackState)
  element?.removeEventListener('playing', handleVideoPlaying)
  element?.removeEventListener('pause', updatePlaybackState)
  element?.removeEventListener('canplay', handleVideoCanPlay)
  element?.removeEventListener('loadeddata', handleVideoCanPlay)
  element?.removeEventListener('durationchange', handleVideoCanPlay)
  element?.removeEventListener('volumechange', updatePlaybackState)
  element?.removeEventListener('timeupdate', maintainPlaybackWindow)
  element?.removeEventListener('progress', maintainPlaybackWindow)
  element?.removeEventListener('waiting', handleVideoWaiting)
  element?.removeEventListener('ended', maintainPlaybackWindow)
}
function schedulePlaybackContinuation(delayMs = continuationRetryDelayMs) {
  if (continuationRetryTimer || !playbackHasStarted) return
  continuationRetryTimer = setTimeout(() => {
    continuationRetryTimer = null
    maintainPlaybackWindow()
  }, delayMs)
}
function retryableContinuationError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return [
    'MEDIA_NOT_READY',
    'PLAYBACK_CONTINUATION_NO_PROGRESS',
    'PLAYBACK_WINDOW_NOT_FOUND',
    'WINDOW_EXPIRED',
    'MAPPING_STALE',
  ].includes(code)
}
function skippedGapLabel(durationUs: string) {
  const milliseconds = Number(BigInt(durationUs)) / 1_000
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))} 毫秒`
  const seconds = milliseconds / 1_000
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(2)} 秒`
}
async function continueAcrossGap(input: {
  sourceWindowId: string
  mode: 'live' | 'archive'
  targetCaptureTimeUs: string
  gapDurationUs: string
  element: HTMLVideoElement
}) {
  if (gapTransition || descriptor.value?.playback_window_id !== input.sourceWindowId) return
  const transition = {
    sourceWindowId: input.sourceWindowId,
    targetWindowId: null as string | null,
    targetCaptureTimeUs: input.targetCaptureTimeUs,
    gapDurationUs: input.gapDurationUs,
    resumePlayback: playbackHasStarted && (!input.element.paused || input.element.ended),
  }
  gapTransition = transition
  markPlaybackBuffering(transition.resumePlayback, input.targetCaptureTimeUs)
  if (transition.resumePlayback) requestMediaPause(input.element)
  prepareAuthoritativeSeek()
  captureTarget.value = input.targetCaptureTimeUs
  mediaError.value = null
  const created = await createWindow(input.targetCaptureTimeUs, input.mode, true)
  if (gapTransition !== transition) return
  if (!created) {
    gapTransition = null
    clearPlaybackBuffering()
    mediaError.value ||= '無法載入媒體中斷後的下一個可播放位置'
    return
  }
  transition.targetWindowId = created.playback_window_id
}
function maintainPlaybackWindow() {
  if (omeDirectPlaybackActive.value) return
  const element = video.value
  const window = descriptor.value
  if (
    !element ||
    !window ||
    seekPreviewActive.value ||
    playbackContinuationInFlight ||
    gapTransition
  )
    return
  const leaseRenewalDue = Date.parse(window.expires_at) <= Date.now() + 60_000
  if (!playbackHasStarted && !leaseRenewalDue) return
  const observedCapture =
    BigInt(window.presentation_origin_capture_us) +
    BigInt(Math.max(0, Math.round(element.currentTime * 1_000_000)))
  const windowEnd = BigInt(window.window_capture_end_us)
  const target = (observedCapture > windowEnd ? windowEnd : observedCapture).toString()
  const browserHeadroom = bufferedSecondsAhead(element)
  if (!element.paused && !mediaTimeRangeContains(element.buffered, element.currentTime)) {
    markPlaybackBuffering(true)
  }
  const nextRange = nextPlayableRangeAfter(
    window.window_capture_end_us,
    timeline.value?.availableRanges ?? [],
  )
  const exhaustedCurrentWindow =
    element.ended || (windowEnd - BigInt(target) <= 100_000n && browserHeadroom <= 0.1)
  if (nextRange && exhaustedCurrentWindow) {
    void continueAcrossGap({
      sourceWindowId: window.playback_window_id,
      mode: 'archive',
      targetCaptureTimeUs: nextRange.targetCaptureTimeUs,
      gapDurationUs: nextRange.gapDurationUs,
      element,
    })
    return
  }
  const decision = leaseRenewalDue
    ? 'extend-window'
    : decidePlaybackContinuation({
        availabilityComplete:
          Boolean(timeline.value?.availabilityComplete) ||
          ['complete_vod', 'ended_live', 'failed'].includes(playbackMode.value),
        browserBufferedSeconds: browserHeadroom,
        currentCaptureTimeUs: target,
        ended: element.ended,
        paused: element.paused,
        playbackHasStarted,
        refreshLeadSeconds: mediaBufferProfile.value.refreshLeadSeconds,
        seekPreviewActive: seekPreviewActive.value,
        windowEndCaptureTimeUs: window.window_capture_end_us,
      })
  if (decision === 'idle') return
  if (decision === 'terminal') {
    clearPlaybackBuffering()
    return
  }
  if (performance.now() - continuationRequestedAt < 500) {
    schedulePlaybackContinuation(500)
    return
  }
  continuationRequestedAt = performance.now()
  if (decision === 'recover-buffer') {
    const recovered = overlayPlayer.value?.recoverPlayback() ?? false
    if (!recovered && !element.paused) requestMediaPause(element)
    schedulePlaybackContinuation(650)
    return
  }
  if (continuationWindowId === window.playback_window_id) return

  const sourceWindowId = window.playback_window_id
  playbackContinuationInFlight = true
  continuationWindowId = sourceWindowId
  void media
    .extendPlaybackWindow(sourceWindowId, {
      schema_version: '1.0.0',
      target_capture_time_us: target,
      requested_forward_us: mediaBufferProfile.value.requestedForwardUs,
    })
    .then(async created => {
      if (descriptor.value?.playback_window_id !== sourceWindowId) return
      if (
        created.mapping_version !== window.mapping_version ||
        created.window_capture_end_us !== window.window_capture_end_us ||
        created.window_capture_start_us !== window.window_capture_start_us ||
        created.expires_at !== window.expires_at
      ) {
        continuationRetryDelayMs = 500
        dvr.refresh(created)
      } else {
        continuationRetryDelayMs = Math.min(4_000, Math.round(continuationRetryDelayMs * 1.6))
      }
    })
    .catch(error => {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (['PLAYBACK_WINDOW_NOT_FOUND', 'WINDOW_EXPIRED'].includes(code)) {
        dvr.clear()
        void createWindow(target, liveCapture.value ? 'live' : 'archive')
        return
      }
      if (!retryableContinuationError(error)) {
        mediaError.value = error instanceof Error ? error.message : '背景載入播放視窗失敗'
      }
      continuationRetryDelayMs = Math.min(4_000, Math.round(continuationRetryDelayMs * 1.6))
    })
    .finally(() => {
      continuationWindowId = null
      playbackContinuationInFlight = false
      if (
        !timeline.value?.availabilityComplete &&
        !['complete_vod', 'ended_live', 'failed'].includes(playbackMode.value) &&
        playbackHasStarted
      ) {
        schedulePlaybackContinuation()
      }
    })
}
function handleVideoReady(element: HTMLVideoElement) {
  if (video.value !== element) {
    clearFramePreviewState()
    detachVideoState(video.value)
    video.value = element
    element.addEventListener('play', updatePlaybackState)
    element.addEventListener('playing', handleVideoPlaying)
    element.addEventListener('pause', updatePlaybackState)
    element.addEventListener('canplay', handleVideoCanPlay)
    element.addEventListener('loadeddata', handleVideoCanPlay)
    element.addEventListener('durationchange', handleVideoCanPlay)
    element.addEventListener('volumechange', updatePlaybackState)
    element.addEventListener('timeupdate', maintainPlaybackWindow)
    element.addEventListener('progress', maintainPlaybackWindow)
    element.addEventListener('waiting', handleVideoWaiting)
    element.addEventListener('ended', maintainPlaybackWindow)
  }
  element.playbackRate = playbackRate.value
  if (omeDirectPlaybackActive.value && omeSeekLiveOnReady.value) {
    omeSeekLiveOnReady.value = false
    overlayPlayer.value?.seekLiveEdge()
  }
  const transition = gapTransition
  if (
    transition?.targetWindowId &&
    descriptor.value?.playback_window_id === transition.targetWindowId
  ) {
    gapTransition = null
    toast.info(`已自動略過 ${skippedGapLabel(transition.gapDurationUs)}媒體中斷`)
  }
  finishPlaybackBufferingIfReady()
  updatePlaybackState()
}
function handleVideoCanPlay() {
  finishPlaybackBufferingIfReady()
}
function handlePlaybackError(error: Error) {
  gapTransition = null
  clearPlaybackBuffering()
  if (omeArchivePlaybackActive.value && omeDirectPlaybackAvailable.value) {
    omeArchivePlaybackActive.value = false
    omeSeekLiveOnReady.value = true
    omeCanonicalTimeValidated.value = false
    omeObservedCaptureTimeUs.value = null
    toast.warning('永久錄影暫時無法載入，已返回即時畫面', {
      description: error.message,
    })
    mediaError.value = null
    return
  }
  mediaError.value = error.message
}
function handleOverlayError(error: Error) {
  toast.warning('AI 分析圖層暫時無法載入', {
    description: error.message,
  })
}
function handleOmePlaybackError(error: Error) {
  gapTransition = null
  clearPlaybackBuffering()
  omePlaybackFailed.value = true
  mediaError.value = error.message
  const failedCaptureId = selectedCaptureId.value
  if (omePlaybackRetryTimer) clearTimeout(omePlaybackRetryTimer)
  omePlaybackRetryTimer = setTimeout(() => {
    omePlaybackRetryTimer = null
    if (failedCaptureId && selectedCaptureId.value === failedCaptureId && liveCapture.value) {
      mediaError.value = null
      omePlaybackFailed.value = false
      omeArchivePlaybackActive.value = false
      omeSeekLiveOnReady.value = false
    }
  }, 15_000)
  toast.warning('OME 即時播放無法載入，已回退舊播放路徑', {
    description: error.message,
  })
}
function handleOmeLivePosition(value: {
  atLiveEdge: boolean
  captureTimeUs: string | null
  mappingStatus: 'validated' | 'unmapped'
}) {
  omeAtLiveEdge.value = value.atLiveEdge
  omeCanonicalTimeValidated.value = value.mappingStatus === 'validated'
  omeObservedCaptureTimeUs.value = value.mappingStatus === 'validated' ? value.captureTimeUs : null
  publishRemoteCursor(
    value.mappingStatus === 'validated' ? value.captureTimeUs : null,
    value.mappingStatus === 'validated' ? (observedCursor.value?.cursor_status ?? 'ready') : 'gap',
  )
}
function setPlaybackRate(rate: number) {
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) return
  playbackRate.value = rate
  if (video.value) video.value.playbackRate = rate
}
function handleBufferState(value: {
  buffered: CanonicalMediaRange[]
  seekable: CanonicalMediaRange[]
  mappingVersion: number | null
  playbackWindowId: string | null
}) {
  if (omeDirectPlaybackActive.value) {
    playerBufferedRanges.value = value.buffered
    playerSeekableRanges.value = value.seekable
    finishPlaybackBufferingIfReady()
    return
  }
  const window = descriptor.value
  playerBufferedRanges.value =
    window &&
    value.playbackWindowId === window.playback_window_id &&
    value.mappingVersion === window.mapping_version
      ? value.buffered
      : []
  playerSeekableRanges.value = []
  finishPlaybackBufferingIfReady()
}
function dispatchMediaAction(
  action: PlayerAction,
  frameCount = 1,
  input: 'keyboard' | 'button' = 'button',
) {
  const element = video.value
  if (!element) return
  if (action === 'play_pause') {
    if (element.paused)
      void requestMediaPlay(element).catch(error => {
        mediaError.value = error instanceof Error ? error.message : '播放器無法開始播放'
      })
    else requestMediaPause(element)
  }
  if (action === 'mute') element.muted = !element.muted
  if (action === 'frame_previous' || action === 'frame_next')
    queueFrameStep(action === 'frame_next' ? 'next' : 'previous', frameCount, input)
  if (action === 'key_point_previous' || action === 'key_point_next')
    void timelineSelection.navigate(
      action === 'key_point_next' ? 'next' : 'previous',
      navigableKeyPoints.value,
      selectedTimelineItem.value === 'point'
        ? (selectedKeyPoint.value?.capture_time_us ?? visualPlayhead.value)
        : visualPlayhead.value,
    )
}

function queueFrameStep(
  direction: 'previous' | 'next',
  count = 1,
  input: 'keyboard' | 'button' = 'button',
) {
  clearOptimisticSeekTarget()
  frameNavigation.enqueue(direction, count, input)
}

function frameStepReady() {
  const window = descriptor.value
  const anchor = authoritativeAnchor.value
  return Boolean(
    window &&
    anchor &&
    dvr.status.value === 'ready' &&
    !dvr.busy.value &&
    anchor.playback_window_id === window.playback_window_id &&
    anchor.mapping_version === window.mapping_version,
  )
}

function currentFramePreviewContext(): string {
  const window = descriptor.value
  const anchor = authoritativeAnchor.value
  if (!window || !anchor) return ''
  return [
    window.playback_window_id,
    window.mapping_version,
    anchor.capture_epoch_id,
    anchor.dvr_segment_id ?? '',
  ].join(':')
}

function rememberFramePreviewDuration(
  fromCaptureTimeUs: string,
  toCaptureTimeUs: string,
  count: number,
  ...contexts: string[]
) {
  const seconds = estimateFrameDurationSeconds(fromCaptureTimeUs, toCaptureTimeUs, count)
  if (seconds === null) return null
  estimatedFrameSeconds = seconds
  for (const context of contexts) {
    if (context) framePreviewDurationByContext.set(context, seconds)
  }
  return seconds
}

async function warmFramePreviewDuration() {
  const generation = ++framePreviewCalibrationGeneration
  const window = descriptor.value
  const anchor = authoritativeAnchor.value
  const context = currentFramePreviewContext()
  if (!frameNavigation.active.value) clearFramePreviewState()
  if (!window || !anchor || !context) {
    estimatedFrameSeconds = null
    return
  }
  const cached = framePreviewDurationByContext.get(context)
  if (cached !== undefined) {
    estimatedFrameSeconds = cached
    return
  }
  estimatedFrameSeconds = null
  for (const direction of ['next', 'previous'] as const) {
    try {
      const adjacent = await media.frameStep({
        schema_version: '1.1.0',
        capture_session_id: window.capture_session_id,
        playback_window_id: window.playback_window_id,
        mapping_version: window.mapping_version,
        capture_frame_index: anchor.capture_frame_index,
        direction,
        count: 1,
      })
      if (
        generation !== framePreviewCalibrationGeneration ||
        context !== currentFramePreviewContext()
      )
        return
      if (
        rememberFramePreviewDuration(
          anchor.capture_time_us,
          adjacent.capture_time_us,
          1,
          context,
        ) !== null
      )
        return
    } catch {
      // A boundary on one side is normal; try the opposite adjacent frame.
    }
  }
}

function previewFrameStep(delta: number) {
  const element = video.value
  const window = descriptor.value
  if (!element || !window) return
  if (!element.paused) requestMediaPause(element)
  if (estimatedFrameSeconds === null) return
  const windowKey = `${window.playback_window_id}:${window.mapping_version}`
  if (framePreviewWindowKey !== windowKey) {
    framePreviewWindowKey = windowKey
    framePreviewTargetSeconds.value = null
    framePreviewCaptureTimeUs.value = null
  }
  const windowDuration =
    Number(BigInt(window.window_capture_end_us) - BigInt(window.presentation_origin_capture_us)) /
    1_000_000
  const mediaEnd = Number.isFinite(element.duration)
    ? Math.min(element.duration, windowDuration)
    : windowDuration
  const base = framePreviewTargetSeconds.value ?? element.currentTime
  framePreviewTargetSeconds.value = Math.max(
    0,
    Math.min(mediaEnd, base + delta * estimatedFrameSeconds),
  )
  const previewCaptureTimeUs =
    BigInt(window.presentation_origin_capture_us) +
    BigInt(Math.round(framePreviewTargetSeconds.value * 1_000_000))
  const captureStart = BigInt(window.window_capture_start_us)
  const captureEnd = BigInt(window.window_capture_end_us)
  framePreviewCaptureTimeUs.value = (
    previewCaptureTimeUs < captureStart
      ? captureStart
      : previewCaptureTimeUs > captureEnd
        ? captureEnd
        : previewCaptureTimeUs
  ).toString()
  scheduleFramePreviewSeek()
}

function scheduleFramePreviewSeek() {
  if (framePreviewRaf !== null) return
  framePreviewRaf = requestAnimationFrame(() => {
    framePreviewRaf = null
    const element = video.value
    if (!element || framePreviewTargetSeconds.value === null) return
    if (!overlayPlayer.value?.previewPlayerMediaTime(framePreviewTargetSeconds.value))
      element.currentTime = framePreviewTargetSeconds.value
  })
}

function clearFramePreviewState() {
  framePreviewTargetSeconds.value = null
  framePreviewCaptureTimeUs.value = null
  framePreviewWindowKey = ''
  if (framePreviewRaf !== null) cancelAnimationFrame(framePreviewRaf)
  framePreviewRaf = null
}

function handleOverlayFrame(frame: number) {
  currentOverlayFrame.value = frame
}

function handleOverlayVideo(value: { width: number; height: number } | null) {
  overlayVideoSize.value = value
}

function handleBallPosition(position: { x: number; y: number }) {
  analysisRevision.setBallPosition(position)
}

function handlePlayerBBox(selection: { trackId: number; frameBBox: AnalysisFrameBBox }) {
  analysisRevision.setPlayerBBox(selection)
}

function handleOverlayTrack(selection: {
  trackId: number
  clientX: number
  clientY: number
  action: string | null
}) {
  if (!analysisOverlayActive.value || ballRelabelEnabled.value || bboxRelabelEnabled.value) return
  analysisRevision.selectTrack(selection.trackId, selection.action)
  if (inspectorTab.value === 'analysis') return
  inspectorTab.value = 'mapping'
  trackPopover.open = true
  trackPopover.trackId = selection.trackId
  // The Reka/shadcn popover collision engine needs viewport coordinates.
  // It will flip and shift the panel when the selected bbox is near an edge.
  trackPopover.x = selection.clientX
  trackPopover.y = selection.clientY
}

let identityNavigationGeneration = 0
async function handleIdentityTrackSelect(selection: {
  trackId: number
  rallyId: string
  firstFrameIndex: string
}) {
  const generation = ++identityNavigationGeneration
  const rally = coach.data.value?.match.rallies.find(item => item.id === selection.rallyId)
  if (!rally) return

  analysisRevision.selectTrack(selection.trackId, null)
  timelineSelection.selectRally(rally)

  const clip = rally.submission.clip
  if (!clip) return

  let replay = overlayReplay.value?.rally.id === rally.id ? overlayReplay.value : null
  if (!replay) {
    try {
      replay = await coachDomain.rallyReplay(rally.id)
    } catch {
      return
    }
  }
  if (generation !== identityNavigationGeneration) return

  const frameIndex = Number(selection.firstFrameIndex)
  const preciseCaptureTime =
    selectedRallyId.value === rally.id && Number.isSafeInteger(frameIndex)
      ? overlayPlayer.value?.overlayFrameCaptureTime(frameIndex)
      : null
  const captureTime =
    preciseCaptureTime ??
    (replay?.clip
      ? captureTimeForIdentityTrackFrame({
          clipStartCaptureTimeUs: clip.start_capture_time_us,
          frameIndex: selection.firstFrameIndex,
          fps: replay.clip.fps,
        })
      : null)
  if (captureTime) await seekTimeline(captureTime)
}

function handleMappingChanged() {
  trackPopover.open = false
  mappingRefreshToken.value += 1
  void coach.refresh()
  void refreshOverlayReplay()
}

watch(coach.lastUpdatedAt, (updatedAt, previous) => {
  if (!updatedAt || !previous || updatedAt.getTime() === previous.getTime()) return
  mappingRefreshToken.value += 1
  void refreshOverlayReplay()
})
watch(
  visualPlayhead,
  value => {
    maskPreviewCursor.value = value
  },
  { immediate: true },
)
const rememberCursorPosition = useThrottleFn(
  (captureSessionId: string, captureTimeUs: string) => {
    workstationViewState.rememberCursor(captureSessionId, captureTimeUs)
  },
  250,
  true,
  true,
)
watch([selectedCaptureId, visualPlayhead], ([captureSessionId, captureTimeUs]) => {
  if (captureSessionId && captureTimeUs) rememberCursorPosition(captureSessionId, captureTimeUs)
})
function rememberTimelineViewport(viewport: TimelineViewport) {
  if (viewport.captureSessionId !== selectedCaptureId.value) return
  workstationViewState.rememberTimelineViewport(viewport)
}

function dispatchHotkeyCommand(action: HotkeyCommand, event: KeyboardEvent) {
  const frameCount = event.ctrlKey ? 5 : 1
  if (action === 'frame_previous' || action === 'frame_next') {
    const direction = action === 'frame_next' ? 'next' : 'previous'
    const owner = frameGestureRouter.claim(
      direction,
      selectedEditableKeyPoint.value ? 'key-point' : 'player',
    )
    if (owner === 'key-point')
      void workstationActions.execute('mark.move', {
        direction,
        count: frameCount,
        input: 'keyboard',
      })
    else
      void workstationActions.execute(
        direction === 'next' ? 'media.frame-next' : 'media.frame-previous',
        { count: frameCount, input: 'keyboard' },
      )
    return
  }
  void workstationActions.execute(workstationActionIdForHotkey(action, event))
}

function releaseHotkeyCommand(action: HotkeyCommand) {
  if (action !== 'frame_previous' && action !== 'frame_next') return
  const direction = action === 'frame_next' ? 'next' : 'previous'
  frameGestureRouter.release(direction)
}

function commandEnabled(action: HotkeyCommand, event?: KeyboardEvent) {
  if (action === 'frame_previous' || action === 'frame_next') {
    const direction = action === 'frame_next' ? 'next' : 'previous'
    const owner = frameGestureRouter.ownerOf(direction)
    const id =
      owner === 'key-point' || (!owner && selectedEditableKeyPoint.value)
        ? 'mark.move'
        : direction === 'next'
          ? 'media.frame-next'
          : 'media.frame-previous'
    return workstationActions.state(id).value.enabled
  }
  return workstationActions.state(workstationActionIdForHotkey(action, event)).value.enabled
}

function isSegmentNavigationHotkey(action: HotkeyCommand, event?: KeyboardEvent) {
  return Boolean(
    event?.shiftKey &&
    (action === 'key_point_previous' || action === 'key_point_next') &&
    !bindings.value[action].split('+').some(part => part.toLowerCase() === 'shift'),
  )
}

function workstationActionIdForHotkey(
  action: HotkeyCommand,
  event?: KeyboardEvent,
): WorkstationActionId {
  if (action === 'play_pause') return 'media.toggle-playback'
  if (isSegmentNavigationHotkey(action, event))
    return action === 'key_point_previous' ? 'media.segment-previous' : 'media.segment-next'
  if (action === 'key_point_previous') return 'media.key-point-previous'
  if (action === 'key_point_next') return 'media.key-point-next'
  if (action === 'frame_previous') return 'media.frame-previous'
  if (action === 'frame_next') return 'media.frame-next'
  return annotationWorkstationActionId[action as AnnotationAction]
}
let lastBlockedHotkeyNotice = ''
let lastBlockedHotkeyNoticeAt = 0
function reportBlockedHotkey(action: HotkeyCommand, event?: KeyboardEvent) {
  const actionState = workstationActions.state(workstationActionIdForHotkey(action, event)).value
  const reason =
    actionState.reason ||
    (action === 'frame_previous' || action === 'frame_next'
      ? omeDirectPlaybackActive.value
        ? omeCanonicalTimeValidated.value
          ? 'OME canonical time 已驗證；逐格與標記仍等待 authoritative cursor contract'
          : 'OME canonical time mapping 尚未驗證，暫停逐格與時間標記'
        : !descriptor.value
          ? '播放器尚未載入可用影片'
          : dvr.status.value === 'gap'
            ? '目前位置沒有可用畫格'
            : '播放視窗正在自動恢復，請稍候'
      : '目前狀態尚不能執行此操作')
  const signature = `${action}:${reason}`
  const now = performance.now()
  if (signature === lastBlockedHotkeyNotice && now - lastBlockedHotkeyNoticeAt < 1_200) return
  lastBlockedHotkeyNotice = signature
  lastBlockedHotkeyNoticeAt = now
  const binding = isSegmentNavigationHotkey(action, event)
    ? shiftedHotkeyBinding(bindings.value[action])
    : bindings.value[action]
  toast.info(`${formatBindingForDisplay(binding)} 暫時不能使用`, {
    description: reason,
    ...(syncNeedsAttention.value
      ? {
          action: {
            label: '重新同步',
            onClick: () => workstationActions.execute('sync.resync'),
          },
        }
      : {}),
  })
}
useAnnotationHotkeyRuntime({
  target: hotkeyTarget,
  dispatch: dispatchHotkeyCommand,
  blocked: reportBlockedHotkey,
  release: releaseHotkeyCommand,
  commandEnabled,
})

watch(
  selectedCaptureId,
  (captureId, previousCaptureId) => {
    if (captureId !== previousCaptureId) {
      annotation.setPlaybackCursor(null, 'stale')
      if (omePlaybackRetryTimer) clearTimeout(omePlaybackRetryTimer)
      omePlaybackRetryTimer = null
      omePlaybackFailed.value = false
      omeArchivePlaybackActive.value = false
      omeSeekLiveOnReady.value = false
      omeAtLiveEdge.value = false
      omeObservedCaptureTimeUs.value = null
      playbackHasStarted = false
      clearPlaybackBuffering()
      gapTransition = null
      continuationRetryDelayMs = 500
      playerBufferedRanges.value = []
      playerSeekableRanges.value = []
      if (continuationRetryTimer) clearTimeout(continuationRetryTimer)
      continuationRetryTimer = null
      if (descriptor.value && descriptor.value.capture_session_id !== captureId) dvr.clear()
    }
    if (captureId)
      annotation.connect(`match:${matchId.toLowerCase()}:capture:${captureId.toLowerCase()}`)
  },
  { immediate: true },
)
watch(
  [selectedCaptureId, defaultPlaybackTarget, defaultPlaybackWindowMode, omeLiveSource],
  ([captureId, target, mode, liveSource]) => {
    if (
      liveSource ||
      !captureId ||
      !target ||
      dvr.busy.value ||
      descriptor.value?.capture_session_id === captureId
    )
      return
    void createWindow(target, mode)
  },
  { immediate: true },
)
watch(
  [timelineEndTarget, () => timeline.value?.timelineVersion, playbackMode],
  maintainPlaybackWindow,
)
watch(
  () => displayAnnotation.value?.rally_id,
  () => {
    keyPointEditing.navigation.cancel()
    timelineSelection.clearPointForDisplayedRallyChange()
  },
  { flush: 'sync' },
)
watch(
  () =>
    [
      annotation.snapshot.value?.rally_id,
      annotation.snapshot.value?.snapshot.annotation_status,
      annotation.snapshot.value?.revision,
    ] as const,
  ([, status], previous) => {
    if (previous && (status === 'submitted' || status === 'voided') && status !== previous[1])
      void coach.refresh()
  },
)
watch(
  [visualPlayhead, selectableSegmentRanges],
  ([cursor, segments]) => {
    cursorRallyId.value = segmentAtCaptureTime(cursor, segments)?.id ?? null
  },
  { immediate: true },
)
watch(
  cursorRallyId,
  rallyId => {
    timelineSelection.followCursor(rallyId)
  },
  { immediate: true },
)
watch([submittedRallies, annotationDrafts], ([submitted, drafts]) => {
  if (!pinnedRallyId.value) return
  if ([...submitted, ...drafts].some(rally => rally.id === pinnedRallyId.value)) return
  timelineSelection.clear()
})
watch(editorMappingAvailable, available => {
  if (!available && (inspectorTab.value === 'mapping' || inspectorTab.value === 'analysis'))
    inspectorTab.value = 'match'
})
watch(editorSelectedAnalysisRunId, () => {
  currentOverlayFrame.value = -1
  ballRelabelEnabled.value = false
  selectedOverlayTrackId.value = null
  selectedOverlayTrackAction.value = null
  trackPopover.open = false
})
watch([state, selectedKeyPointId], () => {
  keyPointEditing.navigation.cancel()
  frameGestureRouter.clear('key-point')
  keyPointEditing.releaseEditingIntent()
})
watch(loadError, value => {
  if (value)
    toast.error(value, {
      action: { label: '重試', onClick: () => void loadMatch() },
    })
})
watch(mediaError, value => {
  if (value) toast.error(value)
})
watch(
  () => annotation.error.value,
  value => {
    if (value)
      toast.error(value, {
        ...(syncNeedsAttention.value
          ? {
              action: {
                label: '重新同步',
                onClick: () => void workstationActions.execute('sync.resync'),
              },
            }
          : {}),
      })
  },
)
watch(
  () => annotation.outboxNeedsConfirmation.value,
  value => {
    if (value)
      toast.warning('場次狀態已更新，請重新操作', {
        action: {
          label: '重新同步',
          onClick: annotation.discardPending,
        },
      })
  },
)
watch(
  processingByRally,
  updates => {
    const failures = Object.values(updates).filter(update => update.processing_status === 'failed')
    for (const update of failures) {
      const signature = `${update.submission_id}:${update.updated_at ?? ''}`
      const shouldNotify = processingFailureWatchReady || update.rally_id === selectedRallyId.value
      if (notifiedProcessingFailures.has(signature)) continue
      notifiedProcessingFailures.add(signature)
      if (!shouldNotify) continue
      const rally = coach.data.value?.match.rallies.find(item => item.id === update.rally_id)
      const title = rally
        ? `第 ${rally.display_set_number} 局 · 回合 ${displayOrdinalFor(rally.id)} 處理失敗`
        : '片段處理失敗'
      const description =
        typeof update.error?.message === 'string'
          ? update.error.message
          : '請點擊「處理失敗」查看工作流程與錯誤詳情。'
      toast.error(title, { description })
    }
    processingFailureWatchReady = true
  },
  { deep: true, immediate: true },
)
watch(
  () => activeProcessing.value?.updated_at,
  () => {
    if (
      activeProcessing.value &&
      ['completed', 'failed'].includes(activeProcessing.value.processing_status)
    )
      void coach.refresh()
  },
)
watch(
  () => dvr.error.value,
  error => {
    if (!error || windowRecoveryInFlight) return
    const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
    if (!['PLAYBACK_WINDOW_NOT_FOUND', 'WINDOW_EXPIRED', 'MAPPING_STALE'].includes(code)) return
    const target =
      authoritativeAnchor.value?.capture_time_us ?? captureTarget.value ?? timelineEndTarget.value
    if (!target) return
    windowRecoveryInFlight = true
    void createWindow(target)
      .then(created => {
        if (created) toast.info('播放視窗已自動重新連線')
      })
      .finally(() => {
        windowRecoveryInFlight = false
      })
  },
)

const transportActions = createTransportActionService({
  manager: workstationActions,
  playerReady: computed(() => Boolean(descriptor.value || omeDirectPlaybackActive.value)),
  frameReady: computed(() =>
    Boolean(
      descriptor.value &&
      (frameNavigation.active.value || !['idle', 'gap', 'error'].includes(dvr.status.value)),
    ),
  ),
  frameMovePending: computed(() => Boolean(pendingTimelineMove.value)),
  liveAvailable: computed(() => Boolean(liveTarget.value || omeDirectPlaybackAvailable.value)),
  correctionCreateEnabled: computed(
    () => Boolean(selectedSubmittedRally.value) && !selectedCorrectionDraft.value,
  ),
  correctionCreateReason: correctionBlockReason,
  correctionCreating,
  correctionCancelEnabled: selectedCorrectionDraft,
  correctionCancelling,
  processingRetryEnabled: computed(
    () => activeProcessing.value?.processing_status === 'failed' && !processingRetrying.value,
  ),
  navigableKeyPoints: computed(() => navigableKeyPoints.value.length > 0),
  navigableSegments: computed(() => selectableSegmentRanges.value.length > 0),
  pointMoveEnabled: computed(
    () => Boolean(selectedKeyPoint.value) && editableDraftState.value && keyPointEditReady.value,
  ),
  pointDeleteEnabled: computed(
    () =>
      Boolean(selectedDeletablePoint.value) && editableDraftState.value && draftMutationReady.value,
  ),
  clipDeleteEnabled: computed(() => clipSelected.value),
  clipDownloadEnabled: computed(() => Boolean(selectedSubmittedRally.value?.submission.clip)),
  togglePlayback: () => dispatchMediaAction('play_pause'),
  stepFrame: (direction, count = 1, input = 'button') => queueFrameStep(direction, count, input),
  goLive: () => {
    if (omeDirectPlaybackAvailable.value) {
      if (omeArchivePlaybackActive.value) {
        mediaError.value = null
        omeSeekLiveOnReady.value = true
        omeArchivePlaybackActive.value = false
        return
      }
      overlayPlayer.value?.seekLiveEdge()
      return
    }
    if (liveTarget.value) return createWindow(liveTarget.value, 'live').then(() => undefined)
  },
  startCorrection,
  cancelCorrection,
  retryProcessing: syncRecovery.retryProcessing,
  navigateKeyPoint: direction =>
    timelineSelection.navigate(
      direction,
      navigableKeyPoints.value,
      selectedKeyPoint.value?.capture_time_us ?? visualPlayhead.value,
    ),
  navigateSegment: direction =>
    timelineSelection.navigateSegment(
      direction,
      selectableSegmentRanges.value,
      visualPlayhead.value,
    ),
  movePoint: (direction, count = 1, input = 'button') => {
    clearOptimisticSeekTarget()
    keyPointEditing.nudge(direction, count, input)
  },
  deletePoint: keyPointEditing.deleteSelected,
  deleteClip: segmentManagement.requestDelete,
  downloadClip: () => {
    downloadDialogOpen.value = true
  },
  toggleMute: () => dispatchMediaAction('mute'),
  setPlaybackRate,
  resetTimelineZoom,
})

const annotationWorkstationService = createAnnotationWorkstationService({
  room: annotation,
  model: workstation,
  actions: workstationActions,
  feedback: workstationFeedback,
  keyPointEditing,
  segments: segmentManagement,
  sync: syncRecovery,
  selection: workstationSelection,
  timeline: timelineSelection,
  analysisReview,
  analysisRevision,
  playback: {
    togglePlayback: () => dispatchMediaAction('play_pause'),
    stepFrame: (direction, count = 1, input = 'button') => queueFrameStep(direction, count, input),
    releaseFrame: direction => frameNavigation.release(direction),
    navigateKeyPoint: direction =>
      timelineSelection.navigate(
        direction,
        navigableKeyPoints.value,
        selectedKeyPoint.value?.capture_time_us ?? visualPlayhead.value,
      ),
    seek: seekTimeline,
    previewSeek: previewTimelineSeek,
    setRate: setPlaybackRate,
  },
  visualization: {
    setOverlayEnabled: workstationPreferences.setOverlayEnabled,
    openSettings: workstationPreferences.open,
  },
  identity: identityAssignment,
  confirmation: workstationConfirmation,
  preferences: workstationPreferences,
})
annotationWorkstationService.registerDisposable(annotationActions.dispose)
annotationWorkstationService.registerDisposable(transportActions.dispose)
annotationWorkstationService.registerDisposable(analysisRevision.dispose)
annotationWorkstationService.registerDisposable(identityAssignment.dispose)
annotationWorkstationService.registerDisposable(keyPointEditing.dispose)
annotationWorkstationService.registerDisposable(segmentManagement.dispose)
annotationWorkstationService.registerDisposable(syncRecovery.dispose)
annotationWorkstationService.registerDisposable(
  workstationFeedback.subscribe(message => {
    const options = message.description ? { description: message.description } : undefined
    if (message.level === 'success') toast.success(message.title, options)
    else if (message.level === 'warning') toast.warning(message.title, options)
    else if (message.level === 'error') toast.error(message.title, options)
    else toast.info(message.title, options)
  }),
)
provideAnnotationWorkstationService(annotationWorkstationService)

function releaseFrameNavigationGestures() {
  frameGestureRouter.releaseAll()
}
function handleWorkstationVisibilityChange() {
  if (document.visibilityState === 'hidden') releaseFrameNavigationGestures()
  else resumeTimelineRefresh()
}
onMounted(() => {
  annotationScope.value?.focus({ preventScroll: true })
  window.addEventListener('blur', releaseFrameNavigationGestures)
  window.addEventListener('online', resumeTimelineRefresh)
  document.addEventListener('visibilitychange', handleWorkstationVisibilityChange)
  void loadMatch().finally(resumeTimelineRefresh)
  scheduleTimelineRefresh(2_500)
})
onBeforeUnmount(() => {
  gapTransition = null
  annotation.setPlaybackCursor(null, null)
  annotationWorkstationService.dispose()
  if (selectedCaptureId.value && visualPlayhead.value)
    workstationViewState.rememberCursor(selectedCaptureId.value, visualPlayhead.value)
  if (timelineRefreshTimer) clearTimeout(timelineRefreshTimer)
  if (cursorResolveTimer) clearTimeout(cursorResolveTimer)
  if (seekPreviewTimer) clearTimeout(seekPreviewTimer)
  if (optimisticSeekTimer) clearTimeout(optimisticSeekTimer)
  if (omePlaybackRetryTimer) clearTimeout(omePlaybackRetryTimer)
  window.removeEventListener('blur', releaseFrameNavigationGestures)
  window.removeEventListener('online', resumeTimelineRefresh)
  document.removeEventListener('visibilitychange', handleWorkstationVisibilityChange)
  frameGestureRouter.releaseAll()
  frameNavigation.stop()
  clearFramePreviewState()
  if (continuationRetryTimer) clearTimeout(continuationRetryTimer)
  annotation.setEditingKeyPoint(null)
  detachVideoState(video.value)
})
</script>

<template>
  <section
    ref="annotationScope"
    tabindex="-1"
    class="editor-shell"
    @keydown.delete.prevent="workstationActions.execute('mark.delete')"
    @pointerdown.capture="annotationScope?.focus({ preventScroll: true })"
  >
    <AnnotationWorkstationHeader
      :title="match?.title ?? matchId"
      :sync-label="syncLabel"
      :latency-ms="annotation.latencyMs.value"
      :busy="
        annotationResyncing || ['connecting', 'reconnecting'].includes(annotation.connection.value)
      "
      :error="
        Boolean(
          annotation.outboxNeedsConfirmation.value || annotation.connection.value === 'closed',
        )
      "
      :connection-title="`${annotation.connection.value} · ${annotation.latencyMs.value ?? '—'} ms · ${selectedCapture?.health ?? 'unknown'}`"
      :resync-visible="syncNeedsAttention"
      @media="captureDialogOpen = true"
      @connection="connectionDialogOpen = true"
      @roster="rosterDialogOpen = true"
    />

    <UiResizablePanelGroup id="annotation-workspace" class="editor-body">
      <UiResizablePanel id="annotation-video" :default-size="78" :min-size="55">
        <main class="viewer-panel">
          <div ref="videoStage" class="video-stage">
            <VideoOverlayPlayer
              ref="overlayPlayer"
              class="video-overlay-player"
              :descriptor="omeLiveSource ? null : descriptor"
              :live-source="omeLiveSource"
              :controls="false"
              :toggle-on-click="
                !analysisOverlayActive ||
                (inspectorTab !== 'mapping' && inspectorTab !== 'analysis')
              "
              :analysis-run-id="annotationOverlayEnabled ? editorOverlayAnalysisRunId : null"
              :analysis-data-enabled="annotationOverlayEnabled && analysisDownloadsEnabled"
              :overlay-capture-time-us="visualPlayhead"
              :overlay-clip-start-capture-time-us="editorOverlayClipStart"
              :overlay-interactive="
                analysisOverlayActive &&
                (inspectorTab === 'mapping' ||
                  (inspectorTab === 'analysis' && analysisRevisionMode))
              "
              :ball-relabel="
                analysisRevisionMode && inspectorTab === 'analysis' && ballRelabelEnabled
              "
              :bbox-relabel="
                analysisRevisionMode && inspectorTab === 'analysis' && bboxRelabelEnabled
              "
              :selected-track-id="
                inspectorTab === 'analysis' || inspectorTab === 'mapping'
                  ? selectedOverlayTrackId
                  : null
              "
              :ball-correction="analysisOverlayActive ? currentBallOverride : null"
              :ball-corrections="analysisOverlayActive ? allBallCorrections : {}"
              :action-corrections="analysisOverlayActive ? currentActionCorrections : {}"
              :player-bbox-corrections="analysisOverlayActive ? allPlayerBBoxCorrections : {}"
              :contact-actor-corrections="analysisOverlayActive ? contactActorCorrections : {}"
              :contact-actor-projections="analysisOverlayActive ? contactActorProjections : {}"
              :contact-time-corrections="analysisOverlayActive ? contactTimeCorrections : {}"
              :identity-labels="overlayIdentityLabels"
              :overlay-events="overlayEvents"
              :overlay-tracks="overlayTracks"
              :overlay-team-labels="overlayTeamLabels"
              :overlay-layers="annotationOverlayLayers"
              @cursor="handleCursor"
              @live-error="handleOmePlaybackError"
              @live-position="handleOmeLivePosition"
              @ready="handleVideoReady"
              @buffer-activity="maintainPlaybackWindow"
              @buffer-state="handleBufferState"
              @overlay-frame="handleOverlayFrame"
              @overlay-video="handleOverlayVideo"
              @ball-position="handleBallPosition"
              @player-bbox="handlePlayerBBox"
              @track-select="handleOverlayTrack"
              @toggle="workstationActions.execute('media.toggle-playback')"
              @error="handlePlaybackError"
              @overlay-error="handleOverlayError"
            />
            <div
              v-if="playbackBuffering"
              class="viewer-buffering"
              role="status"
              aria-live="polite"
              aria-label="影片讀取中"
            >
              <LoaderCircle :size="16" aria-hidden="true" />
              <span>影片讀取中</span>
            </div>
            <AnnotationAnalysisToolbox
              :mode="analysisToolboxMode"
              :frame-index="currentOverlayFrame"
              :selected-action="selectedOverlayAction"
              :selected-hit-label="
                selectedAnalysisHit ? `第 ${selectedAnalysisHit.sequence_index + 1} 球` : null
              "
            />
            <div class="viewer-frame-index" aria-label="目前畫格索引">
              <span>FRAME IDX</span>
              <code>{{ displayFrameIndex }}</code>
            </div>
            <button
              type="button"
              class="viewer-overlay-toggle"
              :class="{ active: annotationOverlayEnabled }"
              :aria-pressed="annotationOverlayEnabled"
              :title="annotationOverlayEnabled ? '關閉分析 Overlay' : '開啟分析 Overlay'"
              @click="
                workstationActions.execute(
                  'visualization.toggle-overlay',
                  !annotationOverlayEnabled,
                )
              "
            >
              <Eye v-if="annotationOverlayEnabled" :size="14" />
              <EyeOff v-else :size="14" />
              <span>Overlay</span>
            </button>
            <div v-if="!descriptor && !omeLiveSource" class="stage-empty">
              <strong>{{ mediaEmptyLabel }}</strong
              ><button
                v-if="defaultPlaybackTarget"
                type="button"
                @click="createWindow(defaultPlaybackTarget, liveCapture ? 'live' : 'archive')"
              >
                {{ liveCapture ? 'LIVE' : '開啟影片' }}
              </button>
            </div>
            <AnnotationTrackAssignmentPopover
              :open="trackPopover.open"
              :match-id="matchId"
              :analysis-run-id="editorSelectedAnalysisRunId"
              :track-id="trackPopover.trackId"
              :left-team-id="selectedSideLeftTeamId"
              :right-team-id="selectedSideRightTeamId"
              :x="trackPopover.x"
              :y="trackPopover.y"
              @close="trackPopover.open = false"
            />
          </div>
        </main>
      </UiResizablePanel>
      <UiResizableHandle id="annotation-inspector-handle" />
      <UiResizablePanel id="annotation-inspector" :default-size="22" :min-size="18" :max-size="45">
        <AnnotationMatchInspector
          ref="matchInspector"
          v-model:tab="inspectorTab"
          :mapping-available="editorMappingAvailable"
          :analysis-available="editorMappingAvailable"
          :match-id="matchId"
          :left-team="selectedSideLeftTeam"
          :right-team="selectedSideRightTeam"
          :current-left-team="leftTeam"
          :current-right-team="rightTeam"
          :left-set-wins="selectedSideLeftSetWins"
          :right-set-wins="selectedSideRightSetWins"
          :set-number="displaySetNumber"
          :set-results="coach.data.value?.match.sets ?? []"
          :rally-ordinal="displayRallyOrdinal"
          :left-team-id="selectedSideLeftTeamId"
          :right-team-id="selectedSideRightTeamId"
          :context-rally-id="operationContextRallyId"
          :drafts="annotationDrafts"
          :rallies="visibleSubmittedRallies"
          :selected-rally-id="selectedRallyId"
          :displayed-rally-id="displayAnnotation?.rally_id ?? null"
          :displayed-outcome-label="currentMaskOutcome"
          :displayed-outcome-side="currentMaskOutcomeSide"
          :analysis-run-id="editorSelectedAnalysisRunId"
          :set-numbers="coach.data.value?.match.sets.map(set => set.set_number) ?? [1]"
          :teams="coach.data.value?.match.teams ?? []"
          :format-rally-duration="rally => formatDuration(rallyDisplayDuration(rally))"
          @select-track="handleIdentityTrackSelect"
        >
          <template #analysis>
            <AnnotationAnalysisPanel
              :frame-index="analysisOverlayActive ? currentOverlayFrame : -1"
              :ball-override="currentBallOverride?.state ?? null"
              :ball-position="currentBallPosition"
              :selected-track-action="selectedOverlayAction"
              :has-action-override="currentActionHasOverride"
              :has-bbox-override="currentBBoxHasOverride"
              :hits="analysisHitItems"
              :removed-hits="removedAnalysisHitItems"
            />
          </template>
        </AnnotationMatchInspector>
      </UiResizablePanel>
    </UiResizablePanelGroup>

    <footer class="timeline-footer">
      <AnnotationTransportBar
        :playing="playing"
        :timecode="displayTimecode"
        :cursor-available="Boolean(visualPlayhead)"
        :live-active="
          omeDirectPlaybackActive
            ? omeAtLiveEdge
            : playbackMode === 'active_live' && descriptor?.mode === 'live'
        "
        :live-available="Boolean(liveTarget || omeDirectPlaybackAvailable)"
        :terminal-label="playbackMode === 'ended_live' ? 'END' : null"
        :context-title="activeContextTitle"
        :context-hits="activeContextHits"
        :context-duration="formatDuration(activeContextDuration)"
        :context-state="
          selectedSubmissionPending || correctionSubmitting
            ? '等待伺服器確認'
            : correctionCreating
              ? '建立修正版中'
              : activeContextState
        "
        :processing="selectedSubmissionPending || correctionSubmitting ? null : activeProcessing"
        :correction-active="selectedCorrectionDraft"
        :correction-block-reason="correctionBlockReason"
        :submission-pending="selectedSubmissionPending || correctionSubmitting"
        :submitted-selected="Boolean(selectedSubmittedRally) && !selectedCorrectionDraft"
        :clip-selected="clipSelected"
        :draft-selected="editableDraftState"
        :muted="muted"
        :playback-rate="playbackRate"
        :timeline-scale="timelineScale"
        :shortcuts="{
          play: formatBindingForDisplay(bindings.play_pause),
          previousFrame: formatBindingForDisplay(bindings.frame_previous),
          nextFrame: formatBindingForDisplay(bindings.frame_next),
          previousPoint: formatBindingForDisplay(bindings.key_point_previous),
          nextPoint: formatBindingForDisplay(bindings.key_point_next),
          previousSegment: formatBindingForDisplay(
            shiftedHotkeyBinding(bindings.key_point_previous),
          ),
          nextSegment: formatBindingForDisplay(shiftedHotkeyBinding(bindings.key_point_next)),
        }"
        @focus-cursor="focusTimelineCursor"
      />
      <DvrTimelineDock
        ref="timelineDock"
        :timeline="timeline"
        :playhead="visualPlayhead"
        :remote-cursors="annotation.remoteCursors.value"
        :playback-mode="playbackMode"
        :restored-view="restoredWorkstationState?.timelineViewport ?? null"
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
        :editable="editableDraftState && draftMutationReady"
        :selected-key-point-id="selectedKeyPointId"
        :selected-point-editor-mode="keyPointEditorPositionMode"
        :mask-selected="timelineCurrentMaskSelected"
        :mask-range="currentMaskRange"
        :current-mask-status="currentMaskStatus"
        :current-mask-label="currentMaskLabel"
        :current-mask-outcome="currentMaskOutcome"
        :current-mask-outcome-side="currentMaskOutcomeSide"
        :current-mask-outcome-team-label="currentMaskOutcomeTeamLabel"
        :segments="displayedTimelineSegments"
        :selected-segment-id="selectedHistoricalSegmentId"
        :soft-locks="annotation.remoteEditorsByKeyPoint.value"
        @scale-change="timelineScale = $event"
        @view-change="rememberTimelineViewport"
      >
        <template #selected-point-editor>
          <AnnotationSelectedKeyPointEditor
            v-if="selectedKeyPoint"
            :selected-ball-event="selectedKeyPoint.ball_event ?? null"
            :previous-ball-event="selectedPreviousBallEvent"
            :selected-ordinal="selectedKeyPoint.sequence_index + 1"
            :selected-actor-id="selectedKeyPoint.ball_event_actor_roster_entry_id ?? null"
            :actor-options="ballEventActorOptions"
            :position-mode="keyPointEditorPositionMode"
            @update:position-mode="keyPointEditorPositionMode = $event"
          />
        </template>
      </DvrTimelineDock>
      <AnnotationCommandStrip
        :bindings="bindings"
        :left-team-label="commandLeftTeamLabel"
        :right-team-label="commandRightTeamLabel"
        :service-mode="hasActiveLocalSegment ? 'end' : 'start'"
      />
    </footer>
    <ClipDownloadDialog
      :open="downloadDialogOpen"
      :rally-id="selectedSubmittedRally?.id ?? null"
      :analysis-run-id="selectedAnalysisRunId"
      :title="activeContextTitle"
      @close="downloadDialogOpen = false"
    />

    <LazyAnnotationSettingsDialog />
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
      :needs-attention="syncNeedsAttention"
      :has-conflicts="annotation.outboxNeedsConfirmation.value"
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
      :open="Boolean(workstationConfirmation.current.value)"
      :title="workstationConfirmation.current.value?.title ?? ''"
      :message="workstationConfirmation.current.value?.message ?? ''"
      :confirm-label="workstationConfirmation.current.value?.confirmLabel ?? ''"
      :secondary-label="confirmSecondaryLabel"
      :danger="workstationConfirmation.current.value?.danger"
      :pending="workstationConfirmation.pending.value"
      @close="workstationConfirmation.close"
      @confirm="workstationConfirmation.confirm"
      @secondary="workstationConfirmation.secondary"
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
  grid-template-rows: 54px minmax(0, 1fr) 300px;
  overflow: hidden;
  background: var(--surface-0);
  color: #edf1f4;
  font-family: 'Segoe UI Variable Text', Aptos, 'Segoe UI', sans-serif;
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
  grid-template-columns:
    minmax(280px, auto) minmax(220px, 1fr)
    minmax(300px, auto);
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
.video-stage :deep(> .video-overlay-player) {
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
    600 0.66rem 'Cascadia Mono',
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
.viewer-buffering {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 8;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  border: 1px solid #856424;
  border-radius: 6px;
  background: #302611ee;
  color: #ffd987;
  font-size: 0.72rem;
  font-weight: 700;
  pointer-events: none;
  transform: translate(-50%, -50%);
}
.viewer-buffering svg {
  animation: viewer-buffering-spin 1s linear infinite;
}
@keyframes viewer-buffering-spin {
  to {
    transform: rotate(360deg);
  }
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
  padding: 0;
  overflow: hidden;
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
    700 0.78rem 'Cascadia Mono',
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
    700 0.63rem 'Cascadia Mono',
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
    grid-template-rows: 39px minmax(0, 1fr) 64px;
  }
  .inspector {
    padding: 0;
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
  padding: 0;
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
  grid-template-rows: 42px minmax(0, 1fr) 64px;
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
    grid-template-rows: 39px minmax(0, 1fr) 64px;
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
  grid-template-rows: 44px minmax(0, 1fr) 320px;
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
    700 0.55rem/1 'Cascadia Mono',
    Consolas,
    monospace;
  letter-spacing: 0.06em;
}
.viewer-frame-index code {
  color: #f3f5f6;
  font:
    700 0.68rem/1 'Cascadia Mono',
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
}
.viewer-overlay-toggle {
  position: absolute;
  top: 44px;
  left: 10px;
  z-index: 7;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid #ffffff2b !important;
  border-radius: 6px !important;
  background: #050709c2 !important;
  color: #aab4bd !important;
  font-size: 0.62rem;
  font-weight: 700;
}
.viewer-overlay-toggle.active {
  border-color: #47a6ff80 !important;
  background: #0d2e49d9 !important;
  color: #a9d8ff !important;
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
@media (max-height: 760px) {
  .editor-shell {
    grid-template-rows: 42px minmax(0, 1fr) 280px;
  }
}
</style>
