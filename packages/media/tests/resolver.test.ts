import { describe, expect, it } from 'vitest'
import {
  buildSampleIndex,
  type CaptureEpochOrigin,
  type SampleIndex,
} from '../src/sample-index'
import {
  frameStep,
  frameStepAcrossSegments,
  resolveCanonicalTime,
  resolveCanonicalTimeAcrossSegments,
  ResolverError,
  type IndexedSegment,
} from '../src/resolver'

const large = 9_007_199_254_740_993n
const timeBase = { num: 1n, den: 60_000n }
const origin: CaptureEpochOrigin = {
  epochId: 'epoch-0',
  sourcePtsOrigin: -large,
  captureTimeOriginUs: large,
  captureFrameOrigin: large,
  timeBase,
}

function twoTouchingSegments(): [IndexedSegment, IndexedSegment] {
  const first = buildSampleIndex(
    [
      {
        media_type: 'video',
        pts: (-large).toString(),
        pkt_duration: '1001',
        key_frame: 1,
      },
      {
        media_type: 'video',
        pts: (-large + 1_001n).toString(),
        pkt_duration: '1001',
      },
    ],
    origin,
  )
  const second = buildSampleIndex(
    [
      {
        media_type: 'video',
        pts: (-large + 2_002n).toString(),
        pkt_duration: '1001',
      },
      {
        media_type: 'video',
        pts: (-large + 3_003n).toString(),
        pkt_duration: '1001',
      },
    ],
    { ...origin, captureFrameOrigin: large + 2n },
  )
  return [
    { segmentId: 'first', index: first, discontinuity: 7 },
    { segmentId: 'second', index: second, discontinuity: 7 },
  ]
}

function oneSampleIndex(options: {
  epochId?: string
  sourcePts: bigint
  captureTimeUs: bigint
  captureFrameIndex: bigint
  sampleTimeBase?: { num: bigint; den: bigint }
}): SampleIndex {
  const sampleTimeBase = options.sampleTimeBase ?? timeBase
  return buildSampleIndex(
    [
      {
        media_type: 'video',
        pts: options.sourcePts.toString(),
        pkt_duration: '1001',
      },
    ],
    {
      epochId: options.epochId ?? origin.epochId,
      sourcePtsOrigin: options.sourcePts,
      captureTimeOriginUs: options.captureTimeUs,
      captureFrameOrigin: options.captureFrameIndex,
      timeBase: sampleTimeBase,
    },
  )
}

function expectResolverCode(
  action: () => unknown,
  code: ResolverError['code'],
  message?: string,
) {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ResolverError)
    expect((error as ResolverError).code).toBe(code)
    if (message !== undefined) {
      expect((error as ResolverError).message).toBe(message)
    }
    return
  }
  throw new Error(`expected ResolverError ${code}`)
}

