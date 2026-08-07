import { describe, expect, it } from 'vitest'
import {
  CaptureEpochPlannerError,
  planCaptureEpochs,
  type CaptureEpochPlannerConfig,
  type FinalizedIndexedSegment,
  type Rational,
} from '../src/epoch-planner'

const canonicalOriginUs = 8_007_199_254_740_993n
const canonicalFrameOrigin = 9_007_199_254_740_993n
const config: CaptureEpochPlannerConfig = {
  canonicalSessionOriginUs: canonicalOriginUs,
  canonicalFrameOrigin,
  timestampToleranceUs: 0n,
}

function segment(
  segmentIdentity: string,
  sourceOrder: bigint,
  sourcePts: bigint,
  durations: readonly bigint[],
  options: {
    sourceIdentity?: string
    timeBase?: Rational
    sourceStartTimeUs?: bigint
    sourceRestart?: boolean
    timestampDiscontinuity?: boolean
    explicitGapBeforeUs?: bigint
  } = {},
): FinalizedIndexedSegment {
  let pts = sourcePts
  const samples = durations.map((durationPts, index) => {
    const sample = {
      sourcePts: pts,
      durationPts,
      keyframe: index === 0,
    }
    pts += durationPts
    return sample
  })
  return {
    segmentIdentity,
    sourceIdentity: options.sourceIdentity ?? 'camera-process-1',
    sourceOrder,
    timeBase: options.timeBase ?? { num: 1n, den: 30n },
    samples,
    ...(options.sourceStartTimeUs === undefined
      ? {}
      : { sourceStartTimeUs: options.sourceStartTimeUs }),
    ...(options.sourceRestart === undefined
      ? {}
      : { sourceRestart: options.sourceRestart }),
    ...(options.timestampDiscontinuity === undefined
      ? {}
      : { timestampDiscontinuity: options.timestampDiscontinuity }),
    ...(options.explicitGapBeforeUs === undefined
      ? {}
      : { explicitGapBeforeUs: options.explicitGapBeforeUs }),
  }
}

