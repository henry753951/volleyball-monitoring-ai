import { describe, expect, it } from 'vitest'
import { createSampleSnapResolver } from '../src/media/sample-snap-resolver.js'

const BASE_US = 9_007_199_254_740_993n

const sample = (
  sourcePts: bigint,
  captureTimeUs: bigint,
  captureFrameIndex: bigint,
) => ({
  sourcePts,
  durationPts: 10n,
  captureTimeUs,
  captureFrameIndex,
  keyframe: captureFrameIndex === 0n,
})

describe('sample snap resolver', () => {
  it('preserves ordered IDs and exact bigint offset', async () => {
    const ids: string[] = []
    const resolver = createSampleSnapResolver(async (requested) => {
      ids.push(...requested)
      return [
        {
          segmentId: 'a',
          discontinuity: 0,
          index: {
            epochId: 'e',
            timeBase: { num: 1n, den: 1n },
            samples: [sample(0n, BASE_US, 0n)],
            availableStartUs: BASE_US,
            availableEndUs: BASE_US + 10n,
          },
        },
        {
          segmentId: 'b',
          discontinuity: 0,
          index: {
            epochId: 'e',
            timeBase: { num: 1n, den: 1n },
            samples: [sample(10n, BASE_US + 10n, 1n)],
            availableStartUs: BASE_US + 10n,
            availableEndUs: BASE_US + 20n,
          },
        },
      ]
    })
    await expect(resolver({
      targetUs: BASE_US + 10n,
      segments: [
        { id: 'a', captureStartUs: BASE_US, captureEndUs: BASE_US + 10n },
        { id: 'b', captureStartUs: BASE_US + 10n, captureEndUs: BASE_US + 20n },
      ],
    })).resolves.toEqual({ captureUs: BASE_US + 10n, playerUs: 10n })
    expect(ids).toEqual(['a', 'b'])
  })

  it('uses the earlier sample when distances tie', async () => {
    const resolver = createSampleSnapResolver(async () => [{
      segmentId: 'a',
      discontinuity: 0,
      index: {
        epochId: 'e',
        timeBase: { num: 1n, den: 1n },
        samples: [
          sample(0n, BASE_US, 0n),
          sample(10n, BASE_US + 10n, 1n),
        ],
        availableStartUs: BASE_US,
        availableEndUs: BASE_US + 20n,
      },
    }])

    await expect(resolver({
      targetUs: BASE_US + 5n,
      segments: [{
        id: 'a',
        captureStartUs: BASE_US,
        captureEndUs: BASE_US + 20n,
      }],
    })).resolves.toEqual({ captureUs: BASE_US, playerUs: 0n })
  })

  it('rejects an empty selected segment set', async () => {
    const resolver = createSampleSnapResolver(async () => [])
    await expect(resolver({ targetUs: 1n, segments: [] }))
      .rejects.toThrow('requires segments')
  })

  it('preserves loader failures as fail-closed resolution failures', async () => {
    const resolver = createSampleSnapResolver(async () => {
      throw new Error('corrupt index')
    })
    await expect(resolver({
      targetUs: 1n,
      segments: [{ id: 'a', captureStartUs: 0n, captureEndUs: 2n }],
    })).rejects.toThrow('corrupt index')
  })

  it('rejects loader count and order mismatches', async () => {
    const input = {
      targetUs: 1n,
      segments: [{ id: 'a', captureStartUs: 0n, captureEndUs: 2n }],
    }
    await expect(createSampleSnapResolver(async () => [])(input))
      .rejects.toThrow('count mismatch')
    await expect(createSampleSnapResolver(async () => [{
      segmentId: 'wrong',
      discontinuity: 0,
      index: {
        epochId: 'e',
        timeBase: { num: 1n, den: 1n },
        samples: [sample(0n, 0n, 0n)],
        availableStartUs: 0n,
        availableEndUs: 10n,
      },
    }])(input)).rejects.toThrow('order mismatch')
  })

  it('rejects a target at the half-open selected end', async () => {
    const resolver = createSampleSnapResolver(async () => [{
      segmentId: 'a',
      discontinuity: 0,
      index: {
        epochId: 'e',
        timeBase: { num: 1n, den: 1n },
        samples: [sample(0n, 0n, 0n)],
        availableStartUs: 0n,
        availableEndUs: 10n,
      },
    }])
    await expect(resolver({
      targetUs: 10n,
      segments: [{ id: 'a', captureStartUs: 0n, captureEndUs: 10n }],
    })).rejects.toThrow('outside ready contiguous range')
  })
})
