import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AnnotationCommandStrip from './AnnotationCommandStrip.vue'
const bindings = { service: 'Z', contact: 'Space', close_left: '<', close_right: '>', close_unknown: '?', submit: 'Enter' }
describe('AnnotationCommandStrip', () => {
  it.each([
    ['IDLE+canMark', 'IDLE', true, false, [true, false, false, false, false, false]],
    ['OPEN+stale', 'OPEN', false, false, [false, false, false, false, false, false]],
    ['OPEN+lastPoint', 'OPEN', true, true, [false, true, true, true, true, false]],
    ['READY', 'READY', false, false, [false, false, false, false, false, true]],
  ])('%s enables exactly the fixed commands', (_name, state, canMark, lastKeyPoint, expected) => {
    const w = mount(AnnotationCommandStrip, { props: { bindings, state: state as 'IDLE'|'OPEN'|'READY'|'SUBMITTED', canMark, lastKeyPoint } })
    expect(w.findAll('button').map(button => !button.attributes('disabled'))).toEqual(expected)
  })
  it('renders exactly six fixed actions and no X', () => { const w = mount(AnnotationCommandStrip, { props: { bindings, state: 'IDLE', canMark: false, lastKeyPoint: false } }); expect(w.findAll('button')).toHaveLength(6); expect(w.text()).not.toContain('X') })
  it('renders formatted keys and specific disabled reasons', () => { const w = mount(AnnotationCommandStrip, { props: { bindings, state: 'IDLE', canMark: false, lastKeyPoint: false } }); expect(w.text()).toContain('游標尚未由伺服器確認'); expect(w.text()).toContain('尚未開啟回合'); expect(w.text()).toContain('提交狀態尚未就緒'); const open = mount(AnnotationCommandStrip, { props: { bindings, state: 'OPEN', canMark: true, lastKeyPoint: false } }); expect(open.text()).toContain('沒有伺服器確認的最後 key point') })
  it('emits enabled action only', async () => { const w = mount(AnnotationCommandStrip, { props: { bindings, state: 'OPEN', canMark: true, lastKeyPoint: true } }); await w.findAll('button')[1]!.trigger('click'); expect(w.emitted('action')?.[0]).toEqual(['contact']); await w.findAll('button')[5]!.trigger('click'); expect(w.emitted('action')).toHaveLength(1) })
})
