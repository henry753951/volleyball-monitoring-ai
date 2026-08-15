import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DvrTimelineDock from './DvrTimelineDock.vue'
const timeline = {
  captureSessionId: 's',
  captureStartTimeUs: '1000',
  liveEdgeCaptureTimeUs: null,
  sourceEndCaptureTimeUs: '4000',
  ingestFrontierCaptureTimeUs: '4000',
  availabilityComplete: true,
  timelineVersion: '1',
  gapRanges: [{ startUs: '2000', endUs: '3000', discontinuity: 1 }],
  availableRanges: [
    { startUs: '1000', endUs: '2000', discontinuity: 0 },
    { startUs: '3000', endUs: '4000', discontinuity: 1 },
  ],
}
const annotation: AnnotationRallySnapshot = {
  schema_version: '2.0.0',
  type: 'rally_snapshot',
  room_id: 'room',
  rally_id: 'rally',
  revision: '1',
  server_sequence: '1',
  snapshot: {
    annotation_status: 'open',
    side_assignment_id: 'assignment',
    score_resolution: 'pending',
    scoring_court_side: null,
    processing_status: 'idle',
    key_points: [
      {
        key_point_id: 'point-1',
        sequence_index: 0,
        marker_kind: 'service',
        is_terminal: false,
        capture_time_us: '1750',
        capture_frame_index: '10',
        timing_precision: 'frame_exact',
        possible_duplicate: false,
      },
    ],
  },
}
describe('DvrTimelineDock mounted interactions', () => {
  it('keeps manual selection, emits one exact committed target, and blocks gaps', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } })
    const lane = w.find('.buffer-status')
    Object.defineProperty(lane.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    await lane.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 25 })
    expect(w.emitted('seek')).toBeUndefined()
    await lane.trigger('pointerup', { pointerId: 1, clientX: 25 })
    expect(w.emitted('clearSelection')).toBeUndefined()
    expect(w.emitted('seek')?.[0]).toEqual(['1750'])
    await lane.trigger('pointerdown', { pointerId: 2, button: 0, clientX: 62 })
    await lane.trigger('pointerup', { pointerId: 2, clientX: 62 })
    expect(w.emitted('clearSelection')).toBeUndefined()
    expect(w.emitted('seek')).toHaveLength(1)
  })
  it('commits one seek from the upper ruler without discarding manual selection', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } })
    const ruler = w.find('.ruler-row')
    Object.defineProperty(ruler.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    await ruler.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 25 })
    expect(w.emitted('seek')).toBeUndefined()
    await ruler.trigger('pointerup', { pointerId: 1, clientX: 25 })
    expect(w.emitted('clearSelection')).toBeUndefined()
    expect(w.emitted('seek')?.[0]).toEqual(['1750'])
  })
  it('clears a pinned segment from empty lane space without seeking', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } })
    const lane = w.find('.lane-content')
    Object.defineProperty(lane.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    await lane.trigger('click', { clientX: 25 })
    expect(w.emitted('clearSelection')).toHaveLength(1)
    expect(w.emitted('seek')).toBeUndefined()
  })
  it('uses Shift+wheel for zoom, plain wheel for pan, and reset restores the 0.1x default', async () => {
    const zoomTimeline = {
      ...timeline,
      captureStartTimeUs: '0',
      sourceEndCaptureTimeUs: '7200000000',
      ingestFrontierCaptureTimeUs: '7200000000',
      gapRanges: [],
      availableRanges: [{ startUs: '0', endUs: '7200000000', discontinuity: 0 }],
    }
    const w = mount(DvrTimelineDock, { props: { timeline: zoomTimeline, playhead: null } })
    const dock = w.find('.timeline-surface')
    const firstTick = () => w.find('.ruler-tick').attributes('title')
    const latestScale = () => Number(w.emitted('scaleChange')?.at(-1)?.[0])
    expect(latestScale()).toBeCloseTo(0.1)
    for (let index = 0; index < 100; index++)
      dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true }))
    await w.vm.$nextTick()
    expect(latestScale()).toBe(60)
    const beforePan = firstTick()
    dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 500 }))
    await w.vm.$nextTick()
    expect(firstTick()).not.toBe(beforePan)
    ;(w.vm as unknown as { resetView: () => void }).resetView()
    await w.vm.$nextTick()
    expect(latestScale()).toBeCloseTo(0.1)
  })
  it('restores the persisted viewport and scale for the same capture session', async () => {
    const longTimeline = {
      ...timeline,
      captureStartTimeUs: '0',
      sourceEndCaptureTimeUs: '7200000000',
      ingestFrontierCaptureTimeUs: '7200000000',
      gapRanges: [],
      availableRanges: [{ startUs: '0', endUs: '7200000000', discontinuity: 0 }],
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline: longTimeline,
        playhead: null,
        restoredView: {
          captureSessionId: 's',
          startCaptureTimeUs: '3600000000',
          endCaptureTimeUs: '3605000000',
          scale: 60,
        },
      },
    })
    const slider = w.get('.buffer-status')
    expect(slider.attributes('aria-valuemin')).toBe('3600000000')
    expect(slider.attributes('aria-valuemax')).toBe('3605000000')
    expect(Number(w.emitted('scaleChange')?.at(-1)?.[0])).toBe(60)
    expect(w.emitted('viewChange')?.at(-1)?.[0]).toEqual({
      captureSessionId: 's',
      startCaptureTimeUs: '3600000000',
      endCaptureTimeUs: '3605000000',
      scale: 60,
    })
    await w.setProps({ playhead: '3602500000' })
    expect(slider.attributes('aria-valuemin')).toBe('3600000000')
    expect(slider.attributes('aria-valuemax')).toBe('3605000000')
    expect(Number(w.emitted('scaleChange')?.at(-1)?.[0])).toBe(60)
  })
  it('ignores a viewport persisted for another capture session', () => {
    const longTimeline = {
      ...timeline,
      captureStartTimeUs: '0',
      sourceEndCaptureTimeUs: '7200000000',
      ingestFrontierCaptureTimeUs: '7200000000',
      gapRanges: [],
      availableRanges: [{ startUs: '0', endUs: '7200000000', discontinuity: 0 }],
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline: longTimeline,
        playhead: '3602500000',
        restoredView: {
          captureSessionId: 'other-capture',
          startCaptureTimeUs: '3600000000',
          endCaptureTimeUs: '3605000000',
          scale: 60,
        },
      },
    })
    const slider = w.get('.buffer-status')
    expect(
      BigInt(slider.attributes('aria-valuemax')!) - BigInt(slider.attributes('aria-valuemin')!),
    ).toBe(3_000_000_000n)
    expect(Number(w.emitted('scaleChange')?.at(-1)?.[0])).toBeCloseTo(0.1)
  })
  it('keeps the visible time range and scale fixed while a live or progressive source grows', async () => {
    const progressiveTimeline = {
      ...timeline,
      captureStartTimeUs: '0',
      sourceEndCaptureTimeUs: null,
      ingestFrontierCaptureTimeUs: '7200000000',
      availabilityComplete: false,
      timelineVersion: '1',
      gapRanges: [],
      availableRanges: [{ startUs: '0', endUs: '7200000000', discontinuity: 0 }],
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline: progressiveTimeline,
        playhead: '3600000000',
        playbackMode: 'progressive_vod',
      },
    })
    const dock = w.get('.timeline-surface')
    const slider = () => w.get('.buffer-status')
    for (let index = 0; index < 100; index++)
      dock.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true }))
    await w.vm.$nextTick()
    const initialRange = [
      slider().attributes('aria-valuemin'),
      slider().attributes('aria-valuemax'),
    ]
    const initialScale = Number(w.emitted('scaleChange')?.at(-1)?.[0])
    expect(BigInt(initialRange[1]!) - BigInt(initialRange[0]!)).toBe(5_000_000n)
    expect(initialScale).toBe(60)

    await w.setProps({
      timeline: {
        ...progressiveTimeline,
        ingestFrontierCaptureTimeUs: '9000000000',
        timelineVersion: '2',
        availableRanges: [{ startUs: '0', endUs: '9000000000', discontinuity: 0 }],
      },
    })

    expect([slider().attributes('aria-valuemin'), slider().attributes('aria-valuemax')]).toEqual(
      initialRange,
    )
    expect(Number(w.emitted('scaleChange')?.at(-1)?.[0])).toBeCloseTo(initialScale)
  })
  it('renders discontinuity marker', () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: null } })
    expect(w.findAll('.gap-range').length).toBeGreaterThan(0)
  })
  it('distinguishes the browser-buffered window from server-available ranges', () => {
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: '1750',
        bufferedWindow: { startCaptureTimeUs: '1400', endCaptureTimeUs: '1900' },
        bufferedRanges: [{ startCaptureTimeUs: '1600', endCaptureTimeUs: '1800' }],
      },
    })
    expect(w.find('.playback-window').exists()).toBe(true)
    expect(w.findAll('.playback-ready')).toHaveLength(1)
    expect(w.findAll('.ready-range')).toHaveLength(2)
  })
  it('marks a completed live source with END instead of an active LIVE edge', () => {
    const w = mount(DvrTimelineDock, {
      props: { timeline, playhead: '3999', playbackMode: 'ended_live' },
    })
    expect(w.find('.source-edge.terminal').text()).toBe('END')
    expect(w.find('.live-edge').exists()).toBe(false)
  })
  it('fully hides a processing mask once its range no longer intersects the viewport', () => {
    const submittedAnnotation: AnnotationRallySnapshot = {
      ...annotation,
      snapshot: {
        ...annotation.snapshot,
        annotation_status: 'submitted',
        key_points: [
          { ...annotation.snapshot.key_points[0]!, capture_time_us: '400' },
          {
            ...annotation.snapshot.key_points[0]!,
            key_point_id: 'point-2',
            sequence_index: 1,
            marker_kind: 'contact',
            capture_time_us: '900',
          },
        ],
      },
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: null,
        annotation: submittedAnnotation,
        maskRange: { startCaptureTimeUs: '0', endCaptureTimeUs: '1000' },
        currentMaskStatus: 'processing',
      },
    })
    const mask = w.find('.timeline-mask.current')
    expect(mask.exists()).toBe(true)
    expect(mask.isVisible()).toBe(false)
  })
  it('switches narrow segments and their secondary visuals to the micro-density presentation', () => {
    const narrowSegment = {
      id: 'narrow',
      label: '第 1 局 · 回合 3',
      startCaptureTimeUs: '1200',
      endCaptureTimeUs: '1300',
      status: 'analyzed' as const,
      points: [
        { id: 'service', markerKind: 'service', isTerminal: false, captureTimeUs: '1210' },
        { id: 'contact', markerKind: 'contact', isTerminal: false, captureTimeUs: '1250' },
        { id: 'terminal', markerKind: 'contact', isTerminal: true, captureTimeUs: '1290' },
      ],
      analysis: {
        startCaptureTimeUs: '1200',
        endCaptureTimeUs: '1300',
        byteLength: '1000000',
        trackCount: 12,
        ballPathCount: 1,
        contactCount: 3,
        capabilities: ['player_tracking', 'ball_tracking'],
      },
    }
    const w = mount(DvrTimelineDock, {
      props: { timeline, playhead: null, segments: [narrowSegment] },
    })
    expect(w.find('.timeline-mask.historical').classes()).toContain('density-micro')
    expect(w.find('.timeline-mask.historical small').text()).toBe('分析完成')
    expect(w.find('.analysis-rail').classes()).toContain('density-micro')
    expect(w.find('.analysis-rail').element.tagName).toBe('BUTTON')
    expect(w.findAll('.historical-point')).toHaveLength(3)
    expect(
      w.findAll('.historical-point').every(point => point.classes().includes('density-micro')),
    ).toBe(true)
  })
  it('renders the Rally outcome on current and historical masks', () => {
    const readyAnnotation: AnnotationRallySnapshot = {
      ...annotation,
      snapshot: {
        ...annotation.snapshot,
        annotation_status: 'ready',
        score_resolution: 'resolved',
        scoring_court_side: 'right',
        key_points: [
          { ...annotation.snapshot.key_points[0]!, capture_time_us: '1200' },
          {
            ...annotation.snapshot.key_points[0]!,
            key_point_id: 'point-2',
            sequence_index: 1,
            marker_kind: 'contact',
            is_terminal: true,
            capture_time_us: '1800',
          },
        ],
      },
    }
    const historical = {
      id: 'historical-outcome',
      label: '第 1 局 · 回合 2',
      outcomeLabel: '得分未知',
      startCaptureTimeUs: '3100',
      endCaptureTimeUs: '3900',
      status: 'processing' as const,
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: null,
        annotation: readyAnnotation,
        currentMaskOutcome: 'R 得分',
        segments: [historical],
      },
    })

    expect(w.get('.timeline-mask.current .mask-outcome').text()).toBe('R 得分')
    expect(w.get('.timeline-mask.current').attributes('aria-label')).toContain('R 得分')
    expect(w.get('.timeline-mask.historical .mask-outcome').text()).toBe('得分未知')
    expect(w.get('.timeline-mask.historical .mask-outcome').classes()).toContain('unknown')
  })
  it('opens the analysis tab through the parent segment without a second selection state', async () => {
    const analyzedSegment = {
      id: 'analyzed',
      label: '第 1 局 · 回合 4',
      startCaptureTimeUs: '1200',
      endCaptureTimeUs: '1800',
      status: 'analyzed' as const,
      analysis: {
        startCaptureTimeUs: '1250',
        endCaptureTimeUs: '1750',
        byteLength: '2400000',
        trackCount: 12,
        ballPathCount: 1,
        contactCount: 3,
        capabilities: ['player_tracking', 'ball_tracking'],
      },
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: null,
        segments: [analyzedSegment],
        selectedSegmentId: 'analyzed',
      },
    })
    const result = w.get('button.analysis-rail')
    expect(result.attributes('aria-pressed')).toBeUndefined()
    expect(result.attributes('aria-label')).toContain('第 1 局 · 回合 4 · 開啟分析結果')
    expect(result.classes()).not.toContain('selected')

    await result.trigger('click')
    expect(w.emitted('selectAnalysis')?.[0]).toEqual(['analyzed'])
    expect(w.emitted('selectSegment')).toBeUndefined()

    await w.get('.lane-content').trigger('click')
    expect(w.emitted('clearSelection')).toHaveLength(1)
  })
  it('keeps the current immutable Rally AI result rail when its duplicate segment mask is suppressed', async () => {
    const current = {
      ...annotation,
      snapshot: { ...annotation.snapshot, annotation_status: 'submitted' as const },
    }
    const analyzedSegment = {
      id: 'rally',
      label: '第 1 局 · 回合 1',
      startCaptureTimeUs: '1200',
      endCaptureTimeUs: '1900',
      status: 'analyzed' as const,
      points: [
        { id: 'ai-contact', markerKind: 'contact', isTerminal: false, captureTimeUs: '1750' },
      ],
      analysis: {
        startCaptureTimeUs: '1250',
        endCaptureTimeUs: '1850',
        byteLength: '2400000',
        trackCount: 12,
        ballPathCount: 1,
        contactCount: 3,
        capabilities: ['player_tracking', 'ball_tracking'],
      },
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: '1750',
        annotation: current,
        segments: [analyzedSegment],
        maskRange: { startCaptureTimeUs: '1200', endCaptureTimeUs: '1900' },
        selectedSegmentId: 'rally',
      },
    })

    expect(w.findAll('.timeline-mask.historical')).toHaveLength(0)
    expect(w.find('.timeline-mask.current').exists()).toBe(true)
    expect(w.findAll('.historical-point')).toHaveLength(1)
    expect(w.get('.historical-point').attributes('aria-label')).toContain('回合 1 · contact')
    expect(w.findAll('.analysis-rail')).toHaveLength(1)
    expect(w.find('.analysis-rail').attributes('aria-label')).toContain('開啟分析結果')

    await w.find('.analysis-rail').trigger('click')
    expect(w.emitted('selectAnalysis')?.[0]).toEqual(['rally'])
  })
  it('drags the playhead once and keeps the optimistic target until cursor sync catches up', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: '1750' } })
    const playhead = w.find('.playhead-handle')
    const lane = w.find('.lane-content')
    Object.defineProperty(lane.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    Object.defineProperty(playhead.element, 'setPointerCapture', { value: () => undefined })
    Object.defineProperty(playhead.element, 'hasPointerCapture', { value: () => false })
    await playhead.trigger('pointerdown', { pointerId: 4, clientX: 25 })
    await playhead.trigger('pointermove', { pointerId: 4, clientX: 75 })
    expect(w.emitted('seek')).toBeUndefined()
    await playhead.trigger('pointerup', { pointerId: 4, clientX: 75 })
    expect(w.emitted('seek')?.[0]).toEqual(['3250'])
    expect(w.find('.buffer-status').attributes('aria-valuenow')).toBe('3250')
    await w.setProps({ playhead: '1750' })
    expect(w.find('.buffer-status').attributes('aria-valuenow')).toBe('3250')
    await w.setProps({ playhead: '3250' })
    expect(w.find('.buffer-status').attributes('aria-valuenow')).toBe('3250')
  })
  it('previews continuously and sends one seek after dragging the ruler', async () => {
    const w = mount(DvrTimelineDock, { props: { timeline, playhead: '1750' } })
    const ruler = w.find('.ruler-row')
    Object.defineProperty(ruler.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    Object.defineProperty(ruler.element, 'setPointerCapture', { value: () => undefined })
    Object.defineProperty(ruler.element, 'hasPointerCapture', { value: () => false })
    await ruler.trigger('pointerdown', { pointerId: 9, button: 0, clientX: 25 })
    expect(w.emitted('seek')).toBeUndefined()
    await ruler.trigger('pointermove', { pointerId: 9, clientX: 75 })
    expect(w.emitted('preview')?.at(-1)).toEqual(['3250'])
    await ruler.trigger('pointerup', { pointerId: 9, clientX: 75 })
    expect(w.emitted('seek')?.at(-1)).toEqual(['3250'])
  })
  it('renders key points inside the single segment lane and double-click focuses its mask', async () => {
    const rangedAnnotation: AnnotationRallySnapshot = {
      ...annotation,
      snapshot: {
        ...annotation.snapshot,
        key_points: [
          annotation.snapshot.key_points[0]!,
          {
            ...annotation.snapshot.key_points[0]!,
            key_point_id: 'point-2',
            sequence_index: 1,
            marker_kind: 'contact',
            capture_time_us: '3250',
            capture_frame_index: '20',
          },
        ],
      },
    }
    const w = mount(DvrTimelineDock, {
      props: { timeline, playhead: null, annotation: rangedAnnotation, editable: true },
    })
    expect(w.findAll('.lane-row')).toHaveLength(1)
    expect(w.find('.clip-lane').findAll('.keypoint-dot')).toHaveLength(2)
    await w.find('.timeline-mask.current').trigger('dblclick')
    expect(w.emitted('selectMask')).toBeTruthy()
    expect(w.emitted('seek')?.at(-1)).toEqual(['1750'])
  })
  it('double-clicks a distant historical segment without snapping back to the old playhead', async () => {
    const distantTimeline = {
      captureSessionId: 's',
      captureStartTimeUs: '0',
      liveEdgeCaptureTimeUs: null,
      sourceEndCaptureTimeUs: '40000000',
      ingestFrontierCaptureTimeUs: '40000000',
      availabilityComplete: true,
      timelineVersion: '1',
      gapRanges: [],
      availableRanges: [{ startUs: '0', endUs: '40000000', discontinuity: 0 }],
    }
    const segment = {
      id: 'historical',
      label: '第 1 局 · 回合 2',
      startCaptureTimeUs: '30000000',
      endCaptureTimeUs: '40000000',
      status: 'analyzed' as const,
    }
    const w = mount(DvrTimelineDock, {
      props: { timeline: distantTimeline, playhead: '1000000', segments: [segment] },
    })
    await w.find('.timeline-mask.historical').trigger('dblclick')
    expect(w.emitted('seek')?.at(-1)).toEqual(['30000000'])
    expect(w.find('.buffer-status').attributes('aria-valuenow')).toBe('30000000')

    await w.setProps({ playhead: '2000000' })
    expect(w.find('.buffer-status').attributes('aria-valuenow')).toBe('30000000')
    await w.setProps({ playhead: '30000000' })
    expect(w.find('.buffer-status').attributes('aria-valuenow')).toBe('30000000')
  })
  it('selects and seeks an editable key-point marker', async () => {
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: null,
        annotation,
        editable: true,
        selectedKeyPointId: 'point-1',
        softLocks: { 'point-1': ['Remote Operator'] },
      },
    })
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
    const w = mount(DvrTimelineDock, {
      props: { timeline, playhead: null, annotation, editable: true },
    })
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
  it('keeps correction-draft service and contact markers editable', () => {
    const correction: AnnotationRallySnapshot = {
      ...annotation,
      snapshot: {
        ...annotation.snapshot,
        active_submission_id: 'submission-1',
        key_points: [
          annotation.snapshot.key_points[0]!,
          {
            ...annotation.snapshot.key_points[0]!,
            key_point_id: 'point-2',
            sequence_index: 1,
            marker_kind: 'contact',
            capture_time_us: '3250',
            capture_frame_index: '20',
          },
        ],
      },
    }
    const w = mount(DvrTimelineDock, {
      props: { timeline, playhead: null, annotation: correction, editable: true },
    })
    const markers = w.findAll('.keypoint-dot')
    expect(markers).toHaveLength(2)
    expect(markers.every(marker => marker.classes().includes('editable'))).toBe(true)
    expect(markers.every(marker => !marker.classes().includes('locked'))).toBe(true)
  })
  it('does not place immutable historical markers over correction-draft markers', () => {
    const correction: AnnotationRallySnapshot = {
      ...annotation,
      snapshot: { ...annotation.snapshot, active_submission_id: 'submission-1' },
    }
    const duplicateSegment = {
      id: 'rally',
      label: '第 1 局 · 回合 1',
      startCaptureTimeUs: '1500',
      endCaptureTimeUs: '1900',
      status: 'analyzed' as const,
      points: [
        { id: 'immutable-point', markerKind: 'service', isTerminal: false, captureTimeUs: '1750' },
      ],
    }
    const w = mount(DvrTimelineDock, {
      props: {
        timeline,
        playhead: null,
        annotation: correction,
        editable: true,
        segments: [duplicateSegment],
      },
    })
    expect(w.findAll('.keypoint-dot:not(.historical-point)')).toHaveLength(1)
    expect(w.findAll('.historical-point')).toHaveLength(0)
  })
})
