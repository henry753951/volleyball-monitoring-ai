import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnnotationMatchInspector from './AnnotationMatchInspector.vue'

const teams = [
  { id: 'left', name: 'Chinese Taipei', shortName: 'TPE' },
  { id: 'right', name: 'Puerto Rico', shortName: 'PUR' },
]

describe('AnnotationMatchInspector outcomes', () => {
  it('shows resolved and explicitly unknown outcomes in the segment list', async () => {
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
        canSwapSides: true,
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
            id: 'submission', supersedes_submission_id: null, submitted_at: '', score_resolution: 'resolved', scoring_court_side: 'left', scoring_team_id: 'left',
            side_assignment_id: 'assignment', side_assignment_reversed: false, left_team_id: 'left', right_team_id: 'right', contact_count: 0,
            key_points: [], clip: null, processing: {} as never,
            analysis: {
              id: 'analysis', status: 'completed', version: 'v1', summary: null,
              identity_mapping_completed: false, coverage_start_capture_time_us: null,
              coverage_end_capture_time_us: null, byte_length: '0', track_count: 0,
              ball_path_count: 0, contact_count: 0, capabilities: [],
            },
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

    await wrapper.get('button[aria-label="修正此片段的左右隊伍"]').trigger('click')
    expect(wrapper.emitted('swapRallySides')?.[0]?.[0]).toMatchObject({ id: 'rally' })
    const liveSwap = wrapper.findAll('button').find(button => button.text().includes('交換場地'))
    expect(liveSwap).toBeTruthy()
    await liveSwap!.trigger('click')
    expect(wrapper.emitted('swapSides')).toHaveLength(1)
  })
})
