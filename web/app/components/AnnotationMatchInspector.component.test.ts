import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import AnnotationMatchInspector from './AnnotationMatchInspector.vue'

const teams = [
  { id: 'left', name: 'Chinese Taipei', shortName: 'TPE' },
  { id: 'right', name: 'Puerto Rico', shortName: 'PUR' },
]

describe('AnnotationMatchInspector outcomes', () => {
  it('shows resolved and explicitly unknown outcomes in the segment list', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'executed' })
    const requestDelete = vi.fn()
    const timeline = {
      selectHistorical: vi.fn(),
      selectRally: vi.fn(),
    }
    const wrapper = mount(AnnotationMatchInspector, {
      global: {
        provide: {
          [annotationWorkstationServiceKey as symbol]: {
            actions: {
              execute,
              state: () => computed(() => ({ enabled: true, pending: false, reason: null })),
            },
            segments: {
              affectsCurrentDraft: computed(() => false),
              deletePending: ref(false),
              placementSaving: ref(false),
              requestBatchAnalysisReset: vi.fn(),
              requestDelete,
              sideSwapPending: ref(false),
            },
            timeline,
          },
        },
        stubs: {
          UiAnimatedModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /><slot name="footer" /></div>',
          },
          AnnotationIdentityPanel: { template: '<div />' },
          UiButton: { template: '<button><slot /></button>' },
          UiScrollArea: { template: '<div><slot /></div>' },
          UiTooltip: { template: '<span><slot /></span>' },
        },
      },
      props: {
        analysisAvailable: false,
        analysisRunId: null,
        currentFrame: -1,
        currentLeftTeam: teams[0]!,
        currentRightTeam: teams[1]!,
        contextRallyId: 'draft',
        displayedOutcomeLabel: '左側 PUR 得分',
        displayedOutcomeSide: 'left',
        displayedRallyId: 'draft',
        drafts: [
          {
            id: 'draft',
            ordinal: 2,
            display_ordinal: 99,
            display_set_number: 1,
            annotation_revision: '2',
            annotation_status: 'ready',
            active_submission_id: null,
            score_resolution: 'unknown',
            scoring_court_side: null,
            scoring_team_id: null,
            side_assignment_id: 'assignment-swapped',
            left_team_id: 'right',
            right_team_id: 'left',
            set_id: 'set',
            set_number: 1,
            boundaries: [{ kind: 'start', capture_time_us: '2000000', capture_frame_index: '120' }],
            key_points: [
              {
                id: 'draft-point',
                sequence_index: 0,
                marker_kind: 'service',
                is_terminal: true,
                capture_time_us: '2',
                capture_frame_index: '2',
              },
            ],
          },
        ],
        formatRallyDuration: () => '1.0 秒',
        leftSetWins: 0,
        leftTeam: teams[0]!,
        leftTeamId: 'left',
        mappingAvailable: false,
        matchId: 'match',
        rallies: [
          {
            id: 'rally',
            ordinal: 1,
            display_ordinal: 1,
            display_set_number: 1,
            annotation_revision: '1',
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
              submitted_at: '',
              score_resolution: 'resolved',
              scoring_court_side: 'left',
              scoring_team_id: 'left',
              side_assignment_id: 'assignment',
              side_assignment_reversed: false,
              left_team_id: 'left',
              right_team_id: 'right',
              contact_count: 0,
              boundaries: [
                { kind: 'start', capture_time_us: '1000000', capture_frame_index: '60' },
              ],
              key_points: [],
              clip: null,
              processing: {} as never,
              analysis: {
                id: 'analysis',
                status: 'completed',
                version: 'v1',
                summary: null,
                identity_mapping_completed: false,
                coverage_start_capture_time_us: null,
                coverage_end_capture_time_us: null,
                byte_length: '0',
                track_count: 0,
                ball_path_count: 0,
                contact_count: 0,
                capabilities: [],
              },
            },
          },
        ],
        rallyOrdinal: 2,
        rightSetWins: 0,
        rightTeam: teams[1]!,
        rightTeamId: 'right',
        selectedRallyId: 'draft',
        setNumber: 1,
        setResults: [{ id: 'set', set_number: 1, winning_team_id: 'right' }],
        setNumbers: [1],
        tab: 'match',
        teams,
      },
    })

    expect(wrapper.findAll('.outcome-badge').map(badge => badge.text())).toEqual([
      '左側 TPE 得分',
      '左側 PUR 得分',
    ])
    expect(wrapper.find('.outcome-badge.unknown').exists()).toBe(false)
    expect(wrapper.findAll('.score-at-rally').map(score => score.text())).toEqual([
      '1 : 0',
      '1 : 1',
    ])
    expect(wrapper.get('.set-divider b').text()).toBe('1 : 1')
    expect(wrapper.get('.score-board').text().replace(/\s+/g, '')).toContain('1:1')
    expect(wrapper.get('.set-result-marker').text()).toContain('第 1 局 · PUR 勝')
    const removeSetWinner = wrapper.get('.set-result-marker__remove')
    expect(removeSetWinner.attributes('aria-label')).toBe('刪除第 1 局勝局標記')
    await removeSetWinner.trigger('click')
    expect(execute).toHaveBeenCalledWith('segment.reopen-last-set')
    await wrapper.get('.row-action-danger').trigger('click')
    expect(requestDelete).toHaveBeenCalledWith('draft', null)
    await wrapper.setProps({
      setResults: [{ id: 'set', set_number: 1, winning_team_id: 'right', status: 'live' }],
    })
    expect(wrapper.find('.set-result-marker').exists()).toBe(false)
    expect(wrapper.findAll('.segment-side-order').map(row => row.text())).toEqual([
      '左側 TPE · 右側 PUR',
      '左側 PUR · 右側 TPE',
    ])
    expect(wrapper.findAll('.side-swap-marker').map(marker => marker.text())).toEqual([
      '第 2 回合起換場左側 PUR · 右側 TPE',
    ])
    expect(wrapper.findAll('.segment-main').map(row => row.text())).toEqual([
      expect.stringContaining('回合 1'),
      expect.stringContaining('回合 2'),
    ])
    expect(wrapper.findAll('.segment-row')[0]!.classes()).not.toContain('active')
    expect(wrapper.findAll('.segment-row')[1]!.classes()).toContain('active')

    await wrapper.findAll('.segment-main')[0]!.trigger('click')
    expect(timeline.selectRally).toHaveBeenCalledWith(expect.objectContaining({ id: 'rally' }))
    await wrapper.findAll('.segment-main')[1]!.trigger('click')
    expect(timeline.selectHistorical).toHaveBeenCalledWith('draft', '2')

    await wrapper.get('button[aria-label="從此回合起對調左右隊伍"]').trigger('click')
    expect(execute).toHaveBeenCalledWith(
      'segment.swap-rally-sides',
      expect.objectContaining({ id: 'rally' }),
    )
    const liveSwap = wrapper.findAll('button').find(button => button.text().includes('對調左右'))
    expect(liveSwap).toBeTruthy()
    await liveSwap!.trigger('click')
    expect(execute).toHaveBeenCalledWith('segment.swap-current-sides')

    const placementButtons = wrapper.findAll('button[aria-label="編輯局與回合"]')
    await placementButtons[1]!.trigger('click')
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
    expect(wrapper.get('.placement-order strong').text()).toBe('第 2 回合')
    await wrapper.get('.placement-form').trigger('submit')
    expect(execute).toHaveBeenCalledWith('segment.update-placement', {
      ordinal: 2,
      rallyId: 'draft',
      setNumber: 1,
    })
  })

  it('orders merged raw sets by capture time instead of raw set number', async () => {
    const timeline = { selectHistorical: vi.fn(), selectRally: vi.fn() }
    const mountInspector = (rallies: any[]) =>
      mount(AnnotationMatchInspector, {
        global: {
          provide: {
            [annotationWorkstationServiceKey as symbol]: {
              actions: {
                execute: vi.fn(),
                state: () => computed(() => ({ enabled: true, pending: false, reason: null })),
              },
              segments: {
                affectsCurrentDraft: computed(() => false),
                deletePending: ref(false),
                placementSaving: ref(false),
                requestBatchAnalysisReset: vi.fn(),
                requestDelete: vi.fn(),
                sideSwapPending: ref(false),
              },
              timeline,
            },
          },
          stubs: {
            UiAnimatedModal: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
            AnnotationIdentityPanel: { template: '<div />' },
            UiButton: { template: '<button><slot /></button>' },
            UiScrollArea: { template: '<div><slot /></div>' },
            UiTooltip: { template: '<span><slot /></span>' },
          },
        },
        props: {
          analysisAvailable: false,
          analysisRunId: null,
          contextRallyId: null,
          currentLeftTeam: teams[0]!,
          currentRightTeam: teams[1]!,
          displayedOutcomeLabel: null,
          displayedOutcomeSide: null,
          displayedRallyId: null,
          drafts: [],
          formatRallyDuration: () => '1.0 秒',
          leftSetWins: 0,
          leftTeam: teams[0]!,
          leftTeamId: 'left',
          mappingAvailable: false,
          matchId: 'match',
          rallyOrdinal: 1,
          rallies,
          rightSetWins: 0,
          rightTeam: teams[1]!,
          rightTeamId: 'right',
          selectedRallyId: null,
          setNumber: 1,
          setNumbers: [1, 2, 3],
          setResults: [
            { id: 'set-1', set_number: 1, winning_team_id: null },
            { id: 'set-3', set_number: 3, winning_team_id: null },
          ],
          tab: 'match',
          teams,
        },
      })

    const rally = (id: string, rawSet: number, ordinal: number, time: string) => ({
      id,
      ordinal,
      display_ordinal: ordinal,
      display_set_number: rawSet,
      annotation_revision: '1',
      processing_status: 'completed',
      scoring_court_side: null,
      scoring_team_id: null,
      set_id: `set-${rawSet}`,
      set_number: rawSet,
      left_score_after: 0,
      right_score_after: 0,
      winner_side: null,
      submission: {
        id: `submission-${id}`,
        supersedes_submission_id: null,
        submitted_at: '',
        score_resolution: 'unknown',
        scoring_court_side: null,
        scoring_team_id: null,
        side_assignment_id: `assignment-${rawSet}`,
        side_assignment_reversed: false,
        left_team_id: 'left',
        right_team_id: 'right',
        contact_count: 0,
        boundaries: [{ kind: 'start', capture_time_us: time, capture_frame_index: '0' }],
        key_points: [],
        clip: null,
        processing: {} as never,
        analysis: null,
      },
    })

    const wrapper = mountInspector([
      rally('late', 1, 2, '2000'),
      rally('orphan-first', 3, 1, '1000'),
    ])

    expect(wrapper.findAll('.segment-main').map(row => row.text())).toEqual([
      expect.stringContaining('回合 1'),
      expect.stringContaining('回合 2'),
    ])
    expect(wrapper.findAll('.segment-main')[0]!.text()).toContain('回合 1')
  })
})
