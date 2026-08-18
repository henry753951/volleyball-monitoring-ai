import { describe, expect, it } from 'vitest'
import { resolveOmeEpochTime } from '../src/media/ome-live-cursor-resolution.js'

describe('OME live cursor PTS mapping', () => {
  it('quantizes browser program time onto the durable CFR recording epoch', () => {
    expect(
      resolveOmeEpochTime({
        captureFrameOrigin: 120n,
        captureTimeOriginUs: 4_000_000n,
        fpsDen: 1,
        fpsNum: 30,
        sourcePtsOrigin: 360_000n,
        sourceTimeBaseDen: 90_000,
        sourceTimeBaseNum: 1,
        targetCaptureTimeUs: 4_033_334n,
      }),
    ).toEqual({
      captureFrameIndex: 121n,
      captureTimeUs: 4_033_333n,
      snapDistanceUs: 1n,
      sourcePts: 363_000n,
    })
  })

  it('uses the same nearest-frame rule for positions beyond finalized extents', () => {
    expect(
      resolveOmeEpochTime({
        captureFrameOrigin: 0n,
        captureTimeOriginUs: 0n,
        fpsDen: 1,
        fpsNum: 30,
        sourcePtsOrigin: 0n,
        sourceTimeBaseDen: 90_000,
        sourceTimeBaseNum: 1,
        targetCaptureTimeUs: 1_016_666n,
      }),
    ).toMatchObject({
      captureFrameIndex: 30n,
      captureTimeUs: 1_000_000n,
      sourcePts: 90_000n,
    })
  })
})
