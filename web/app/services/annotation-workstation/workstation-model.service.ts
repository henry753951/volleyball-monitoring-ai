import type { AnnotationKeyPoint, AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { computed } from 'vue'
import { isSupersededSourceSubmission } from '~/lib/annotationKeyPointNavigation'
import type { CoachMatchState, CoachRally, CoachTeam } from '~/lib/coachDomain'
import type { CaptureTimeline, Match } from '~/lib/coreDomain'
import { annotationOutcomeLabel } from '~/utils/annotationOutcome'
import { deriveCoachDisplayOrdinals } from '~/utils/rallyDisplayOrder'
import type { TimelineSelectionItem } from '~/utils/timelineSelection'

type WorkstationState = 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'

function processingStateLabel(status: string) {
  if (status === 'idle') return '待重新分析'
  if (status === 'failed') return '處理失敗'
  if (status === 'clip_queued' || status === 'clipping') return '剪切中'
  if (status === 'ai_queued') return '等待 Worker'
  if (status === 'ai_processing') return 'AI 分析中'
  if (status === 'artifact_ingesting') return '回傳結果中'
  return '處理中'
}

type TimelineOutcomeSide = 'left' | 'right'

function timelineOutcomeMetadata(input: {
  scoreResolution?: string | null
  scoringCourtSide?: string | null
  scoringTeamId?: string | null
  leftTeamId?: string | null
  rightTeamId?: string | null
  teams?: readonly CoachTeam[]
}) {
  const side: TimelineOutcomeSide | null =
    input.scoreResolution === 'resolved' &&
    (input.scoringCourtSide === 'left' || input.scoringCourtSide === 'right')
      ? input.scoringCourtSide
      : null
  if (!side) return { side: null, teamLabel: null }

  const sideTeamId = side === 'left' ? input.leftTeamId : input.rightTeamId
  const teamId = input.scoringTeamId ?? sideTeamId
  const team = teamId ? input.teams?.find(candidate => candidate.id === teamId) : null
  return {
    side,
    teamLabel: team?.shortName || team?.name || (side === 'left' ? '左隊' : '右隊'),
  }
}

export interface AnnotationWorkstationModelOptions {
  coachData: Ref<CoachMatchState | null>
  match: Ref<Match | null>
  timeline: ComputedRef<CaptureTimeline | null>
  displayAnnotation: ComputedRef<AnnotationRallySnapshot | null>
  confirmedAnnotation: ShallowRef<AnnotationRallySnapshot | null>
  roomSnapshots?: ComputedRef<readonly AnnotationRallySnapshot[]>
  state: ComputedRef<WorkstationState>
  selectedRallyId: ComputedRef<string | null>
  selectedKeyPoint: ComputedRef<AnnotationKeyPoint | null>
  selectedTimelineItem: Ref<TimelineSelectionItem>
  cursorRallyId: Ref<string | null>
  visualPlayhead?: Ref<string | null>
}

export function createAnnotationWorkstationModelService(
  options: AnnotationWorkstationModelOptions,
) {
  const submittedRallies = computed(() => options.coachData.value?.match.rallies ?? [])
  const annotationDrafts = computed(() => {
    const drafts = options.coachData.value?.match.drafts ?? []
    const currentRallyId = options.displayAnnotation.value?.rally_id
    if (!currentRallyId || ['OPEN', 'READY'].includes(options.state.value)) return drafts
    // The realtime acknowledgement advances before the dashboard refresh. Do
    // not let its stale OPEN draft override the just-submitted rally state.
    if (options.selectedRallyId.value !== currentRallyId) return drafts
    return drafts.filter(draft => draft.id !== currentRallyId)
  })
  const correctionDraftRallyIds = computed(
    () =>
      new Set(
        annotationDrafts.value.filter(draft => draft.active_submission_id).map(draft => draft.id),
      ),
  )
  const correctionSourceSubmissionIds = computed(
    () =>
      new Set(
        annotationDrafts.value.flatMap(draft =>
          draft.active_submission_id ? [draft.active_submission_id] : [],
        ),
      ),
  )
  const draftRallyIds = computed(() => new Set(annotationDrafts.value.map(draft => draft.id)))
  const visibleSubmittedRallies = computed(() =>
    submittedRallies.value.filter(rally => !draftRallyIds.value.has(rally.id)),
  )
  const displayOrdinals = computed(() =>
    deriveCoachDisplayOrdinals(annotationDrafts.value, submittedRallies.value),
  )
  const displayOrdinalFor = (rallyId: string) => displayOrdinals.value.get(rallyId) ?? 1
  const completedRallies = computed(() =>
    submittedRallies.value.filter(rally => rally.submission.analysis?.status === 'completed'),
  )
  const selectedDraftRally = computed(
    () => annotationDrafts.value.find(rally => rally.id === options.selectedRallyId.value) ?? null,
  )
  const selectedSubmittedRally = computed(() =>
    selectedDraftRally.value
      ? null
      : (submittedRallies.value.find(rally => rally.id === options.selectedRallyId.value) ?? null),
  )
  const selectedAnalysisRally = computed(() =>
    selectedDraftRally.value
      ? null
      : (completedRallies.value.find(rally => rally.id === options.selectedRallyId.value) ?? null),
  )
  const selectedRally = computed(() =>
    selectedDraftRally.value ? null : selectedAnalysisRally.value,
  )
  const mappingAvailable = computed(() =>
    Boolean(selectedAnalysisRally.value?.submission.analysis?.id),
  )
  const selectedAnalysisRunId = computed(
    () => selectedAnalysisRally.value?.submission.analysis?.id ?? null,
  )
  const currentSet = computed(
    () =>
      options.coachData.value?.match.sets.find(set => set.status === 'live') ??
      options.coachData.value?.match.sets.at(-1) ??
      null,
  )
  const leftTeamId = computed(
    () =>
      currentSet.value?.side_assignment?.left_team_id ??
      options.coachData.value?.match.teams[0]?.id ??
      null,
  )
  const rightTeamId = computed(
    () =>
      currentSet.value?.side_assignment?.right_team_id ??
      options.coachData.value?.match.teams[1]?.id ??
      null,
  )
  const leftSetWins = computed(
    () =>
      options.coachData.value?.match.sets.filter(set => set.winning_team_id === leftTeamId.value)
        .length ?? 0,
  )
  const rightSetWins = computed(
    () =>
      options.coachData.value?.match.sets.filter(set => set.winning_team_id === rightTeamId.value)
        .length ?? 0,
  )
  const leftTeam = computed(
    () =>
      options.coachData.value?.match.teams.find(team => team.id === leftTeamId.value) ??
      options.coachData.value?.match.teams[0] ??
      null,
  )
  const rightTeam = computed(
    () =>
      options.coachData.value?.match.teams.find(team => team.id === rightTeamId.value) ??
      options.coachData.value?.match.teams[1] ??
      null,
  )
  const clipPreRollUs = computed(() =>
    BigInt(
      options.match.value?.clipPreRollUs ?? options.coachData.value?.match.clip_pre_roll_us ?? '0',
    ),
  )
  const clipPostRollUs = computed(() =>
    BigInt(
      options.match.value?.clipPostRollUs ??
        options.coachData.value?.match.clip_post_roll_us ??
        '0',
    ),
  )
  const clipPreRollSeconds = computed(() => Number(clipPreRollUs.value / 1_000_000n))
  const clipPostRollSeconds = computed(() => Number(clipPostRollUs.value / 1_000_000n))

  function clipRangeForPoints(points: ReadonlyArray<{ capture_time_us: string }>) {
    if (!points.length) return null
    const ordered = [...points].sort((left, right) => {
      const difference = BigInt(left.capture_time_us) - BigInt(right.capture_time_us)
      return difference < 0n ? -1 : difference > 0n ? 1 : 0
    })
    const requestedStart = BigInt(ordered[0]!.capture_time_us) - clipPreRollUs.value
    const requestedEndCandidate = BigInt(ordered.at(-1)!.capture_time_us) + clipPostRollUs.value
    const requestedEnd =
      requestedEndCandidate > requestedStart ? requestedEndCandidate : requestedStart + 1n
    const timelineStart = options.timeline.value?.availableRanges[0]?.startUs
    const timelineEnd = options.timeline.value?.availableRanges.at(-1)?.endUs
    const start =
      requestedStart < 0n
        ? 0n
        : timelineStart && requestedStart < BigInt(timelineStart)
          ? BigInt(timelineStart)
          : requestedStart
    const end =
      timelineEnd && requestedEnd > BigInt(timelineEnd) ? BigInt(timelineEnd) : requestedEnd
    return { startCaptureTimeUs: start.toString(), endCaptureTimeUs: end.toString() }
  }
  function annotationRangeForPoints(points: ReadonlyArray<{ capture_time_us: string }>) {
    if (!points.length) return null
    let start = BigInt(points[0]!.capture_time_us)
    let end = start
    for (const point of points.slice(1)) {
      const captureTimeUs = BigInt(point.capture_time_us)
      if (captureTimeUs < start) start = captureTimeUs
      if (captureTimeUs > end) end = captureTimeUs
    }
    return {
      startCaptureTimeUs: start.toString(),
      endCaptureTimeUs: (end > start ? end : start + 1n).toString(),
    }
  }
  function clipRangeForRally(rally: CoachRally) {
    return rally.submission.clip
      ? {
          startCaptureTimeUs: rally.submission.clip.start_capture_time_us,
          endCaptureTimeUs: rally.submission.clip.end_capture_time_us,
        }
      : rally.submission.boundaries?.length
        ? clipRangeForPoints(rally.submission.boundaries)
        : clipRangeForPoints(rally.submission.key_points)
  }
  function rallyDisplayDuration(rally: CoachRally) {
    const range = clipRangeForRally(rally)
    return range
      ? (BigInt(range.endCaptureTimeUs) - BigInt(range.startCaptureTimeUs)).toString()
      : null
  }

  const timelineSegments = computed(() => {
    const currentRallyId = options.displayAnnotation.value?.rally_id
    const activeSubmissionId = options.displayAnnotation.value?.snapshot.active_submission_id
    const submitted = submittedRallies.value.flatMap(rally => {
      // A correction draft with the same rally id fully replaces the submitted
      // projection in the workstation. This must come from the dashboard draft
      // collection so it also holds before the user selects the rally after F5.
      if (correctionDraftRallyIds.value.has(rally.id)) return []
      const range = clipRangeForRally(rally)
      // The editable draft owns the mask. A predecessor analysis may still be
      // present in the dashboard as a source projection, but it is not part of
      // the active correction draft and must not be rendered as its result rail.
      if (!range) return []
      const analysis = rally.submission.analysis
      const failed = rally.processing_status === 'failed'
      const processingCompleted = rally.processing_status === 'completed'
      const sourcePointsReplaced =
        isSupersededSourceSubmission({
          activeSubmissionId,
          currentRallyId,
          rallyId: rally.id,
          submissionId: rally.submission.id,
        }) || correctionSourceSubmissionIds.value.has(rally.submission.id)
      const analysisReplaced =
        sourcePointsReplaced ||
        Boolean(
          activeSubmissionId &&
          currentRallyId &&
          rally.id === currentRallyId &&
          ['OPEN', 'READY'].includes(options.state.value),
        )
      const outcome = timelineOutcomeMetadata({
        scoreResolution: rally.submission.score_resolution,
        scoringCourtSide: rally.submission.scoring_court_side,
        scoringTeamId: rally.submission.scoring_team_id,
        leftTeamId: rally.submission.left_team_id,
        rightTeamId: rally.submission.right_team_id,
        teams: options.coachData.value?.match.teams,
      })
      return [
        {
          id: rally.id,
          label: `第 ${rally.display_set_number} 局 · 回合 ${displayOrdinalFor(rally.id)}`,
          stateLabel: failed
            ? '處理失敗'
            : processingCompleted && analysis?.status === 'completed'
              ? analysis.identity_mapping_completed
                ? '球員已確認'
                : '待指派球員'
              : processingStateLabel(rally.processing_status),
          outcomeLabel: annotationOutcomeLabel({
            scoreResolution: rally.submission.score_resolution,
            scoringCourtSide: rally.submission.scoring_court_side,
            scoringTeamId: rally.submission.scoring_team_id,
            teams: options.coachData.value?.match.teams,
          }),
          outcomeSide: outcome.side,
          outcomeTeamLabel: outcome.teamLabel,
          startCaptureTimeUs: range.startCaptureTimeUs,
          endCaptureTimeUs: range.endCaptureTimeUs,
          // Timeline key points are editorial truth. AI contacts belong to the
          // separate analysis rail and must never replace or visually duplicate
          // the human event sequence.
          points: sourcePointsReplaced
            ? []
            : rally.submission.key_points.map(point => ({
                id: point.id,
                markerKind: point.marker_kind,
                isTerminal: point.is_terminal,
                captureTimeUs: point.capture_time_us,
                ballEvent: point.ball_event ?? null,
              })),
          reservedByPeer: false,
          status: failed
            ? ('failed' as const)
            : rally.processing_status === 'idle'
              ? ('idle' as const)
              : processingCompleted && analysis?.status === 'completed'
                ? analysis.identity_mapping_completed
                  ? ('mapped' as const)
                  : ('analyzed' as const)
                : ('processing' as const),
          analysis:
            !analysisReplaced && analysis?.status === 'completed'
              ? {
                  startCaptureTimeUs:
                    analysis.coverage_start_capture_time_us ?? range.startCaptureTimeUs,
                  endCaptureTimeUs: analysis.coverage_end_capture_time_us ?? range.endCaptureTimeUs,
                  byteLength: analysis.byte_length,
                  trackCount: analysis.track_count,
                  ballPathCount: analysis.ball_path_count,
                  contactCount: analysis.contact_count,
                  capabilities: analysis.capabilities,
                }
              : null,
        },
      ]
    })
    const drafts = annotationDrafts.value.flatMap(draft => {
      const range = draft.boundaries?.length
        ? clipRangeForPoints(draft.boundaries)
        : clipRangeForPoints(draft.key_points)
      if (
        !range ||
        (draft.id === currentRallyId && ['OPEN', 'READY'].includes(options.state.value))
      )
        return []
      const outcome = timelineOutcomeMetadata({
        scoreResolution: draft.score_resolution,
        scoringCourtSide: draft.scoring_court_side,
        scoringTeamId: draft.scoring_team_id,
        leftTeamId: draft.left_team_id ?? leftTeamId.value,
        rightTeamId: draft.right_team_id ?? rightTeamId.value,
        teams: options.coachData.value?.match.teams,
      })
      return [
        {
          id: draft.id,
          label: `第 ${draft.display_set_number} 局 · 回合 ${displayOrdinalFor(draft.id)}`,
          stateLabel: draft.active_submission_id
            ? '修正版草稿'
            : draft.annotation_status === 'ready'
              ? '待送出'
              : '標記中',
          outcomeLabel: annotationOutcomeLabel({
            scoreResolution: draft.score_resolution,
            scoringCourtSide: draft.scoring_court_side,
            scoringTeamId: draft.scoring_team_id,
            teams: options.coachData.value?.match.teams,
          }),
          outcomeSide: outcome.side,
          outcomeTeamLabel: outcome.teamLabel,
          startCaptureTimeUs: range.startCaptureTimeUs,
          endCaptureTimeUs: range.endCaptureTimeUs,
          points: draft.key_points.map(point => ({
            id: point.id,
            markerKind: point.marker_kind,
            isTerminal: point.is_terminal,
            captureTimeUs: point.capture_time_us,
            ballEvent: point.ball_event ?? null,
          })),
          reservedByPeer: false,
          status: 'draft' as const,
          analysis: null,
        },
      ]
    })
    const knownRallyIds = new Set([
      ...submittedRallies.value.map(rally => rally.id),
      ...annotationDrafts.value.map(draft => draft.id),
      ...(currentRallyId ? [currentRallyId] : []),
    ])
    const peerDrafts = (options.roomSnapshots?.value ?? []).flatMap(peer => {
      if (
        knownRallyIds.has(peer.rally_id) ||
        !['open', 'ready'].includes(peer.snapshot.annotation_status)
      )
        return []
      const anchors = peer.snapshot.boundaries?.length
        ? peer.snapshot.boundaries
        : peer.snapshot.key_points
      const range = clipRangeForPoints(anchors)
      if (!range) return []
      return [
        {
          id: peer.rally_id,
          label: '其他標註者片段',
          stateLabel:
            peer.snapshot.annotation_status === 'ready' ? '其他標註者待送出' : '其他標註者標記中',
          outcomeLabel: null,
          outcomeSide: null,
          outcomeTeamLabel: null,
          startCaptureTimeUs: range.startCaptureTimeUs,
          endCaptureTimeUs: range.endCaptureTimeUs,
          points: peer.snapshot.key_points.map(point => ({
            id: point.key_point_id,
            markerKind: point.marker_kind,
            isTerminal: point.is_terminal,
            captureTimeUs: point.capture_time_us,
            ballEvent: point.ball_event ?? null,
          })),
          reservedByPeer: true,
          status: 'draft' as const,
          analysis: null,
        },
      ]
    })
    return [...submitted, ...drafts, ...peerDrafts]
  })
  const currentMaskRange = computed(() => {
    const snapshot = options.displayAnnotation.value
    const points = snapshot?.snapshot.key_points ?? []
    const currentSubmitted =
      submittedRallies.value.find(rally => rally.id === snapshot?.rally_id) ?? null
    if (!snapshot) return null
    if (!['open', 'ready'].includes(snapshot.snapshot.annotation_status) && currentSubmitted)
      return clipRangeForRally(currentSubmitted)
    const start = snapshot.snapshot.boundaries?.find(boundary => boundary.kind === 'start')
    if (!start) return clipRangeForPoints(points)
    const end = snapshot.snapshot.boundaries?.find(boundary => boundary.kind === 'end')
    const previewEnd =
      end?.capture_time_us ??
      (snapshot.snapshot.annotation_status === 'open'
        ? (options.visualPlayhead?.value ?? null)
        : null) ??
      start.capture_time_us
    const startUs = BigInt(start.capture_time_us)
    const endUs = BigInt(previewEnd) > startUs ? BigInt(previewEnd) : startUs
    const requestedStart = startUs > clipPreRollUs.value ? startUs - clipPreRollUs.value : 0n
    const requestedEnd = endUs + clipPostRollUs.value
    // An OPEN draft may keep following the local playhead after the user seeks
    // beyond a later Rally. Keep that local cursor independent, but cap the
    // rendered clip preview at the first canonical segment that follows it.
    // Peer editable drafts are deliberately excluded: only submitted/processing
    // segments are stable enough to constrain another client's preview.
    const nextCanonicalStart = timelineSegments.value.reduce<bigint | null>((next, segment) => {
      if (segment.id === snapshot.rally_id || segment.status === 'draft') return next
      const candidate = BigInt(segment.startCaptureTimeUs)
      if (candidate <= requestedStart || (next !== null && candidate >= next)) return next
      return candidate
    }, null)
    const canonicalEnd =
      nextCanonicalStart !== null && requestedEnd > nextCanonicalStart
        ? nextCanonicalStart
        : requestedEnd
    const timelineStart = options.timeline.value?.availableRanges[0]?.startUs
    const timelineEnd = options.timeline.value?.availableRanges.at(-1)?.endUs
    return {
      startCaptureTimeUs: (timelineStart && requestedStart < BigInt(timelineStart)
        ? BigInt(timelineStart)
        : requestedStart
      ).toString(),
      endCaptureTimeUs: (timelineEnd && canonicalEnd > BigInt(timelineEnd)
        ? BigInt(timelineEnd)
        : canonicalEnd
      ).toString(),
    }
  })
  const selectableSegmentRanges = computed(() => {
    const currentId = options.displayAnnotation.value?.rally_id
    return currentId && currentMaskRange.value
      ? [...timelineSegments.value, { id: currentId, ...currentMaskRange.value }]
      : timelineSegments.value
  })
  const reservationSegmentRanges = computed(() => {
    const ranges = new Map<
      string,
      { id: string; startCaptureTimeUs: string; endCaptureTimeUs: string }
    >()
    for (const rally of submittedRallies.value) {
      const points = rally.submission.boundaries?.length
        ? rally.submission.boundaries
        : rally.submission.key_points
      const range = annotationRangeForPoints(points)
      if (range) ranges.set(rally.id, { id: rally.id, ...range })
    }
    for (const draft of annotationDrafts.value) {
      const points = draft.boundaries?.length ? draft.boundaries : draft.key_points
      const range = annotationRangeForPoints(points)
      if (range) ranges.set(draft.id, { id: draft.id, ...range })
    }
    for (const peer of options.roomSnapshots?.value ?? []) {
      if (!['open', 'ready'].includes(peer.snapshot.annotation_status)) continue
      const points = peer.snapshot.boundaries?.length
        ? peer.snapshot.boundaries
        : peer.snapshot.key_points
      const range = annotationRangeForPoints(points)
      if (range) ranges.set(peer.rally_id, { id: peer.rally_id, ...range })
    }
    return [...ranges.values()]
  })
  const currentAnnotationRally = computed(
    () =>
      submittedRallies.value.find(
        rally => rally.id === options.displayAnnotation.value?.rally_id,
      ) ?? null,
  )
  const currentMaskStatus = computed<'idle' | 'failed' | 'processing' | 'analyzed' | 'mapped'>(
    () => {
      const analysis = currentAnnotationRally.value?.submission.analysis
      if (currentAnnotationRally.value?.processing_status === 'failed') return 'failed'
      if (currentAnnotationRally.value?.processing_status === 'idle') return 'idle'
      if (currentAnnotationRally.value?.processing_status !== 'completed') return 'processing'
      return analysis?.status === 'completed'
        ? analysis.identity_mapping_completed
          ? 'mapped'
          : 'analyzed'
        : 'processing'
    },
  )
  const currentAnnotationDraft = computed(
    () =>
      annotationDrafts.value.find(
        draft => draft.id === options.displayAnnotation.value?.rally_id,
      ) ?? null,
  )
  const currentMaskLabel = computed(() =>
    currentAnnotationDraft.value
      ? `第 ${currentAnnotationDraft.value.display_set_number} 局 · 回合 ${displayOrdinalFor(currentAnnotationDraft.value.id)}`
      : currentAnnotationRally.value
        ? `第 ${currentAnnotationRally.value.display_set_number} 局 · 回合 ${displayOrdinalFor(currentAnnotationRally.value.id)}`
        : null,
  )
  const currentOutcomeSource = computed(
    () => currentAnnotationDraft.value ?? currentAnnotationRally.value?.submission ?? null,
  )
  const currentOutcomeSideTeamIds = computed(() => ({
    left: currentOutcomeSource.value?.left_team_id ?? leftTeamId.value,
    right: currentOutcomeSource.value?.right_team_id ?? rightTeamId.value,
  }))
  const currentOutcomeScoringTeamId = computed(() => {
    const snapshot = options.displayAnnotation.value?.snapshot
    const source = currentOutcomeSource.value
    if (!snapshot || !source) return null
    return source?.score_resolution === snapshot?.score_resolution &&
      source?.scoring_court_side === snapshot?.scoring_court_side
      ? source.scoring_team_id
      : null
  })
  const currentMaskOutcome = computed(() => {
    const snapshot = options.displayAnnotation.value?.snapshot
    const teams = options.coachData.value?.match.teams
    const currentLeftTeam = teams?.find(team => team.id === currentOutcomeSideTeamIds.value.left)
    const currentRightTeam = teams?.find(team => team.id === currentOutcomeSideTeamIds.value.right)
    return annotationOutcomeLabel({
      scoreResolution: snapshot?.score_resolution,
      scoringCourtSide: snapshot?.scoring_court_side,
      scoringTeamId: currentOutcomeScoringTeamId.value,
      teams,
      leftLabel: currentLeftTeam?.shortName ?? currentLeftTeam?.name ?? '左隊',
      rightLabel: currentRightTeam?.shortName ?? currentRightTeam?.name ?? '右隊',
    })
  })
  const currentMaskOutcomeMetadata = computed(() => {
    const snapshot = options.displayAnnotation.value?.snapshot
    return timelineOutcomeMetadata({
      scoreResolution: snapshot?.score_resolution,
      scoringCourtSide: snapshot?.scoring_court_side,
      scoringTeamId: currentOutcomeScoringTeamId.value,
      leftTeamId: currentOutcomeSideTeamIds.value.left,
      rightTeamId: currentOutcomeSideTeamIds.value.right,
      teams: options.coachData.value?.match.teams,
    })
  })
  const currentMaskOutcomeSide = computed(() => currentMaskOutcomeMetadata.value.side)
  const currentMaskOutcomeTeamLabel = computed(() => currentMaskOutcomeMetadata.value.teamLabel)
  const cursorRally = computed(
    () => submittedRallies.value.find(rally => rally.id === options.cursorRallyId.value) ?? null,
  )
  const activeOverlayRally = computed(() =>
    cursorRally.value?.submission.analysis?.status === 'completed' ? cursorRally.value : null,
  )
  const activeOverlayAnalysisRunId = computed(
    () => activeOverlayRally.value?.submission.analysis?.id ?? null,
  )
  const activeOverlayClipStart = computed(
    () => activeOverlayRally.value?.submission.clip?.start_capture_time_us ?? null,
  )
  const activeContextRally = computed(() => selectedSubmittedRally.value)
  const selectedCurrentMask = computed(
    () =>
      options.selectedRallyId.value !== null &&
      options.selectedRallyId.value === (options.displayAnnotation.value?.rally_id ?? null),
  )
  const activeContextDraft = computed(
    () =>
      selectedDraftRally.value ?? (selectedCurrentMask.value ? currentAnnotationDraft.value : null),
  )
  const selectedEditableDraft = computed(() =>
    Boolean(
      selectedCurrentMask.value &&
      options.displayAnnotation.value &&
      ['OPEN', 'READY'].includes(options.state.value),
    ),
  )
  const activeCorrectionDraft = computed(() => {
    if (selectedDraftRally.value?.active_submission_id) return selectedDraftRally.value
    if (
      currentAnnotationDraft.value?.active_submission_id &&
      (!options.selectedRallyId.value ||
        currentAnnotationDraft.value.id === options.selectedRallyId.value)
    )
      return currentAnnotationDraft.value
    return null
  })
  const correctionActive = computed(() =>
    Boolean(
      activeCorrectionDraft.value ||
      (['OPEN', 'READY'].includes(options.state.value) &&
        options.confirmedAnnotation.value?.snapshot.active_submission_id) ||
      (selectedSubmittedRally.value?.submission.supersedes_submission_id &&
        selectedSubmittedRally.value.processing_status === 'failed'),
    ),
  )
  const correctionRallyId = computed(
    () =>
      activeCorrectionDraft.value?.id ??
      (selectedSubmittedRally.value?.submission.supersedes_submission_id &&
      selectedSubmittedRally.value.processing_status === 'failed'
        ? selectedSubmittedRally.value.id
        : null),
  )
  const selectedDeletablePoint = computed(
    () =>
      options.selectedTimelineItem.value === 'point' &&
      options.selectedKeyPoint.value?.marker_kind !== 'service' &&
      // Submitted/AI results are immutable. A point may only be removed from
      // the currently displayed draft (ordinary draft or correction draft).
      // The action wiring adds the local-owner and sync-readiness gates.
      selectedEditableDraft.value,
  )
  const activeContextTitle = computed(() =>
    activeContextDraft.value
      ? `第 ${activeContextDraft.value.display_set_number} 局 · 回合 ${displayOrdinalFor(activeContextDraft.value.id)}`
      : activeContextRally.value
        ? `第 ${activeContextRally.value.display_set_number} 局 · 回合 ${displayOrdinalFor(activeContextRally.value.id)}`
        : '游標未落在片段內',
  )
  const activeContextHits = computed(
    () =>
      activeContextDraft.value?.key_points.filter(point => point.marker_kind === 'contact')
        .length ??
      activeContextRally.value?.submission.analysis?.contact_count ??
      activeContextRally.value?.submission.contact_count ??
      0,
  )
  const activeContextDuration = computed(() => {
    const range = activeContextDraft.value
      ? clipRangeForPoints(activeContextDraft.value.key_points)
      : activeContextRally.value
        ? clipRangeForRally(activeContextRally.value)
        : null
    return range
      ? (BigInt(range.endCaptureTimeUs) - BigInt(range.startCaptureTimeUs)).toString()
      : null
  })
  const activeContextState = computed(() =>
    activeContextDraft.value
      ? activeContextDraft.value.active_submission_id
        ? '修正版草稿'
        : activeContextDraft.value.annotation_status === 'ready'
          ? '待送出'
          : '標記中'
      : activeContextRally.value?.processing_status !== 'completed'
        ? activeContextRally.value
          ? processingStateLabel(activeContextRally.value.processing_status)
          : '—'
        : activeContextRally.value?.submission.analysis?.status === 'completed'
          ? activeContextRally.value.submission.analysis.identity_mapping_completed
            ? '已指派'
            : '分析完成'
          : activeContextRally.value
            ? processingStateLabel(activeContextRally.value.processing_status)
            : '—',
  )
  const displayRallyOrdinal = computed(() =>
    activeContextRally.value
      ? displayOrdinalFor(activeContextRally.value.id)
      : activeContextDraft.value
        ? displayOrdinalFor(activeContextDraft.value.id)
        : '—',
  )
  const displaySetNumber = computed(
    () =>
      activeContextRally.value?.display_set_number ??
      activeContextDraft.value?.display_set_number ??
      currentSet.value?.set_number ??
      1,
  )

  return {
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
    clipRangeForPoints,
    clipRangeForRally,
    rallyDisplayDuration,
    displayOrdinalFor,
    timelineSegments,
    currentMaskRange,
    selectableSegmentRanges,
    reservationSegmentRanges,
    selectedCurrentMask,
    currentAnnotationRally,
    currentMaskStatus,
    currentMaskLabel,
    currentMaskOutcome,
    currentMaskOutcomeSide,
    currentMaskOutcomeTeamLabel,
    activeOverlayAnalysisRunId,
    activeOverlayClipStart,
    currentAnnotationDraft,
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
  }
}
