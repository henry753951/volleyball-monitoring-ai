import { computed } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import type { WorkstationActionId } from '~/services/annotation-workstation/workstation-action.service'
import AnnotationSelectedKeyPointEditor from './AnnotationSelectedKeyPointEditor.vue'

function mountEditor() {
  const execute = vi.fn().mockResolvedValue({ status: 'executed', value: undefined })
  const wrapper = mount(AnnotationSelectedKeyPointEditor, {
    props: {
      selectedBallEvent: { kind: 'SPIKE', result: 'SUCCESS' },
      selectedActorId: null,
      actorOptions: [{ id: 'roster-11', label: 'TPE · #11 王一' }],
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
      },
    },
  })
  return { wrapper, execute }
}

describe('AnnotationSelectedKeyPointEditor', () => {
  it('uses the selected event tone and edits its result without creating another point', async () => {
    const { wrapper, execute } = mountEditor()
    expect(wrapper.get('.selected-point-editor').attributes('style')).toContain('#f06f8f')
    const failure = wrapper.findAll('button').find(button => button.text().includes('失敗'))
    expect(failure).toBeDefined()
    await failure!.trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.set-event', {
      kind: 'SPIKE',
      result: 'FAILURE',
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
})
