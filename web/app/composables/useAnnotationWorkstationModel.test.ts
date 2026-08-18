import type { AnnotationKeyPoint, AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { computed, ref, shallowRef } from 'vue'
import { describe, expect, it } from 'vitest'
import type { CoachMatchState } from '~/lib/coachDomain'
import type { CaptureTimeline, Match } from '~/lib/coreDomain'
import type { TimelineSelectionItem } from '~/utils/timelineSelection'
import { useAnnotationWorkstationModel } from './useAnnotationWorkstationModel'

const snapshot: AnnotationRallySnapshot = {
  schema_version: '2.0.0',
  type: 'rally_snapshot',
  room_id: 'room',
  rally_id: 'rally',
  revision: '3',
  server_sequence: '3',
  snapshot: {
    annotation_status: 'submitted',
    active_submission_id: 'submission',
    side_assignment_id: 'assignment',
    score_resolution: 'resolved',
    scoring_court_side: 'left',
    processing_status: 'completed',
    key_points: [
      {
        key_point_id: 'service',
        sequence_index: 0,
        marker_kind: 'service',
        is_terminal: false,
        capture_time_us: '1000000',
        capture_frame_index: '30',
        timing_precision: 'frame_exact',
        possible_duplicate: false,
      },
      {
        key_point_id: 'terminal',
        sequence_index: 1,
        marker_kind: 'contact',
        is_terminal: true,
        capture_time_us: '2000000',
        capture_frame_index: '60',
        timing_precision: 'frame_exact',
        possible_duplicate: false,
      },
    ],
  },
}

const coachState = {
  schema_version: '1.0.0',
  match: {
    id: 'match',
    title: 'Match',
    status: 'live',
    clip_pre_roll_us: '0',
    clip_post_roll_us: '0',
    captures: [],
    drafts: [],
    sets: [],
    teams: [
      { id: 'left', name: 'Left', shortName: 'L' },
      { id: 'right', name: 'Right', shortName: 'R' },
    ],
    rallies: [
      {
        id: 'rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '3',
        processing_status: 'completed',
        scoring_court_side: 'left',
        scoring_team_id: 'left',
        set_id: 'set',
        set_number: 1,
        left_score_after: 1,
        right_score_after: 0,
        winner_side: 'left',
        submission: {
          id: 'submission',
          supersedes_submission_id: null,
          submitted_at: '2026-08-10T00:00:00.000Z',
          score_resolution: 'resolved',
          scoring_court_side: 'left',
          scoring_team_id: 'left',
          side_assignment_id: 'assignment',
          side_assignment_reversed: false,
          left_team_id: 'left',
          right_team_id: 'right',
          contact_count: 1,
          key_points: [
            {
              id: 'service',
              sequence_index: 0,
              marker_kind: 'service',
              is_terminal: false,
              capture_time_us: '1000000',
              capture_frame_index: '30',
            },
            {
              id: 'terminal',
              sequence_index: 1,
              marker_kind: 'contact',
              is_terminal: true,
              capture_time_us: '2000000',
              capture_frame_index: '60',
            },
          ],
          clip: {
            id: 'clip',
            status: 'completed',
            start_capture_time_us: '1000000',
            end_capture_time_us: '2000000',
            duration_us: '1000000',
          },
          processing: {} as never,
          analysis: {
            id: 'analysis',
            status: 'completed',
            version: 'v1',
            summary: {},
            identity_mapping_completed: false,
            coverage_start_capture_time_us: '1100000',
            coverage_end_capture_time_us: '1900000',
            byte_length: '2048',
            track_count: 12,
            ball_path_count: 1,
            contact_count: 1,
            contact_points: [
              {
                id: 'ai-contact',
                capture_time_us: '1500000',
                frame_index: '15',
                source: 'ai',
                confidence: 0.9,
              },
            ],
            capabilities: ['player_tracking', 'ball_tracking'],
          },
        },
      },
    ],
  },
} as CoachMatchState

describe('useAnnotationWorkstationModel timeline layers', () => {
  it('keeps reservation ranges independent from overlapping clip handles', () => {
    const state = structuredClone(coachState)
    state.match.clip_pre_roll_us = '5000000'
    state.match.clip_post_roll_us = '5000000'
    state.match.rallies[0]!.submission.clip = {
      id: 'clip',
      status: 'completed',
      start_capture_time_us: '0',
      end_capture_time_us: '7000000',
      duration_us: '7000000',
    }
    const model = useAnnotationWorkstationModel({
      coachData: ref(state),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed<AnnotationRallySnapshot | null>(() => null),
      confirmedAnnotation: shallowRef<AnnotationRallySnapshot | null>(null),
      state: computed(() => 'IDLE' as const),
      selectedRallyId: computed(() => null),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>(null),
      cursorRallyId: ref(null),
    })

    expect(model.timelineSegments.value[0]).toEqual(
      expect.objectContaining({ startCaptureTimeUs: '0', endCaptureTimeUs: '7000000' }),
    )
    expect(model.reservationSegmentRanges.value).toEqual([
      { id: 'rally', startCaptureTimeUs: '1000000', endCaptureTimeUs: '2000000' },
    ])
  })

  it('projects room-wide peer drafts as read-only reserved ranges before dashboard refresh', () => {
    const peerSnapshot = structuredClone(snapshot)
    peerSnapshot.rally_id = 'peer-rally'
    peerSnapshot.revision = '1'
    peerSnapshot.server_sequence = '9'
    peerSnapshot.snapshot.annotation_status = 'open'
    peerSnapshot.snapshot.active_submission_id = null
    peerSnapshot.snapshot.boundaries = [
      {
        kind: 'start',
        capture_time_us: '3000000',
        capture_frame_index: '90',
        timing_precision: 'frame_exact',
      },
    ]
    peerSnapshot.snapshot.key_points = []
    const model = useAnnotationWorkstationModel({
      coachData: ref(coachState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed<AnnotationRallySnapshot | null>(() => null),
      confirmedAnnotation: shallowRef<AnnotationRallySnapshot | null>(null),
      roomSnapshots: computed(() => [peerSnapshot]),
      state: computed(() => 'IDLE' as const),
      selectedRallyId: computed(() => null),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>(null),
      cursorRallyId: ref(null),
    })

    expect(model.annotationDrafts.value).toEqual([])
    expect(model.timelineSegments.value).toContainEqual(
      expect.objectContaining({
        id: 'peer-rally',
        reservedByPeer: true,
        startCaptureTimeUs: '3000000',
        endCaptureTimeUs: '3000001',
        stateLabel: '其他標註者標記中',
        status: 'draft',
      }),
    )
  })

  it('only exposes a selected point as deletable while the displayed rally is an editable draft', () => {
    const selectedKeyPoint = computed<AnnotationKeyPoint | null>(
      () => snapshot.snapshot.key_points[1] ?? null,
    )
    const submittedModel = useAnnotationWorkstationModel({
      coachData: ref(coachState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => snapshot),
      confirmedAnnotation: shallowRef(snapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint,
      selectedTimelineItem: ref<TimelineSelectionItem>('point'),
      cursorRallyId: ref('rally'),
    })
    expect(submittedModel.selectedDeletablePoint.value).toBe(false)

    const correctionSnapshot = structuredClone(snapshot)
    correctionSnapshot.snapshot.annotation_status = 'open'
    correctionSnapshot.rally_id = 'correction-rally'
    const correctionModel = useAnnotationWorkstationModel({
      coachData: ref(coachState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => correctionSnapshot),
      confirmedAnnotation: shallowRef(correctionSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => 'correction-rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(
        () => correctionSnapshot.snapshot.key_points[1] ?? null,
      ),
      selectedTimelineItem: ref<TimelineSelectionItem>('point'),
      cursorRallyId: ref('correction-rally'),
    })
    expect(correctionModel.selectedDeletablePoint.value).toBe(true)
  })

  it('keeps an earlier READY boundary draft selectable after a new OPEN draft starts', () => {
    const state = structuredClone(coachState)
    state.match.rallies = []
    state.match.drafts = [
      {
        id: 'ready-rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '2',
        annotation_status: 'ready',
        active_submission_id: null,
        score_resolution: 'pending',
        scoring_court_side: null,
        scoring_team_id: null,
        set_id: 'set',
        set_number: 1,
        key_points: [],
        boundaries: [
          { kind: 'start', capture_time_us: '1000000', capture_frame_index: '30' },
          { kind: 'end', capture_time_us: '2000000', capture_frame_index: '60' },
        ],
      },
      {
        id: 'open-rally',
        ordinal: 2,
        display_ordinal: 2,
        display_set_number: 1,
        annotation_revision: '1',
        annotation_status: 'open',
        active_submission_id: null,
        score_resolution: 'pending',
        scoring_court_side: null,
        scoring_team_id: null,
        set_id: 'set',
        set_number: 1,
        key_points: [],
        boundaries: [{ kind: 'start', capture_time_us: '3000000', capture_frame_index: '90' }],
      },
    ]
    const openSnapshot: AnnotationRallySnapshot = {
      schema_version: '3.0.0',
      type: 'rally_snapshot',
      room_id: 'room',
      rally_id: 'open-rally',
      revision: '1',
      server_sequence: '4',
      snapshot: {
        annotation_status: 'open',
        active_submission_id: null,
        side_assignment_id: 'assignment',
        score_resolution: 'pending',
        scoring_court_side: null,
        processing_status: 'idle',
        boundaries: [
          {
            kind: 'start',
            capture_time_us: '3000000',
            capture_frame_index: '90',
            timing_precision: 'frame_exact',
          },
        ],
        key_points: [],
      },
    }
    const model = useAnnotationWorkstationModel({
      coachData: ref(state),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => openSnapshot),
      confirmedAnnotation: shallowRef(openSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => 'ready-rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('mask'),
      cursorRallyId: ref('open-rally'),
      visualPlayhead: ref('3500000'),
    })

    expect(model.annotationDrafts.value.map(draft => draft.id)).toEqual([
      'ready-rally',
      'open-rally',
    ])
    expect(model.timelineSegments.value).toContainEqual(
      expect.objectContaining({ id: 'ready-rally', stateLabel: '待送出' }),
    )
    expect(model.currentMaskRange.value).toMatchObject({
      startCaptureTimeUs: '3000000',
      endCaptureTimeUs: '3500000',
    })
  })

  it('caps an OPEN preview at the next canonical Rally start', () => {
    const state = structuredClone(coachState)
    const nextRally = state.match.rallies[0]!
    nextRally.id = 'next-rally'
    nextRally.submission.id = 'next-submission'
    nextRally.submission.clip = {
      id: 'next-clip',
      status: 'completed',
      start_capture_time_us: '4000000',
      end_capture_time_us: '5000000',
      duration_us: '1000000',
    }
    state.match.drafts = [
      {
        id: 'open-rally',
        ordinal: 2,
        display_ordinal: 2,
        display_set_number: 1,
        annotation_revision: '1',
        annotation_status: 'open',
        active_submission_id: null,
        score_resolution: 'pending',
        scoring_court_side: null,
        scoring_team_id: null,
        set_id: 'set',
        set_number: 1,
        key_points: [],
        boundaries: [{ kind: 'start', capture_time_us: '2000000', capture_frame_index: '60' }],
      },
    ]
    const openSnapshot: AnnotationRallySnapshot = {
      schema_version: '3.0.0',
      type: 'rally_snapshot',
      room_id: 'room',
      rally_id: 'open-rally',
      revision: '1',
      server_sequence: '4',
      snapshot: {
        annotation_status: 'open',
        active_submission_id: null,
        side_assignment_id: 'assignment',
        score_resolution: 'pending',
        scoring_court_side: null,
        processing_status: 'idle',
        boundaries: [
          {
            kind: 'start',
            capture_time_us: '2000000',
            capture_frame_index: '60',
            timing_precision: 'frame_exact',
          },
        ],
        key_points: [],
      },
    }
    const model = useAnnotationWorkstationModel({
      coachData: ref(state),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => openSnapshot),
      confirmedAnnotation: shallowRef(openSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => 'open-rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('mask'),
      cursorRallyId: ref('open-rally'),
      visualPlayhead: ref('7000000'),
    })

    expect(model.currentMaskRange.value).toMatchObject({
      startCaptureTimeUs: '2000000',
      endCaptureTimeUs: '4000000',
    })
  })

  it('does not let a peer editable draft constrain the local OPEN preview', () => {
    const state = structuredClone(coachState)
    state.match.rallies = []
    state.match.drafts = [
      {
        id: 'open-rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '1',
        annotation_status: 'open',
        active_submission_id: null,
        score_resolution: 'pending',
        scoring_court_side: null,
        scoring_team_id: null,
        set_id: 'set',
        set_number: 1,
        key_points: [],
        boundaries: [{ kind: 'start', capture_time_us: '2000000', capture_frame_index: '60' }],
      },
      {
        id: 'peer-draft',
        ordinal: 2,
        display_ordinal: 2,
        display_set_number: 1,
        annotation_revision: '1',
        annotation_status: 'open',
        active_submission_id: null,
        score_resolution: 'pending',
        scoring_court_side: null,
        scoring_team_id: null,
        set_id: 'set',
        set_number: 1,
        key_points: [],
        boundaries: [{ kind: 'start', capture_time_us: '4000000', capture_frame_index: '120' }],
      },
    ]
    const openSnapshot: AnnotationRallySnapshot = {
      schema_version: '3.0.0',
      type: 'rally_snapshot',
      room_id: 'room',
      rally_id: 'open-rally',
      revision: '1',
      server_sequence: '4',
      snapshot: {
        annotation_status: 'open',
        active_submission_id: null,
        side_assignment_id: 'assignment',
        score_resolution: 'pending',
        scoring_court_side: null,
        processing_status: 'idle',
        boundaries: [
          {
            kind: 'start',
            capture_time_us: '2000000',
            capture_frame_index: '60',
            timing_precision: 'frame_exact',
          },
        ],
        key_points: [],
      },
    }
    const model = useAnnotationWorkstationModel({
      coachData: ref(state),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => openSnapshot),
      confirmedAnnotation: shallowRef(openSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => 'open-rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('mask'),
      cursorRallyId: ref('open-rally'),
      visualPlayhead: ref('7000000'),
    })

    expect(model.currentMaskRange.value?.endCaptureTimeUs).toBe('7000000')
  })

  it('keeps the current submitted Rally analysis data for the independent result rail', () => {
    const model = useAnnotationWorkstationModel({
      coachData: ref(coachState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => snapshot),
      confirmedAnnotation: shallowRef(snapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('segment'),
      cursorRallyId: ref('rally'),
    })

    expect(model.timelineSegments.value).toMatchObject([
      {
        id: 'rally',
        outcomeLabel: '左側 L 得分',
        outcomeSide: 'left',
        outcomeTeamLabel: 'L',
        points: [
          { id: 'service', markerKind: 'service', captureTimeUs: '1000000' },
          { id: 'terminal', markerKind: 'contact', captureTimeUs: '2000000' },
        ],
        analysis: {
          startCaptureTimeUs: '1100000',
          endCaptureTimeUs: '1900000',
          byteLength: '2048',
        },
      },
    ])
    expect(model.currentMaskOutcome.value).toBe('左側 L 得分')
    expect(model.currentMaskOutcomeSide.value).toBe('left')
    expect(model.currentMaskOutcomeTeamLabel.value).toBe('L')
  })

  it('uses the realtime outcome while coach data is still stale', () => {
    const realtimeSnapshot = structuredClone(snapshot)
    realtimeSnapshot.snapshot.scoring_court_side = 'right'
    const model = useAnnotationWorkstationModel({
      coachData: ref(coachState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => realtimeSnapshot),
      confirmedAnnotation: shallowRef(realtimeSnapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('segment'),
      cursorRallyId: ref('rally'),
    })

    expect(model.currentMaskOutcome.value).toBe('右側 R 得分')
    expect(model.currentMaskOutcomeSide.value).toBe('right')
    expect(model.currentMaskOutcomeTeamLabel.value).toBe('R')
  })

  it('keeps outcome presentation empty while the initial rally data is loading', () => {
    const model = useAnnotationWorkstationModel({
      coachData: ref<CoachMatchState | null>(null),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => null),
      confirmedAnnotation: shallowRef(null),
      state: computed(() => 'IDLE' as const),
      selectedRallyId: computed(() => null),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>(null),
      cursorRallyId: ref(null),
    })

    expect(model.currentMaskOutcome.value).toBeNull()
    expect(model.currentMaskOutcomeSide.value).toBeNull()
    expect(model.currentMaskOutcomeTeamLabel.value).toBeNull()
  })

  it('labels a hard-cut legacy result as awaiting a new analysis instead of processing', () => {
    const retiredState = structuredClone(coachState)
    retiredState.match.rallies[0]!.processing_status = 'idle'
    retiredState.match.rallies[0]!.submission.analysis = null
    const model = useAnnotationWorkstationModel({
      coachData: ref(retiredState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => snapshot),
      confirmedAnnotation: shallowRef(snapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('segment'),
      cursorRallyId: ref('rally'),
    })

    expect(model.timelineSegments.value[0]).toMatchObject({
      stateLabel: '待重新分析',
      status: 'idle',
    })
    expect(model.currentMaskStatus.value).toBe('idle')
    expect(model.activeContextState.value).toBe('待重新分析')
  })

  it('derives visible rally numbers from capture order when stored values are stale', () => {
    const staleState = structuredClone(coachState)
    staleState.match.rallies[0]!.display_ordinal = 8
    const model = useAnnotationWorkstationModel({
      coachData: ref(staleState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => snapshot),
      confirmedAnnotation: shallowRef(snapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('segment'),
      cursorRallyId: ref('rally'),
    })

    expect(model.timelineSegments.value[0]?.label).toBe('第 1 局 · 回合 1')
    expect(model.currentMaskLabel.value).toBe('第 1 局 · 回合 1')
    expect(model.activeContextTitle.value).toBe('第 1 局 · 回合 1')
    expect(model.displayRallyOrdinal.value).toBe(1)
  })

  it('ignores a stale correction draft after realtime submit acknowledgement', () => {
    const staleDashboard = structuredClone(coachState)
    staleDashboard.match.rallies[0]!.submission.contact_count = 0
    staleDashboard.match.rallies[0]!.submission.analysis!.contact_count = 2
    staleDashboard.match.drafts = [
      {
        id: 'rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '4',
        annotation_status: 'open',
        active_submission_id: 'submission',
        set_id: 'set',
        set_number: 1,
        key_points: staleDashboard.match.rallies[0]!.submission.key_points,
      },
    ]
    const model = useAnnotationWorkstationModel({
      coachData: ref(staleDashboard),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => snapshot),
      confirmedAnnotation: shallowRef(snapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('point'),
      cursorRallyId: ref('rally'),
    })

    expect(model.annotationDrafts.value).toEqual([])
    expect(model.selectedSubmittedRally.value?.id).toBe('rally')
    expect(model.activeContextState.value).toBe('分析完成')
    expect(model.activeContextHits.value).toBe(2)
  })

  it('shows fresh correction processing while retaining the previous analysis fallback', () => {
    const processingCorrection = structuredClone(coachState)
    processingCorrection.match.rallies[0]!.processing_status = 'clip_queued'
    processingCorrection.match.rallies[0]!.submission.supersedes_submission_id =
      'previous-submission'
    const processingSnapshot = structuredClone(snapshot)
    processingSnapshot.snapshot.processing_status = 'clip_queued'
    const model = useAnnotationWorkstationModel({
      coachData: ref(processingCorrection),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => processingSnapshot),
      confirmedAnnotation: shallowRef(processingSnapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('segment'),
      cursorRallyId: ref('rally'),
    })

    expect(model.selectedAnalysisRunId.value).toBe('analysis')
    expect(model.activeContextState.value).toBe('剪切中')
    expect(model.timelineSegments.value[0]).toMatchObject({
      status: 'processing',
      analysis: { byteLength: '2048' },
    })
  })

  it('keeps a failed submitted correction cancellable', () => {
    const failedCorrectionState = structuredClone(coachState)
    failedCorrectionState.match.rallies[0]!.processing_status = 'failed'
    failedCorrectionState.match.rallies[0]!.submission.supersedes_submission_id =
      'previous-submission'
    const failedSnapshot = structuredClone(snapshot)
    failedSnapshot.snapshot.processing_status = 'failed'
    const model = useAnnotationWorkstationModel({
      coachData: ref(failedCorrectionState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => failedSnapshot),
      confirmedAnnotation: shallowRef(failedSnapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('segment'),
      cursorRallyId: ref('rally'),
    })

    expect(model.correctionActive.value).toBe(true)
  })

  it('keeps an open correction cancellable when selection is temporarily unresolved', () => {
    const correctionState = structuredClone(coachState)
    correctionState.match.drafts = [
      {
        id: 'rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '4',
        annotation_status: 'open',
        active_submission_id: 'submission',
        set_id: 'set',
        set_number: 1,
        key_points: correctionState.match.rallies[0]!.submission.key_points,
      },
    ]
    const correctionSnapshot = structuredClone(snapshot)
    correctionSnapshot.snapshot.annotation_status = 'open'
    const model = useAnnotationWorkstationModel({
      coachData: ref(correctionState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => correctionSnapshot),
      confirmedAnnotation: shallowRef(correctionSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => null),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>(null),
      cursorRallyId: ref(null),
    })

    expect(model.selectedCurrentMask.value).toBe(false)
    expect(model.activeContextTitle.value).toBe('游標未落在片段內')
    expect(model.activeContextState.value).toBe('—')
    expect(model.correctionActive.value).toBe(true)
    expect(model.correctionRallyId.value).toBe('rally')
  })

  it('hides the predecessor analysis rail while its correction draft is OPEN', () => {
    const correctionState = structuredClone(coachState)
    correctionState.match.drafts = [
      {
        id: 'rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '4',
        annotation_status: 'open',
        active_submission_id: 'submission',
        set_id: 'set',
        set_number: 1,
        key_points: correctionState.match.rallies[0]!.submission.key_points,
      },
    ]
    const correctionSnapshot = structuredClone(snapshot)
    correctionSnapshot.snapshot.annotation_status = 'open'
    const model = useAnnotationWorkstationModel({
      coachData: ref(correctionState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => correctionSnapshot),
      confirmedAnnotation: shallowRef(correctionSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => 'rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('mask'),
      cursorRallyId: ref('rally'),
    })

    expect(model.selectedEditableDraft.value).toBe(true)
    expect(model.selectedAnalysisRunId.value).toBeNull()
    expect(model.mappingAvailable.value).toBe(false)
    expect(model.timelineSegments.value.every(segment => !segment.analysis)).toBe(true)
  })

  it('keeps every correction draft analysis hidden after reload before a rally is selected', () => {
    const correctionState = structuredClone(coachState)
    const secondRally = structuredClone(correctionState.match.rallies[0]!)
    secondRally.id = 'rally-2'
    secondRally.submission.id = 'submission-2'
    correctionState.match.rallies.push(secondRally)
    correctionState.match.drafts = [
      {
        id: 'rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '4',
        annotation_status: 'open',
        active_submission_id: 'submission',
        set_id: 'set',
        set_number: 1,
        key_points: correctionState.match.rallies[0]!.submission.key_points,
      },
      {
        id: 'rally-2',
        ordinal: 2,
        display_ordinal: 2,
        display_set_number: 1,
        annotation_revision: '2',
        annotation_status: 'open',
        active_submission_id: 'submission-2',
        set_id: 'set',
        set_number: 1,
        key_points: secondRally.submission.key_points,
      },
    ]
    const reloadedSnapshot = structuredClone(snapshot)
    reloadedSnapshot.snapshot.annotation_status = 'submitted'
    const model = useAnnotationWorkstationModel({
      coachData: ref(correctionState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => reloadedSnapshot),
      confirmedAnnotation: shallowRef(reloadedSnapshot),
      state: computed(() => 'SUBMITTED' as const),
      selectedRallyId: computed(() => null),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>(null),
      cursorRallyId: ref(null),
    })

    expect(model.timelineSegments.value.filter(segment => segment.analysis)).toEqual([])
    expect(model.timelineSegments.value.filter(segment => segment.status === 'draft')).toHaveLength(
      2,
    )
  })

  it('hides a superseded analysis rail and removes its immutable points from a new correction rally', () => {
    const correctionState = structuredClone(coachState)
    correctionState.match.drafts = [
      {
        id: 'correction-rally',
        ordinal: 1,
        display_ordinal: 1,
        display_set_number: 1,
        annotation_revision: '1',
        annotation_status: 'open',
        active_submission_id: 'submission',
        set_id: 'set',
        set_number: 1,
        key_points: correctionState.match.rallies[0]!.submission.key_points,
      },
    ]
    const correctionSnapshot = structuredClone(snapshot)
    correctionSnapshot.rally_id = 'correction-rally'
    correctionSnapshot.snapshot.annotation_status = 'open'
    const model = useAnnotationWorkstationModel({
      coachData: ref(correctionState),
      match: ref<Match | null>(null),
      timeline: computed<CaptureTimeline | null>(() => null),
      displayAnnotation: computed(() => correctionSnapshot),
      confirmedAnnotation: shallowRef(correctionSnapshot),
      state: computed(() => 'OPEN' as const),
      selectedRallyId: computed(() => 'correction-rally'),
      selectedKeyPoint: computed<AnnotationKeyPoint | null>(() => null),
      selectedTimelineItem: ref<TimelineSelectionItem>('mask'),
      cursorRallyId: ref('correction-rally'),
    })

    expect(model.timelineSegments.value).toContainEqual(
      expect.objectContaining({
        id: 'rally',
        points: [],
        analysis: null,
      }),
    )
  })
})
