import { computed } from 'vue'
import type { BallEventValue } from '@volleyball-monitoring/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import type { WorkstationActionId } from '~/services/annotation-workstation/workstation-action.service'
import AnnotationSelectedKeyPointEditor from './AnnotationSelectedKeyPointEditor.vue'

type TestActorOption = {
  id: string
  label: string
  teamId?: string
  teamLabel?: string
  jerseyNumber?: string
  playerName?: string
  position?: 'UNSPECIFIED' | 'OH' | 'MB' | 'OPP' | 'S' | 'L' | 'DS'
}

function mountEditor(
  selectedBallEvent: BallEventValue = { kind: 'SPIKE', result: 'SUCCESS' },
  selectedOrdinal = 3,
  actorOptions: ReadonlyArray<TestActorOption> = [{ id: 'roster-11', label: 'TPE · #11 王一' }],
) {
  const execute = vi.fn().mockResolvedValue({ status: 'executed', value: undefined })
  const wrapper = mount(AnnotationSelectedKeyPointEditor, {
    props: {
      selectedBallEvent,
      selectedOrdinal,
      selectedActorId: null,
      actorOptions,
    },
    global: {
      provide: {
        [annotationWorkstationServiceKey as symbol]: {
          actions: {
            execute,
            state: (id: WorkstationActionId) =>
              computed(() => ({
                id,
                group: 'marking',
                label: id,
                shortcut: null,
                visible: true,
                enabled: true,
                pending: false,
                reason: null,
              })),
          },
        },
      },
      stubs: {
        UiPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
        UiKbd: { template: '<kbd><slot /></kbd>' },
      },
    },
  })
  return { wrapper, execute }
}

describe('AnnotationSelectedKeyPointEditor', () => {
  it('uses the selected event tone and edits its result without creating another point', async () => {
    const { wrapper, execute } = mountEditor()
    expect(wrapper.get('.selected-point-editor').attributes('data-annotation-hotkey-surface')).toBe(
      'workstation',
    )
    expect(wrapper.get('.selected-point-editor').attributes('style')).toContain('#f06f8f')
    const failure = wrapper.findAll('button').find(button => button.text().includes('失敗'))
    expect(failure).toBeDefined()
    await failure!.trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.set-event', {
      kind: 'SPIKE',
      result: 'FAILURE',
      serve_style: null,
    })
    expect(execute).not.toHaveBeenCalledWith('mark.contact')
  })

  it('assigns the selected point actor through the workstation action manager', async () => {
    const { wrapper, execute } = mountEditor()
    const player = wrapper.findAll('button').find(button => button.text().includes('#11 王一'))
    expect(player).toBeDefined()
    await player!.trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.set-actor', 'roster-11')
  })

  it('shows team tabs, a scroll area, jersey order, and position badges', async () => {
    const { wrapper } = mountEditor(undefined, 3, [
      {
        id: 'iri-10',
        label: 'IRI · #10 A',
        teamId: 'team-iri',
        teamLabel: 'IRI',
        jerseyNumber: '10',
        playerName: 'A',
        position: 'OH',
      },
      {
        id: 'iri-2',
        label: 'IRI · #2 B',
        teamId: 'team-iri',
        teamLabel: 'IRI',
        jerseyNumber: '2',
        playerName: 'B',
        position: 'S',
      },
      {
        id: 'pak-1',
        label: 'PAK · #1 C',
        teamId: 'team-pak',
        teamLabel: 'PAK',
        jerseyNumber: '1',
        playerName: 'C',
        position: 'L',
      },
    ])

    expect(wrapper.find('.actor-options-scroll').exists()).toBe(true)
    expect(wrapper.findAll('.ui-tabs__trigger').map(tab => tab.text())).toEqual(['IRI2', 'PAK1'])
    expect(wrapper.findAll('.actor-option').map(option => option.text())).toEqual([
      '#2BS',
      '#10AOH',
    ])
    expect(wrapper.findAll('.actor-option__position-badge').map(badge => badge.text())).toEqual([
      'S',
      'OH',
    ])
  })

  it('toggles the selected result off instead of forcing a value', async () => {
    const { wrapper, execute } = mountEditor()
    const success = wrapper.findAll('button').find(button => button.text().includes('成功'))
    await success!.trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.set-event', {
      kind: 'SPIKE',
      result: null,
      serve_style: null,
    })
  })

  it('shows jump/standing serve controls and persists an explicit standing serve', async () => {
    const { wrapper, execute } = mountEditor(
      { kind: 'SERVE', result: null, serve_style: 'JUMP' },
      1,
    )
    const standing = wrapper.findAll('button').find(button => button.text().includes('站發'))
    expect(standing).toBeDefined()
    await standing!.trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.set-event', {
      kind: 'SERVE',
      result: null,
      serve_style: 'STANDING',
    })
  })

  it('lets the operator pin the editor instead of following the selected point', async () => {
    const { wrapper } = mountEditor()
    await wrapper
      .findAll('button')
      .find(button => button.attributes('title') === '固定在時間軸下方')
      ?.trigger('click')

    expect(wrapper.emitted('update:positionMode')).toEqual([['pinned']])
  })
})
