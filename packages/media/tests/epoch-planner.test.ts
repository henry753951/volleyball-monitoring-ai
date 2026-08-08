import { describe, expect, it } from 'vitest'
import {
  CaptureEpochPlannerError,
  planCaptureEpochs,
  planNextCaptureSegment,
  type CaptureEpochPlannerConfig,
  type FinalizedIndexedSegment,
  type PersistedCaptureHead,
  type PlanNextCaptureSegmentResult,
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

function persistedHead(
  result: PlanNextCaptureSegmentResult,
  epochId = result.epoch.epochKey,
): PersistedCaptureHead {
  return {
    epochId,
    epochSequence: result.epoch.epochSequence,
    discontinuity: result.epoch.discontinuity,
    timeBase: result.epoch.timeBase,
    sourcePtsOrigin: result.epoch.sourcePtsOrigin,
    captureTimeOriginUs: result.epoch.captureTimeOriginUs,
    captureFrameOrigin: result.epoch.captureFrameOrigin,
    lastSourcePtsEndExclusive: result.segment.sourcePtsEndExclusive,
    lastCaptureEndUs: result.segment.captureEndUs,
    lastCaptureFrameIndex:
      result.segment.firstFrameIndex + result.segment.frameCount - 1n,
  }
}

function planIncremental(
  value: FinalizedIndexedSegment,
  currentHead: PersistedCaptureHead | null,
  options: {
    newEpochId?: string
    sourceRestart?: boolean
    timestampDiscontinuity?: boolean
    explicitGapBeforeUs?: bigint
    plannerConfig?: CaptureEpochPlannerConfig
  } = {},
): PlanNextCaptureSegmentResult {
  return planNextCaptureSegment({
    currentHead,
    newEpochId: options.newEpochId ?? `new-epoch-${value.segmentIdentity}`,
    segment: value,
    sourceRestart: options.sourceRestart ?? false,
    timestampDiscontinuity: options.timestampDiscontinuity ?? false,
    ...(options.explicitGapBeforeUs === undefined
      ? {}
      : { explicitGapBeforeUs: options.explicitGapBeforeUs }),
    config: options.plannerConfig ?? config,
  })
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

  it('opens a touching epoch without a playback discontinuity for a recorder-local PTS reset', () => {
    const first = segment('before-reset', 0n, 100n, [1n, 1n, 1n])
    const reset = segment('after-reset', 1n, 0n, [1n, 1n])

    const plan = planCaptureEpochs([first, reset], config)

    expect(plan.epochs).toHaveLength(2)
    expect(plan.epochs[1]!.reasons).toContain('PTS_RESET')
    expect(plan.segments[1]!.discontinuity).toBe(0)
    expect(plan.segments[1]!.sampleIndex.samples[0]!.sourcePts).toBe(0n)
    expect(plan.segments[1]!.captureStartUs).toBe(
      plan.segments[0]!.captureEndUs,
    )
    expect(plan.gaps).toHaveLength(0)
    expect(plan.availableRanges).toHaveLength(1)
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
    expect(plan.epochs.map((epoch) => epoch.discontinuity)).toEqual([0, 0, 1, 2])
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

describe('planNextCaptureSegment', () => {
  it('opens the first epoch at configured canonical origins', () => {
    const first = planIncremental(
      segment('first', 0n, -3_000n, [1_001n, 1_001n], {
        timeBase: { num: 1n, den: 60_000n },
      }),
      null,
    )

    expect(first.epoch).toMatchObject({
      disposition: 'CREATE_NEXT',
      epochKey: 'new-epoch-first',
      epochSequence: 0,
      discontinuity: 0,
      sourcePtsOrigin: -3_000n,
      captureTimeOriginUs: canonicalOriginUs,
      captureFrameOrigin: canonicalFrameOrigin,
      reasons: ['SESSION_START'],
    })
    expect(first.segment).toMatchObject({
      epochKey: 'new-epoch-first',
      captureStartUs: canonicalOriginUs,
      firstFrameIndex: canonicalFrameOrigin,
      frameCount: 2n,
      isGap: false,
    })
    expect(first.segment.sampleIndex.epochId).toBe('new-epoch-first')
    expect(first.nextCaptureFrameIndex).toBe(canonicalFrameOrigin + 2n)
    expect(() =>
      planIncremental(segment('invalid-first', 0n, 0n, [1n]), null, {
        explicitGapBeforeUs: 1n,
      }),
    ).toThrowError(
      new CaptureEpochPlannerError(
        'INVALID_SEGMENT',
        'first segment cannot declare a preceding gap',
      ),
    )
  })

  it('reuses the persisted affine epoch for an exact continuation', () => {
    const first = planIncremental(
      segment('first', 0n, 90_071_992_547_409_931n, [1n, 1n]),
      null,
    )
    const head = persistedHead(first, 'persisted-epoch-id')
    const second = planIncremental(
      segment(
        'second',
        1n,
        head.lastSourcePtsEndExclusive,
        [1n, 1n],
      ),
      head,
      { newEpochId: 'unused-new-epoch-id' },
    )

    expect(second.epoch).toEqual({
      disposition: 'REUSE_EXISTING',
      epochKey: 'persisted-epoch-id',
      epochSequence: 0,
      discontinuity: 0,
      timeBase: head.timeBase,
      sourcePtsOrigin: head.sourcePtsOrigin,
      captureTimeOriginUs: head.captureTimeOriginUs,
      captureFrameOrigin: head.captureFrameOrigin,
      reasons: [],
    })
    expect(second.segment.captureStartUs).toBe(first.segment.captureEndUs)
    expect(second.segment.firstFrameIndex).toBe(
      first.segment.firstFrameIndex + first.segment.frameCount,
    )
    expect(second.segment.sampleIndex.samples[0]).toMatchObject({
      captureTimeUs: first.segment.captureEndUs,
      captureFrameIndex: canonicalFrameOrigin + 2n,
    })
    expect(second.segment.sampleIndex.epochId).toBe('persisted-epoch-id')
  })

  it('opens a touching next epoch without splitting playback for PTS reset or overlap', () => {
    const first = planIncremental(
      segment('first', 0n, 100n, [10n, 10n]),
      null,
    )
    const head = persistedHead(first)

    for (const firstPts of [0n, 110n]) {
      const next = planIncremental(
        segment(`boundary-${firstPts}`, 1n, firstPts, [1n]),
        head,
      )
      expect(next.epoch).toMatchObject({
        disposition: 'CREATE_NEXT',
        epochKey: `new-epoch-boundary-${firstPts}`,
        epochSequence: 1,
        discontinuity: 0,
        sourcePtsOrigin: firstPts,
        captureTimeOriginUs: head.lastCaptureEndUs,
        captureFrameOrigin: head.lastCaptureFrameIndex + 1n,
      })
      expect(next.epoch.reasons).toContain('PTS_RESET')
      expect(next.segment.captureStartUs).toBe(head.lastCaptureEndUs)
      expect(next.segment.epochKey).toBe(`new-epoch-boundary-${firstPts}`)
      expect(next.segment.sampleIndex.epochId).toBe(
        `new-epoch-boundary-${firstPts}`,
      )
      expect(next.gap).toBeUndefined()
    }
  })

  it('turns a positive same-timebase PTS hole into an exact real gap', () => {
    const zeroConfig = {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
    }
    const first = planIncremental(
      segment('first', 0n, 0n, [1_000n], {
        timeBase: { num: 1n, den: 1_000n },
      }),
      null,
      { plannerConfig: zeroConfig },
    )
    const head = persistedHead(first)
    const next = planIncremental(
      segment('after-hole', 1n, 1_500n, [1_000n], {
        timeBase: { num: 1n, den: 1_000n },
      }),
      head,
      { plannerConfig: zeroConfig },
    )

    expect(next.epoch.reasons).toEqual(['TIMESTAMP_DISCONTINUITY'])
    expect(next.gap).toEqual({
      startUs: 1_000_000n,
      endUs: 1_500_000n,
      discontinuity: 1,
      reasons: ['TIMESTAMP_DISCONTINUITY'],
    })
    expect(next.segment.captureStartUs).toBe(1_500_000n)
  })

  it('reconciles an explicit gap with the PTS gap within bigint tolerance', () => {
    const timeBase = { num: 1n, den: 1_000n }
    const toleranceConfig = {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
      timestampToleranceUs: 10n,
    }
    const first = planIncremental(
      segment('first', 0n, 0n, [1_000n], { timeBase }),
      null,
      { plannerConfig: toleranceConfig },
    )
    const head = persistedHead(first)
    const matching = planIncremental(
      segment('matching', 1n, 1_500n, [1_000n], { timeBase }),
      head,
      {
        explicitGapBeforeUs: 500_010n,
        plannerConfig: toleranceConfig,
      },
    )

    expect(matching.gap).toMatchObject({
      startUs: 1_000_000n,
      endUs: 1_500_000n,
    })
    expect(matching.epoch.reasons).toEqual([
      'TIMESTAMP_DISCONTINUITY',
      'EXPLICIT_GAP',
    ])
    expect(() =>
      planIncremental(
        segment('conflicting', 1n, 1_500n, [1_000n], { timeBase }),
        head,
        {
          explicitGapBeforeUs: 500_011n,
          plannerConfig: toleranceConfig,
        },
      ),
    ).toThrowError(
      new CaptureEpochPlannerError(
        'GAP_CONFLICT',
        'independent gap observations conflict',
      ),
    )
  })

  it('opens a touching epoch for a time-base change', () => {
    const first = planIncremental(segment('first', 0n, 0n, [1n]), null)
    const head = persistedHead(first)
    const changed = planIncremental(
      segment('changed', 1n, 1n, [1_001n], {
        timeBase: { num: 1n, den: 60_000n },
      }),
      head,
    )

    expect(changed.epoch.reasons).toEqual(['TIME_BASE_CHANGE'])
    expect(changed.epoch.timeBase).toEqual({ num: 1n, den: 60_000n })
    expect(changed.segment.captureStartUs).toBe(head.lastCaptureEndUs)
  })

  it('uses only explicit lifecycle signals for restart and discontinuity', () => {
    const first = planIncremental(segment('first', 0n, 0n, [1n]), null)
    const head = persistedHead(first)
    const changedIdentityWithoutSignal = planIncremental(
      segment('identity-only', 1n, 1n, [1n], {
        sourceIdentity: 'unpersisted-new-identity',
      }),
      head,
    )
    expect(changedIdentityWithoutSignal.epoch.disposition).toBe(
      'REUSE_EXISTING',
    )

    const restarted = planIncremental(
      segment('restart', 1n, 1n, [1n], {
        sourceIdentity: 'new-source-lifetime',
      }),
      head,
      { sourceRestart: true },
    )
    expect(restarted.epoch.reasons).toEqual(['SOURCE_RESTART'])
    expect(restarted.epoch.discontinuity).toBe(1)
    expect(restarted.segment.captureStartUs).toBe(head.lastCaptureEndUs)

    const discontinuous = planIncremental(
      segment('discontinuous', 1n, 1n, [1n]),
      head,
      { timestampDiscontinuity: true },
    )
    expect(discontinuous.epoch.reasons).toEqual([
      'TIMESTAMP_DISCONTINUITY',
    ])
    expect(discontinuous.segment.captureStartUs).toBe(head.lastCaptureEndUs)
  })

  it('indexes VFR 60000/1001 samples without FPS-derived timing', () => {
    const exactConfig = {
      ...config,
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
    }
    const first = planIncremental(
      segment('vfr', 0n, -2_002n, [1_001n, 2_002n, 1_001n], {
        timeBase: { num: 1n, den: 60_000n },
      }),
      null,
      { plannerConfig: exactConfig },
    )

    expect(first.segment.sampleIndex.samples).toEqual([
      {
        sourcePts: -2_002n,
        durationPts: 1_001n,
        captureTimeUs: 0n,
        captureFrameIndex: 0n,
        keyframe: true,
      },
      {
        sourcePts: -1_001n,
        durationPts: 2_002n,
        captureTimeUs: 16_683n,
        captureFrameIndex: 1n,
        keyframe: false,
      },
      {
        sourcePts: 1_001n,
        durationPts: 1_001n,
        captureTimeUs: 50_050n,
        captureFrameIndex: 2n,
        keyframe: false,
      },
    ])
    expect(first.segment.captureEndUs).toBe(66_733n)
  })

  it('retains capture time and frame precision beyond 2^53', () => {
    const hugeTime = 90_071_992_547_409_931n
    const hugeFrame = 90_071_992_547_409_933n
    const hugeConfig = {
      ...config,
      canonicalSessionOriginUs: hugeTime,
      canonicalFrameOrigin: hugeFrame,
    }
    const first = planIncremental(
      segment('huge', 0n, -9_000n, [3_000n, 3_000n], {
        timeBase: { num: 1n, den: 90_000n },
      }),
      null,
      { plannerConfig: hugeConfig },
    )

    expect(first.segment.sampleIndex.samples[1]).toMatchObject({
      sourcePts: -6_000n,
      captureTimeUs: hugeTime + 33_333n,
      captureFrameIndex: hugeFrame + 1n,
    })
    expect(first.nextCaptureFrameIndex).toBe(hugeFrame + 2n)
  })

  it('rejects malformed persisted epoch and last-segment state', () => {
    const first = planIncremental(segment('first', 0n, 0n, [1n]), null)
    const valid = persistedHead(first)
    const malformed: PersistedCaptureHead[] = [
      { ...valid, epochId: '' },
      { ...valid, epochSequence: -1 },
      { ...valid, discontinuity: valid.epochSequence + 1 },
      { ...valid, timeBase: { num: 0n, den: 30n } },
      { ...valid, captureFrameOrigin: -1n },
      { ...valid, lastCaptureFrameIndex: valid.captureFrameOrigin - 1n },
      {
        ...valid,
        lastSourcePtsEndExclusive: valid.sourcePtsOrigin,
      },
      { ...valid, lastCaptureEndUs: valid.lastCaptureEndUs + 1n },
    ]

    for (const head of malformed) {
      expect(() =>
        planIncremental(segment('next', 1n, 1n, [1n]), head),
      ).toThrowError(CaptureEpochPlannerError)
      try {
        planIncremental(segment('next', 1n, 1n, [1n]), head)
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_PERSISTED_HEAD' })
      }
    }
  })

  it('rejects an unsafe new epoch identity even when reuse is expected', () => {
    const first = planIncremental(segment('first', 0n, 0n, [1n]), null)
    const head = persistedHead(first)

    for (const newEpochId of ['', '   ', 'bad\0identity']) {
      expect(() =>
        planIncremental(segment('next', 1n, 1n, [1n]), head, {
          newEpochId,
        }),
      ).toThrowError(
        new CaptureEpochPlannerError(
          'INVALID_CONFIG',
          'newEpochId must be a safe non-empty opaque identity',
        ),
      )
    }
  })

  it('fails safely when the next Int32 epoch cannot be represented', () => {
    const first = planIncremental(segment('first', 0n, 0n, [1n]), null)
    const exhausted: PersistedCaptureHead = {
      ...persistedHead(first),
      epochSequence: 2_147_483_647,
      discontinuity: 2_147_483_647,
    }

    expect(() =>
      planIncremental(segment('reset', 1n, 0n, [1n]), exhausted),
    ).toThrowError(
      new CaptureEpochPlannerError(
        'INT32_EXHAUSTED',
        'capture epoch Int32 sequence exhausted',
      ),
    )
  })

  it('does not fabricate a sample or frame inside an explicit gap', () => {
    const first = planIncremental(segment('first', 0n, 0n, [1n, 1n]), null)
    const head = persistedHead(first)
    const after = planIncremental(
      segment('after-gap', 1n, 2n, [1n]),
      head,
      { explicitGapBeforeUs: 5_000_000n },
    )

    expect(after.gap).toEqual({
      startUs: head.lastCaptureEndUs,
      endUs: head.lastCaptureEndUs + 5_000_000n,
      discontinuity: 1,
      reasons: ['EXPLICIT_GAP'],
    })
    expect(after.segment.sampleIndex.samples).toHaveLength(1)
    expect(after.segment.firstFrameIndex).toBe(head.lastCaptureFrameIndex + 1n)
    expect(after.nextCaptureFrameIndex).toBe(head.lastCaptureFrameIndex + 2n)
    expect(after.segment.sampleIndex.samples[0]!.captureTimeUs).toBe(
      after.gap.endUs,
    )
  })

  it('matches the batch planner for equivalent two-segment inputs', () => {
    const cases = [
      [
        segment('first-contiguous', 0n, -2_002n, [1_001n, 1_001n], {
          timeBase: { num: 1n, den: 60_000n },
        }),
        segment('second-contiguous', 1n, 0n, [1_001n], {
          timeBase: { num: 1n, den: 60_000n },
        }),
      ],
      [
        segment('first-reset', 0n, 100n, [1n, 1n]),
        segment('second-reset', 1n, 0n, [1n]),
      ],
      [
        segment('first-hole', 0n, 0n, [1_000n], {
          timeBase: { num: 1n, den: 1_000n },
        }),
        segment('second-hole', 1n, 1_500n, [1_000n], {
          timeBase: { num: 1n, den: 1_000n },
        }),
      ],
    ] as const

    for (const [firstInput, secondInput] of cases) {
      const batch = planCaptureEpochs([firstInput, secondInput], config)
      const first = planIncremental(firstInput, null, {
        newEpochId: 'capture-epoch-0',
      })
      const second = planIncremental(secondInput, persistedHead(first), {
        newEpochId: 'capture-epoch-1',
      })
      const expected = batch.segments[1]!

      expect(second.epoch).toMatchObject({
        epochKey: expected.epochKey,
        epochSequence: expected.epochSequence,
        discontinuity: expected.discontinuity,
      })
      expect(second.segment).toMatchObject({
        sourcePtsStart: expected.sourceStartPts,
        sourcePtsEndExclusive: expected.sourceEndPtsExclusive,
        captureStartUs: expected.captureStartUs,
        captureEndUs: expected.captureEndUs,
        sampleIndex: expected.sampleIndex,
      })
      expect(second.liveEdgeCaptureTimeUs).toBe(
        batch.liveEdgeCaptureTimeUs,
      )
      expect(second.nextCaptureFrameIndex).toBe(batch.nextCaptureFrameIndex)
    }
  })
})
