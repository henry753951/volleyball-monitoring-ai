import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DvrTimelineDock from './DvrTimelineDock.vue'
const timeline = { captureSessionId: 's', captureStartTimeUs: '1000', liveEdgeCaptureTimeUs: null, timelineVersion: '1', availableRanges: [{ startUs: '1000', endUs: '2000', discontinuity: 0 }, { startUs: '3000', endUs: '4000', discontinuity: 1 }] }
const annotation: AnnotationRallySnapshot = {
  schema_version: '2.0.0', type: 'rally_snapshot', room_id: 'room', rally_id: 'rally', revision: '1', server_sequence: '1',
  snapshot: { annotation_status: 'open', side_assignment_id: 'assignment', score_resolution: 'pending', scoring_court_side: null, processing_status: 'idle', key_points: [{ key_point_id: 'point-1', sequence_index: 0, marker_kind: 'service', is_terminal: false, capture_time_us: '1750', capture_frame_index: '10', timing_precision: 'frame_exact', possible_duplicate: false }] },
}
describe('DvrTimelineDock mounted interactions', () => {
  it('emits exact target and blocks gaps', async () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); const lane = w.find('[role="slider"]'); Object.defineProperty(lane.element, 'getBoundingClientRect', { value: () => ({ left: 0, width: 100 }) }); await lane.trigger('click', { clientX: 25 }); expect(w.emitted('seek')?.[0]).toEqual(['1750']); await lane.trigger('click', { clientX: 62 }); expect(w.emitted('seek')).toHaveLength(1) })
  it('uses Shift+wheel for zoom, plain wheel for pan, and reset restores the full view', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } })
    const dock = w.find('.timeline-surface')
    const firstTick = () => w.find('.ruler-tick').attributes('title')
    expect(w.find('.zoom-readout').exists()).toBe(false)
    for (let index = 0; index < 50; index++) dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true }))
    await w.vm.$nextTick()
    expect(w.find('.zoom-readout').text()).toContain('64.0×')
    const beforePan = firstTick()
    dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }))
    await w.vm.$nextTick()
    expect(firstTick()).not.toBe(beforePan)
    await w.find('.zoom-readout').trigger('click')
    expect(w.find('.zoom-readout').exists()).toBe(false)
  })
  it('renders discontinuity marker', () => { const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } }); expect(w.findAll('.gap-range').length).toBeGreaterThan(0) })
  it('selects and seeks an editable key-point marker', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null, annotation, editable: true, selectedKeyPointId: 'point-1', softLocks: { 'point-1': ['Remote Operator'] } } })
    const marker = w.find('.keypoint-dot')
    expect(marker.classes()).toContain('editable')
    expect(marker.classes()).toContain('selected')
    expect(marker.classes()).toContain('soft-locked')
    expect(marker.attributes('title')).toContain('Remote Operator 正在調整（提示，不阻擋）')
    expect(marker.attributes('disabled')).toBeUndefined()
    await marker.trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['point-1'])
    expect(w.emitted('seek')?.[0]).toEqual(['1750'])
  })
  it('previews a marker drag and emits a ready-range target with a non-blocking edit hint', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null, annotation, editable: true } })
    const marker = w.find('.keypoint-dot')
    const lane = marker.element.parentElement as HTMLElement
    Object.defineProperty(lane, 'getBoundingClientRect', { value: () => ({ left: 0, width: 100 }) })
    Object.defineProperty(marker.element, 'setPointerCapture', { value: () => undefined })
    Object.defineProperty(marker.element, 'hasPointerCapture', { value: () => false })
    await marker.trigger('pointerdown', { pointerId: 7, clientX: 25 })
    await marker.trigger('pointermove', { pointerId: 7, clientX: 75 })
    expect(marker.classes()).toContain('point-dragging')
    await marker.trigger('pointerup', { pointerId: 7, clientX: 75 })
    expect(w.emitted('editStart')?.[0]).toEqual(['point-1'])
    expect(w.emitted('move')?.[0]).toEqual(['point-1', '3250'])
    await marker.trigger('click')
    expect(w.emitted('select')).toBeUndefined()
  })
})
