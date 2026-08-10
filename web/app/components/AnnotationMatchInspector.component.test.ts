import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnnotationMatchInspector from './AnnotationMatchInspector.vue'

const teams = [
  { id: 'left', name: 'Chinese Taipei', shortName: 'TPE' },
  { id: 'right', name: 'Puerto Rico', shortName: 'PUR' },
]

describe('AnnotationMatchInspector outcomes', () => {
  it('shows resolved and explicitly unknown outcomes in the segment list', () => {
    const wrapper = mount(AnnotationMatchInspector, {
      global: {
        stubs: {
          UiAnimatedModal: true,
          AnnotationIdentityPanel: true,
          UiButton: { template: '<button><slot /></button>' },
          UiScrollArea: { template: '<div><slot /></div>' },
          UiTooltip: { template: '<span><slot /></span>' },
        },
      },
      props: {
        analysisAvailable: false,
        analysisRunId: null,
        canStartNextSet: false,
        currentFrame: -1,
        drafts: [{
          id: 'draft', ordinal: 2, display_ordinal: 2, display_set_number: 1,
          annotation_revision: '2', annotation_status: 'ready', active_submission_id: null,
          score_resolution: 'unknown', scoring_court_side: null, scoring_team_id: null,
          set_id: 'set', set_number: 1,
          key_points: [{ id: 'draft-point', sequence_index: 0, marker_kind: 'service', is_terminal: true, capture_time_us: '2', capture_frame_index: '2' }],
        }],
        formatRallyDuration: () => '1.0 秒',
        leftScore: 1,
        leftSetWins: 0,
        leftTeam: teams[0]!,
        leftTeamId: 'left',
        mappingAvailable: false,
        mappingCompleted: false,
        matchId: 'match',
        rallies: [{
          id: 'rally', ordinal: 1, display_ordinal: 1, display_set_number: 1,
          annotation_revision: '1', processing_status: 'completed', scoring_court_side: 'left', scoring_team_id: 'left',
          set_id: 'set', set_number: 1, left_score_after: 1, right_score_after: 0, winner_side: 'left',
          submission: {
            id: 'submission', supersedes_submission_id: null, submitted_at: '', score_resolution: 'resolved', scoring_court_side: 'left', scoring_team_id: 'left', contact_count: 0,
            key_points: [], clip: null, processing: {} as never, analysis: null,
          },
        }],
        rallyOrdinal: 2,
        rightScore: 0,
        rightSetWins: 0,
        rightTeam: teams[1]!,
        rightTeamId: 'right',
        selectedRallyId: null,
        setNumber: 1,
        setNumbers: [1],
        tab: 'match',
        teams,
      },
    })

    expect(wrapper.findAll('.outcome-badge').map(badge => badge.text())).toEqual(['TPE 得分', '得分未知'])
    expect(wrapper.get('.outcome-badge.unknown').text()).toBe('得分未知')
  })
})
