import { computed } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { annotationWorkstationServiceKey } from '~/services/annotation-workstation/annotation-workstation.service'
import type { WorkstationActionId } from '~/services/annotation-workstation/workstation-action.service'
import AnnotationCommandStrip from './AnnotationCommandStrip.vue'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const bindings = {
  service: 'Z',
  contact: 'X',
  spike: 'C',
  receive_success: 'V',
  receive_error: 'B',
  close_left: '<',
  close_right: '>',
  close_unknown: '?',
  submit: 'Enter',
}

function mountStrip(
  options: {
    disabled?: Partial<Record<WorkstationActionId, string>>
    props?: Record<string, unknown>
  } = {},
) {
  const execute = vi.fn().mockResolvedValue({ status: 'executed', value: undefined })
  const service = {
    actions: {
      execute,
      state: (id: WorkstationActionId) =>
        computed(() => ({
          id,
          group: 'marking',
          label: id,
          shortcut: null,
          visible: true,
          enabled: !options.disabled?.[id],
          pending: false,
          reason: options.disabled?.[id] ?? null,
        })),
    },
  }
  const wrapper = mount(AnnotationCommandStrip, {
    props: { bindings, ...options.props },
    global: {
      provide: { [annotationWorkstationServiceKey as symbol]: service },
      stubs: {
        UiKbd: { template: '<kbd><slot /></kbd>' },
        UiPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
      },
    },
  })
  return { wrapper, execute }
}

describe('AnnotationCommandStrip', () => {
  it('renders Z, X/C/V/B, rally outcomes and settings without a visible Enter action', () => {
    const { wrapper } = mountStrip()
    expect(wrapper.findAll('button')).toHaveLength(9)
    expect(wrapper.text()).toContain('X')
    expect(wrapper.find('.command-contact').text()).toContain('HIT')
    expect(wrapper.text()).toContain('C')
    expect(wrapper.text()).toContain('V')
    expect(wrapper.text()).toContain('B')
    expect(wrapper.text()).not.toContain('Enter')
  })

  it('uses the central action state as the only disabled decision', () => {
    const { wrapper } = mountStrip({
      disabled: {
        'mark.contact': '游標尚未確認',
        'outcome.left': '目前沒有可設定結果的片段',
      },
    })
    expect(wrapper.find('.command-contact').attributes('title')).toBe('游標尚未確認')
    expect(wrapper.find('.command-close_left').attributes('title')).toBe('目前沒有可設定結果的片段')
    expect((wrapper.find('.command-contact').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('.command-close_right').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('changes the Z label from start to end for an open boundary draft', () => {
    const { wrapper } = mountStrip({ props: { serviceMode: 'end' } })
    expect(wrapper.findAll('button')[0]?.text()).toContain('結束片段')
    expect(wrapper.findAll('button')[0]?.attributes('title')).toBe('結束片段')
  })

  it('names the teams currently occupying each court side', () => {
    const { wrapper } = mountStrip({
      props: { leftTeamLabel: 'TPE', rightTeamLabel: 'ITA' },
    })
    expect(wrapper.find('.command-close_left').text()).toContain('左側 TPE 得分')
    expect(wrapper.find('.command-close_right').text()).toContain('右側 ITA 得分')
  })

  it('dispatches annotation commands through the injected service', async () => {
    const { wrapper, execute } = mountStrip()
    await wrapper.find('.command-contact').trigger('click')
    expect(execute).toHaveBeenCalledWith('mark.contact')
  })

  it('keeps selected-point result and actor controls out of the fixed command strip', () => {
    const { wrapper } = mountStrip()
    expect(wrapper.text()).not.toContain('未指定球員')
    expect(wrapper.find('.selected-point-editor').exists()).toBe(false)
  })
})