describe('planCaptureEpochs', () => {
  it('keeps exact 30fps segment boundaries in one epoch', () => {
    const startPts = 9_007_199_254_740_993n
    const first = segment('segment-1', 0n, startPts, [1n, 1n, 1n])
    const second = segment('segment-2', 1n, startPts + 3n, [1n, 1n])

    const plan = planCaptureEpochs([first, second], config)

    expect(plan.epochs).toHaveLength(1)
    expect(plan.segments[0]!.captureStartUs).toBe(canonicalOriginUs)
    expect(plan.segments[0]!.captureEndUs).toBe(canonicalOriginUs + 100_000n)
    expect(plan.segments[1]!.captureStartUs).toBe(
      plan.segments[0]!.captureEndUs,
    )
    expect(plan.availableRanges).toEqual([
      {
        startUs: canonicalOriginUs,
        endUs: canonicalOriginUs + 166_667n,
        discontinuity: 0,
        segmentIdentities: ['segment-1', 'segment-2'],
      },
    ])
    expect(plan.nextCaptureFrameIndex).toBe(canonicalFrameOrigin + 5n)
  })

  it('preserves true 60000/1001 timing without per-frame rounding drift', () => {
    const timeBase = { num: 1n, den: 60_000n }
    const first = segment('segment-1', 0n, 0n, [1_001n, 1_001n], {
      timeBase,
    })
    const second = segment('segment-2', 1n, 2_002n, [1_001n], {
      timeBase,
    })

    const plan = planCaptureEpochs([first, second], {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
    })

    expect(plan.segments[0]!.sampleIndex.samples.map((sample) => sample.captureTimeUs))
      .toEqual([0n, 16_683n])
    expect(plan.segments[0]!.captureEndUs).toBe(33_367n)
    expect(plan.segments[1]!.captureStartUs).toBe(33_367n)
    expect(plan.liveEdgeCaptureTimeUs).toBe(50_050n)
  })

  it('uses VFR sample durations for the next segment boundary', () => {
    const timeBase = { num: 1n, den: 90_000n }
    const first = segment('segment-1', 0n, 0n, [1_501n, 1_502n], {
      timeBase,
    })
    const second = segment('segment-2', 1n, 3_003n, [3_000n], {
      timeBase,
    })

    const plan = planCaptureEpochs([first, second], {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
    })

    expect(plan.segments[0]!.sampleIndex.samples.map((sample) => sample.captureTimeUs))
      .toEqual([0n, 16_678n])
    expect(plan.segments[0]!.captureEndUs).toBe(33_367n)
    expect(plan.segments[1]!.captureStartUs).toBe(33_367n)
    expect(plan.segments[1]!.captureEndUs).toBe(66_700n)
  })

  it('preserves negative source PTS inside the epoch mapping', () => {
    const first = segment('segment-1', 0n, -9_000n, [3_000n, 3_000n], {
      timeBase: { num: 1n, den: 90_000n },
    })
    const second = segment('segment-2', 1n, -3_000n, [3_000n], {
      timeBase: { num: 1n, den: 90_000n },
    })

    const plan = planCaptureEpochs([first, second], config)

    expect(plan.epochs[0]!.sourcePtsOrigin).toBe(-9_000n)
    expect(plan.segments[1]!.sampleIndex.samples[0]!.sourcePts).toBe(-3_000n)
    expect(plan.segments[1]!.captureStartUs).toBe(
      canonicalOriginUs + 66_667n,
    )
  })

  it('retains bigint precision beyond JavaScript safe integers', () => {
    const startPts = 90_071_992_547_409_931n
    const plan = planCaptureEpochs(
      [segment('huge-segment', 90_071_992_547_409_931n, startPts, [1n, 1n])],
      config,
    )

    expect(plan.epochs[0]!.sourcePtsOrigin).toBe(startPts)
    expect(plan.segments[0]!.sampleIndex.samples[1]).toMatchObject({
      sourcePts: startPts + 1n,
      captureTimeUs: canonicalOriginUs + 33_333n,
      captureFrameIndex: canonicalFrameOrigin + 1n,
    })
  })

  it('opens a touching discontinuity when PTS resets without known downtime', () => {
    const first = segment('before-reset', 0n, 100n, [1n, 1n, 1n])
    const reset = segment('after-reset', 1n, 0n, [1n, 1n])

    const plan = planCaptureEpochs([first, reset], config)

    expect(plan.epochs).toHaveLength(2)
    expect(plan.epochs[1]!.reasons).toContain('PTS_RESET')
    expect(plan.segments[1]!.discontinuity).toBe(1)
    expect(plan.segments[1]!.sampleIndex.samples[0]!.sourcePts).toBe(0n)
    expect(plan.segments[1]!.captureStartUs).toBe(
      plan.segments[0]!.captureEndUs,
    )
    expect(plan.gaps).toHaveLength(0)
    expect(plan.availableRanges).toHaveLength(2)
  })

  it('turns a forward PTS timestamp jump into a real unavailable range', () => {
    const timeBase = { num: 1n, den: 1_000n }
    const first = segment('before-jump', 0n, 0n, [1_000n], { timeBase })
    const jumped = segment('after-jump', 1n, 1_500n, [1_000n], { timeBase })

    const plan = planCaptureEpochs([first, jumped], {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
    })

    expect(plan.epochs[1]!.reasons).toEqual(['TIMESTAMP_DISCONTINUITY'])
    expect(plan.gaps).toEqual([
      {
        startUs: 1_000_000n,
        endUs: 1_500_000n,
        beforeSegmentIdentity: 'before-jump',
        afterSegmentIdentity: 'after-jump',
        discontinuity: 1,
        reasons: ['TIMESTAMP_DISCONTINUITY'],
      },
    ])
    expect(plan.segments[1]!.captureStartUs).toBe(1_500_000n)
  })

  it('opens a new epoch for a source restart or identity change', () => {
    const first = segment('before-restart', 0n, 0n, [1n])
    const restarted = segment('after-restart', 1n, 1n, [1n], {
      sourceIdentity: 'camera-process-2',
      sourceRestart: true,
    })

    const plan = planCaptureEpochs([first, restarted], config)

    expect(plan.epochs[1]).toMatchObject({
      epochSequence: 1,
      discontinuity: 1,
      sourceIdentity: 'camera-process-2',
      reasons: ['SOURCE_RESTART', 'SOURCE_IDENTITY_CHANGE'],
    })
    expect(plan.gaps).toHaveLength(0)
  })

  it('represents an explicit missing interval without fabricating samples', () => {
    const first = segment('before-gap', 0n, 0n, [1n, 1n])
    const after = segment('after-gap', 1n, 2n, [1n], {
      explicitGapBeforeUs: 5_000_000n,
    })

    const plan = planCaptureEpochs([first, after], {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
    })

    expect(plan.gaps).toEqual([
      {
        startUs: 66_667n,
        endUs: 5_066_667n,
        beforeSegmentIdentity: 'before-gap',
        afterSegmentIdentity: 'after-gap',
        discontinuity: 1,
        reasons: ['EXPLICIT_GAP'],
      },
    ])
    expect(plan.segments[1]!.captureStartUs).toBe(5_066_667n)
    const allSampleTimes = plan.segments.flatMap((value) =>
      value.sampleIndex.samples.map((sample) => sample.captureTimeUs),
    )
    expect(
      allSampleTimes.some((time) => time > 66_667n && time < 5_066_667n),
    ).toBe(false)
  })

  it('keeps a declared discontinuity boundary explicit even without a gap', () => {
    const first = segment('segment-1', 0n, 0n, [1n])
    const second = segment('segment-2', 1n, 1n, [1n], {
      timestampDiscontinuity: true,
    })

    const plan = planCaptureEpochs([first, second], config)

    expect(plan.epochs[1]!.reasons).toEqual(['TIMESTAMP_DISCONTINUITY'])
    expect(plan.segments[1]!.captureStartUs).toBe(
      plan.segments[0]!.captureEndUs,
    )
    expect(plan.availableRanges.map((range) => range.discontinuity)).toEqual([
      0, 1,
    ])
  })

  it('uses explicit bigint timestamp tolerance and exposes real timestamp drift', () => {
    const first = segment('segment-1', 0n, 0n, [1_000n], {
      timeBase: { num: 1n, den: 1_000n },
      sourceStartTimeUs: 10_000_000n,
    })
    const withinTolerance = segment('segment-2', 1n, 1_000n, [1_000n], {
      timeBase: { num: 1n, den: 1_000n },
      sourceStartTimeUs: 11_000_005n,
    })
    const drifted = segment('segment-2', 1n, 1_000n, [1_000n], {
      timeBase: { num: 1n, den: 1_000n },
      sourceStartTimeUs: 11_000_011n,
    })
    const toleranceConfig = { ...config, timestampToleranceUs: 10n }

    expect(planCaptureEpochs([first, withinTolerance], toleranceConfig).epochs)
      .toHaveLength(1)
    const driftPlan = planCaptureEpochs([first, drifted], toleranceConfig)
    expect(driftPlan.epochs[1]!.reasons).toEqual([
      'TIMESTAMP_DISCONTINUITY',
    ])
    expect(driftPlan.gaps[0]!.endUs - driftPlan.gaps[0]!.startUs).toBe(11n)
  })

  it('deduplicates an exact replay deterministically, including after newer input', () => {
    const first = segment('segment-1', 0n, 0n, [1n, 1n])
    const second = segment('segment-2', 1n, 2n, [1n])
    const replay = {
      ...first,
      samples: first.samples.map((sample) => ({ ...sample })),
    }

    const baseline = planCaptureEpochs([first, second], config)
    const replayed = planCaptureEpochs([first, second, replay], config)

    expect(replayed).toEqual(baseline)
    expect(replayed.segments.map((value) => value.segmentIdentity)).toEqual([
      'segment-1',
      'segment-2',
    ])
  })

  it('fails closed on out-of-order, reused-order, and conflicting replay input', () => {
    const first = segment('segment-1', 0n, 0n, [1n])
    const second = segment('segment-2', 1n, 1n, [1n])
    const conflictingReplay = segment('segment-1', 0n, 0n, [2n])
    const reusedOrder = segment('other-segment', 0n, 1n, [1n])

    expect(() => planCaptureEpochs([second, first], config)).toThrowError(
      new CaptureEpochPlannerError(
        'ORDER_CONFLICT',
        'segments must arrive in strictly increasing source order',
      ),
    )
    expect(() => planCaptureEpochs([first, reusedOrder], config)).toThrowError(
      CaptureEpochPlannerError,
    )
    expect(() =>
      planCaptureEpochs([first, conflictingReplay], config),
    ).toThrowError(
      new CaptureEpochPlannerError(
        'DUPLICATE_CONFLICT',
        'segment segment-1 replay conflicts',
      ),
    )
  })

  it('keeps canonical samples monotonic across reset, gap, and restart epochs', () => {
    const segments = [
      segment('initial', 0n, 100n, [1n, 1n]),
      segment('reset', 1n, 0n, [1n, 1n]),
      segment('gap', 2n, 2n, [1n], { explicitGapBeforeUs: 2_000_000n }),
      segment('restart', 3n, 0n, [1n], {
        sourceIdentity: 'camera-process-2',
        sourceRestart: true,
      }),
    ]

    const plan = planCaptureEpochs(segments, config)
    const samples = plan.segments.flatMap((value) => value.sampleIndex.samples)

    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!.captureTimeUs).toBeGreaterThan(
        samples[index - 1]!.captureTimeUs,
      )
      expect(samples[index]!.captureFrameIndex).toBe(
        samples[index - 1]!.captureFrameIndex + 1n,
      )
    }
    expect(plan.epochs.map((epoch) => epoch.discontinuity)).toEqual([0, 1, 2, 3])
    expect(plan.liveEdgeCaptureTimeUs).toBeGreaterThan(canonicalOriginUs)
  })

  it('fails when independent real-gap observations disagree beyond tolerance', () => {
    const first = segment('segment-1', 0n, 0n, [1_000n], {
      timeBase: { num: 1n, den: 1_000n },
      sourceStartTimeUs: 0n,
    })
    const second = segment('segment-2', 1n, 2_000n, [1_000n], {
      timeBase: { num: 1n, den: 1_000n },
      sourceStartTimeUs: 2_000_000n,
      explicitGapBeforeUs: 500_000n,
    })

    expect(() =>
      planCaptureEpochs([first, second], {
        ...config,
        timestampToleranceUs: 10n,
      }),
    ).toThrowError(
      new CaptureEpochPlannerError(
        'GAP_CONFLICT',
        'independent gap observations conflict',
      ),
    )
  })

  it('rejects internal sample holes instead of hiding a discontinuity in one segment', () => {
    const invalid: FinalizedIndexedSegment = {
      ...segment('invalid', 0n, 0n, [1n, 1n]),
      samples: [
        { sourcePts: 0n, durationPts: 1n, keyframe: true },
        { sourcePts: 2n, durationPts: 1n, keyframe: false },
      ],
    }

    expect(() => planCaptureEpochs([invalid], config)).toThrowError(
      new CaptureEpochPlannerError(
        'INVALID_SEGMENT',
        'sample table must be contiguous within a segment',
      ),
    )
  })
})
