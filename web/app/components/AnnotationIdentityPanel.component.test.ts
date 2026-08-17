import { flushPromises, mount } from '@vue/test-utils'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachMatchAnalytics } from '~/lib/coachDomain'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import { createIdentityAssignmentControllerService } from '~/services/annotation-workstation/identity-assignment-controller.service'
import { createWorkstationActionManager } from '~/services/annotation-workstation/workstation-action.service'
import UiPlayerCombobox from './ui/PlayerCombobox.vue'

const coachClient = vi.hoisted(() => ({
  analytics: vi.fn(),
  assignTrackIdentity: vi.fn(),
  clearTrackIdentity: vi.fn(),
  applyReidAutomaticAssignments: vi.fn(),
  requestReidFeatureRebuild: vi.fn(),
  reidFeatureRebuildRequest: vi.fn(),
  requestReidAssociationRerun: vi.fn(),
  reidAssociationRerunRequest: vi.fn(),
}))

vi.mock('~/lib/coachDomain', () => ({
  createCoachDomainClient: () => coachClient,
}))

vi.mock('~/lib/coreDomain', () => ({
  createGraphQLTransport: () => ({}),
}))

let AnnotationIdentityPanel: (typeof import('./AnnotationIdentityPanel.vue'))['default']

const teams = [
  { id: 'team-left', name: 'Blue Waves', shortName: 'BLU' },
  { id: 'team-right', name: 'Red Sparks', shortName: 'RED' },
]

function analyticsFixture(): CoachMatchAnalytics {
  const players = Array.from({ length: 8 }, (_, index) => ({
    roster_entry_id: `roster-${index + 1}`,
    team_id: 'team-left',
    jersey_number: String(index + 11),
    position: index === 7 ? ('DS' as const) : ('OH' as const),
    name: index === 7 ? 'Bench Player' : `Player ${index + 1}`,
    contact_count: 0,
    sample_count: 0,
    rally_count: 0,
    action_counts: {},
    heatmap_samples: [],
    error_count: null,
  }))

  return {
    schema_version: '1.0.0',
    match: { id: 'match-1', title: 'Identity test' },
    feature_availability: { identity: true, action: false, court_positions: true },
    metrics: {},
    teams: teams.map(team => ({ ...team, wins: 0, losses: 0, unknown: 0, sample_count: 0 })),
    sets: [],
    rallies: [],
    players,
    tracks: [
      {
        analysis_run_id: 'analysis-1',
        track_id: 1,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 1,
        court_side: 'left',
        first_frame_index: '0',
        last_frame_index: '120',
        observed_frame_ranges: [{ start: '0', end: '120' }],
        roster_entry_id: 'roster-1',
        identity_mapping_completed: false,
        gid_id: '2d9a44cc-21f2-4c02-a172-c4ca8aa00001',
        gid_team_id: 'team-left',
        gid_slot_index: 1,
        gid_label: 'L1',
        identity_source: 'propagated',
        identity_confidence: 0.91,
        identity_revision: '4',
        manual_required: false,
        reid_model: {
          name: 'nested-part-adaptation',
          checkpoint_sha256: 'a'.repeat(64),
          preprocess_version: 'nested-part-adaptation-v1',
        },
      },
      {
        analysis_run_id: 'analysis-1',
        track_id: 2,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 1,
        court_side: 'left',
        first_frame_index: '0',
        last_frame_index: '120',
        observed_frame_ranges: [{ start: '0', end: '120' }],
        roster_entry_id: null,
        identity_mapping_completed: false,
        gid_id: '2d9a44cc-21f2-4c02-a172-c4ca8aa00002',
        gid_team_id: 'team-left',
        gid_slot_index: 2,
        gid_label: 'L2',
        identity_source: 'ai',
        identity_confidence: 0.73,
        identity_revision: '4',
        manual_required: true,
        reid_model: {
          name: 'nested-part-adaptation',
          checkpoint_sha256: 'a'.repeat(64),
          preprocess_version: 'nested-part-adaptation-v1',
        },
      },
    ],
    unassigned_tracks: [
      {
        analysis_run_id: 'analysis-1',
        track_id: 2,
        rally_id: 'rally-1',
        set_number: 1,
        rally_ordinal: 1,
      },
    ],
  }
}

