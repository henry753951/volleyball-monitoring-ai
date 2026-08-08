<script setup lang="ts">
import { ChevronLeft, ChevronRight, Crosshair, Home, Pause, Play, RadioTower, RotateCcw, Settings, SkipBack, SkipForward, StepBack, StepForward, Trash2, UsersRound, Volume2, VolumeX, Wifi, XCircle } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { createMediaClient } from '~/lib/mediaClient'
import { useAuthoritativeDvrWindow, seekVideoToCanonicalFrame, authoritativeControlsEnabled } from '~/composables/useAuthoritativeDvrWindow'
import { createCoreDomainClient, createGraphQLTransport, type Match, type CaptureSession } from '~/lib/coreDomain'
import { ANNOTATION_COMMANDS, formatBindingForDisplay, type AnnotationAction, type HotkeyCommand, type MediaAction } from '~/utils/annotationHotkeys'
import type { PlaybackCursorInput } from '~/lib/mediaModel'
import type { CoachRally } from '~/lib/coachDomain'
import { resolveSegmentSelection, segmentAtCaptureTime } from '~/lib/dvrTimeline'

definePageMeta({ layout: 'annotation' })
const route = useRoute()
const matchId = String(route.params.matchId)
const match = ref<Match | null>(null)
const loadError = ref<string | null>(null)
const media = createMediaClient()
const core = createCoreDomainClient(createGraphQLTransport('/graphql'))
const dvr = useAuthoritativeDvrWindow(media)
const descriptor = computed(() => dvr.current.value)
const { profile: mediaBufferProfile } = useMediaPlaybackPreferences()
const video = ref<HTMLVideoElement | null>(null)
const overlayPlayer = ref<{
  seekCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean
  previewCaptureTimeIfBuffered: (targetCaptureTimeUs: string) => boolean
  prewarmDescriptor: (nextDescriptor: NonNullable<typeof descriptor.value>) => Promise<void>
} | null>(null)
const playing = ref(false)
const muted = ref(false)
const captureTarget = ref('')
const mediaError = ref<string | null>(null)
const authoritativeAnchor = computed(() => dvr.anchor.value)
const observedCursor = shallowRef<PlaybackCursorInput | null>(null)
const cursorStatus = ref<'ready' | 'stale' | 'seeking' | 'gap'>('stale')
const annotation = useAnnotationRoom()
const coach = useCoachMatchState(matchId)
const state = annotation.state
const currentLastKeyPointId = computed(() => annotation.lastKeyPoint.value?.key_point_id ?? null)
const selectedKeyPointId = ref<string | null>(null)
const selectedTimelineItem = ref<'mask' | 'point' | 'segment' | null>(null)
const selectedKeyPoint = computed(() => annotation.snapshot.value?.snapshot.key_points.find(point => point.key_point_id === selectedKeyPointId.value) ?? null)
const pendingTimelineMove = shallowRef<{ keyPointId: string; playbackWindowId: string | null } | null>(null)
const frameQueueRunning = ref(false)
const seekPreviewActive = ref(false)
const canMark = computed(() => authoritativeControlsEnabled({ cursorReady: cursorStatus.value === 'ready', status: dvr.status.value, busy: dvr.busy.value, descriptor: descriptor.value, anchor: authoritativeAnchor.value }))
const commandReady = computed(() => !annotation.busy.value && annotation.pendingCount.value === 0 && !pendingTimelineMove.value)
const { bindings } = useAnnotationHotkeys()
const annotationScope = useTemplateRef<HTMLElement>('annotationScope')
const settingsOpen = ref(false)
const settingsInitialPage = ref<'root' | 'media' | 'clip' | 'hotkeys'>('root')
const clipPolicySaving = ref(false)
const clipPolicyError = ref<string | null>(null)
const cursorFollow = ref(false)
const captureDialogOpen = ref(false)
const connectionDialogOpen = ref(false)
const rosterDialogOpen = ref(false)
const confirmAction = ref<'void' | 'correction' | 'next-left' | 'next-right' | null>(null)
const confirmTitle = computed(() => confirmAction.value === 'void' ? '刪除未送出片段' : confirmAction.value === 'correction' ? '建立修正版' : '開啟新一局')
const confirmMessage = computed(() => confirmAction.value === 'void'
  ? '這個未送出片段會立即刪除，已送出的資料不受影響。'
  : confirmAction.value === 'correction'
    ? '送出修正版並完成 AI 處理後，教練端會更新為新版本。'
    : `${confirmAction.value === 'next-left' ? leftTeam.value?.name ?? '左隊' : rightTeam.value?.name ?? '右隊'}取得本局，比分歸零並開始下一局。`)
const confirmLabel = computed(() => confirmAction.value === 'void' ? '刪除片段' : confirmAction.value === 'correction' ? '建立修正版' : '確認並開始')
const correctionSubmissionId = ref<string | null>(null)
const inspectorTab = ref<'match' | 'mapping'>('match')
const pinnedRallyId = ref<string | null>(null)
const cursorRallyId = ref<string | null>(null)
const selectedRallyId = computed(() => resolveSegmentSelection(pinnedRallyId.value, cursorRallyId.value))
let matchRefreshTimer: ReturnType<typeof setInterval> | null = null
let timelineMoveTimeout: ReturnType<typeof setTimeout> | null = null
let cursorResolveTimer: ReturnType<typeof setTimeout> | null = null
let seekPreviewTimer: ReturnType<typeof setTimeout> | null = null
let seekPreviewTarget: string | null = null
let cursorResolveInFlight = false
let pendingCursorResolve: PlaybackCursorInput | null = null
let lastCursorResolveAt = 0
let lastResolvedCursorKey = ''
let matchRefreshInFlight = false
let windowRecoveryInFlight = false
let playbackContinuationInFlight = false
let playbackHasStarted = false
let continuationWindowId: string | null = null
let continuationRequestedAt = 0
let windowCreatePromise: ReturnType<typeof dvr.create> | null = null
let windowCreateTarget: string | undefined
let windowCreateMode: 'live' | 'archive' | undefined
let queuedFrameDelta = 0

const controls = computed(() => ANNOTATION_COMMANDS.map(command => ({
  ...command,
  key: formatBindingForDisplay(bindings.value[command.action]),
  ...commandAvailability(command.action),
})))
const commandAvailabilityMap = computed(() => Object.fromEntries(controls.value.map(control => [control.action, { enabled: control.enabled, reason: control.reason }])))

