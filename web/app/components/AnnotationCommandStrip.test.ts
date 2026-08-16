import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
describe('AnnotationCommandStrip', () => {
  it.each([
    [
      'IDLE+canMark',
      'IDLE',
      true,
      false,
      [true, false, false, false, false, false, false, false, true],
    ],
    [
      'OPEN+stale',
      'OPEN',
      false,
      false,
      [false, false, false, false, false, true, true, true, true],
    ],
    ['OPEN+cursor', 'OPEN', true, true, [true, true, true, true, true, true, true, true, true]],
    ['READY', 'READY', false, false, [false, false, false, false, false, true, true, true, true]],
    [
      'READY+contact',
      'READY',
      false,
      true,
      [false, false, false, false, false, true, true, true, true],
    ],
  ])('%s enables exactly the fixed commands', (_name, state, canMark, lastKeyPoint, expected) => {
    const w = mount(AnnotationCommandStrip, {
      props: {
        bindings,
        state: state as 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED',
        canMark: canMark === true,
        lastKeyPoint: lastKeyPoint === true,
      },
    })
    expect(
      w.findAll('button').map(button => !(button.element as HTMLButtonElement).disabled),
    ).toEqual(expected)
  })
  it('groups Z, X/C/V/B, rally outcomes and settings without a visible Enter action', () => {
    const w = mount(AnnotationCommandStrip, {
      props: { bindings, state: 'IDLE', canMark: false, lastKeyPoint: false },
    })
    expect(w.findAll('button')).toHaveLength(9)
    expect(w.text()).toContain('X')
    expect(w.text()).toContain('C')
    expect(w.text()).toContain('V')
    expect(w.text()).toContain('B')
    expect(w.text()).not.toContain('Enter')
  })
  it('changes the Z label from start to end for an open boundary draft', () => {
    const w = mount(AnnotationCommandStrip, {
      props: {
        bindings,
        state: 'OPEN',
        canMark: true,
        lastKeyPoint: true,
        serviceMode: 'end',
        availability: { service: { enabled: true, reason: '' } },
      },
    })
    expect(w.findAll('button')[0]?.text()).toContain('結束片段')
    expect(w.findAll('button')[0]?.attributes('title')).toBe('結束片段')
  })
  it('names the teams currently occupying each court side', () => {
    const w = mount(AnnotationCommandStrip, {
      props: {
        bindings,
        state: 'OPEN',
        canMark: true,
        lastKeyPoint: true,
        leftTeamLabel: 'TPE',
        rightTeamLabel: 'ITA',
      },
    })
    expect(w.find('.command-close_left').text()).toContain('左側 TPE 得分')
    expect(w.find('.command-close_right').text()).toContain('右側 ITA 得分')
    expect(w.find('.command-close_left').attributes('title')).toBe('左側 TPE 得分')
    expect(w.find('.command-close_right').attributes('title')).toBe('右側 ITA 得分')
  })
  it('renders formatted keys and concise disabled reasons', () => {
    const w = mount(AnnotationCommandStrip, {
      props: { bindings, state: 'IDLE', canMark: false, lastKeyPoint: false },
    })
    expect(w.findAll('button').map(button => button.attributes('title'))).toContain('游標尚未確認')
    expect(w.findAll('button').map(button => button.attributes('title'))).toContain('尚未開始片段')
    const open = mount(AnnotationCommandStrip, {
      props: { bindings, state: 'OPEN', canMark: false, lastKeyPoint: false },
    })
    expect(open.findAll('button').map(button => button.attributes('title'))).toContain(
      '游標尚未確認',
    )
    expect(open.findAll('button').map(button => button.attributes('title'))).toContain('左側得分')
  })
  it('emits enabled action only', async () => {
    const w = mount(AnnotationCommandStrip, {
      props: {
        bindings,
        state: 'OPEN',
        canMark: true,
        lastKeyPoint: true,
        availability: { close_left: { enabled: false, reason: '測試停用' } },
      },
    })
    await w.findAll('button')[1]!.trigger('click')
    expect(w.emitted('action')?.[0]).toEqual(['contact'])
    await w.findAll('button')[5]!.trigger('click')
    expect(w.emitted('action')).toHaveLength(1)
  })
  it('edits the selected event actor without adding another keypoint', async () => {
    const w = mount(AnnotationCommandStrip, {
      props: {
        bindings,
        state: 'READY',
        canMark: false,
        lastKeyPoint: true,
        selectedKeyPoint: true,
        selectedBallEvent: { kind: 'SPIKE', result: 'SUCCESS' },
        actorOptions: [{ id: 'roster-11', label: 'TPE · #11 王一' }],
      },
      global: {
        stubs: {
          UiKbd: { template: '<kbd><slot /></kbd>' },
          UiPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
        },
      },
    })

    const option = w.findAll('button').find(button => button.text().includes('#11 王一'))
    expect(option).toBeDefined()
    await option!.trigger('click')

    expect(w.emitted('setBallEventActor')?.[0]).toEqual(['roster-11'])
    expect(w.emitted('action')).toBeUndefined()
  })
})
