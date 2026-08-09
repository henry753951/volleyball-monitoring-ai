import type { AnnotationKeyPoint, AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { computed } from 'vue'
import type { CoachMatchState, CoachRally } from '~/lib/coachDomain'
import type { CaptureTimeline, Match } from '~/lib/coreDomain'
import type { TimelineSelectionItem } from '~/utils/timelineSelection'

type WorkstationState = 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'

function processingStateLabel(status: string) {
  if (status === 'failed') return '處理失敗'
  if (status === 'clip_queued' || status === 'clipping') return '剪切中'
  if (status === 'ai_queued') return '等待 Worker'
  if (status === 'ai_processing') return 'AI 分析中'
  if (status === 'artifact_ingesting') return '回傳結果中'
  return '處理中'
}

interface Options {
  coachData: Ref<CoachMatchState | null>
  match: Ref<Match | null>
  timeline: ComputedRef<CaptureTimeline | null>
  displayAnnotation: ComputedRef<AnnotationRallySnapshot | null>
  confirmedAnnotation: ShallowRef<AnnotationRallySnapshot | null>
  state: ComputedRef<WorkstationState>
  selectedRallyId: ComputedRef<string | null>
  selectedKeyPoint: ComputedRef<AnnotationKeyPoint | null>
  selectedTimelineItem: Ref<TimelineSelectionItem>
  cursorRallyId: Ref<string | null>
}

export function useAnnotationWorkstationModel(options: Options) {
  const submittedRallies = computed(() => options.coachData.value?.match.rallies ?? [])
  const annotationDrafts = computed(() => options.coachData.value?.match.drafts ?? [])
  const draftRallyIds = computed(() => new Set(annotationDrafts.value.map(draft => draft.id)))
  const visibleSubmittedRallies = computed(() => submittedRallies.value.filter(rally => !draftRallyIds.value.has(rally.id)))
  const completedRallies = computed(() => submittedRallies.value.filter(rally => rally.submission.analysis?.status === 'completed'))
  const selectedDraftRally = computed(() => annotationDrafts.value.find(rally => rally.id === options.selectedRallyId.value) ?? null)
  const selectedSubmittedRally = computed(() => selectedDraftRally.value ? null : submittedRallies.value.find(rally => rally.id === options.selectedRallyId.value) ?? null)
  const selectedRally = computed(() => selectedDraftRally.value ? null : completedRallies.value.find(rally => rally.id === options.selectedRallyId.value) ?? null)
  const mappingAvailable = computed(() => Boolean(selectedRally.value?.submission.analysis?.id))
  const selectedAnalysisRunId = computed(() => selectedRally.value?.submission.analysis?.id ?? null)
  const currentSet = computed(() => options.coachData.value?.match.sets.find(set => set.status === 'live') ?? options.coachData.value?.match.sets.at(-1) ?? null)
  const leftTeamId = computed(() => currentSet.value?.side_assignment?.left_team_id ?? options.coachData.value?.match.teams[0]?.id ?? null)
  const rightTeamId = computed(() => currentSet.value?.side_assignment?.right_team_id ?? options.coachData.value?.match.teams[1]?.id ?? null)
  const leftSetWins = computed(() => options.coachData.value?.match.sets.filter(set => set.winning_team_id === leftTeamId.value).length ?? 0)
  const rightSetWins = computed(() => options.coachData.value?.match.sets.filter(set => set.winning_team_id === rightTeamId.value).length ?? 0)
  const leftTeam = computed(() => options.coachData.value?.match.teams.find(team => team.id === leftTeamId.value) ?? options.coachData.value?.match.teams[0] ?? null)
  const rightTeam = computed(() => options.coachData.value?.match.teams.find(team => team.id === rightTeamId.value) ?? options.coachData.value?.match.teams[1] ?? null)
  const clipPreRollUs = computed(() => BigInt(options.match.value?.clipPreRollUs ?? options.coachData.value?.match.clip_pre_roll_us ?? '3000000'))
  const clipPostRollUs = computed(() => BigInt(options.match.value?.clipPostRollUs ?? options.coachData.value?.match.clip_post_roll_us ?? '3000000'))
  const clipPreRollSeconds = computed(() => Number(clipPreRollUs.value / 1_000_000n))
  const clipPostRollSeconds = computed(() => Number(clipPostRollUs.value / 1_000_000n))

  function clipRangeForPoints(points: ReadonlyArray<{ capture_time_us: string }>) {
    if (!points.length) return null
    const ordered = [...points].sort((left, right) => {
      const difference = BigInt(left.capture_time_us) - BigInt(right.capture_time_us)
      return difference < 0n ? -1 : difference > 0n ? 1 : 0
    })
    const requestedStart = BigInt(ordered[0]!.capture_time_us) - clipPreRollUs.value
    const requestedEnd = BigInt(ordered.at(-1)!.capture_time_us) + clipPostRollUs.value
    const timelineStart = options.timeline.value?.availableRanges[0]?.startUs
    const timelineEnd = options.timeline.value?.availableRanges.at(-1)?.endUs
    const start = requestedStart < 0n ? 0n : timelineStart && requestedStart < BigInt(timelineStart) ? BigInt(timelineStart) : requestedStart
    const end = timelineEnd && requestedEnd > BigInt(timelineEnd) ? BigInt(timelineEnd) : requestedEnd
    return { startCaptureTimeUs: start.toString(), endCaptureTimeUs: end.toString() }
  }
  function clipRangeForRally(rally: CoachRally) {
    return rally.submission.clip
      ? { startCaptureTimeUs: rally.submission.clip.start_capture_time_us, endCaptureTimeUs: rally.submission.clip.end_capture_time_us }
      : clipRangeForPoints(rally.submission.key_points)
  }
  function rallyDisplayDuration(rally: CoachRally) {
    const range = clipRangeForRally(rally)
    return range ? (BigInt(range.endCaptureTimeUs) - BigInt(range.startCaptureTimeUs)).toString() : null
  }

  const timelineSegments = computed(() => {
    const currentRallyId = options.displayAnnotation.value?.rally_id
    const submitted = submittedRallies.value.flatMap((rally) => {
      const range = clipRangeForRally(rally)
      // Keep the current immutable submission in the data set so its AI result
      // rail remains available. DvrTimelineDock suppresses only the duplicate
      // segment mask; an active correction draft still suppresses stale results.
      if (!range || draftRallyIds.value.has(rally.id)) return []
      const analysis = rally.submission.analysis
      const failed = rally.processing_status === 'failed'
      return [{
        id: rally.id,
        label: `第 ${rally.display_set_number} 局 · 回合 ${rally.display_ordinal}`,
        stateLabel: analysis?.status === 'completed' ? analysis.identity_mapping_completed ? '球員已確認' : '待指派球員' : processingStateLabel(rally.processing_status),
        outcomeLabel: rally.submission.score_resolution === 'unknown' ? '結果未知' : `${options.coachData.value?.match.teams.find(team => team.id === rally.submission.scoring_team_id)?.shortName ?? '得分隊'} 得分`,
        startCaptureTimeUs: range.startCaptureTimeUs,
        endCaptureTimeUs: range.endCaptureTimeUs,
        points: rally.submission.key_points.map(point => ({ id: point.id, markerKind: point.marker_kind, isTerminal: point.is_terminal, captureTimeUs: point.capture_time_us })),
        status: failed ? 'failed' as const : analysis?.status === 'completed' ? analysis.identity_mapping_completed ? 'mapped' as const : 'analyzed' as const : 'processing' as const,
        analysis: analysis?.status === 'completed' ? {
          startCaptureTimeUs: analysis.coverage_start_capture_time_us ?? range.startCaptureTimeUs, endCaptureTimeUs: analysis.coverage_end_capture_time_us ?? range.endCaptureTimeUs,
          byteLength: analysis.byte_length, trackCount: analysis.track_count, ballPathCount: analysis.ball_path_count,
          contactCount: analysis.contact_count, capabilities: analysis.capabilities,
        } : null,
      }]
    })
    const drafts = annotationDrafts.value.flatMap((draft) => {
      const range = clipRangeForPoints(draft.key_points)
      if (!range || draft.id === currentRallyId) return []
      return [{ id: draft.id, label: `第 ${draft.display_set_number} 局 · 回合 ${draft.display_ordinal}`, stateLabel: draft.active_submission_id ? '修正版草稿' : draft.annotation_status === 'ready' ? '待送出' : '標記中', outcomeLabel: draft.key_points.some(point => point.is_terminal) ? '已標記終止點' : null, startCaptureTimeUs: range.startCaptureTimeUs, endCaptureTimeUs: range.endCaptureTimeUs, points: draft.key_points.map(point => ({ id: point.id, markerKind: point.marker_kind, isTerminal: point.is_terminal, captureTimeUs: point.capture_time_us })), status: 'draft' as const }]
    })
    return [...submitted, ...drafts]
  })
  const currentMaskRange = computed(() => {
    const snapshot = options.displayAnnotation.value
    const points = snapshot?.snapshot.key_points ?? []
    const currentSubmitted = submittedRallies.value.find(rally => rally.id === snapshot?.rally_id) ?? null
    return snapshot && !['open', 'ready'].includes(snapshot.snapshot.annotation_status) && currentSubmitted ? clipRangeForRally(currentSubmitted) : snapshot ? clipRangeForPoints(points) : null
  })
  const selectableSegmentRanges = computed(() => {
    const currentId = options.displayAnnotation.value?.rally_id
    return currentId && currentMaskRange.value ? [...timelineSegments.value, { id: currentId, ...currentMaskRange.value }] : timelineSegments.value
  })
  const currentAnnotationRally = computed(() => submittedRallies.value.find(rally => rally.id === options.displayAnnotation.value?.rally_id) ?? null)
  const currentMaskStatus = computed<'failed' | 'processing' | 'analyzed' | 'mapped'>(() => {
    const analysis = currentAnnotationRally.value?.submission.analysis
    if (currentAnnotationRally.value?.processing_status === 'failed') return 'failed'
    return analysis?.status === 'completed' ? analysis.identity_mapping_completed ? 'mapped' : 'analyzed' : 'processing'
  })
  const currentAnnotationDraft = computed(() => annotationDrafts.value.find(draft => draft.id === options.displayAnnotation.value?.rally_id) ?? null)
  const currentMaskLabel = computed(() => currentAnnotationDraft.value ? `第 ${currentAnnotationDraft.value.display_set_number} 局 · 回合 ${currentAnnotationDraft.value.display_ordinal}` : currentAnnotationRally.value ? `第 ${currentAnnotationRally.value.display_set_number} 局 · 回合 ${currentAnnotationRally.value.display_ordinal}` : null)
  const currentMaskOutcome = computed(() => {
    const snapshot = options.displayAnnotation.value?.snapshot
    if (!snapshot || snapshot.score_resolution === 'pending') return null
    if (snapshot.score_resolution === 'unknown') return '結果未知'
    return snapshot.scoring_court_side === 'left' ? `${leftTeam.value?.shortName ?? '左隊'} 得分` : `${rightTeam.value?.shortName ?? '右隊'} 得分`
  })
  const cursorRally = computed(() => submittedRallies.value.find(rally => rally.id === options.cursorRallyId.value) ?? null)
  const activeOverlayRally = computed(() => cursorRally.value?.submission.analysis?.status === 'completed' ? cursorRally.value : null)
  const activeOverlayAnalysisRunId = computed(() => activeOverlayRally.value?.submission.analysis?.id ?? null)
  const activeOverlayClipStart = computed(() => activeOverlayRally.value?.submission.clip?.start_capture_time_us ?? null)
  const activeContextRally = computed(() => selectedSubmittedRally.value)
  const selectedCurrentMask = computed(() => options.selectedRallyId.value === options.displayAnnotation.value?.rally_id)
  const activeContextDraft = computed(() => selectedDraftRally.value ?? (selectedCurrentMask.value ? currentAnnotationDraft.value : null))
  const selectedEditableDraft = computed(() => Boolean(
    selectedCurrentMask.value
    && options.displayAnnotation.value
    && ['OPEN', 'READY'].includes(options.state.value),
  ))
  const activeCorrectionDraft = computed(() => {
    if (currentAnnotationDraft.value?.active_submission_id) return currentAnnotationDraft.value
    if (selectedDraftRally.value?.active_submission_id) return selectedDraftRally.value
    return annotationDrafts.value.find(draft => Boolean(draft.active_submission_id)) ?? null
  })
  const correctionActive = computed(() => Boolean(
    activeCorrectionDraft.value
    || (['OPEN', 'READY'].includes(options.state.value)
      && options.confirmedAnnotation.value?.snapshot.active_submission_id)
    || (selectedSubmittedRally.value?.submission.supersedes_submission_id
      && selectedSubmittedRally.value.processing_status === 'failed'),
  ))
  const correctionRallyId = computed(() => activeCorrectionDraft.value?.id
    ?? (selectedSubmittedRally.value?.submission.supersedes_submission_id
      && selectedSubmittedRally.value.processing_status === 'failed'
      ? selectedSubmittedRally.value.id
      : null))
  const selectedDeletablePoint = computed(() => options.selectedTimelineItem.value === 'point' && options.selectedKeyPoint.value?.marker_kind !== 'service')
  const activeContextTitle = computed(() => activeContextDraft.value ? `第 ${activeContextDraft.value.display_set_number} 局 · 回合 ${activeContextDraft.value.display_ordinal}` : activeContextRally.value ? `第 ${activeContextRally.value.display_set_number} 局 · 回合 ${activeContextRally.value.display_ordinal}` : '游標未落在片段內')
  const activeContextHits = computed(() => activeContextDraft.value?.key_points.filter(point => point.marker_kind === 'contact').length ?? activeContextRally.value?.submission.contact_count ?? 0)
  const activeContextDuration = computed(() => {
    const range = activeContextDraft.value ? clipRangeForPoints(activeContextDraft.value.key_points) : activeContextRally.value ? clipRangeForRally(activeContextRally.value) : null
    return range ? (BigInt(range.endCaptureTimeUs) - BigInt(range.startCaptureTimeUs)).toString() : null
  })
  const activeContextState = computed(() => activeContextDraft.value ? activeContextDraft.value.active_submission_id ? '修正版草稿' : activeContextDraft.value.annotation_status === 'ready' ? '待送出' : '標記中' : activeContextRally.value?.submission.analysis?.status === 'completed' ? activeContextRally.value.submission.analysis.identity_mapping_completed ? '已指派' : '分析完成' : activeContextRally.value ? processingStateLabel(activeContextRally.value.processing_status) : '—')
  const displayRallyOrdinal = computed(() => activeContextRally.value?.display_ordinal ?? activeContextDraft.value?.display_ordinal ?? '—')
  const displaySetNumber = computed(() => activeContextRally.value?.display_set_number ?? activeContextDraft.value?.display_set_number ?? currentSet.value?.set_number ?? 1)

  return { submittedRallies, annotationDrafts, visibleSubmittedRallies, selectedSubmittedRally, selectedRally, mappingAvailable, selectedAnalysisRunId, currentSet, leftTeamId, rightTeamId, leftSetWins, rightSetWins, leftTeam, rightTeam, clipPreRollUs, clipPostRollUs, clipPreRollSeconds, clipPostRollSeconds, clipRangeForPoints, clipRangeForRally, rallyDisplayDuration, timelineSegments, currentMaskRange, selectableSegmentRanges, selectedCurrentMask, currentAnnotationRally, currentMaskStatus, currentMaskLabel, currentMaskOutcome, activeOverlayAnalysisRunId, activeOverlayClipStart, currentAnnotationDraft, selectedEditableDraft, correctionActive, correctionRallyId, selectedDeletablePoint, activeContextTitle, activeContextHits, activeContextDuration, activeContextState, displayRallyOrdinal, displaySetNumber }
}
