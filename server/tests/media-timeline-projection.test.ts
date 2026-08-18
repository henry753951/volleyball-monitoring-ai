import { describe, expect, it } from 'vitest'
import {
  applyTimelineSegments,
  emptyTimelineProjection,
  parseTimelineProjection,
  serializeTimelineProjection,
} from '../src/services/media-timeline-projection.js'

const programId = '50000000-0000-4000-8000-000000000001'
const readyAt = new Date('2026-08-18T00:00:00.000Z')

function row(
  sequenceNumber: bigint,
  startUs: bigint,
  endUs: bigint,
  input: { discontinuity?: number; gap?: boolean; ready?: boolean } = {},
) {
  return {
    captureEndUs: endUs,
    captureStartUs: startUs,
    discontinuitySequence: input.discontinuity ?? 0,
    isGap: input.gap ?? false,
    readyAt: input.ready === false ? null : readyAt,
    sequenceNumber,
  }
}

describe('media timeline projection', () => {
  it('merges contiguous READY rows without asset joins', () => {
    const projection = applyTimelineSegments(emptyTimelineProjection(programId, 0n), 3n, [
      row(0n, 0n, 2_000_000n),
      row(1n, 2_000_000n, 4_000_000n),
      row(2n, 4_000_000n, 6_000_000n),
    ])

    expect(projection.availableRanges).toEqual([
      { discontinuity: 0, endUs: 6_000_000n, startUs: 0n },
    ])
    expect(projection.finalizedSequence).toBe(2n)
    expect(projection.observedSequence).toBe(2n)
    expect(projection.liveEdgeUs).toBe(6_000_000n)
    expect(projection.ingestFrontierUs).toBe(6_000_000n)
  })

  it('records a pending tail but does not expose or finalize it', () => {
    const base = applyTimelineSegments(emptyTimelineProjection(programId, 0n), 1n, [
      row(0n, 0n, 2_000_000n),
    ])
    const pending = applyTimelineSegments(base, 1n, [
      row(1n, 2_000_000n, 4_000_000n, { ready: false }),
    ])

    expect(pending.finalizedSequence).toBe(0n)
    expect(pending.observedSequence).toBe(1n)
    expect(pending.liveEdgeUs).toBe(2_000_000n)
    expect(pending.ingestFrontierUs).toBe(4_000_000n)
    expect(pending.availableRanges[0]?.endUs).toBe(2_000_000n)

    const published = applyTimelineSegments(pending, 2n, [row(1n, 2_000_000n, 4_000_000n)])
    expect(published.finalizedSequence).toBe(1n)
    expect(published.liveEdgeUs).toBe(4_000_000n)
    expect(published.availableRanges[0]?.endUs).toBe(4_000_000n)
  })

  it('keeps gaps and discontinuities as separate ranges', () => {
    const projection = applyTimelineSegments(emptyTimelineProjection(programId, 0n), 3n, [
      row(0n, 0n, 2_000_000n),
      row(1n, 2_000_000n, 3_000_000n, { gap: true }),
      row(2n, 3_000_000n, 5_000_000n, { discontinuity: 1 }),
    ])

    expect(projection.availableRanges).toEqual([
      { discontinuity: 0, endUs: 2_000_000n, startUs: 0n },
      { discontinuity: 1, endUs: 5_000_000n, startUs: 3_000_000n },
    ])
    expect(projection.gapRanges).toEqual([
      { discontinuity: 0, endUs: 3_000_000n, startUs: 2_000_000n },
    ])
  })

  it('round-trips bigint cursors through Redis JSON', () => {
    const projection = applyTimelineSegments(
      emptyTimelineProjection(programId, 9_007_199_254_740_993n),
      9_007_199_254_740_994n,
      [row(9_007_199_254_740_992n, 9_007_199_254_740_992n, 9_007_199_255_740_992n)],
    )
    expect(parseTimelineProjection(serializeTimelineProjection(projection))).toEqual(projection)
  })
})
