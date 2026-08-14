import { flushPromises, mount } from '@vue/test-utils'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachMatchAnalytics } from '~/lib/coachDomain'
import IdentityReplacementDialog from './IdentityReplacementDialog.vue'
import UiPlayerCombobox from './ui/PlayerCombobox.vue'

const coachClient = vi.hoisted(() => ({
  analytics: vi.fn(),
  assignTrackIdentity: vi.fn(),
  clearTrackIdentity: vi.fn(),
  applyReidAutomaticAssignments: vi.fn(),
  setTrackIdentityMappingComplete: vi.fn(),
}))

vi.mock('~/lib/coachDomain', () => ({
  createCoachDomainClient: () => coachClient,
}))

vi.mock('~/lib/coreDomain', () => ({
  createGraphQLTransport: () => ({}),
}))

const replacementWarningEnabled = ref(true)
let AnnotationIdentityPanel: typeof import('./AnnotationIdentityPanel.vue')['default']

const teams = [
  { id: 'team-left', name: 'Blue Waves', shortName: 'BLU' },
  { id: 'team-right', name: 'Red Sparks', shortName: 'RED' },
]

function analyticsFixture(): CoachMatchAnalytics {
  const players = Array.from({ length: 8 }, (_, index) => ({
    roster_entry_id: `roster-${index + 1}`,
    team_id: 'team-left',
    jersey_number: String(index + 11),
    position: index === 7 ? 'DS' as const : 'OH' as const,
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
        reid_model: { name: 'nested-part-adaptation', checkpoint_sha256: 'a'.repeat(64), preprocess_version: 'nested-part-adaptation-v1' },
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
        reid_model: { name: 'nested-part-adaptation', checkpoint_sha256: 'a'.repeat(64), preprocess_version: 'nested-part-adaptation-v1' },
      },
    ],
    unassigned_tracks: [{ analysis_run_id: 'analysis-1', track_id: 2, rally_id: 'rally-1', set_number: 1, rally_ordinal: 1 }],
  }
}

function mountPanel() {
  return mount(AnnotationIdentityPanel, {
    props: {
      matchId: 'match-1',
      analysisRunId: 'analysis-1',
      leftTeamId: 'team-left',
      rightTeamId: 'team-right',
      teams,
      mappingCompleted: false,
      currentFrame: 60,
    },
  })
}

beforeAll(async () => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('shallowRef', shallowRef)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('onMounted', onMounted)
  vi.stubGlobal('useState', () => replacementWarningEnabled)
  vi.stubGlobal('useIdentityReplacementWarning', () => ({ enabled: replacementWarningEnabled }))
  AnnotationIdentityPanel = (await import('./AnnotationIdentityPanel.vue')).default
})

beforeEach(() => {
  vi.clearAllMocks()
  replacementWarningEnabled.value = true
  coachClient.analytics.mockResolvedValue(analyticsFixture())
  coachClient.assignTrackIdentity.mockResolvedValue({ assignTrackIdentity: { schema_version: '1.0.0' } })
  coachClient.applyReidAutomaticAssignments.mockResolvedValue({
    applyReidAutomaticAssignments: {
      schema_version: '1.0.0', match_id: 'match-1', analysis_run_id: 'analysis-1',
      assigned_count: 1, already_assigned_count: 1, preserved_manual_count: 0, unresolved_count: 0,
    },
  })
})

describe('AnnotationIdentityPanel ReID assignments', () => {
  it('shows GID confidence and the complete team roster, including bench players', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('沿用先前確認')
    expect(wrapper.text()).toContain('T001')
    expect(wrapper.text()).toContain('L1')
    expect(wrapper.text()).toContain('91%')

    const unassigned = wrapper.findAllComponents(UiPlayerCombobox)[1]!
    const options = unassigned.props('options')
    expect(options).toHaveLength(9)
    expect(options.map(option => option.label)).toContain('#18 Bench Player')
    expect(unassigned.props('modelValue')).toBe('')

    wrapper.unmount()
  })

  it.each([
    ['依 GID 從這段起改正', 'from_here'],
    ['這其實是不同的人', 'split_identity'],
    ['只修正這個 Local ID', 'clip_only'],
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
    expect(wrapper.emitted('changed')).toHaveLength(1)

    wrapper.unmount()
  })

  it('uses the product dialog instead of a browser confirm when replacing an occupied player', async () => {
    const browserConfirm = vi.spyOn(window, 'confirm')
    const wrapper = mountPanel()
    await flushPromises()

    wrapper.findAllComponents(UiPlayerCombobox)[1]!.vm.$emit('update:modelValue', 'roster-1')
    await flushPromises()

    const dialog = wrapper.getComponent(IdentityReplacementDialog)
    expect(dialog.props()).toMatchObject({ playerName: 'Player 1', occupiedTrackId: 1, targetTrackId: 2 })
    expect(browserConfirm).not.toHaveBeenCalled()
    dialog.vm.$emit('confirm')
    await flushPromises()

    expect(coachClient.assignTrackIdentity).toHaveBeenCalledWith({
      analysisRunId: 'analysis-1',
      trackId: 2,
      rosterEntryId: 'roster-1',
      identityMode: 'from_here',
    })
    browserConfirm.mockRestore()
    wrapper.unmount()
  })

  it('switches between Local and GID views without changing the local assignment payload', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map(tab => tab.text())).toEqual(expect.arrayContaining(['Local 分派2', 'GID 分派2']))
    await tabs.find(tab => tab.text().includes('GID 分派'))!.trigger('click')

    expect(wrapper.text()).toContain('一個 GID 可包含多個 Local ID')
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

  it('manually reapplies prior GID bindings to local assignments', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.get('.identity-auto').trigger('click')
    await flushPromises()

    expect(coachClient.applyReidAutomaticAssignments).toHaveBeenCalledWith({ analysisRunId: 'analysis-1' })
    expect(wrapper.text()).toContain('已自動套用 1 個 Local ID')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    wrapper.unmount()
  })
})
