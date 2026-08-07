import { describe, expect, it } from 'vitest'
import {
  buildAvailabilityRanges,
  buildSampleIndex,
  parseSampleIndexDocument,
  serializeSampleIndex,
  type CaptureEpochOrigin,
  type FfprobeFrame,
  type SampleIndex,
  type SampleIndexDocument,
} from '../src/sample-index'

const large = 9_007_199_254_740_993n

const epochOrigin: CaptureEpochOrigin = {
  epochId: 'epoch-v1',
  sourcePtsOrigin: -large,
  captureTimeOriginUs: large,
  captureFrameOrigin: large,
  timeBase: { num: 1n, den: 60_000n },
}

const canonicalFrames: FfprobeFrame[] = [
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
    key_frame: 0,
  },
  {
    media_type: 'video',
    pts: (-large + 2_002n).toString(),
    pkt_duration: '1001',
    key_frame: 0,
  },
]

function validIndex(): SampleIndex {
  return buildSampleIndex(canonicalFrames, epochOrigin)
}

function validDocument(): SampleIndexDocument {
  return serializeSampleIndex(validIndex())
}

function documentWithSampleOverride(
  override: Record<string, unknown>,
  sampleIndex = 0,
): unknown {
  const document = validDocument()
  return {
    ...document,
    samples: document.samples.map((sample, index) =>
      index === sampleIndex ? { ...sample, ...override } : sample,
    ),
  }
}

describe('strict sample index v1 codec', () => {
  it('materializes bigint values and is a stable JSON byte inverse', () => {
    const original = validIndex()
    const documentBytes = JSON.stringify(serializeSampleIndex(original))
    const parsed = parseSampleIndexDocument(
      JSON.parse(documentBytes),
      epochOrigin,
    )

    expect(parsed).toEqual(original)
    expect(parsed.samples[0]).toMatchObject({
      sourcePts: -large,
      captureTimeUs: large,
      captureFrameIndex: large,
    })
    expect(JSON.stringify(serializeSampleIndex(parsed))).toBe(documentBytes)
  })

  it('preserves all persisted 64-bit sample fields beyond safe integers', () => {
    const duration = large
    const origin: CaptureEpochOrigin = {
      epochId: 'huge-epoch',
      sourcePtsOrigin: -large,
      captureTimeOriginUs: large,
      captureFrameOrigin: large,
      timeBase: { num: 1n, den: 1_000_000n },
    }
    const index = buildSampleIndex(
      [
        {
          media_type: 'video',
          pts: (-large).toString(),
          pkt_duration: duration.toString(),
          key_frame: 1,
        },
        {
          media_type: 'video',
          pts: '0',
          pkt_duration: duration.toString(),
          key_frame: 0,
        },
      ],
      origin,
    )
    const document = serializeSampleIndex(index)

    expect(document.samples[0]!.sourcePts).toBe((-large).toString())
    expect(document.samples[0]!.durationPts).toBe(large.toString())
    expect(BigInt(document.samples[1]!.captureTimeUs)).toBeGreaterThan(large)
    expect(BigInt(document.samples[1]!.captureFrameIndex)).toBeGreaterThanOrEqual(
      large,
    )
    expect(parseSampleIndexDocument(document, origin)).toEqual(index)
  })

  it.each([
    null,
    [],
    {},
    { schemaVersion: '1.0.0', epochId: 'epoch-v1', timeBase: {} },
  ])('rejects malformed document containers', (value) => {
    expect(() => parseSampleIndexDocument(value, epochOrigin)).toThrow()
  })

  it('rejects unknown fields at every document level', () => {
    const document = validDocument()

    expect(() =>
      parseSampleIndexDocument({ ...document, extra: true }, epochOrigin),
    ).toThrow('unknown or missing fields')
    expect(() =>
      parseSampleIndexDocument(
        { ...document, timeBase: { ...document.timeBase, extra: true } },
        epochOrigin,
      ),
    ).toThrow('unknown or missing fields')
    expect(() =>
      parseSampleIndexDocument(
        documentWithSampleOverride({ extra: true }),
        epochOrigin,
      ),
    ).toThrow('unknown or missing fields')
  })

  it('rejects wrong version, empty epoch, and empty samples', () => {
    const document = validDocument()

    expect(() =>
      parseSampleIndexDocument(
        { ...document, schemaVersion: '2.0.0' },
        epochOrigin,
      ),
    ).toThrow('unsupported')
    expect(() =>
      parseSampleIndexDocument({ ...document, epochId: '' }, epochOrigin),
    ).toThrow('non-empty')
    expect(() =>
      parseSampleIndexDocument({ ...document, samples: [] }, epochOrigin),
    ).toThrow('non-empty')
  })

  it.each([
    { num: '0', den: '60000' },
    { num: '-1', den: '60000' },
    { num: '01', den: '60000' },
    { num: '1', den: '0' },
    { num: 1, den: '60000' },
  ])('rejects invalid or numeric time base %#', (timeBase) => {
    const document = validDocument()
    expect(() =>
      parseSampleIndexDocument({ ...document, timeBase }, epochOrigin),
    ).toThrow()
  })

  it.each([
    ['sourcePts', 1],
    ['sourcePts', '01'],
    ['sourcePts', '-0'],
    ['durationPts', 1],
    ['durationPts', '0'],
    ['durationPts', '-1'],
    ['captureTimeUs', large],
    ['captureTimeUs', '-1'],
    ['captureFrameIndex', large],
    ['captureFrameIndex', '-1'],
    ['keyframe', 1],
    ['keyframe', 'true'],
  ])('rejects invalid persisted sample field %s', (field, value) => {
    expect(() =>
      parseSampleIndexDocument(
        documentWithSampleOverride({ [field]: value }),
        epochOrigin,
      ),
    ).toThrow()
  })

  it('rejects epoch, time-base, and capture-time inconsistencies', () => {
    const document = validDocument()

    expect(() =>
      parseSampleIndexDocument(
        document,
        { ...epochOrigin, epochId: 'other-epoch' },
      ),
    ).toThrow('epoch')
    expect(() =>
      parseSampleIndexDocument(document, {
        ...epochOrigin,
        timeBase: { num: 1n, den: 30n },
      }),
    ).toThrow('time base')
    expect(() =>
      parseSampleIndexDocument(
        documentWithSampleOverride(
          { captureTimeUs: (large + 16_684n).toString() },
          1,
        ),
        epochOrigin,
      ),
    ).toThrow('epoch origin')
  })

  it('rejects sample holes, overlaps, and frame-index discontinuities', () => {
    expect(() =>
      parseSampleIndexDocument(
        documentWithSampleOverride(
          { sourcePts: (-large + 1_002n).toString() },
          1,
        ),
        epochOrigin,
      ),
    ).toThrow('hole')
    expect(() =>
      parseSampleIndexDocument(
        documentWithSampleOverride(
          { sourcePts: (-large + 1_000n).toString() },
          1,
        ),
        epochOrigin,
      ),
    ).toThrow('overlap')
    expect(() =>
      parseSampleIndexDocument(
        documentWithSampleOverride(
          { captureFrameIndex: (large + 2n).toString() },
          1,
        ),
        epochOrigin,
      ),
    ).toThrow('frame indices')
  })

  it('rejects inconsistent runtime bounds before serialization', () => {
    const index = validIndex()

    expect(() =>
      serializeSampleIndex({
        ...index,
        availableStartUs: index.availableStartUs + 1n,
      }),
    ).toThrow('available start')
    expect(() =>
      serializeSampleIndex({
        ...index,
        availableEndUs: index.samples.at(-1)!.captureTimeUs,
      }),
    ).toThrow('available end')
  })
})