describe('canonical sample resolution', () => {
  it('returns frame_exact for both exact and nonzero single-segment snaps', () => {
    const [first] = twoTouchingSegments()
    const exact = resolveCanonicalTime(
      first.index,
      first.segmentId,
      first.index.samples[1]!.captureTimeUs,
    )
    const snapped = resolveCanonicalTime(
      first.index,
      first.segmentId,
      first.index.samples[1]!.captureTimeUs + 17n,
    )

    expect(exact).toMatchObject({ kind: 'frame_exact', snapDistanceUs: '0' })
    expect(snapped).toMatchObject({
      kind: 'frame_exact',
      snapDistanceUs: '17',
    })
  })

  it('searches globally on both sides of a touching segment boundary', () => {
    const segments = twoTouchingSegments()
    const left = segments[0].index.samples.at(-1)!
    const right = segments[1].index.samples[0]!
    const windowStartUs = segments[0].index.availableStartUs
    const windowEndUs = segments[1].index.availableEndUs

    expect(
      resolveCanonicalTimeAcrossSegments(
        segments,
        left.captureTimeUs + 1n,
        windowStartUs,
        windowEndUs,
      ),
    ).toMatchObject({
      kind: 'frame_exact',
      segmentId: 'first',
      snapDistanceUs: '1',
      sample: { captureFrameIndex: left.captureFrameIndex.toString() },
    })
    expect(
      resolveCanonicalTimeAcrossSegments(
        segments,
        right.captureTimeUs - 1n,
        windowStartUs,
        windowEndUs,
      ),
    ).toMatchObject({
      kind: 'frame_exact',
      segmentId: 'second',
      snapDistanceUs: '1',
      sample: { captureFrameIndex: right.captureFrameIndex.toString() },
    })
  })

  it('chooses the earlier capture time on an exact tie across a boundary', () => {
    const segments = twoTouchingSegments()
    const earlier = segments[0].index.samples.at(-1)!
    const later = segments[1].index.samples[0]!
    const midpoint =
      earlier.captureTimeUs +
      (later.captureTimeUs - earlier.captureTimeUs) / 2n

    expect(later.captureTimeUs - midpoint).toBe(
      midpoint - earlier.captureTimeUs,
    )
    expect(
      resolveCanonicalTimeAcrossSegments(
        segments,
        midpoint,
        segments[0].index.availableStartUs,
        segments[1].index.availableEndUs,
      ),
    ).toMatchObject({
      segmentId: 'first',
      snapDistanceUs: '8342',
      sample: { captureTimeUs: earlier.captureTimeUs.toString() },
    })
  })

  it('preserves negative source PTS and canonical values beyond 2^53', () => {
    const segments = twoTouchingSegments()
    const target = segments[1].index.samples[1]!

    const result = resolveCanonicalTimeAcrossSegments(
      segments,
      target.captureTimeUs,
      segments[0].index.availableStartUs,
      segments[1].index.availableEndUs,
    )

    expect(BigInt(result.sample.sourcePts)).toBeLessThan(0n)
    expect(result.sample.captureTimeUs).toBe(target.captureTimeUs.toString())
    expect(result.sample.captureFrameIndex).toBe(
      target.captureFrameIndex.toString(),
    )
    expect(BigInt(result.sample.captureTimeUs)).toBeGreaterThan(2n ** 53n)
    expect(BigInt(result.sample.captureFrameIndex)).toBeGreaterThan(2n ** 53n)
  })

  it('enforces start-inclusive and end-exclusive playback bounds', () => {
    const segments = twoTouchingSegments()
    const startUs = segments[1].index.availableStartUs
    const endUs = segments[1].index.availableEndUs

    expect(
      resolveCanonicalTimeAcrossSegments(segments, startUs, startUs, endUs),
    ).toMatchObject({ segmentId: 'second', snapDistanceUs: '0' })
    expectResolverCode(
      () => resolveCanonicalTimeAcrossSegments(segments, endUs, startUs, endUs),
      'CAPTURE_GAP',
    )
    expectResolverCode(
      () =>
        resolveCanonicalTimeAcrossSegments(
          segments,
          startUs - 1n,
          startUs,
          endUs,
        ),
      'CAPTURE_GAP',
    )
  })
})