function mountPanel() {
  const manager = createWorkstationActionManager()
  const assignment = createIdentityAssignmentControllerService(
    {
      matchId: 'match-1',
      analysisRunId: 'analysis-1',
      currentFrame: 60,
      refreshAfterCommit: true,
    },
    coachClient as never,
    manager,
  )
  return mount(AnnotationIdentityPanel, {
    props: {
      matchId: 'match-1',
      analysisRunId: 'analysis-1',
      leftTeamId: 'team-left',
      rightTeamId: 'team-right',
      teams,
    },
    global: {
      provide: {
        [annotationWorkstationServiceKey as symbol]: { identity: assignment, actions: manager },
      },
    },
  })
}

beforeAll(async () => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('shallowRef', shallowRef)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('onMounted', onMounted)
  AnnotationIdentityPanel = (await import('./AnnotationIdentityPanel.vue')).default
})

beforeEach(() => {
  vi.clearAllMocks()
  coachClient.analytics.mockResolvedValue(analyticsFixture())
  coachClient.assignTrackIdentity.mockResolvedValue({
    assignTrackIdentity: { schema_version: '1.0.0' },
  })
  coachClient.applyReidAutomaticAssignments.mockResolvedValue({
    applyReidAutomaticAssignments: {
      schema_version: '1.0.0',
      match_id: 'match-1',
      analysis_run_id: 'analysis-1',
      assigned_count: 1,
      already_assigned_count: 1,
      preserved_manual_count: 0,
      unresolved_count: 0,
    },
  })
  coachClient.requestReidFeatureRebuild.mockResolvedValue({
    request_id: 'feature-request',
    status: 'QUEUED',
  })
  coachClient.reidFeatureRebuildRequest.mockResolvedValue({
    request_id: 'feature-request',
    status: 'COMPLETED',
  })
  coachClient.requestReidAssociationRerun.mockResolvedValue({
    request_id: 'association-request',
    status: 'QUEUED',
  })
  coachClient.reidAssociationRerunRequest.mockResolvedValue({
    request_id: 'association-request',
    status: 'COMPLETED',
  })
})