describe('shared sample timing kernel', () => {
  it('uses one epoch-relative rescale for exact adjacent 30fps endpoints', () => {
    const origin: CaptureEpochOrigin = {
      epochId: 'epoch-30',
      sourcePtsOrigin: 0n,
      captureTimeOriginUs: 0n,
      captureFrameOrigin: 0n,
      timeBase: { num: 1n, den: 30n },
    }
    const first = buildSampleIndex(
      [
        { media_type: 'video', pts: '0', pkt_duration: '1' },
        { media_type: 'video', pts: '1', pkt_duration: '1' },
      ],
      origin,
    )
    const second = buildSampleIndex(
      [{ media_type: 'video', pts: '2', pkt_duration: '1' }],
      { ...origin, captureFrameOrigin: 2n },
    )

    expect(first.availableEndUs).toBe(66_667n)
    expect(second.availableStartUs).toBe(66_667n)
    expect(second.availableEndUs).toBe(100_000n)
    expect(
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'second', index: second, discontinuity: 0 },
      ]),
    ).toEqual([
      {
        segmentIds: ['first', 'second'],
        startUs: 0n,
        endUs: 100_000n,
        discontinuity: 0,
      },
    ])
  })

  it('keeps true 60000/1001 segments touching without a rounded gap', () => {
    const origin: CaptureEpochOrigin = {
      epochId: 'epoch-5994',
      sourcePtsOrigin: 0n,
      captureTimeOriginUs: 0n,
      captureFrameOrigin: 0n,
      timeBase: { num: 1n, den: 60_000n },
    }
    const first = buildSampleIndex(
      [
        { media_type: 'video', pts: '0', pkt_duration: '1001' },
        { media_type: 'video', pts: '1001', pkt_duration: '1001' },
      ],
      origin,
    )
    const second = buildSampleIndex(
      [{ media_type: 'video', pts: '2002', pkt_duration: '1001' }],
      { ...origin, captureFrameOrigin: 2n },
    )

    expect(first.availableEndUs).toBe(33_367n)
    expect(second.availableStartUs).toBe(33_367n)
    expect(second.availableEndUs).toBe(50_050n)
  })

  it('allows realistic VFR durations while preserving exact boundaries', () => {
    const origin: CaptureEpochOrigin = {
      epochId: 'epoch-vfr',
      sourcePtsOrigin: -3_003n,
      captureTimeOriginUs: large,
      captureFrameOrigin: large,
      timeBase: { num: 1n, den: 90_000n },
    }
    const first = buildSampleIndex(
      [
        { media_type: 'video', pts: '-3003', pkt_duration: '1501' },
        { media_type: 'video', pts: '-1502', pkt_duration: '1502' },
      ],
      origin,
    )
    const second = buildSampleIndex(
      [{ media_type: 'video', pts: '0', pkt_duration: '3000' }],
      { ...origin, captureFrameOrigin: large + 2n },
    )

    expect(first.samples.map((sample) => sample.sourcePts)).toEqual([
      -3_003n,
      -1_502n,
    ])
    expect(first.availableEndUs).toBe(large + 33_367n)
    expect(second.availableStartUs).toBe(first.availableEndUs)
  })

  it('rejects duration holes and overlaps instead of making them playable', () => {
    const origin: CaptureEpochOrigin = {
      epochId: 'epoch-invalid',
      sourcePtsOrigin: 0n,
      captureTimeOriginUs: 0n,
      captureFrameOrigin: 0n,
      timeBase: { num: 1n, den: 1n },
    }

    expect(() =>
      buildSampleIndex(
        [
          { media_type: 'video', pts: '0', pkt_duration: '1' },
          { media_type: 'video', pts: '2', pkt_duration: '1' },
        ],
        origin,
      ),
    ).toThrow('hole')
    expect(() =>
      buildSampleIndex(
        [
          { media_type: 'video', pts: '0', pkt_duration: '2' },
          { media_type: 'video', pts: '1', pkt_duration: '1' },
        ],
        origin,
      ),
    ).toThrow('overlap')
  })
})