describe('canonical frame step', () => {
  it('steps exactly one persisted sample across a touching segment boundary', () => {
    const segments = twoTouchingSegments()
    const current = segments[0].index.samples.at(-1)!
    const expected = segments[1].index.samples[0]!

    expect(
      frameStepAcrossSegments(
        segments,
        current.captureFrameIndex,
        'next',
        segments[0].index.availableStartUs,
        segments[1].index.availableEndUs,
      ),
    ).toEqual({
      kind: 'frame_exact',
      epochId: 'epoch-0',
      segmentId: 'second',
      sample: {
        sourcePts: expected.sourcePts.toString(),
        captureTimeUs: expected.captureTimeUs.toString(),
        captureFrameIndex: expected.captureFrameIndex.toString(),
      },
    })
    expect(
      frameStepAcrossSegments(
        segments,
        expected.captureFrameIndex,
        'previous',
        segments[0].index.availableStartUs,
        segments[1].index.availableEndUs,
      ),
    ).toMatchObject({
      segmentId: 'first',
      sample: { captureFrameIndex: current.captureFrameIndex.toString() },
    })
  })

  it('returns WINDOW_BOUNDARY when the valid adjacent sample is outside the window', () => {
    const segments = twoTouchingSegments()
    const current = segments[0].index.samples.at(-1)!
    const next = segments[1].index.samples[0]!

    expectResolverCode(
      () =>
        frameStepAcrossSegments(
          segments,
          current.captureFrameIndex,
          'next',
          segments[0].index.availableStartUs,
          next.captureTimeUs,
        ),
      'WINDOW_BOUNDARY',
    )
  })

  it('rejects a current sample before the window when stepping next inward', () => {
    const segments = twoTouchingSegments()
    const outsideCurrent = segments[0].index.samples[0]!
    const insideNext = segments[0].index.samples[1]!

    expectResolverCode(
      () =>
        frameStepAcrossSegments(
          segments,
          outsideCurrent.captureFrameIndex,
          'next',
          insideNext.captureTimeUs,
          segments[1].index.availableEndUs,
        ),
      'SAMPLE_NOT_FOUND',
    )
  })

  it('rejects a current sample at the exclusive window end when stepping previous inward', () => {
    const segments = twoTouchingSegments()
    const outsideCurrent = segments[1].index.samples.at(-1)!

    expectResolverCode(
      () =>
        frameStepAcrossSegments(
          segments,
          outsideCurrent.captureFrameIndex,
          'previous',
          segments[0].index.availableStartUs,
          outsideCurrent.captureTimeUs,
        ),
      'SAMPLE_NOT_FOUND',
    )
  })

  it('returns SAMPLE_NOT_FOUND at the actual beginning and end', () => {
    const segments = twoTouchingSegments()
    const first = segments[0].index.samples[0]!
    const last = segments[1].index.samples.at(-1)!

    expectResolverCode(
      () =>
        frameStepAcrossSegments(
          segments,
          first.captureFrameIndex,
          'previous',
          segments[0].index.availableStartUs,
          segments[1].index.availableEndUs,
        ),
      'SAMPLE_NOT_FOUND',
    )
    expectResolverCode(
      () =>
        frameStepAcrossSegments(
          segments,
          last.captureFrameIndex,
          'next',
          segments[0].index.availableStartUs,
          segments[1].index.availableEndUs,
        ),
      'SAMPLE_NOT_FOUND',
    )
  })

  it.each([
    ['gap', 'no adjacent sample across canonical gap'],
    ['discontinuity', 'no adjacent sample across discontinuity'],
    ['epoch', 'no adjacent sample across capture epoch'],
  ] as const)(
    'returns SAMPLE_NOT_FOUND instead of crossing a %s boundary',
    (boundary, message) => {
      const segments = twoTouchingSegments()
      const current = segments[0].index.samples.at(-1)!
      if (boundary === 'gap') {
        const shiftedStartUs = segments[1].index.availableStartUs + 1n
        segments[1] = {
          ...segments[1],
          index: oneSampleIndex({
            sourcePts: segments[1].index.samples[0]!.sourcePts,
            captureTimeUs: shiftedStartUs,
            captureFrameIndex: current.captureFrameIndex + 1n,
          }),
        }
      } else if (boundary === 'discontinuity') {
        segments[1] = { ...segments[1], discontinuity: 8 }
      } else {
        segments[1] = {
          ...segments[1],
          index: {
            ...segments[1].index,
            epochId: 'epoch-1',
          },
        }
      }

      expectResolverCode(
        () =>
          frameStepAcrossSegments(
            segments,
            current.captureFrameIndex,
            'next',
            segments[0].index.availableStartUs,
            segments[1].index.availableEndUs,
          ),
        'SAMPLE_NOT_FOUND',
        message,
      )
    },
  )

  it('keeps the single-segment step API exact', () => {
    const [first] = twoTouchingSegments()
    const current = first.index.samples[0]!
    const expected = first.index.samples[1]!

    expect(
      frameStep(
        first.index,
        first.segmentId,
        current.captureFrameIndex,
        'next',
      ),
    ).toMatchObject({
      kind: 'frame_exact',
      epochId: origin.epochId,
      segmentId: first.segmentId,
      sample: { captureFrameIndex: expected.captureFrameIndex.toString() },
    })
  })
})