describe('AnnotationIdentityPanel ReID assignments', () => {
  it('keeps feature rebuild and association rerun as separate actions', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper
      .findAll('button')
      .find(button => button.text().includes('用現有資料再配對'))!
      .trigger('click')
    await flushPromises()
    expect(coachClient.requestReidAssociationRerun).toHaveBeenCalledWith(
      expect.objectContaining({ analysisRunId: 'analysis-1' }),
    )
    expect(coachClient.reidAssociationRerunRequest).toHaveBeenCalledWith('association-request')
    expect(wrapper.text()).toContain('球員重新配對完成')

    await wrapper
      .findAll('button')
      .find(button => button.text().includes('重新分析外觀再配對'))!
      .trigger('click')
    await flushPromises()
    expect(coachClient.requestReidFeatureRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ analysisRunId: 'analysis-1' }),
    )
    expect(wrapper.text()).toContain('球員外觀資料已更新')
    expect(wrapper.text()).toContain('不會覆蓋人工指派')
    expect(wrapper.text()).toContain('速度較快')
    expect(wrapper.text()).toContain('耗時較久')
    wrapper.unmount()
  })

  it('stops the foreground spinner when a background ReID request stays queued', async () => {
    vi.useFakeTimers()
    coachClient.reidAssociationRerunRequest.mockResolvedValue({
      request_id: 'association-request',
      status: 'QUEUED',
    })
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper
      .findAll('button')
      .find(button => button.text().includes('用現有資料再配對'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('.identity-auto .spin').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(30_001)
    await flushPromises()

    expect(wrapper.text()).toContain('已停止等待，不會一直佔用畫面')
    expect(wrapper.find('.identity-auto .spin').exists()).toBe(false)
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('shows GID confidence and the complete team roster, including bench players', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('沿用先前確認')
    expect(wrapper.text()).toContain('T001')
    expect(wrapper.text()).toContain('GID 2D9A44CC')
    expect(wrapper.text()).toContain('91%')

    const unassigned = wrapper.findAllComponents(UiPlayerCombobox)[1]!
    const options = unassigned.props('options')
    expect(options).toHaveLength(9)
    expect(options.map(option => option.label)).toContain('#18 Bench Player')
    expect(options.find(option => option.label === '#18 Bench Player')).toMatchObject({
      jerseyNumber: '18',
      playerName: 'Bench Player',
      position: 'DS',
    })
    expect(unassigned.props('modelValue')).toBe('')

    wrapper.unmount()
  })

  it('navigates from the Local row but does not navigate when the player selector is clicked', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.get('.identity-row').trigger('click')
    expect(wrapper.emitted('select-track')).toEqual([
      [{ trackId: 1, rallyId: 'rally-1', firstFrameIndex: '0' }],
    ])
    expect(wrapper.get('.identity-row').classes()).not.toContain('focused')

    await wrapper.get('.identity-select').trigger('click')
    expect(wrapper.emitted('select-track')).toHaveLength(1)
    wrapper.unmount()
  })

  it.each([
    ['只重綁目前 GID', 'from_here'],
    ['只有這個 Local ID 的 GID 判錯', 'split_identity'],
    ['只改這個 Local 的顯示', 'clip_only'],
  ] as const)('sends %s corrections with identityMode=%s', async (buttonLabel, identityMode) => {
    const wrapper = mountPanel()
    await flushPromises()

    wrapper.findAllComponents(UiPlayerCombobox)[0]!.vm.$emit('update:modelValue', 'roster-2')
    await flushPromises()
    const correction = wrapper.get('[aria-label="選擇球員修正方式"]')
    const action = correction.findAll('button').find(button => button.text().includes(buttonLabel))
    expect(action).toBeTruthy()

    await action!.trigger('click')
    await flushPromises()

    expect(coachClient.assignTrackIdentity).toHaveBeenCalledWith({
      analysisRunId: 'analysis-1',
      trackId: 1,
      rosterEntryId: 'roster-2',
      identityMode,
    })

    wrapper.unmount()
  })

  it('switches between Local and GID views without changing the local assignment payload', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map(tab => tab.text())).toEqual(
      expect.arrayContaining(['Local 分派2', '人員群組2']),
    )
    await tabs.find(tab => tab.text().includes('人員群組'))!.trigger('click')

    expect(wrapper.text()).toContain('群組代表跨片段的追蹤關聯')
    const gidCombobox = wrapper.findAllComponents(UiPlayerCombobox)[1]!
    gidCombobox.vm.$emit('update:modelValue', 'roster-2')
    await flushPromises()

    expect(coachClient.assignTrackIdentity).toHaveBeenCalledWith({
      analysisRunId: 'analysis-1',
      trackId: 2,
      rosterEntryId: 'roster-2',
      identityMode: 'from_here',
    })
    wrapper.unmount()
  })

  it('creates and confirms a forward GID binding for a Local ID without ReID evidence', async () => {
    const fixture = analyticsFixture()
    fixture.tracks[1] = {
      ...fixture.tracks[1]!,
      gid_id: null,
      gid_team_id: null,
      gid_slot_index: null,
      gid_label: null,
      reid_model: null,
    }
    coachClient.analytics.mockResolvedValue(fixture)
    const wrapper = mountPanel()
    await flushPromises()

    wrapper.findAllComponents(UiPlayerCombobox)[1]!.vm.$emit('update:modelValue', 'roster-2')
    await flushPromises()

    expect(coachClient.assignTrackIdentity).toHaveBeenCalledWith({
      analysisRunId: 'analysis-1',
      trackId: 2,
      rosterEntryId: 'roster-2',
      identityMode: 'from_here',
    })
    wrapper.unmount()
  })
})