const selectedCapture = computed<CaptureSession | null>(() => {
  const sessions = (match.value?.captureSessions ?? []).filter(session => session.timeline?.availableRanges.length)
  return sessions.slice().sort((a, b) => (Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '')) || a.id.localeCompare(b.id))[0] ?? null
})
const submittedRallies = computed(() => coach.data.value?.match.rallies ?? [])
const annotationDrafts = computed(() => coach.data.value?.match.drafts ?? [])
const draftRallyIds = computed(() => new Set(annotationDrafts.value.map(draft => draft.id)))
const visibleSubmittedRallies = computed(() => submittedRallies.value.filter(rally => !draftRallyIds.value.has(rally.id)))
const visibleRallyCount = computed(() => new Set([...submittedRallies.value.map(rally => rally.id), ...annotationDrafts.value.map(draft => draft.id)]).size)
const completedRallies = computed(() => submittedRallies.value.filter(rally => rally.submission.analysis?.status === 'completed'))
const selectedDraftRally = computed(() => annotationDrafts.value.find(rally => rally.id === selectedRallyId.value) ?? null)
const selectedSubmittedRally = computed(() => selectedDraftRally.value ? null : submittedRallies.value.find(rally => rally.id === selectedRallyId.value) ?? null)
const selectedRally = computed(() => selectedDraftRally.value ? null : completedRallies.value.find(rally => rally.id === selectedRallyId.value) ?? null)
const mappingAvailable = computed(() => Boolean(selectedRally.value?.submission.analysis?.id))
const selectedAnalysisRunId = computed(() => selectedRally.value?.submission.analysis?.id ?? null)
const timelineSegments = computed(() => {
  const currentRallyId = annotation.snapshot.value?.rally_id
  const submitted = submittedRallies.value.flatMap((rally) => {
    const points = rally.submission.key_points
    const range = clipRangeForRally(rally)
    if (!range || rally.id === currentRallyId || draftRallyIds.value.has(rally.id)) return []
    const analysis = rally.submission.analysis
    return [{
      id: rally.id,
      label: `第 ${rally.set_number} 局 · 回合 ${rally.ordinal}`,
      stateLabel: analysis?.status === 'completed' ? analysis.identity_mapping_completed ? '球員已確認' : '待指派球員' : '分析中',
      outcomeLabel: rally.submission.score_resolution === 'unknown'
        ? '結果未知'
        : `${coach.data.value?.match.teams.find(team => team.id === rally.submission.scoring_team_id)?.shortName ?? '得分隊'} 得分`,
      startCaptureTimeUs: range.startCaptureTimeUs,
      endCaptureTimeUs: range.endCaptureTimeUs,
      points: points.map(point => ({ id: point.id, markerKind: point.marker_kind, isTerminal: point.is_terminal, captureTimeUs: point.capture_time_us })),
      status: analysis?.status === 'completed' ? analysis.identity_mapping_completed ? 'mapped' as const : 'analyzed' as const : 'processing' as const,
      analysis: analysis?.status === 'completed' && analysis.coverage_start_capture_time_us && analysis.coverage_end_capture_time_us
        ? {
            startCaptureTimeUs: analysis.coverage_start_capture_time_us,
            endCaptureTimeUs: analysis.coverage_end_capture_time_us,
            byteLength: analysis.byte_length,
            trackCount: analysis.track_count,
            ballPathCount: analysis.ball_path_count,
            contactCount: analysis.contact_count,
            capabilities: analysis.capabilities,
          }
        : null,
    }]
  })
  const drafts = annotationDrafts.value.flatMap((draft) => {
    const range = clipRangeForPoints(draft.key_points)
    if (draft.id === currentRallyId || !range) return []
    return [{
      id: draft.id,
      label: `第 ${draft.set_number} 局 · 回合 ${draft.ordinal}`,
      stateLabel: draft.active_submission_id ? '修正版' : draft.annotation_status === 'ready' ? '待送出' : '標記中',
      outcomeLabel: draft.key_points.some(point => point.is_terminal) ? '已標記終止點' : null,
      startCaptureTimeUs: range.startCaptureTimeUs,
      endCaptureTimeUs: range.endCaptureTimeUs,
      points: draft.key_points.map(point => ({ id: point.id, markerKind: point.marker_kind, isTerminal: point.is_terminal, captureTimeUs: point.capture_time_us })),
      status: 'draft' as const,
    }]
  })
  return [...submitted, ...drafts]
})
const currentSet = computed(() => coach.data.value?.match.sets.find(set => set.status === 'live') ?? coach.data.value?.match.sets.at(-1) ?? null)
const leftSetWins = computed(() => coach.data.value?.match.sets.filter(set => set.winning_team_id === leftTeamId.value).length ?? 0)
const rightSetWins = computed(() => coach.data.value?.match.sets.filter(set => set.winning_team_id === rightTeamId.value).length ?? 0)
const leftTeamId = computed(() => currentSet.value?.side_assignment?.left_team_id ?? coach.data.value?.match.teams[0]?.id ?? null)
const rightTeamId = computed(() => currentSet.value?.side_assignment?.right_team_id ?? coach.data.value?.match.teams[1]?.id ?? null)
const leftTeam = computed(() => coach.data.value?.match.teams.find(team => team.id === leftTeamId.value) ?? coach.data.value?.match.teams[0] ?? null)
const rightTeam = computed(() => coach.data.value?.match.teams.find(team => team.id === rightTeamId.value) ?? coach.data.value?.match.teams[1] ?? null)
const timeline = computed(() => selectedCapture.value?.timeline ?? null)
const currentMaskRange = computed(() => {
  const snapshot = annotation.snapshot.value
  const points = snapshot?.snapshot.key_points ?? []
  const editableDraft = snapshot && ['open', 'ready'].includes(snapshot.snapshot.annotation_status)
  return !editableDraft && currentAnnotationRally.value ? clipRangeForRally(currentAnnotationRally.value) : snapshot ? clipRangeForPoints(points) : null
})
const selectableSegmentRanges = computed(() => {
  const currentId = annotation.snapshot.value?.rally_id
  const currentRange = currentMaskRange.value
  return currentId && currentRange
    ? [...timelineSegments.value, { id: currentId, ...currentRange }]
    : timelineSegments.value
})
const selectedCurrentMask = computed(() => selectedRallyId.value === annotation.snapshot.value?.rally_id)
const selectedHistoricalSegmentId = computed(() => selectedCurrentMask.value ? null : selectedRallyId.value)
const selectedCaptureId = computed(() => selectedCapture.value?.id ?? null)
const liveTarget = computed(() => timeline.value?.liveEdgeCaptureTimeUs ?? timeline.value?.availableRanges.at(-1)?.endUs ?? null)
const visualPlayhead = computed(() => {
  const cursor = observedCursor.value
  const window = descriptor.value
  if (!cursor || !window || cursor.playback_window_id !== window.playback_window_id || cursor.mapping_version !== window.mapping_version) return authoritativeAnchor.value?.capture_time_us ?? null
  const projected = BigInt(window.presentation_origin_capture_us) + BigInt(cursor.player_media_time_us)
  const start = BigInt(window.window_capture_start_us)
  const end = BigInt(window.window_capture_end_us)
  return (projected < start ? start : projected > end ? end : projected).toString()
})
const cursorRally = computed(() => {
  return submittedRallies.value.find(rally => rally.id === cursorRallyId.value) ?? null
})
const currentAnnotationRally = computed(() => submittedRallies.value.find(rally => rally.id === annotation.snapshot.value?.rally_id) ?? null)
const currentMaskStatus = computed<'processing' | 'analyzed' | 'mapped'>(() => {
  const analysis = currentAnnotationRally.value?.submission.analysis
  return analysis?.status === 'completed' ? analysis.identity_mapping_completed ? 'mapped' : 'analyzed' : 'processing'
})
const currentMaskLabel = computed(() => {
  const draft = currentAnnotationDraft.value
  return draft ? `第 ${draft.set_number} 局 · 回合 ${draft.ordinal}` : currentAnnotationRally.value ? `第 ${currentAnnotationRally.value.set_number} 局 · 回合 ${currentAnnotationRally.value.ordinal}` : null
})
const currentMaskOutcome = computed(() => {
  const snapshot = annotation.snapshot.value?.snapshot
  if (!snapshot || snapshot.score_resolution === 'pending') return null
  if (snapshot.score_resolution === 'unknown') return '結果未知'
  return snapshot.scoring_court_side === 'left' ? `${leftTeam.value?.shortName ?? '左隊'} 得分` : `${rightTeam.value?.shortName ?? '右隊'} 得分`
})
const activeOverlayRally = computed(() => cursorRally.value?.submission.analysis?.status === 'completed' ? cursorRally.value : null)
const activeOverlayAnalysisRunId = computed(() => activeOverlayRally.value?.submission.analysis?.id ?? null)
const activeOverlayClipStart = computed(() => activeOverlayRally.value?.submission.clip?.start_capture_time_us ?? null)
const navigableKeyPoints = computed(() => {
  const currentRallyId = annotation.snapshot.value?.rally_id ?? null
  const submitted = submittedRallies.value.flatMap(rally => rally.id === currentRallyId ? [] : rally.submission.key_points.map(point => ({
    id: point.id,
    captureTimeUs: point.capture_time_us,
    rallyId: rally.id,
    editable: false,
  })))
  const drafts = annotationDrafts.value.flatMap(draft => draft.id === currentRallyId ? [] : draft.key_points.map(point => ({
    id: point.id,
    captureTimeUs: point.capture_time_us,
    rallyId: draft.id,
    editable: draft.annotation_status === 'open',
  })))
  const current = (annotation.snapshot.value?.snapshot.key_points ?? []).map(point => ({
    id: point.key_point_id,
    captureTimeUs: point.capture_time_us,
    rallyId: currentRallyId,
    editable: state.value === 'OPEN',
  }))
  return [...submitted, ...drafts, ...current].sort((left, right) => {
    const difference = BigInt(left.captureTimeUs) - BigInt(right.captureTimeUs)
    return difference < 0n ? -1 : difference > 0n ? 1 : left.id.localeCompare(right.id)
  })
})
const activeContextRally = computed(() => selectedSubmittedRally.value)
const currentAnnotationDraft = computed(() => annotationDrafts.value.find(draft => draft.id === annotation.snapshot.value?.rally_id) ?? null)
const activeContextDraft = computed(() => selectedDraftRally.value ?? (selectedCurrentMask.value ? currentAnnotationDraft.value : null))
const selectedEditableDraft = computed(() => Boolean(activeContextDraft.value && activeContextDraft.value.id === annotation.snapshot.value?.rally_id && ['OPEN', 'READY'].includes(state.value)))
const correctionActive = computed(() => Boolean(selectedEditableDraft.value && annotation.snapshot.value?.snapshot.active_submission_id))
const selectedDeletablePoint = computed(() => selectedTimelineItem.value === 'point' && selectedKeyPoint.value?.marker_kind !== 'service')
const activeContextTitle = computed(() => activeContextDraft.value
  ? `第 ${activeContextDraft.value.set_number} 局 · 回合 ${activeContextDraft.value.ordinal}`
  : activeContextRally.value
    ? `第 ${activeContextRally.value.set_number} 局 · 回合 ${activeContextRally.value.ordinal}`
    : '游標未落在片段內')
const activeContextHits = computed(() => activeContextDraft.value?.key_points.filter(point => point.marker_kind === 'contact').length ?? activeContextRally.value?.submission.contact_count ?? 0)
const activeContextDuration = computed(() => activeContextDraft.value
  ? clipDurationForPoints(activeContextDraft.value.key_points)
  : activeContextRally.value ? rallyDisplayDuration(activeContextRally.value) : null)
const activeContextState = computed(() => activeContextDraft.value
  ? activeContextDraft.value.annotation_status === 'ready' ? '待送出' : '標記中'
  : activeContextRally.value?.submission.analysis?.status === 'completed'
    ? activeContextRally.value.submission.analysis.identity_mapping_completed ? '已指派' : '分析完成'
    : activeContextRally.value ? '處理中' : '—')
const displayRallyOrdinal = computed(() => activeContextRally.value?.ordinal ?? activeContextDraft.value?.ordinal ?? '—')
const syncLabel = computed(() => annotation.error.value || annotation.outboxNeedsConfirmation.value
  ? 'WS 需注意'
  : annotation.pendingCount.value || annotation.busy.value
    ? 'WS 同步中'
    : annotation.connection.value === 'ready' ? 'WS 正常' : 'WS 離線')
const displayTimecode = computed(() => formatTimecode(observedCursor.value?.player_media_time_us))
const remoteEditorsFor = (keyPointId: string) => annotation.remoteEditorsByKeyPoint.value[keyPointId] ?? []

function openSettings(page: 'root' | 'media' | 'clip' | 'hotkeys' = 'root') {
  settingsInitialPage.value = page
  settingsOpen.value = true
}

const clipPreRollUs = computed(() => BigInt(match.value?.clipPreRollUs ?? coach.data.value?.match.clip_pre_roll_us ?? '3000000'))
const clipPostRollUs = computed(() => BigInt(match.value?.clipPostRollUs ?? coach.data.value?.match.clip_post_roll_us ?? '3000000'))
const clipPreRollSeconds = computed(() => Number(clipPreRollUs.value / 1_000_000n))
const clipPostRollSeconds = computed(() => Number(clipPostRollUs.value / 1_000_000n))
function clipRangeForPoints(points: ReadonlyArray<{ capture_time_us: string }>) {
  if (!points.length) return null
  const requestedStart = BigInt(points[0]!.capture_time_us) - clipPreRollUs.value
  const requestedEnd = BigInt(points.at(-1)!.capture_time_us) + clipPostRollUs.value
  const timelineStart = timeline.value?.availableRanges[0]?.startUs
  const timelineEnd = timeline.value?.availableRanges.at(-1)?.endUs
  const start = requestedStart < 0n ? 0n : timelineStart && requestedStart < BigInt(timelineStart) ? BigInt(timelineStart) : requestedStart
  const end = timelineEnd && requestedEnd > BigInt(timelineEnd) ? BigInt(timelineEnd) : requestedEnd
  return { startCaptureTimeUs: start.toString(), endCaptureTimeUs: end.toString() }
}

