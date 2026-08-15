import { describe, expect, it } from 'vitest'
import {
  clipRangeOverlaps,
  focusedTimelineView,
  formatTimelinePosition,
  formatTimelineScale,
  paddedClipRange,
  resolveSegmentSelection,
  rulerTicks,
  segmentAtCaptureTime,
  selectNonOverlappingRanges,
  timelineScaleForZoom,
  timelineViewForRange,
  timelineViewForScale,
  timelineZoomLimit,
} from './dvrTimeline'

describe('DVR timeline viewport', () => {
  it('keeps ruler labels relative to the full timeline origin while panning', () => {
    const ticks = rulerTicks({ startUs: '12000000', endUs: '20000000' }, '0')
    expect(ticks[0]?.label).toBe('00:00:12.000')
    expect(ticks.at(-1)?.label).toBe('00:00:20.000')
  })

  it('lets manual zoom reach a fixed five-second viewport on long recordings', () => {
    expect(timelineZoomLimit({ startUs: '0', endUs: '7200000000' })).toBe(1440)
    expect(timelineZoomLimit({ startUs: '0', endUs: '20000000' })).toBe(4)
  })

  it('focuses a segment with breathing room without exceeding the five-second viewport ceiling', () => {
    const view = focusedTimelineView(
      { startUs: '0', endUs: '120000000' },
      { startCaptureTimeUs: '60000000', endCaptureTimeUs: '70000000' },
    )
    expect(view.startUs).toBe('58750000')
    expect(view.endUs).toBe('71250000')
    expect(capturePercent(view.startUs, view.endUs, '60000000')).toBe(10)
    expect(capturePercent(view.startUs, view.endUs, '70000000')).toBe(90)
  })

  it('uses a stable scale where five seconds is 60x and the default is 0.1x', () => {
    const bounds = { startUs: '0', endUs: '7200000000' }
    const defaultView = timelineViewForScale(bounds, 0.1, '3600000000')
    const detailView = timelineViewForScale(bounds, 60, '3600000000')
    expect(BigInt(defaultView.endUs) - BigInt(defaultView.startUs)).toBe(3_000_000_000n)
    expect(BigInt(detailView.endUs) - BigInt(detailView.startUs)).toBe(5_000_000n)
    expect(timelineScaleForZoom(bounds, defaultView.zoom)).toBeCloseTo(0.1)
    expect(timelineScaleForZoom(bounds, detailView.zoom)).toBe(60)
    expect([formatTimelineScale(0.01), formatTimelineScale(0.1), formatTimelineScale(60)]).toEqual([
      '0.01×',
      '0.1×',
      '60×',
    ])
  })

  it('preserves an absolute viewport when a progressive timeline grows', () => {
    const preserved = timelineViewForRange(
      { startUs: '0', endUs: '9000000000' },
      { startUs: '2100000000', endUs: '5100000000' },
    )
    expect(preserved).toEqual({
      zoom: 3,
      pan: 0.35,
      startUs: '2100000000',
      endUs: '5100000000',
    })
  })

  it('formats the transport time from the capture origin rather than playback-window PTS', () => {
    expect(formatTimelinePosition('1799983333', '0')).toBe('29:59.983')
    expect(formatTimelinePosition('1029163257', '1000000000')).toBe('00:29.163')
    expect(formatTimelinePosition('999', '1000')).toBe('00:00.000')
  })

  it('never returns overlapping visual masks and lets the active range win', () => {
    const visible = selectNonOverlappingRanges(
      [
        { id: 'old-revision', startCaptureTimeUs: '100', endCaptureTimeUs: '300' },
        { id: 'next-rally', startCaptureTimeUs: '400', endCaptureTimeUs: '500' },
        { id: 'duplicate-next', startCaptureTimeUs: '450', endCaptureTimeUs: '550' },
      ],
      { startCaptureTimeUs: '150', endCaptureTimeUs: '350' },
    )
    expect(visible.map(range => range.id)).toEqual(['next-rally'])
  })

  it('uses the cursor segment until an explicit pointer selection is pinned', () => {
    const segments = [
      { id: 'rally-1', startCaptureTimeUs: '100', endCaptureTimeUs: '200' },
      { id: 'rally-2', startCaptureTimeUs: '300', endCaptureTimeUs: '400' },
    ]
    expect(segmentAtCaptureTime('150', segments)?.id).toBe('rally-1')
    expect(segmentAtCaptureTime('250', segments)).toBeNull()
    expect(resolveSegmentSelection(null, 'rally-1')).toBe('rally-1')
    expect(resolveSegmentSelection('rally-2', 'rally-1')).toBe('rally-2')
    expect(resolveSegmentSelection(null, null)).toBeNull()
  })

  it('rejects a moved key point when its padded clip would overlap another segment', () => {
    const range = paddedClipRange(['10000000', '16000000'], 3_000_000n, 3_000_000n)
    expect(range).toEqual({ startCaptureTimeUs: '7000000', endCaptureTimeUs: '19000000' })
    expect(
      clipRangeOverlaps(
        range!,
        [{ id: 'other', startCaptureTimeUs: '18500000', endCaptureTimeUs: '22000000' }],
        'current',
      ),
    ).toBe(true)
    expect(
      clipRangeOverlaps(
        range!,
        [{ id: 'current', startCaptureTimeUs: '18500000', endCaptureTimeUs: '22000000' }],
        'current',
      ),
    ).toBe(false)
  })
})

function capturePercent(startUs: string, endUs: string, targetUs: string) {
  return Number(((BigInt(targetUs) - BigInt(startUs)) * 100n) / (BigInt(endUs) - BigInt(startUs)))
}