describe('availability range validation', () => {
  function oneSampleIndex(
    epochId: string,
    sourcePts: bigint,
    captureTimeUs: bigint,
    captureFrameIndex: bigint,
  ): SampleIndex {
    return buildSampleIndex(
      [
        {
          media_type: 'video',
          pts: sourcePts.toString(),
          pkt_duration: '1',
        },
      ],
      {
        epochId,
        sourcePtsOrigin: sourcePts,
        captureTimeOriginUs: captureTimeUs,
        captureFrameOrigin: captureFrameIndex,
        timeBase: { num: 1n, den: 1n },
      },
    )
  }

  it('preserves a real gap and a touching discontinuity as separate ranges', () => {
    const first = oneSampleIndex('epoch-0', 0n, 0n, 0n)
    const afterGap = oneSampleIndex('epoch-1', 0n, 2_000_000n, 1n)
    const touchingDiscontinuity = oneSampleIndex(
      'epoch-2',
      0n,
      3_000_000n,
      2n,
    )

    expect(
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'after-gap', index: afterGap, discontinuity: 1 },
        {
          segmentId: 'touching',
          index: touchingDiscontinuity,
          discontinuity: 2,
        },
      ]),
    ).toEqual([
      { segmentIds: ['first'], startUs: 0n, endUs: 1_000_000n, discontinuity: 0 },
      {
        segmentIds: ['after-gap'],
        startUs: 2_000_000n,
        endUs: 3_000_000n,
        discontinuity: 1,
      },
      {
        segmentIds: ['touching'],
        startUs: 3_000_000n,
        endUs: 4_000_000n,
        discontinuity: 2,
      },
    ])
  })

  it('fails on duplicate, overlap, gap-without-discontinuity, and regression', () => {
    const first = oneSampleIndex('epoch-0', 0n, 0n, 0n)
    const touching = oneSampleIndex('epoch-0', 1n, 1_000_000n, 1n)
    const overlapping = oneSampleIndex('epoch-overlap', 0n, 500_000n, 1n)
    const gap = oneSampleIndex('epoch-gap', 0n, 3_000_000n, 1n)

    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'same', index: first, discontinuity: 0 },
        { segmentId: 'same', index: touching, discontinuity: 0 },
      ]),
    ).toThrow('duplicate')
    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'overlap', index: overlapping, discontinuity: 1 },
      ]),
    ).toThrow('overlap')
    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'gap', index: gap, discontinuity: 0 },
      ]),
    ).toThrow('requires a new discontinuity')
    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'gap', index: gap, discontinuity: 1 },
        { segmentId: 'touching', index: touching, discontinuity: 0 },
      ]),
    ).toThrow()
  })

  it('fails on skipped discontinuities and epoch misuse', () => {
    const first = oneSampleIndex('epoch-0', 0n, 0n, 0n)
    const touchingSameEpoch = oneSampleIndex('epoch-0', 1n, 1_000_000n, 1n)
    const touchingNewEpoch = oneSampleIndex('epoch-1', 0n, 1_000_000n, 1n)

    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'skipped', index: touchingNewEpoch, discontinuity: 2 },
      ]),
    ).toThrow('skipped')
    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'wrong-epoch', index: touchingNewEpoch, discontinuity: 0 },
      ]),
    ).toThrow('cannot span capture epochs')
    expect(() =>
      buildAvailabilityRanges([
        { segmentId: 'first', index: first, discontinuity: 0 },
        { segmentId: 'same-epoch', index: touchingSameEpoch, discontinuity: 1 },
      ]),
    ).toThrow('requires a new capture epoch')
  })
})
