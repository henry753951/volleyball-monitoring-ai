import type { AnnotationKeyPoint, AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { computed, ref, shallowRef } from 'vue'
import { describe, expect, it } from 'vitest'
import type { CoachMatchState } from '~/lib/coachDomain'
import type { CaptureTimeline, Match } from '~/lib/coreDomain'
import type { TimelineSelectionItem } from '~/utils/timelineSelection'
import { useAnnotationWorkstationModel } from './useAnnotationWorkstationModel'

const snapshot: AnnotationRallySnapshot = {
  schema_version: '2.0.0', type: 'rally_snapshot', room_id: 'room', rally_id: 'rally', revision: '3', server_sequence: '3',
  snapshot: {
    annotation_status: 'submitted', active_submission_id: 'submission', side_assignment_id: 'assignment',
    score_resolution: 'resolved', scoring_court_side: 'left', processing_status: 'completed',
    key_points: [
      { key_point_id: 'service', sequence_index: 0, marker_kind: 'service', is_terminal: false, capture_time_us: '1000000', capture_frame_index: '30', timing_precision: 'frame_exact', possible_duplicate: false },
      { key_point_id: 'terminal', sequence_index: 1, marker_kind: 'contact', is_terminal: true, capture_time_us: '2000000', capture_frame_index: '60', timing_precision: 'frame_exact', possible_duplicate: false },
    ],
  },
}

const coachState = {
  schema_version: '1.0.0',
  match: {
    id: 'match', title: 'Match', status: 'live', clip_pre_roll_us: '0', clip_post_roll_us: '0', captures: [], drafts: [], sets: [],
    teams: [{ id: 'left', name: 'Left', shortName: 'L' }, { id: 'right', name: 'Right', shortName: 'R' }],
    rallies: [{
      id: 'rally', ordinal: 1, display_ordinal: 1, display_set_number: 1, annotation_revision: '3', processing_status: 'completed',
      scoring_court_side: 'left', scoring_team_id: 'left', set_id: 'set', set_number: 1, left_score_after: 1, right_score_after: 0, winner_side: 'left',
      submission: {
        id: 'submission', supersedes_submission_id: null, submitted_at: '2026-08-10T00:00:00.000Z', score_resolution: 'resolved', scoring_court_side: 'left', scoring_team_id: 'left', contact_count: 1,
        key_points: [
          { id: 'service', sequence_index: 0, marker_kind: 'service', is_terminal: false, capture_time_us: '1000000', capture_frame_index: '30' },
          { id: 'terminal', sequence_index: 1, marker_kind: 'contact', is_terminal: true, capture_time_us: '2000000', capture_frame_index: '60' },
        ],
        clip: { id: 'clip', status: 'completed', start_capture_time_us: '1000000', end_capture_time_us: '2000000', duration_us: '1000000' },
        processing: {} as never,
        analysis: {
          id: 'analysis', status: 'completed', version: 'v1', summary: {}, identity_mapping_completed: false,
          coverage_start_capture_time_us: '1100000', coverage_end_capture_time_us: '1900000', byte_length: '2048',
          track_count: 12, ball_path_count: 1, contact_count: 1, capabilities: ['player_tracking', 'ball_tracking'],
        },
      },
    }],
  },
} as CoachMatchState

describe('useAnnotationWorkstationModel timeline layers', () => {
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

    expect(model.timelineSegments.value).toMatchObject([{
      id: 'rally',
      analysis: { startCaptureTimeUs: '1100000', endCaptureTimeUs: '1900000', byteLength: '2048' },
    }])
  })

  it('keeps a failed submitted correction cancellable', () => {
    const failedCorrectionState = structuredClone(coachState)
    failedCorrectionState.match.rallies[0]!.processing_status = 'failed'
    failedCorrectionState.match.rallies[0]!.submission.supersedes_submission_id = 'previous-submission'
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
    correctionState.match.drafts = [{
      id: 'rally', ordinal: 1, display_ordinal: 1, display_set_number: 1,
      annotation_revision: '4', annotation_status: 'open', active_submission_id: 'submission',
      set_id: 'set', set_number: 1,
      key_points: correctionState.match.rallies[0]!.submission.key_points,
    }]
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
    expect(model.correctionActive.value).toBe(true)
    expect(model.correctionRallyId.value).toBe('rally')
  })
})
