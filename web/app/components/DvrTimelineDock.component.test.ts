import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DvrTimelineDock from './DvrTimelineDock.vue'
const timeline = { captureSessionId: 's', captureStartTimeUs: '1000', liveEdgeCaptureTimeUs: null, timelineVersion: '1', availableRanges: [{ startUs: '1000', endUs: '2000', discontinuity: 0 }, { startUs: '3000', endUs: '4000', discontinuity: 1 }] }
describe('DvrTimelineDock mounted interactions', () => {
  it('emits exact target and blocks gaps', async () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); const lane = w.find('[role="slider"]'); Object.defineProperty(lane.element, 'getBoundingClientRect', { value: () => ({ left: 0, width: 100 }) }); await lane.trigger('click', { clientX: 25 }); expect(w.emitted('seek')?.[0]).toEqual(['1750']); await lane.trigger('click', { clientX: 62 }); expect(w.emitted('seek')).toHaveLength(1) })
  it('uses Shift+wheel for zoom, plain wheel for pan, and reset restores the full view', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } })
    const dock = w.find('.timeline-surface')
    const zoom = () => w.find('.zoom-readout').text()
    const firstTick = () => w.find('.ruler-tick').attributes('title')
    expect(zoom()).toContain('1.0×')
    for (let index = 0; index < 50; index++) dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true }))
    await w.vm.$nextTick()
    expect(zoom()).toContain('64.0×')
    const beforePan = firstTick()
    dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }))
    await w.vm.$nextTick()
    expect(firstTick()).not.toBe(beforePan)
    await w.find('.zoom-readout').trigger('click')
    expect(zoom()).toContain('1.0×')
  })
  it('renders discontinuity marker', () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); expect(w.findAll('.gap-range').length).toBeGreaterThan(0) })
})