describe('cross-segment validation', () => {
  it('rejects empty sets, empty IDs, and duplicate IDs', () => {
    expectResolverCode(
      () => resolveCanonicalTimeAcrossSegments([], 0n, 0n, 1n),
      'INVALID_SEGMENT_SET',
    )
    const segments = twoTouchingSegments()
    expectResolverCode(
      () =>
        resolveCanonicalTimeAcrossSegments(
          [{ ...segments[0], segmentId: ' ' }],
          segments[0].index.availableStartUs,
          segments[0].index.availableStartUs,
          segments[0].index.availableEndUs,
        ),
      'INVALID_SEGMENT_SET',
    )
    expectResolverCode(
      () =>
        resolveCanonicalTimeAcrossSegments(
          [segments[0], { ...segments[1], segmentId: segments[0].segmentId }],
          segments[0].index.availableStartUs,
          segments[0].index.availableStartUs,
          segments[1].index.availableEndUs,
        ),
      'INVALID_SEGMENT_SET',
    )
  })

  it.each(['order', 'gap', 'overlap'] as const)(
    'rejects invalid segment range %s',
    (failure) => {
      const segments = twoTouchingSegments()
      const indexedStartUs = segments[0].index.availableStartUs
      const indexedEndUs = segments[1].index.availableEndUs
      if (failure === 'order') {
        segments.reverse()
      } else {
        const firstLast = segments[0].index.samples.at(-1)!
        const delta = failure === 'gap' ? 1n : -1n
        const captureTimeUs = segments[1].index.availableStartUs + delta
        segments[1] = {
          ...segments[1],
          index: oneSampleIndex({
            sourcePts: firstLast.sourcePts + firstLast.durationPts,
            captureTimeUs,
            captureFrameIndex: firstLast.captureFrameIndex + 1n,
          }),
        }
      }

      expectResolverCode(
        () =>
          resolveCanonicalTimeAcrossSegments(
            segments,
            indexedStartUs,
            indexedStartUs,
            indexedEndUs,
          ),
        'INVALID_SEGMENT_SET',
      )
    },
  )

  it.each(['discontinuity', 'epoch'] as const)(
    'rejects a resolver set that crosses a %s boundary',
    (boundary) => {
      const segments = twoTouchingSegments()
      if (boundary === 'discontinuity') {
        segments[1] = { ...segments[1], discontinuity: 8 }
      } else {
        segments[1] = {
          ...segments[1],
          index: { ...segments[1].index, epochId: 'epoch-1' },
        }
      }

      expectResolverCode(
        () =>
          resolveCanonicalTimeAcrossSegments(
            segments,
            segments[0].index.availableStartUs,
            segments[0].index.availableStartUs,
            segments[1].index.availableEndUs,
          ),
        'INVALID_SEGMENT_SET',
      )
    },
  )

  it('rejects frame discontinuity, time-base mismatch, and duplicate samples', () => {
    const [first, second] = twoTouchingSegments()
    const secondFirst = second.index.samples[0]!
    const frameDiscontinuity: IndexedSegment = {
      ...second,
      index: oneSampleIndex({
        sourcePts: secondFirst.sourcePts,
        captureTimeUs: secondFirst.captureTimeUs,
        captureFrameIndex: secondFirst.captureFrameIndex + 1n,
      }),
    }
    const mismatchedTimeBase: IndexedSegment = {
      ...second,
      index: oneSampleIndex({
        sourcePts: secondFirst.sourcePts,
        captureTimeUs: secondFirst.captureTimeUs,
        captureFrameIndex: secondFirst.captureFrameIndex,
        sampleTimeBase: { num: 1n, den: 90_000n },
      }),
    }
    const duplicateSourceSample: IndexedSegment = {
      ...second,
      index: oneSampleIndex({
        sourcePts: first.index.samples.at(-1)!.sourcePts,
        captureTimeUs: secondFirst.captureTimeUs,
        captureFrameIndex: secondFirst.captureFrameIndex,
      }),
    }

    for (const invalid of [
      frameDiscontinuity,
      mismatchedTimeBase,
      duplicateSourceSample,
    ]) {
      expectResolverCode(
        () =>
          resolveCanonicalTimeAcrossSegments(
            [first, invalid],
            first.index.availableStartUs,
            first.index.availableStartUs,
            invalid.index.availableEndUs,
          ),
        'INVALID_SEGMENT_SET',
      )
    }
  })

  it('rejects invalid or out-of-range windows before resolving or stepping', () => {
    const segments = twoTouchingSegments()
    const indexedStartUs = segments[0].index.availableStartUs
    const indexedEndUs = segments[1].index.availableEndUs

    for (const [startUs, endUs] of [
      [indexedStartUs, indexedStartUs],
      [indexedStartUs - 1n, indexedEndUs],
      [indexedStartUs, indexedEndUs + 1n],
    ] as const) {
      expectResolverCode(
        () =>
          resolveCanonicalTimeAcrossSegments(
            segments,
            indexedStartUs,
            startUs,
            endUs,
          ),
        'INVALID_SEGMENT_SET',
      )
      expectResolverCode(
        () =>
          frameStepAcrossSegments(
            segments,
            segments[0].index.samples[0]!.captureFrameIndex,
            'next',
            startUs,
            endUs,
          ),
        'INVALID_SEGMENT_SET',
      )
    }
  })

  it('rejects a segment that violates persisted index codec invariants', () => {
    const [first] = twoTouchingSegments()
    const malformed: IndexedSegment = {
      ...first,
      index: {
        ...first.index,
        samples: [
          { ...first.index.samples[0]!, durationPts: 0n },
          first.index.samples[1]!,
        ],
      },
    }

    expectResolverCode(
      () =>
        resolveCanonicalTimeAcrossSegments(
          [malformed],
          malformed.index.availableStartUs,
          malformed.index.availableStartUs,
          malformed.index.availableEndUs,
        ),
      'INVALID_SEGMENT_SET',
    )
  })
})