function commandAvailability(action: AnnotationAction) {
  if (!commandReady.value) return { enabled: false, reason: '標記同步中' }
  if (action === 'submit') return state.value === 'READY'
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: '片段尚未完成' }
  const cursor = visualPlayhead.value
  if (!cursor || !canMark.value) return { enabled: false, reason: '播放游標尚未確認' }
  const cursorValue = BigInt(cursor)
  const currentRange = currentMaskRange.value
  const insideCurrent = Boolean(currentRange
    && cursorValue >= BigInt(currentRange.startCaptureTimeUs)
    && cursorValue <= BigInt(currentRange.endCaptureTimeUs))
  if (action === 'service') {
    if (state.value === 'OPEN') return { enabled: false, reason: '目前仍有正在編輯的片段' }
    const start = cursorValue > clipPreRollUs.value ? cursorValue - clipPreRollUs.value : 0n
    const end = cursorValue + clipPostRollUs.value
    const overlap = selectableSegmentRanges.value.some(range => start < BigInt(range.endCaptureTimeUs) && end > BigInt(range.startCaptureTimeUs))
    return overlap ? { enabled: false, reason: '片段延展範圍會與既有片段重疊' } : { enabled: true, reason: '' }
  }
  if (!['OPEN', 'READY'].includes(state.value)) return { enabled: false, reason: '請先開始或開啟可編輯片段' }
  if (!insideCurrent) return { enabled: false, reason: '游標不在可編輯片段內' }
  if (action === 'contact') {
    if (state.value !== 'OPEN') return { enabled: false, reason: '已完成片段不可新增擊球點' }
    const service = annotation.snapshot.value?.snapshot.key_points.find(point => point.marker_kind === 'service')
    if (!service || cursorValue < BigInt(service.capture_time_us)) return { enabled: false, reason: '擊球點必須位於發球之後' }
    return { enabled: true, reason: '' }
  }
  return currentLastKeyPointId.value
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: '沒有可設為終止點的擊球點' }
}
function clipDurationForPoints(points: ReadonlyArray<{ capture_time_us: string }>) {
  const range = clipRangeForPoints(points)
  return range ? (BigInt(range.endCaptureTimeUs) - BigInt(range.startCaptureTimeUs)).toString() : null
}
function clipRangeForRally(rally: CoachRally) {
  const clip = rally.submission.clip
  return clip
    ? { startCaptureTimeUs: clip.start_capture_time_us, endCaptureTimeUs: clip.end_capture_time_us }
    : clipRangeForPoints(rally.submission.key_points)
}
function rallyDisplayDuration(rally: CoachRally) {
  const range = clipRangeForRally(rally)
  return range ? (BigInt(range.endCaptureTimeUs) - BigInt(range.startCaptureTimeUs)).toString() : null
}

function formatTimecode(value?: string | null) {
  if (!value) return '00:00.000'
  const milliseconds = Number(BigInt(value) / 1_000n)
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const ms = milliseconds % 1_000
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
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
  }
  catch (error) {
    if (!options.silent) loadError.value = error instanceof Error ? error.message : '場次資料載入失敗'
  }
  finally { matchRefreshInFlight = false }
}

async function updateClipPolicy(preRollSeconds: number, postRollSeconds: number) {
  clipPolicySaving.value = true
  clipPolicyError.value = null
  try {
    match.value = await core.updateMatchClipPolicy({ matchId, preRollSeconds, postRollSeconds })
    await coach.refresh()
    toast.success('片段範圍已更新')
  }
  catch (error) {
    clipPolicyError.value = error instanceof Error ? error.message : '片段範圍儲存失敗'
  }
  finally { clipPolicySaving.value = false }
}

