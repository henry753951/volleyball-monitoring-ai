import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AnnotationCommandStrip from './AnnotationCommandStrip.vue'
const bindings = { service: 'Z', contact: 'X', close_left: '<', close_right: '>', close_unknown: '?', submit: 'Enter' }
describe('AnnotationCommandStrip', () => {
  it.each([
    ['IDLE+canMark', 'IDLE', true, false, [true, false, false, false, false, true]],
    ['OPEN+stale', 'OPEN', false, false, [false, false, false, false, false, true]],
    ['OPEN+lastPoint', 'OPEN', true, true, [false, true, true, true, true, true]],
    ['READY', 'READY', false, false, [false, false, false, false, false, true]],
  ])('%s enables exactly the fixed commands', (_name, state, canMark, lastKeyPoint, expected) => {
    const w = mount(AnnotationCommandStrip, { props: { bindings, state: state as 'IDLE'|'OPEN'|'READY'|'SUBMITTED', canMark: canMark === true, lastKeyPoint: lastKeyPoint === true } })
    expect(w.findAll('button').map(button => !(button.element as HTMLButtonElement).disabled)).toEqual(expected)
  })
  it('renders five touch actions plus settings, with X contact and no visible Enter action', () => { const w = mount(AnnotationCommandStrip, { props: { bindings, state: 'IDLE', canMark: false, lastKeyPoint: false } }); expect(w.findAll('button')).toHaveLength(6); expect(w.text()).toContain('X'); expect(w.text()).not.toContain('Enter') })
  it('renders formatted keys and concise disabled reasons', () => { const w = mount(AnnotationCommandStrip, { props: { bindings, state: 'IDLE', canMark: false, lastKeyPoint: false } }); expect(w.findAll('button').map(button => button.attributes('title'))).toContain('游標尚未確認'); expect(w.findAll('button').map(button => button.attributes('title'))).toContain('尚未開始片段'); const open = mount(AnnotationCommandStrip, { props: { bindings, state: 'OPEN', canMark: true, lastKeyPoint: false } }); expect(open.findAll('button').map(button => button.attributes('title'))).toContain('沒有可結束的擊球點') })
  it('emits enabled action only', async () => { const w = mount(AnnotationCommandStrip, { props: { bindings, state: 'OPEN', canMark: true, lastKeyPoint: true } }); await w.findAll('button')[1]!.trigger('click'); expect(w.emitted('action')?.[0]).toEqual(['contact']); await w.findAll('button')[5]!.trigger('click'); expect(w.emitted('action')).toHaveLength(1) })
})
