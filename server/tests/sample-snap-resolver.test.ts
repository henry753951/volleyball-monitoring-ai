import { describe, expect, it } from 'vitest'
import { createSampleSnapResolver } from '../src/media/sample-snap-resolver.js'

const sample = (time: bigint, frame: bigint) => ({
  sourcePts: time,
  durationPts: 10n,
  captureTimeUs: time,
  captureFrameIndex: frame,
  keyframe: frame === 0n,
})

describe('sample snap resolver', () => {
  it('preserves ordered IDs and exact bigint offset', async () => {
    const ids: string[] = []
    const resolver = createSampleSnapResolver(async (requested) => {
      ids.push(...requested)
      return [{ segmentId: 'a', discontinuity: 0, index: { epochId: 'e', timeBase: { num: 1n, den: 1n }, samples: [sample(9007199254740993n, 0n)], availableStartUs: 9007199254740993n, availableEndUs: 9007199254741003n } }]
    })
    await expect(resolver({ targetUs: 9007199254740993n, segments: [{ id: 'a', captureStartUs: 9007199254740993n, captureEndUs: 9007199254741003n }] })).resolves.toEqual({ captureUs: 9007199254740993n, playerUs: 0n })
    expect(ids).toEqual(['a'])
  })

  it('rejects empty, mismatched, and loader failures', async () => {
    const resolver = createSampleSnapResolver(async () => { throw new Error('corrupt index') })
    await expect(resolver({ targetUs: 1n, segments: [] })).rejects.toThrow('requires segments')
    await expect(resolver({ targetUs: 1n, segments: [{ id: 'a', captureStartUs: 0n, captureEndUs: 2n }] })).rejects.toThrow('corrupt index')
    const mismatch = createSampleSnapResolver(async () => [])
    await expect(mismatch({ targetUs: 1n, segments: [{ id: 'a', captureStartUs: 0n, captureEndUs: 2n }] })).rejects.toThrow('count mismatch')
  })
})
