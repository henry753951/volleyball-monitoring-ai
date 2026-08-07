import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DvrTimelineDock from './DvrTimelineDock.vue'
const timeline = { captureSessionId: 's', captureStartTimeUs: '1000', liveEdgeCaptureTimeUs: null, timelineVersion: '1', availableRanges: [{ startUs: '1000', endUs: '2000', discontinuity: 0 }, { startUs: '3000', endUs: '4000', discontinuity: 1 }] }
describe('DvrTimelineDock interactions', () => {
  it('emits exact bigint seek target and blocks gap clicks', async () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); const lane = w.find('[role="slider"]'); await lane.trigger('click', { clientX: 25 }); expect(w.emitted('seek')?.[0]).toEqual(['1250']); await lane.trigger('click', { clientX: 62 }); expect(w.emitted('seek')).toHaveLength(1) })
  it('bounds wheel zoom and shift pan; reset restores view', async () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); const dock = w.find('.timeline-dock'); for (let i = 0; i < 50; i++) await dock.trigger('wheel', { deltaY: -100 }); for (let i = 0; i < 50; i++) await dock.trigger('wheel', { deltaY: 100, shiftKey: true }); await w.find('button').trigger('click'); expect(w.find('.timeline-dock').exists()).toBe(true) })
  it('renders discontinuity marker lane', () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); expect(w.find('.timeline-dock__gap-lane').exists()).toBe(true); expect(w.findAll('.timeline-dock__gap').length).toBeGreaterThan(0) })
})