async function resolveLatestCursor() {
  cursorResolveTimer = null
  if (cursorResolveInFlight || !pendingCursorResolve) return
  const cursor = pendingCursorResolve
  pendingCursorResolve = null
  cursorResolveInFlight = true
  lastCursorResolveAt = performance.now()
  try {
    const resolved = await dvr.resolve(cursor)
    if (resolved) lastResolvedCursorKey = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}:${cursor.player_media_time_us}`
    const timelineMove = pendingTimelineMove.value
    if (resolved && timelineMove && timelineMove.playbackWindowId === cursor.playback_window_id) {
      pendingTimelineMove.value = null
      if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout)
      timelineMoveTimeout = null
      try {
        if (state.value === 'OPEN' && selectedKeyPointId.value === timelineMove.keyPointId && commandReady.value) {
          await annotation.edit('MOVE_KEY_POINT', { keyPointId: timelineMove.keyPointId, cursor })
        }
      }
      finally { releaseEditingIntent() }
      return
    }
  }
  catch (error) { mediaError.value = error instanceof Error ? error.message : '游標解析失敗' }
  finally {
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
  const previousSeekGeneration = observedCursor.value?.seek_generation
  observedCursor.value = cursor
  cursorStatus.value = cursor.cursor_status
  if (seekPreviewActive.value) return
  if (cursor.cursor_status !== 'ready') {
    pendingCursorResolve = null
    return
  }
  const key = `${cursor.playback_window_id}:${cursor.mapping_version}:${cursor.seek_generation}:${cursor.player_media_time_us}`
  if (key === lastResolvedCursorKey) return
  const anchorNeedsRefresh = authoritativeAnchor.value?.playback_window_id !== cursor.playback_window_id
    || authoritativeAnchor.value.mapping_version !== cursor.mapping_version
  const shouldResolve = anchorNeedsRefresh
    || cursor.seek_generation !== previousSeekGeneration
    || Boolean(pendingTimelineMove.value)
  if (!shouldResolve) return
  pendingCursorResolve = cursor
  scheduleCursorResolve(true)
}

async function createWindow(target = captureTarget.value || undefined, requestedMode?: 'live' | 'archive') {
  const mode = requestedMode ?? (target === liveTarget.value ? 'live' : 'archive')
  if (windowCreatePromise && target === windowCreateTarget && mode === windowCreateMode) return windowCreatePromise
  mediaError.value = null
  const request = (async () => {
    try {
      const session = selectedCapture.value
      if (!session || !target) throw new Error('目前沒有可播放的 capture range')
      captureTarget.value = target
      return await dvr.create({
        schema_version: '1.0.0',
        capture_session_id: session.id,
        mode,
        target_capture_time_us: target,
        requested_back_us: mediaBufferProfile.value.requestedBackUs,
        requested_forward_us: mediaBufferProfile.value.requestedForwardUs,
      })
    }
    catch (error) { mediaError.value = error instanceof Error ? error.message : '播放視窗建立失敗'; return null }
    finally { mediaError.value = dvr.error.value instanceof Error ? dvr.error.value.message : mediaError.value }
  })()
  windowCreatePromise = request
  windowCreateTarget = target
  windowCreateMode = mode
  try { return await request }
  finally {
    if (windowCreatePromise === request) {
      windowCreatePromise = null
      windowCreateTarget = undefined
      windowCreateMode = undefined
    }
  }
}

async function seekTimeline(targetCaptureTimeUs: string) {
  seekPreviewActive.value = false
  seekPreviewTarget = null
  if (seekPreviewTimer) clearTimeout(seekPreviewTimer)
  seekPreviewTimer = null
  captureTarget.value = targetCaptureTimeUs
  if (overlayPlayer.value?.seekCaptureTimeIfBuffered(targetCaptureTimeUs)) return
  await createWindow(targetCaptureTimeUs)
}

function previewTimelineSeek(targetCaptureTimeUs: string | null) {
  seekPreviewActive.value = Boolean(targetCaptureTimeUs)
  seekPreviewTarget = targetCaptureTimeUs
  if (seekPreviewTimer) clearTimeout(seekPreviewTimer)
  seekPreviewTimer = null
  if (!targetCaptureTimeUs || overlayPlayer.value?.previewCaptureTimeIfBuffered(targetCaptureTimeUs)) return
  seekPreviewTimer = setTimeout(() => {
    seekPreviewTimer = null
    const target = seekPreviewTarget
    if (!target || !seekPreviewActive.value) return
    void createWindow(target)
  }, 140)
}

function dispatchAnnotationAction(action: AnnotationAction) {
  const control = controls.value.find(item => item.action === action)
  if (!control?.enabled) return
  void annotation.dispatch(action, observedCursor.value).catch(() => undefined)
}

function editKeyPoint(kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT') {
  if (!selectedKeyPointId.value || state.value !== 'OPEN' || !commandReady.value) return
  if (kind === 'MOVE_KEY_POINT' && !canMark.value) return
  if (kind === 'MOVE_KEY_POINT') annotation.setEditingKeyPoint(selectedKeyPointId.value)
  void annotation.edit(kind, { keyPointId: selectedKeyPointId.value, cursor: observedCursor.value }).then(() => {
    if (kind === 'DELETE_KEY_POINT') selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
  }).catch(() => undefined).finally(() => { if (kind === 'MOVE_KEY_POINT') releaseEditingIntent() })
}

function selectTimelineKeyPoint(keyPointId: string) {
  pinnedRallyId.value = null
  selectedKeyPointId.value = keyPointId
  selectedTimelineItem.value = 'point'
}

function selectTimelineMask() {
  pinnedRallyId.value = annotation.snapshot.value?.rally_id ?? null
  selectedTimelineItem.value = 'mask'
  selectedKeyPointId.value = null
}

function clearTimelineSelection() {
  pinnedRallyId.value = null
  selectedTimelineItem.value = null
  selectedKeyPointId.value = null
}

async function selectHistoricalSegment(segmentId: string, _targetCaptureTimeUs: string) {
  const draft = annotationDrafts.value.find(candidate => candidate.id === segmentId)
  if (draft) {
    await annotation.selectRally(draft.id)
    pinnedRallyId.value = draft.id
    selectedTimelineItem.value = 'mask'
    selectedKeyPointId.value = null
    return
  }
  pinnedRallyId.value = segmentId
  selectedTimelineItem.value = 'segment'
  selectedKeyPointId.value = null
}

function selectRally(rally: CoachRally) {
  pinnedRallyId.value = rally.id
  selectedTimelineItem.value = 'segment'
  selectedKeyPointId.value = null
  if (rally.submission.clip) void seekTimeline(rally.submission.clip.start_capture_time_us)
}

function openMapping() {
  if (!mappingAvailable.value) return
  inspectorTab.value = 'mapping'
}

function releaseEditingIntent() {
  annotation.setEditingKeyPoint(null)
}

function beginTimelineKeyPointEdit(keyPointId: string) {
  if (state.value !== 'OPEN' || !commandReady.value) return
  selectedKeyPointId.value = keyPointId
  annotation.setEditingKeyPoint(keyPointId)
}

function cancelTimelineKeyPointEdit(keyPointId: string) {
  if (pendingTimelineMove.value?.keyPointId === keyPointId) return
  releaseEditingIntent()
}

async function moveTimelineKeyPoint(keyPointId: string, targetCaptureTimeUs: string) {
  if (state.value !== 'OPEN' || !commandReady.value || !selectedCapture.value) {
    releaseEditingIntent()
    return
  }
  selectedKeyPointId.value = keyPointId
  annotation.setEditingKeyPoint(keyPointId)
  pendingTimelineMove.value = { keyPointId, playbackWindowId: null }
  try {
    if (descriptor.value && overlayPlayer.value?.seekCaptureTimeIfBuffered(targetCaptureTimeUs)) {
      pendingTimelineMove.value = { keyPointId, playbackWindowId: descriptor.value.playback_window_id }
      timelineMoveTimeout = setTimeout(() => {
        if (pendingTimelineMove.value?.keyPointId !== keyPointId) return
        pendingTimelineMove.value = null
        timelineMoveTimeout = null
        toast.error('無法解析拖曳位置，擊球點未變更')
        releaseEditingIntent()
      }, 8_000)
      return
    }
    const created = await dvr.create({
      schema_version: '1.0.0',
      capture_session_id: selectedCapture.value.id,
      mode: 'archive',
      target_capture_time_us: targetCaptureTimeUs,
    })
    if (!created || pendingTimelineMove.value?.keyPointId !== keyPointId) throw new Error('拖曳播放視窗已被較新的操作取代')
    pendingTimelineMove.value = { keyPointId, playbackWindowId: created.playback_window_id }
    timelineMoveTimeout = setTimeout(() => {
      if (pendingTimelineMove.value?.keyPointId !== keyPointId) return
      pendingTimelineMove.value = null
      timelineMoveTimeout = null
      toast.error('無法解析拖曳位置，擊球點未變更')
      releaseEditingIntent()
    }, 8_000)
  }
  catch (error) {
    pendingTimelineMove.value = null
    if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout)
    timelineMoveTimeout = null
    toast.error(error instanceof Error ? error.message : '拖曳擊球點失敗')
    releaseEditingIntent()
  }
}

async function nudgeSelectedKeyPoint(direction: 'previous' | 'next') {
  const point = selectedKeyPoint.value
  const capture = selectedCapture.value
  if (!point || !capture || state.value !== 'OPEN' || !commandReady.value) return
  annotation.setEditingKeyPoint(point.key_point_id)
  try {
    let window = descriptor.value
    if (!window || BigInt(point.capture_time_us) < BigInt(window.window_capture_start_us) || BigInt(point.capture_time_us) >= BigInt(window.window_capture_end_us)) {
      window = await dvr.create({
        schema_version: '1.0.0',
        capture_session_id: capture.id,
        mode: 'archive',
        target_capture_time_us: point.capture_time_us,
      })
    }
    if (!window) throw new Error('無法建立擊球點微調視窗')
    const frame = await media.frameStep({
      schema_version: '1.0.0',
      capture_session_id: capture.id,
      playback_window_id: window.playback_window_id,
      mapping_version: window.mapping_version,
      capture_frame_index: point.capture_frame_index,
      direction,
    })
    const cursor: PlaybackCursorInput = {
      schema_version: '1.0.0',
      playback_window_id: frame.playback_window_id,
      mapping_version: frame.mapping_version,
      player_media_time_us: frame.player_media_time_us,
      observation_source: 'current_time_fallback',
      presented_frames: null,
      seek_generation: (observedCursor.value?.seek_generation ?? 0) + 1,
      cursor_status: 'ready',
    }
    observedCursor.value = cursor
    cursorStatus.value = 'ready'
    const resolved = await dvr.resolve(cursor)
    if (!resolved) throw new Error('伺服器無法解析微調畫格')
    if (video.value) seekVideoToCanonicalFrame(video.value, frame)
    await annotation.edit('MOVE_KEY_POINT', { keyPointId: point.key_point_id, cursor })
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : '擊球點微調失敗')
  }
  finally { releaseEditingIntent() }
}

function reopenRally() {
  if (state.value !== 'READY' || !commandReady.value) return
  void annotation.edit('REOPEN_RALLY').catch(() => undefined)
}

function voidRally() {
  if (!['OPEN', 'READY'].includes(state.value) || !commandReady.value) return
  correctionSubmissionId.value = null
  confirmAction.value = 'void'
}

function deleteSelection() {
  if (selectedDeletablePoint.value) editKeyPoint('DELETE_KEY_POINT')
  else if (selectedEditableDraft.value) voidRally()
}

function startCorrection() {
  const submissionId = selectedSubmittedRally.value?.submission.id
  if (!submissionId || !commandReady.value) return
  correctionSubmissionId.value = submissionId
  confirmAction.value = 'correction'
}

function cancelCorrection() {
  if (!correctionActive.value || !commandReady.value) return
  void annotation.cancelCorrection().then(() => {
    pinnedRallyId.value = annotation.snapshot.value?.rally_id ?? null
    selectedTimelineItem.value = 'segment'
    selectedKeyPointId.value = null
    toast.success('已取消修正，原送出版本維持有效')
    void coach.refresh()
  }).catch(() => undefined)
}

function requestNextSet(side: 'left' | 'right') {
  if (!currentSet.value || !commandReady.value) return
  confirmAction.value = side === 'left' ? 'next-left' : 'next-right'
}

function closeConfirmAction() {
  confirmAction.value = null
  correctionSubmissionId.value = null
}

function confirmPendingAction() {
  const action = confirmAction.value
  const submissionId = correctionSubmissionId.value
  confirmAction.value = null
  correctionSubmissionId.value = null
  if (action === 'void') {
    void annotation.edit('VOID_RALLY', { reason: 'operator_voided_from_workstation' }).then(() => toast.success('未送出片段已刪除')).catch(() => undefined)
    return
  }
  if (action === 'next-left' || action === 'next-right') {
    const winningTeamId = action === 'next-left' ? leftTeamId.value : rightTeamId.value
    if (!winningTeamId) return
    void core.startNextSet({ matchId, winningTeamId }).then(async () => {
      await Promise.all([loadMatch({ silent: true }), coach.refresh()])
      toast.success('新一局已開始')
    }).catch(error => toast.error(error instanceof Error ? error.message : '無法開始新一局'))
    return
  }
  if (!submissionId) return
  void annotation.createCorrection(submissionId).then(async () => {
    // A correction draft is cloned as READY so its terminal outcome is preserved
    // transactionally. Enter edit mode immediately; the operator will close it
    // again after making changes, then submit the new immutable revision.
    await annotation.edit('REOPEN_RALLY')
    pinnedRallyId.value = annotation.snapshot.value?.rally_id ?? null
    selectedTimelineItem.value = null
    selectedKeyPointId.value = annotation.lastKeyPoint.value?.key_point_id ?? null
    toast.success('修正版已建立，可開始編輯')
  }).catch(() => undefined)
}

type PlayerAction = MediaAction | 'mute'
function updatePlaybackState() {
  playing.value = Boolean(video.value && !video.value.paused)
  if (playing.value) playbackHasStarted = true
  muted.value = Boolean(video.value?.muted)
}
function detachVideoState(element: HTMLVideoElement | null) {
  element?.removeEventListener('play', updatePlaybackState)
  element?.removeEventListener('pause', updatePlaybackState)
  element?.removeEventListener('volumechange', updatePlaybackState)
  element?.removeEventListener('timeupdate', maintainPlaybackWindow)
  element?.removeEventListener('ended', maintainPlaybackWindow)
}
function maintainPlaybackWindow() {
  const element = video.value
  const window = descriptor.value
  if (!element || !window || seekPreviewActive.value || playbackContinuationInFlight || !playbackHasStarted) return
  if (element.paused && !element.ended) return
  if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !Number.isFinite(element.duration) || element.duration <= 0) return
  if (!element.ended && element.duration - element.currentTime > mediaBufferProfile.value.refreshLeadSeconds) return
  if (continuationWindowId === window.playback_window_id || performance.now() - continuationRequestedAt < 750) return

  const windowEnd = BigInt(window.window_capture_end_us)
  const timelineEnd = liveTarget.value ? BigInt(liveTarget.value) : null
  if (!timelineEnd || windowEnd >= timelineEnd) return
  const observedCapture = BigInt(window.presentation_origin_capture_us) + BigInt(Math.max(0, Math.round(element.currentTime * 1_000_000)))
  const target = (observedCapture > windowEnd ? windowEnd : observedCapture).toString()
  const sourceWindowId = window.playback_window_id
  continuationRequestedAt = performance.now()
  playbackContinuationInFlight = true
  const session = selectedCapture.value
  if (!session) { playbackContinuationInFlight = false; return }
  void media.createPlaybackWindow({
    schema_version: '1.0.0',
    capture_session_id: session.id,
    mode: window.mode,
    target_capture_time_us: target,
    requested_back_us: mediaBufferProfile.value.requestedBackUs,
    requested_forward_us: mediaBufferProfile.value.requestedForwardUs,
  }).then(async (created) => {
    await overlayPlayer.value?.prewarmDescriptor(created)
    if (descriptor.value?.playback_window_id !== sourceWindowId) return
    if (BigInt(created.window_capture_end_us) <= windowEnd) {
      continuationWindowId = null
      return
    }
    continuationWindowId = sourceWindowId
    dvr.activate(created)
  }).catch((error) => {
    continuationWindowId = null
    mediaError.value = error instanceof Error ? error.message : '背景載入播放視窗失敗'
  }).finally(() => { playbackContinuationInFlight = false })
}
function handleVideoReady(element: HTMLVideoElement) {
  if (video.value !== element) {
    detachVideoState(video.value)
    video.value = element
    element.addEventListener('play', updatePlaybackState)
    element.addEventListener('pause', updatePlaybackState)
    element.addEventListener('volumechange', updatePlaybackState)
    element.addEventListener('timeupdate', maintainPlaybackWindow)
    element.addEventListener('ended', maintainPlaybackWindow)
  }
  updatePlaybackState()
}
function dispatchMediaAction(action: PlayerAction, frameCount = 1) {
  const element = video.value
  if (!element) return
  if (action === 'play_pause') {
    if (element.paused) void element.play().catch((error) => { mediaError.value = error instanceof Error ? error.message : '播放器無法開始播放' })
    else element.pause()
  }
  if (action === 'mute') element.muted = !element.muted
  if (action === 'frame_previous' || action === 'frame_next') queueFrameStep(action === 'frame_next' ? 'next' : 'previous', frameCount)
  if (action === 'key_point_previous' || action === 'key_point_next') navigateKeyPoint(action === 'key_point_next' ? 'next' : 'previous')
}

function queueFrameStep(direction: 'previous' | 'next', count = 1) {
  queuedFrameDelta = Math.max(-60, Math.min(60, queuedFrameDelta + (direction === 'next' ? count : -count)))
  if (!frameQueueRunning.value) void drainFrameQueue()
}

async function drainFrameQueue() {
  if (!descriptor.value || frameQueueRunning.value) return
  frameQueueRunning.value = true
  try {
    if (observedCursor.value?.cursor_status === 'ready') {
      const resolved = await dvr.resolve(observedCursor.value)
      if (resolved) lastResolvedCursorKey = `${observedCursor.value.playback_window_id}:${observedCursor.value.mapping_version}:${observedCursor.value.seek_generation}:${observedCursor.value.player_media_time_us}`
    }
    while (queuedFrameDelta !== 0 && descriptor.value && authoritativeAnchor.value) {
      const direction = queuedFrameDelta > 0 ? 'next' : 'previous'
      queuedFrameDelta += direction === 'next' ? -1 : 1
      const anchor = await dvr.step(direction, target => ({ schema_version: '1.0.0', capture_session_id: descriptor.value!.capture_session_id, mode: descriptor.value!.mode, target_capture_time_us: target }))
      if (!anchor) { queuedFrameDelta = 0; break }
      const localUs = BigInt(anchor.player_media_time_us)
      if (localUs < 0n || localUs > 86_400_000_000n) throw new RangeError('frame-step returned an unbounded player time')
      if (video.value) seekVideoToCanonicalFrame(video.value, anchor)
    }
  }
  catch (error) { queuedFrameDelta = 0; mediaError.value = error instanceof Error ? error.message : '逐幀請求失敗' }
  finally { frameQueueRunning.value = false }
}

function navigateKeyPoint(direction: 'previous' | 'next') {
  const points = navigableKeyPoints.value
  if (!points.length) return
  const selectedIndex = selectedKeyPointId.value ? points.findIndex(point => point.id === selectedKeyPointId.value) : -1
  const reference = selectedKeyPoint.value?.capture_time_us ?? visualPlayhead.value
  const target = selectedIndex >= 0
    ? points[selectedIndex + (direction === 'next' ? 1 : -1)]
    : direction === 'next'
      ? points.find(point => !reference || BigInt(point.captureTimeUs) > BigInt(reference))
      : points.findLast(point => !reference || BigInt(point.captureTimeUs) < BigInt(reference))
  if (!target) { toast.info(direction === 'next' ? '已到最後一個擊球點' : '已到第一個擊球點'); return }
  if (target.rallyId === annotation.snapshot.value?.rally_id) {
    selectedKeyPointId.value = target.id
    selectedTimelineItem.value = 'point'
  }
  else if (target.rallyId && annotationDrafts.value.some(draft => draft.id === target.rallyId)) {
    void selectHistoricalSegment(target.rallyId, target.captureTimeUs)
    return
  }
  else {
    pinnedRallyId.value = target.rallyId
    selectedTimelineItem.value = 'segment'
    selectedKeyPointId.value = null
  }
  void seekTimeline(target.captureTimeUs)
}

function dispatchHotkeyCommand(action: HotkeyCommand, event: KeyboardEvent) {
  if (action === 'play_pause' || action.startsWith('frame_') || action.startsWith('key_point_')) dispatchMediaAction(action as MediaAction, event.shiftKey ? 5 : 1)
  else dispatchAnnotationAction(action as AnnotationAction)
}
function commandEnabled(action: HotkeyCommand) {
  if (action === 'play_pause') return Boolean(descriptor.value)
  if (action.startsWith('key_point_')) return navigableKeyPoints.value.length > 0
  return action.startsWith('frame_')
    ? Boolean(descriptor.value && authoritativeAnchor.value && cursorStatus.value === 'ready')
    : controls.value.some(control => control.action === action && control.enabled)
}
useAnnotationHotkeyRuntime({ target: annotationScope, dispatch: dispatchHotkeyCommand, commandEnabled })

watch(selectedCaptureId, (captureId) => {
  if (captureId) annotation.connect(`match:${matchId.toLowerCase()}:capture:${captureId.toLowerCase()}`)
}, { immediate: true })
watch([selectedCaptureId, liveTarget], ([captureId, target]) => {
  if (!captureId || !target || dvr.busy.value || descriptor.value?.capture_session_id === captureId) return
  void createWindow(target)
}, { immediate: true })
watch(liveTarget, () => {
  if (video.value?.ended) maintainPlaybackWindow()
})
watch(() => annotation.snapshot.value?.rally_id, () => {
  pinnedRallyId.value = null
  selectedKeyPointId.value = null
  selectedTimelineItem.value = null
}, { flush: 'sync' })
watch([visualPlayhead, selectableSegmentRanges], ([cursor, segments]) => {
  cursorRallyId.value = segmentAtCaptureTime(cursor, segments)?.id ?? null
}, { immediate: true })
watch(cursorRallyId, (rallyId) => {
  if (pinnedRallyId.value) return
  selectedTimelineItem.value = rallyId ? 'segment' : null
  selectedKeyPointId.value = null
}, { immediate: true })
watch([submittedRallies, annotationDrafts], ([submitted, drafts]) => {
  if (!pinnedRallyId.value) return
  if (![...submitted, ...drafts].some(rally => rally.id === pinnedRallyId.value)) pinnedRallyId.value = null
})
watch(mappingAvailable, (available) => {
  if (!available && inspectorTab.value === 'mapping') inspectorTab.value = 'match'
})
watch([state, selectedKeyPointId], () => {
  queuedFrameDelta = 0
  releaseEditingIntent()
})
watch(loadError, (value) => { if (value) toast.error(value, { action: { label: '重試', onClick: () => void loadMatch() } }) })
watch(mediaError, (value) => { if (value) toast.error(value) })
watch(() => annotation.error.value, (value) => {
  if (value) toast.error(value, { action: { label: '重新同步', onClick: () => void annotation.refreshActive() } })
})
watch(() => annotation.outboxNeedsConfirmation.value, (value) => {
  if (value) toast.warning('場次狀態已更新，請重新操作', { action: { label: '重新同步', onClick: annotation.discardPending } })
})
watch(() => dvr.error.value, (error) => {
  if (!error || windowRecoveryInFlight) return
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (!['PLAYBACK_WINDOW_NOT_FOUND', 'WINDOW_EXPIRED', 'MAPPING_STALE'].includes(code)) return
  const target = authoritativeAnchor.value?.capture_time_us ?? captureTarget.value ?? liveTarget.value
  if (!target) return
  windowRecoveryInFlight = true
  void createWindow(target).then((created) => {
    if (created) toast.info('播放視窗已自動重新連線')
  }).finally(() => { windowRecoveryInFlight = false })
})
onMounted(() => {
  annotationScope.value?.focus({ preventScroll: true })
  void loadMatch()
  matchRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void loadMatch({ silent: true })
  }, 2_500)
})
onBeforeUnmount(() => {
  if (matchRefreshTimer) clearInterval(matchRefreshTimer)
  if (timelineMoveTimeout) clearTimeout(timelineMoveTimeout)
  if (cursorResolveTimer) clearTimeout(cursorResolveTimer)
  if (seekPreviewTimer) clearTimeout(seekPreviewTimer)
  annotation.setEditingKeyPoint(null)
  detachVideoState(video.value)
})
</script>

<template>
  <section ref="annotationScope" tabindex="-1" class="editor-shell" @keydown.delete.prevent="deleteSelection" @pointerdown.capture="annotationScope?.focus({ preventScroll: true })">
    <header class="app-bar">
      <div class="window-title"><NuxtLink to="/control" class="window-home" aria-label="返回控制台" title="返回控制台"><Home :size="15" /></NuxtLink><strong>{{ match?.title ?? matchId }}</strong></div>
      <nav class="window-menu" aria-label="場次工具">
        <button type="button" @click="captureDialogOpen = true"><RadioTower :size="13" />媒體資訊</button>
        <button type="button" :title="`${annotation.connection.value} · ${selectedCapture?.health ?? 'unknown'}`" @click="connectionDialogOpen = true"><Wifi :size="13" />連線資訊</button>
        <button type="button" @click="rosterDialogOpen = true"><UsersRound :size="13" />球員編輯</button>
      </nav>
      <div class="session-status"><i class="status-dot" :class="{ busy: annotation.busy.value || annotation.pendingCount.value > 0 || annotation.connection.value !== 'ready', error: annotation.error.value || annotation.outboxNeedsConfirmation.value }" /><span>{{ syncLabel }}</span></div>
      <div class="app-actions">
        <button type="button" aria-label="設定" title="設定" @click="openSettings('root')"><Settings :size="16" /></button>
      </div>
    </header>

    <UiResizablePanelGroup id="annotation-workspace" class="editor-body">
      <UiResizablePanel id="annotation-video" :default-size="78" :min-size="55">
      <main class="viewer-panel">
        <div class="video-stage">
          <VideoOverlayPlayer ref="overlayPlayer" :descriptor="descriptor" :controls="false" toggle-on-click :analysis-run-id="activeOverlayAnalysisRunId" :overlay-capture-time-us="visualPlayhead" :overlay-clip-start-capture-time-us="activeOverlayClipStart" @cursor="handleCursor" @ready="handleVideoReady" @toggle="dispatchMediaAction('play_pause')" @error="mediaError = $event.message" />
          <div v-if="annotation.snapshot.value" class="stage-mask" :class="annotation.snapshot.value.snapshot.annotation_status === 'submitted' ? 'submitted' : 'draft'" />
          <div class="viewer-frame-index" aria-label="目前畫格索引">
            <span>FRAME IDX</span>
            <code>{{ authoritativeAnchor?.capture_frame_index ?? '—' }}</code>
          </div>
          <div v-if="!descriptor" class="stage-empty"><strong>{{ selectedCapture ? '媒體緩衝中' : '尚未加入媒體' }}</strong><button v-if="liveTarget" type="button" @click="createWindow(liveTarget)">LIVE</button></div>
        </div>
      </main>
      </UiResizablePanel>
      <UiResizableHandle id="annotation-inspector-handle" />
      <UiResizablePanel id="annotation-inspector" :default-size="22" :min-size="18" :max-size="45">
      <aside class="inspector">
        <div class="mode-switch"><button type="button" :class="{ active: inspectorTab === 'match' }" @click="inspectorTab = 'match'">場次資訊</button><button type="button" :class="{ active: inspectorTab === 'mapping' }" :disabled="!mappingAvailable" :title="mappingAvailable ? '球員指派' : '選取分析完成的片段後可使用'" @click="openMapping">球員指派</button></div>
        <div v-if="inspectorTab === 'match'" class="match-inspector">
          <div class="score-summary">
            <div class="set-scoreline"><span>第 {{ currentSet?.set_number ?? 1 }} 局 · 回合 {{ displayRallyOrdinal }}</span><b>局數 {{ leftSetWins }} : {{ rightSetWins }}</b></div>
            <div class="score-board">
            <span>{{ leftTeam?.shortName || leftTeam?.name || '左隊' }}</span><b>{{ currentSet?.left_score ?? 0 }}</b><i>:</i><b>{{ currentSet?.right_score ?? 0 }}</b><span>{{ rightTeam?.shortName || rightTeam?.name || '右隊' }}</span>
            </div>
            <div class="next-set-actions"><button type="button" :disabled="state === 'OPEN' || !leftTeamId" @click="requestNextSet('left')">{{ leftTeam?.shortName ?? '左隊' }} 勝局</button><button type="button" :disabled="state === 'OPEN' || !rightTeamId" @click="requestNextSet('right')">{{ rightTeam?.shortName ?? '右隊' }} 勝局</button></div>
          </div>
          <div class="segment-list-title"><span>片段</span><b>{{ visibleRallyCount }}</b></div>
          <UiScrollArea class="segment-scroll"><div class="segment-list"><button v-for="draft in annotationDrafts" :key="draft.id" type="button" class="segment-row" :class="{ active: selectedRallyId === draft.id }" @click="selectHistoricalSegment(draft.id, draft.key_points[0]?.capture_time_us ?? visualPlayhead ?? '0')">
            <div><span>第 {{ draft.set_number }} 局 · 回合 {{ draft.ordinal }}</span><small>{{ draft.annotation_status === 'ready' ? '待送出' : '標記中' }} · {{ draft.key_points.filter(point => point.marker_kind === 'contact').length }} 次擊球</small></div><i class="draft" />
          </button><button v-for="rally in visibleSubmittedRallies" :key="rally.id" type="button" class="segment-row" :class="{ active: selectedRallyId === rally.id }" @click="selectRally(rally)">
            <div><span>第 {{ rally.set_number }} 局 · 回合 {{ rally.ordinal }}</span><small>{{ formatDuration(rallyDisplayDuration(rally)) }} · {{ rally.submission.contact_count }} 次擊球</small></div><i :class="{ processing: rally.submission.analysis?.status !== 'completed', mapped: rally.submission.analysis?.identity_mapping_completed }" />
          </button></div></UiScrollArea>
        </div>
        <div v-else class="mapping-inspector">
          <UiScrollArea class="mapping-scroll"><div class="mapping-scroll-content"><AnnotationIdentityPanel :match-id="matchId" :analysis-run-id="selectedAnalysisRunId" :left-team-id="leftTeamId" :right-team-id="rightTeamId" :teams="coach.data.value?.match.teams ?? []" :mapping-completed="Boolean(selectedRally?.submission.analysis?.identity_mapping_completed)" @changed="coach.refresh" /></div></UiScrollArea>
        </div>
      </aside>
      </UiResizablePanel>
    </UiResizablePanelGroup>

    <footer class="timeline-footer">
      <div class="transport-bar">
        <UiTooltip :content="playing ? '暫停' : '播放'"><button type="button" class="transport-button" :aria-label="playing ? '暫停' : '播放'" :disabled="!descriptor" @click="dispatchMediaAction('play_pause')"><Pause v-if="playing" :size="16" fill="currentColor" /><Play v-else :size="16" fill="currentColor" /></button></UiTooltip>
        <UiTooltip content="上一幀；按住連續移動，Shift 一次 5 幀"><button type="button" class="transport-button" aria-label="前一幀" :disabled="!authoritativeAnchor || Boolean(pendingTimelineMove)" @click="dispatchMediaAction('frame_previous')"><ChevronLeft :size="18" stroke-width="2.2" /></button></UiTooltip>
        <UiTooltip content="下一幀；按住連續移動，Shift 一次 5 幀"><button type="button" class="transport-button" aria-label="後一幀" :disabled="!authoritativeAnchor || Boolean(pendingTimelineMove)" @click="dispatchMediaAction('frame_next')"><ChevronRight :size="18" stroke-width="2.2" /></button></UiTooltip>
        <code class="timecode">{{ displayTimecode }}</code>
        <div class="transport-context">
          <div><strong>{{ activeContextTitle }}</strong><small>{{ activeContextHits }} 次擊球 · {{ formatDuration(activeContextDuration) }}</small></div>
          <span>{{ activeContextState }}</span>
        </div>
        <button type="button" class="live-badge" :class="{ active: descriptor?.mode === 'live' }" :disabled="!liveTarget" @click="createWindow(liveTarget ?? undefined)">LIVE</button>
        <i class="transport-separator" />
        <UiTooltip v-if="correctionActive" content="放棄這次修改並恢復原送出版本"><button type="button" class="tool-button" :disabled="!commandReady" aria-label="取消修正" @click="cancelCorrection"><XCircle :size="14" />取消修正</button></UiTooltip>
        <UiTooltip v-if="selectedSubmittedRally" content="以 immutable submission 建立修正版"><button type="button" class="tool-button" :disabled="!commandReady" aria-label="建立修正版" @click="startCorrection"><RotateCcw :size="14" />建立修正版</button></UiTooltip>
        <UiTooltip content="上一個擊球點，可跨片段"><button type="button" class="tool-button icon-tool" :disabled="!navigableKeyPoints.length" aria-label="上一個擊球點" @click="dispatchMediaAction('key_point_previous')"><SkipBack :size="14" /><UiKbd>{{ formatBindingForDisplay(bindings.key_point_previous) }}</UiKbd></button></UiTooltip>
        <UiTooltip content="下一個擊球點，可跨片段"><button type="button" class="tool-button icon-tool" :disabled="!navigableKeyPoints.length" aria-label="下一個擊球點" @click="dispatchMediaAction('key_point_next')"><SkipForward :size="14" /><UiKbd>{{ formatBindingForDisplay(bindings.key_point_next) }}</UiKbd></button></UiTooltip>
        <UiTooltip content="所選擊球點向前一畫格"><button type="button" class="tool-button icon-only" :disabled="state !== 'OPEN' || !selectedKeyPoint || !commandReady" aria-label="擊球點前移一幀" @click="nudgeSelectedKeyPoint('previous')"><StepBack :size="14" /></button></UiTooltip>
        <UiTooltip content="所選擊球點向後一畫格"><button type="button" class="tool-button icon-only" :disabled="state !== 'OPEN' || !selectedKeyPoint || !commandReady" aria-label="擊球點後移一幀" @click="nudgeSelectedKeyPoint('next')"><StepForward :size="14" /></button></UiTooltip>
        <UiTooltip :content="cursorFollow ? '點擊擊球點時會跳到該畫格' : '點擊擊球點只選取，不移動播放游標'"><button type="button" class="tool-button" :class="{ active: cursorFollow }" :aria-pressed="cursorFollow" aria-label="游標跟隨模式" @click="cursorFollow = !cursorFollow"><Crosshair :size="14" />游標跟隨</button></UiTooltip>
        <UiTooltip content="刪除目前選取"><button type="button" class="tool-button danger" :disabled="(!selectedDeletablePoint && !selectedEditableDraft) || !commandReady" aria-label="刪除所選" @click="deleteSelection"><Trash2 :size="14" />刪除所選</button></UiTooltip>
        <UiTooltip :content="muted ? '開啟聲音' : '靜音'"><button type="button" class="transport-button" :aria-label="muted ? '開啟聲音' : '靜音'" :disabled="!descriptor" @click="dispatchMediaAction('mute')"><VolumeX v-if="muted" :size="16" /><Volume2 v-else :size="16" /></button></UiTooltip>
      </div>
      <DvrTimelineDock :timeline="timeline" :playhead="visualPlayhead" :buffered-window="descriptor ? { startCaptureTimeUs: descriptor.window_capture_start_us, endCaptureTimeUs: descriptor.window_capture_end_us } : null" :annotation="annotation.snapshot.value" :editable="state === 'OPEN' && !pendingTimelineMove" :selected-key-point-id="selectedKeyPointId" :mask-selected="selectedCurrentMask" :mask-range="currentMaskRange" :current-mask-status="currentMaskStatus" :current-mask-label="currentMaskLabel" :current-mask-outcome="currentMaskOutcome" :cursor-follow="cursorFollow" :segments="timelineSegments" :selected-segment-id="selectedHistoricalSegmentId" :soft-locks="annotation.remoteEditorsByKeyPoint.value" @preview="previewTimelineSeek" @seek="seekTimeline" @clear-selection="clearTimelineSelection" @select="selectTimelineKeyPoint" @select-mask="selectTimelineMask" @select-segment="selectHistoricalSegment" @edit-start="beginTimelineKeyPointEdit" @edit-cancel="cancelTimelineKeyPointEdit" @move="moveTimelineKeyPoint" />
      <AnnotationCommandStrip :bindings="bindings" :state="state" :can-mark="canMark" :last-key-point="Boolean(currentLastKeyPointId)" :command-ready="commandReady" :pending-command="annotation.pendingCount.value > 0" :availability="commandAvailabilityMap" @action="dispatchAnnotationAction" @settings="openSettings('hotkeys')" />
    </footer>

    <LazyAnnotationSettingsDialog :open="settingsOpen" :initial-page="settingsInitialPage" :clip-pre-roll-seconds="clipPreRollSeconds" :clip-post-roll-seconds="clipPostRollSeconds" :clip-policy-saving="clipPolicySaving" :clip-policy-error="clipPolicyError" @update-clip-policy="updateClipPolicy" @close="settingsOpen = false" />
    <LazyCaptureControlDialog :open="captureDialogOpen" :match-id="matchId" :captures="match?.captureSessions ?? []" @close="captureDialogOpen = false" @changed="loadMatch" />
    <LazyAnnotationConnectionDialog :open="connectionDialogOpen" :connection="annotation.connection.value" :capture="selectedCapture" :descriptor="descriptor" :pending="annotation.pendingCount.value" :editors="annotation.presence.value.length" @close="connectionDialogOpen = false" />
    <LazyRosterEditorDialog v-if="match" :open="rosterDialogOpen" :match="match" @close="rosterDialogOpen = false" @changed="loadMatch" />
    <LazyConfirmActionDialog :open="Boolean(confirmAction)" :title="confirmTitle" :message="confirmMessage" :confirm-label="confirmLabel" :danger="confirmAction === 'void'" @close="closeConfirmAction" @confirm="confirmPendingAction" />
  </section>
</template>

<style scoped>
:global(html),:global(body),:global(#__nuxt){width:100%;height:100%;margin:0;overflow:hidden}:global(body){background:#0b0d0f}.editor-shell{--surface-0:#0b0d0f;--surface-1:#121519;--line:#30363d;--line-strong:#4a535d;--muted:#98a2ad;--green:#49d88a;--amber:#f5b84b;--blue:#62a9ff;--red:#ff6b72;width:100vw;height:100dvh;display:grid;grid-template-rows:54px minmax(0,1fr) 238px;overflow:hidden;background:var(--surface-0);color:#edf1f4;font-family:"Segoe UI Variable Text",Aptos,"Segoe UI",sans-serif}.editor-shell button,.editor-shell a{min-height:34px;padding:7px 11px;border:1px solid var(--line-strong);border-radius:6px;background:#20252b;color:inherit;cursor:pointer;text-decoration:none}.editor-shell button:not(:disabled):hover,.editor-shell a:hover{border-color:#6b7681;background:#282e35}.editor-shell button:disabled{opacity:.35;cursor:not-allowed}.app-bar{min-width:0;display:grid;grid-template-columns:minmax(280px,auto) minmax(220px,1fr) minmax(300px,auto);align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:#101317}.brand-block{min-width:0}.brand-block h1{margin:0;font-size:.98rem;font-weight:720}.brand-block p{margin:2px 0 0;color:var(--muted);font-size:.69rem}.session-status{min-width:0;display:flex;justify-content:center;align-items:center;gap:8px;color:#c4ccd4;font-size:.78rem}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}.status-dot.busy{background:var(--amber)}.status-dot.error{background:var(--red)}.app-actions{min-width:0;display:flex;justify-content:flex-end;align-items:center;gap:7px}.app-actions>a,.app-actions>button{width:34px;padding:0;display:grid;place-items:center}.media-name{max-width:340px;overflow:hidden;color:var(--muted);font-size:.73rem;text-overflow:ellipsis;white-space:nowrap}.editor-body{min-height:0;display:grid;grid-template-columns:minmax(0,1fr) clamp(288px,24vw,350px);overflow:hidden}.viewer-panel{min-width:0;min-height:0;display:grid;place-items:center;padding:10px;overflow:hidden;background:#050607}.video-stage{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden;background:#000;box-shadow:0 12px 38px #0006}.video-stage :deep(>div){width:100%;height:100%;border-radius:0}.video-stage :deep(video){width:100%;height:100%;object-fit:contain;cursor:pointer}.stage-mask{position:absolute;inset:0;pointer-events:none}.stage-mask.draft{background:#9ba4ae1a}.stage-mask.submitted{background:#2dcd7b14}.viewer-badges{position:absolute;top:8px;right:8px;display:flex;gap:5px;pointer-events:none}.viewer-badges span{padding:3px 6px;border:1px solid #ffffff2b;border-radius:4px;background:#050709c2;color:#d9e0e6;font:600 .66rem "Cascadia Mono",Consolas,monospace}.stage-empty{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:9px;color:#edf1f4;text-align:center}.stage-empty span{color:var(--muted);font-size:.75rem}.stage-error,.global-error,.outbox-banner{position:absolute;z-index:8;padding:9px;border-radius:5px;font-size:.72rem}.stage-error,.global-error{border:1px solid #8e4146;background:#351a1cee;color:#ffb7bb}.stage-error{left:12px;bottom:12px}.global-error{left:12px;top:64px}.outbox-banner{left:50%;top:64px;display:flex;align-items:center;gap:10px;transform:translateX(-50%);border:1px solid #856424;background:#302611ee;color:#ffd987}.outbox-banner.confirm{border-color:#8e4146;background:#351a1cee;color:#ffb7bb}.outbox-banner button{min-height:28px;padding:4px 7px}.inspector{min-height:0;padding:12px;overflow-y:auto;border-left:1px solid var(--line);background:var(--surface-1);font-size:.77rem;scrollbar-width:none}.mode-switch{display:grid;grid-template-columns:1fr 1fr;margin-bottom:12px;border:1px solid var(--line);border-radius:7px;overflow:hidden}.mode-switch button{min-height:34px;border:0;border-radius:0;background:transparent;color:var(--muted)}.mode-switch button+button{border-left:1px solid var(--line)}.mode-switch button.active{background:#273039;color:#fff}.inspector-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--line)}.inspector-heading div{display:grid;gap:2px}.inspector-heading strong{font-size:.88rem}.inspector-heading span{color:var(--muted);font-size:.69rem}.section-title{display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;color:#cdd4db;font-size:.7rem}.section-title b{min-width:22px;padding:2px 5px;border-radius:10px;background:#292f36;text-align:center}.keypoint-list{max-height:170px;margin:0;padding:0;overflow:auto;list-style:none}.keypoint-list li{min-height:34px;display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid #262c32;cursor:pointer}.keypoint-list li:hover,.keypoint-list li.selected{background:#20262c}.keypoint-list code{color:var(--muted);font-size:.66rem}.point-kind{display:grid;width:20px;height:20px;place-items:center;border-radius:50%;color:#0b0d0f;font-size:.62rem;font-weight:800;background:var(--amber)}.point-kind.contact{background:var(--blue)}.keypoint-list em{color:var(--green);font-style:normal}.empty-row{display:block;margin:0;padding:9px 5px;color:var(--muted);font-size:.7rem;overflow-wrap:anywhere}.stack-actions{display:grid;gap:6px;margin-top:8px}.stack-actions button{min-height:31px;font-size:.7rem}.stack-actions button.active{border-color:#4d8fc7;background:#15324a;color:#a9d8ff}.stack-actions .danger{color:#ff9ca1}.timeline-footer{min-height:0;display:grid;grid-template-rows:43px minmax(0,1fr) 54px;border-top:1px solid var(--line);background:#111419}.transport-bar{min-width:0;display:flex;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid #292f35}.transport-button{width:34px;min-height:31px!important;padding:0!important}.timecode{min-width:96px;margin-left:4px;color:#fff;font:700 .78rem "Cascadia Mono",Consolas,monospace}.transport-help{min-width:0;overflow:hidden;color:var(--muted);font-size:.68rem;text-overflow:ellipsis;white-space:nowrap;margin-right:auto}.mode-indicator{flex:none;padding:4px 7px;border:1px solid #43515e;border-radius:4px;color:#9fc7eb;font:700 .63rem "Cascadia Mono",Consolas,monospace}@media(max-width:1050px){.app-bar{grid-template-columns:240px 1fr 230px}.media-name{display:none}.editor-body{grid-template-columns:minmax(0,1fr) 288px}.mode-indicator{display:none}}@media(max-height:760px){.editor-shell{grid-template-rows:48px minmax(0,1fr) 210px}.brand-block p{display:none}.timeline-footer{grid-template-rows:39px minmax(0,1fr) 50px}.inspector{padding:9px}.keypoint-list{max-height:110px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.presence-count{padding:2px 6px;border:1px solid #34404a;border-radius:4px;color:#9fc7eb;font-size:.65rem}
.correction-button{width:100%;border-color:#8c6d2e!important;background:#302711!important;color:#ffe0a0!important}.correction-note{margin:4px 0 0;padding:8px;border:1px solid #64512d;border-radius:5px;background:#2a2314;color:#f0ce88;font-size:.68rem;line-height:1.45}
.keypoint-list li.remote-editing{box-shadow:inset 2px 0 #cf77e6;background:#241b2a}.keypoint-list small{color:#e3a9f2;font-size:.62rem}
</style>

<style scoped>
:global(body){background:#09090b}
.editor-shell{--surface-0:#09090b;--surface-1:#111113;--line:#27272a;--line-strong:#3f3f46;--muted:#a1a1aa;background:#09090b;color:#f4f4f5}
.editor-shell button,.editor-shell a{border-color:transparent;background:#18181b}
.editor-shell button:not(:disabled):hover,.editor-shell a:hover{border-color:transparent;background:#27272a}
.editor-shell .app-bar{background:#09090b}
.editor-shell .window-title svg{color:#d4d4d8}
.editor-shell .mode-switch{border-color:#27272a;background:#111113}
.editor-shell .mode-switch button+button{border-left-color:#27272a}
.editor-shell .mode-switch button.active{background:#27272a;color:#fafafa}
.editor-shell .segment-row.active{background:#27272a!important}
.editor-shell .transport-button{border-color:transparent!important;background:#18181b!important}
.editor-shell .live-badge{border-color:transparent!important;background:#27272a!important;color:#a1a1aa!important}
.editor-shell .live-badge.active{border-color:transparent!important;background:#163c27!important;color:#86efac!important}
.editor-shell .tool-button:hover:not(:disabled),.editor-shell .tool-button.active{background:#27272a!important}
.editor-shell .transport-context>span{background:#27272a;color:#d4d4d8}
</style>

<style scoped>
.window-title{gap:6px}.window-home{width:29px!important;min-height:29px!important;display:grid!important;place-items:center;padding:0!important;border-color:transparent!important;border-radius:8px!important;background:transparent!important;color:#aeb8c2!important}.window-home:hover{background:#232a31!important;color:#fff!important}.window-title>strong{margin-left:2px}.app-actions{min-width:32px}.inspector{display:flex;flex-direction:column;overflow:hidden}.mode-switch{flex:none}.match-inspector,.mapping-inspector{min-height:0;flex:1}.match-inspector{display:grid;grid-template-rows:auto 35px minmax(0,1fr)}.mapping-inspector{overflow:auto}.score-summary{padding-top:5px;border-bottom:1px solid var(--line)}.rally-counter{display:block;color:#7f8993;font-size:.6rem;font-weight:750;letter-spacing:.04em;text-align:center}.score-summary .score-board{border-bottom:0}.segment-scroll{min-height:0;height:100%}.segment-list{padding-right:5px}.segment-row{min-height:49px!important}.segment-row>div{min-width:0;display:grid;gap:3px;text-align:left}.segment-row small{color:#77838e;font-size:.58rem;font-weight:500}.transport-context{min-width:220px;max-width:520px;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;margin-left:auto;padding:0 8px;border-left:1px solid #2e353c}.transport-context>div{min-width:0;display:grid;gap:1px}.transport-context strong,.transport-context small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transport-context strong{font-size:.65rem}.transport-context small{color:#7f8a95;font-size:.56rem}.transport-context>span{padding:3px 7px;border-radius:999px;background:#26303a;color:#a9c9e2;font-size:.56rem;font-weight:750}.context-edit{width:28px!important;min-height:28px!important;display:grid!important;place-items:center;padding:0!important;border-color:transparent!important;background:transparent!important}.transport-button svg{filter:drop-shadow(0 1px 0 #000)}@media(max-width:1180px){.transport-context{max-width:300px}.transport-context small{display:none}}@media(max-width:980px){.transport-context{display:none}}
</style>

<style scoped>
.editor-shell{grid-template-rows:44px minmax(0,1fr) 230px}.app-bar{grid-template-columns:auto minmax(280px,1fr) auto minmax(220px,auto);gap:12px;padding:0 10px;background:#0e1114}.window-title{min-width:0;display:flex;align-items:center;gap:7px}.window-title svg{color:#62a9ff}.window-title strong{max-width:260px;overflow:hidden;font-size:.75rem;text-overflow:ellipsis;white-space:nowrap}.window-menu{display:flex;align-items:center;gap:2px}.window-menu button,.window-menu a{width:auto!important;min-height:27px!important;display:flex!important;align-items:center;gap:5px;padding:0 8px!important;border-color:transparent!important;background:transparent!important;color:#9da6af;font-size:.65rem}.window-menu button:hover,.window-menu a:hover{background:#20262c!important;color:#eef2f5}.session-status{justify-content:flex-start;font-size:.68rem}.app-actions>a,.app-actions>button{width:30px!important;min-height:30px!important;border-color:transparent!important;border-radius:7px!important;background:transparent!important}.media-name{max-width:220px;font-size:.65rem}.editor-body{grid-template-columns:minmax(0,1fr) clamp(280px,22vw,330px)}.viewer-panel{padding:0;background:#030405}.video-stage{box-shadow:none}.viewer-badges span{border-radius:6px;font-size:.59rem}.inspector{padding:10px}.mode-switch{margin-bottom:10px;border-radius:8px}.mode-switch button{min-height:32px;font-size:.68rem}.score-board{min-height:62px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto minmax(0,1fr);align-items:center;gap:7px;padding:0 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}.score-board span{overflow:hidden;color:#aab2bb;font-size:.68rem;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.score-board span:last-child{text-align:right}.score-board b{font-size:1.55rem}.score-board i{color:#69737d;font-style:normal}.current-segment{min-height:52px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #282e34}.current-segment>div{display:grid;gap:2px}.current-segment span{color:#8d97a1;font-size:.62rem}.current-segment strong{font-size:.72rem}.segment-state{padding:3px 7px;border-radius:999px;background:#353c44!important;color:#c3c9d0!important;font-weight:700}.segment-state.open{background:#32373d!important}.segment-state.ready{background:#5b4519!important;color:#ffd987!important}.segment-state.submitted{background:#173f5f!important;color:#a9d7ff!important}.segment-stats{display:grid;grid-template-columns:repeat(3,1fr);margin:0;border-bottom:1px solid #282e34}.segment-stats div{min-height:53px;display:grid;place-content:center;justify-items:center;gap:2px}.segment-stats div+div{border-left:1px solid #282e34}.segment-stats dt{color:#7e8892;font-size:.6rem}.segment-stats dd{margin:0;font-size:.8rem;font-weight:700}.correction-button{min-height:34px!important;display:flex;align-items:center;justify-content:center;gap:7px;margin-top:10px}.segment-list-title{height:35px;display:flex;align-items:center;justify-content:space-between;color:#aab2bb;font-size:.65rem;font-weight:700}.segment-list-title b{min-width:20px;padding:2px 5px;border-radius:999px;background:#293039;font-size:.6rem;text-align:center}.segment-row{width:100%;min-height:37px!important;display:flex;align-items:center;justify-content:space-between!important;padding:0 9px!important;border:0!important;border-bottom:1px solid #242a30!important;border-radius:0!important;background:transparent!important;font-size:.66rem}.segment-row.active{background:#202830!important}.segment-row i{width:8px;height:8px;border-radius:50%;background:#4295d8}.segment-row i.processing{background:#d5a331}.segment-row i.mapped{background:#36b878}.segment-picker{display:grid;grid-template-columns:42px 1fr;align-items:center;gap:6px;margin-bottom:10px}.segment-picker span{color:#87919b;font-size:.64rem}.segment-picker select{height:31px;padding:0 8px;border:1px solid #404951;border-radius:6px;outline:0;background:#191e23;color:#eef2f5;font-size:.67rem}.timeline-footer{grid-template-rows:42px minmax(0,1fr) 53px}.transport-bar{gap:4px;padding:4px 10px}.transport-button{display:grid;place-items:center;border-radius:7px!important}.timecode{min-width:82px;margin-left:3px;font-size:.7rem}.live-badge{min-height:22px!important;padding:2px 7px!important;border:1px solid #59636d!important;border-radius:999px!important;background:#22272d!important;color:#a9b1ba!important;font-size:.56rem!important;font-weight:800}.live-badge.active{border-color:#287a50!important;background:#173c29!important;color:#73dda2!important}.transport-separator{width:1px;height:23px;margin:0 3px;background:#30363d}.tool-button{min-height:30px!important;display:flex;align-items:center;gap:5px;padding:0 8px!important;border-color:transparent!important;background:transparent!important;color:#aab3bc!important;font-size:.63rem}.tool-button:hover:not(:disabled),.tool-button.active{background:#252c33!important;color:#fff!important}.tool-button.danger{color:#dba1a5!important}.transport-spacer{flex:1}.global-error,.outbox-banner{top:52px}.presence-count{display:grid;min-width:18px;height:18px;place-items:center;border-radius:999px}.stage-empty span{display:none}@media(max-width:1050px){.app-bar{grid-template-columns:auto 1fr auto}.window-menu{display:none}.editor-body{grid-template-columns:minmax(0,1fr) 280px}.media-name{display:none}}@media(max-height:760px){.editor-shell{grid-template-rows:42px minmax(0,1fr) 204px}.timeline-footer{grid-template-rows:39px minmax(0,1fr) 49px}.tool-button span{display:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<style scoped>
.editor-shell{grid-template-rows:44px minmax(0,1fr) 260px}.editor-body{display:flex!important;grid-template-columns:none!important}.viewer-panel,.inspector{width:100%;height:100%}.viewer-badges{top:10px;right:10px;z-index:6;align-items:center}.viewer-badges span{min-height:22px;display:inline-flex;align-items:center;padding:3px 7px;line-height:1}.transport-context{grid-template-columns:minmax(0,1fr) auto}.icon-tool :deep(kbd){height:18px;min-width:18px;font-size:.56rem}
.segment-row i.draft{background:#71717a}
</style>
<style scoped>
.viewer-frame-index{position:absolute;top:10px;left:10px;z-index:6;display:flex;width:max-content!important;height:auto!important;align-items:baseline;gap:8px;pointer-events:none;padding:5px 8px;border:1px solid #ffffff2b;border-radius:5px;background:#050709c2;color:#d9e0e6}
.viewer-frame-index span{color:#9da7b1;font:700 .55rem/1 "Cascadia Mono",Consolas,monospace;letter-spacing:.06em}
.viewer-frame-index code{color:#f3f5f6;font:700 .68rem/1 "Cascadia Mono",Consolas,monospace;font-variant-numeric:tabular-nums}
</style>
<style scoped>
.segment-list-title{height:30px}
.match-inspector{grid-template-rows:auto 30px minmax(0,1fr)}
.segment-list{padding-right:0}
.segment-row{padding:0 4px!important}
</style>
<style scoped>
.mapping-inspector{overflow:hidden}
.mapping-scroll{height:100%;min-height:0}
.mapping-scroll-content{padding-right:10px;padding-bottom:10px}
.mode-switch button:disabled{cursor:not-allowed;opacity:.42}
</style>
<style scoped>
.set-scoreline{display:flex;align-items:center;justify-content:space-between;padding:2px 5px;color:#8f99a3;font-size:.58rem;font-weight:650}.set-scoreline b{color:#d7dce1;font-size:.6rem}.next-set-actions{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:5px;border-top:1px solid #282e34}.next-set-actions button{min-height:25px!important;padding:2px 6px!important;border-color:#343a40!important;background:#181b1f!important;color:#aeb6be!important;font-size:.58rem}.transport-context{flex:0 1 270px;min-width:150px;max-width:340px;margin-left:0}.tool-button.icon-only{width:28px;padding:0!important;justify-content:center}.transport-bar>:last-child{margin-left:auto}@media(max-width:1280px){.transport-context{max-width:210px}.transport-context small{display:none}.tool-button{padding-inline:5px!important}}
</style>
