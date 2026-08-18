import { describe, expect, it } from 'vitest'
import {
  buildCanonicalClipFfmpegArgs,
  mapClipKeyPoint,
  parseCanonicalClipProbe,
  selectCanonicalClipRange,
  type ClipSourceSegment,
} from '../src/media/clip-timing'

function segment(durations: bigint[]): ClipSourceSegment {
  let pts = 0n
  let captureTimeUs = 0n
  const samples = durations.map((durationPts, index) => {
    const sample = {
      sourcePts: pts,
      durationPts,
      captureTimeUs,
      captureFrameIndex: BigInt(index),
      keyframe: index === 0,
    }
    pts += durationPts
    captureTimeUs += durationPts
    return sample
  })
  return {
    id: 'segment-1',
    captureEpochId: 'epoch-1',
    captureStartUs: 0n,
    captureEndUs: captureTimeUs,
    sourcePtsStart: 0n,
    sourcePtsEnd: pts,
    firstFrameIndex: 0n,
    frameCount: BigInt(samples.length),
    index: {
      epochId: 'epoch-1',
      timeBase: { num: 1n, den: 1_000_000n },
      samples,
      availableStartUs: 0n,
      availableEndUs: captureTimeUs,
    },
  }
}

describe('canonical clip timing', () => {
  it('selects VFR samples and maps an immutable key point by exact identity', () => {
    const source = segment([33_366n, 41_000n, 25_000n, 50_000n])
    const point = source.index.samples[1]!
    const selected = selectCanonicalClipRange([source], 30_000n, 120_000n, [
      {
        id: 'point-1',
        captureEpochId: source.captureEpochId,
        sourcePts: point.sourcePts,
        captureTimeUs: point.captureTimeUs,
        captureFrameIndex: point.captureFrameIndex,
      },
    ])

    expect(selected.sourceSamples.map(sample => sample.durationPts)).toEqual([
      33_366n,
      41_000n,
      25_000n,
      50_000n,
    ])
    expect(selected.keyPointOrdinals.get('point-1')).toBe(1)
    expect(selected.actualStartCaptureUs).toBe(0n)
    expect(selected.actualEndCaptureUs).toBe(149_366n)
  })

  it('fails closed when the immutable anchor does not match the actual source sample', () => {
    const source = segment([33_366n, 33_367n])
    expect(() =>
      selectCanonicalClipRange([source], 0n, 60_000n, [
        {
          id: 'wrong-point',
          captureEpochId: source.captureEpochId,
          sourcePts: 1n,
          captureTimeUs: 0n,
          captureFrameIndex: 0n,
        },
      ]),
    ).toThrow('has no exact source sample')
  })

  it('resolves an estimated live observation to the finalized recording sample by canonical frame', () => {
    const source = segment([33_000n, 34_000n, 33_000n])
    const selected = selectCanonicalClipRange([source], 0n, source.captureEndUs, [
      {
        id: 'estimated-live-point',
        captureEpochId: 'provisional-or-legacy-epoch',
        sourcePts: 33_333n,
        captureTimeUs: 33_333n,
        captureFrameIndex: 1n,
        timingPrecision: 'ESTIMATED',
      },
    ])

    expect(selected.keyPointOrdinals.get('estimated-live-point')).toBe(1)
    expect(selected.resolvedKeyPointSamples.get('estimated-live-point')).toMatchObject({
      captureEpochId: source.captureEpochId,
      sourcePts: 33_000n,
      captureTimeUs: 33_000n,
      captureFrameIndex: 1n,
    })
  })

  it('rejects an estimated frame whose canonical timestamp is more than one sample away', () => {
    const source = segment([33_000n, 34_000n])
    expect(() =>
      selectCanonicalClipRange([source], 0n, source.captureEndUs, [
        {
          id: 'bad-estimated-point',
          captureEpochId: 'provisional-epoch',
          sourcePts: 0n,
          captureTimeUs: 100_000n,
          captureFrameIndex: 1n,
          timingPrecision: 'ESTIMATED',
        },
      ]),
    ).toThrow('has no exact source sample')
  })

  it('includes an immutable end boundary at the exact requested end with zero post-roll', () => {
    const source = segment([33_366n, 33_367n, 33_366n])
    const endBoundary = source.index.samples[2]!
    const selected = selectCanonicalClipRange([source], 0n, endBoundary.captureTimeUs, [
      {
        id: 'end-boundary',
        captureEpochId: source.captureEpochId,
        sourcePts: endBoundary.sourcePts,
        captureTimeUs: endBoundary.captureTimeUs,
        captureFrameIndex: endBoundary.captureFrameIndex,
      },
    ])

    expect(selected.sourceSamples).toHaveLength(3)
    expect(selected.keyPointOrdinals.get('end-boundary')).toBe(2)
    expect(selected.actualEndCaptureUs).toBe(100_099n)
  })

  it('preserves exact anchors across a contiguous OME epoch PTS reset', () => {
    const first = segment([16_000n, 16_000n])
    const reset = segment([16_000n, 16_000n])
    const second: ClipSourceSegment = {
      ...reset,
      id: 'segment-2',
      captureEpochId: 'epoch-2',
      captureStartUs: first.captureEndUs,
      captureEndUs: first.captureEndUs + reset.captureEndUs,
      firstFrameIndex: first.frameCount,
      index: {
        ...reset.index,
        epochId: 'epoch-2',
        availableStartUs: first.captureEndUs,
        availableEndUs: first.captureEndUs + reset.captureEndUs,
        samples: reset.index.samples.map(sample => ({
          ...sample,
          captureTimeUs: sample.captureTimeUs + first.captureEndUs,
          captureFrameIndex: sample.captureFrameIndex + first.frameCount,
        })),
      },
    }
    const point = second.index.samples[0]!
    const selected = selectCanonicalClipRange([first, second], 0n, second.captureEndUs, [
      {
        id: 'reset-point',
        captureEpochId: second.captureEpochId,
        sourcePts: point.sourcePts,
        captureTimeUs: point.captureTimeUs,
        captureFrameIndex: point.captureFrameIndex,
      },
    ])

    expect(selected.sourceSamples.map(sample => sample.captureEpochId)).toEqual([
      'epoch-1',
      'epoch-1',
      'epoch-2',
      'epoch-2',
    ])
    expect(selected.sourceSamples.map(sample => sample.sourcePts)).toEqual([
      0n,
      16_000n,
      0n,
      16_000n,
    ])
    expect(selected.keyPointOrdinals.get('reset-point')).toBe(2)
  })

  it('preserves exact cumulative PTS timing at 60000/1001 without per-frame rounding drift', () => {
    const samples = [
      {
        sourcePts: 1_001n,
        durationPts: 1_001n,
        captureTimeUs: 0n,
        captureFrameIndex: 0n,
        keyframe: true,
      },
      {
        sourcePts: 2_002n,
        durationPts: 1_001n,
        captureTimeUs: 16_683n,
        captureFrameIndex: 1n,
        keyframe: false,
      },
      {
        sourcePts: 3_003n,
        durationPts: 1_001n,
        captureTimeUs: 33_367n,
        captureFrameIndex: 2n,
        keyframe: false,
      },
    ]
    const source: ClipSourceSegment = {
      id: 'segment-60fps',
      captureEpochId: 'epoch-60fps',
      captureStartUs: 0n,
      captureEndUs: 50_050n,
      sourcePtsStart: 1_001n,
      sourcePtsEnd: 4_004n,
      firstFrameIndex: 0n,
      frameCount: 3n,
      index: {
        epochId: 'epoch-60fps',
        timeBase: { num: 1n, den: 60_000n },
        samples,
        availableStartUs: 0n,
        availableEndUs: 50_050n,
      },
    }

    const selected = selectCanonicalClipRange([source], 0n, 50_000n, [])

    expect(selected.sourceSamples).toHaveLength(3)
  })

  it('still rejects a real timestamp discontinuity', () => {
    const source = segment([16_000n, 16_000n, 16_000n])
    const samples = [...source.index.samples]
    samples[2] = { ...samples[2]!, captureTimeUs: samples[2]!.captureTimeUs + 2n }
    const discontinuous: ClipSourceSegment = {
      ...source,
      index: { ...source.index, samples },
    }

    expect(() => selectCanonicalClipRange([discontinuous], 0n, 48_000n, [])).toThrow(
      'canonical sample capture time does not match source PTS',
    )
  })

  it('builds a frame-ordinal transcode without CFR coercion or time seeking', () => {
    const args = buildCanonicalClipFfmpegArgs('source.mp4', 'clip.mp4', {
      sourceStartFrame: 3n,
      sourceEndFrameExclusive: 9n,
      sourceStartOffsetUs: 100_000n,
      durationUs: 200_000n,
    })
    expect(args).toContain('trim=start_frame=3:end_frame=9,setpts=PTS-STARTPTS')
    expect(args).toContain('passthrough')
    expect(args).not.toContain('-r')
    expect(args).not.toContain('-ss')
    expect(args).not.toContain('-shortest')
    expect(args).toContain('atrim=start=0.100000:duration=0.200000,asetpts=PTS-STARTPTS')

    const concatArgs = buildCanonicalClipFfmpegArgs(
      'source.concat.txt',
      'clip.mp4',
      {
        sourceStartFrame: 3n,
        sourceEndFrameExclusive: 9n,
        sourceStartOffsetUs: 100_000n,
        durationUs: 200_000n,
      },
      'concat',
    )
    expect(concatArgs).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0']))
  })

  it('uses actual output PTS and rejects dropped or duplicated output frames', () => {
    const payload = {
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
          time_base: '1/90000',
        },
        { codec_type: 'audio' },
      ],
      frames: [
        { media_type: 'video', pts: '0', pkt_duration: '3003', key_frame: 1 },
        { media_type: 'audio', pts: '0', pkt_duration: '1024', key_frame: 1 },
        { media_type: 'video', pts: '3003', pkt_duration: '3600', key_frame: 0 },
        { media_type: 'video', pts: '6603', pkt_duration: '2400', key_frame: 0 },
      ],
    }
    const video = parseCanonicalClipProbe(payload, 3, { fpsNum: 30, fpsDen: 1 })
    expect(mapClipKeyPoint('point-2', 1, video)).toEqual({
      clipPts: 3003n,
      clipTimeUs: 33_367n,
      clipFrameIndex: 1n,
    })
    expect(() => parseCanonicalClipProbe(payload, 4, { fpsNum: 30, fpsDen: 1 })).toThrow(
      'frame count mismatch',
    )
  })

  it('derives a missing final packet duration from the exact stream end', () => {
    const video = parseCanonicalClipProbe(
      {
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            avg_frame_rate: '60000/1001',
            time_base: '1/60000',
            start_pts: '0',
            duration_ts: '3003',
          },
        ],
        frames: [
          { media_type: 'video', pts: '0', pkt_duration: '1001', key_frame: 1 },
          { media_type: 'video', pts: '1001', pkt_duration: '1001', key_frame: 0 },
          { media_type: 'video', pts: '2002', key_frame: 0 },
        ],
      },
      3,
      { fpsNum: 60, fpsDen: 1 },
    )

    expect(video.frames).toEqual([
      { pts: 0n, durationPts: 1001n },
      { pts: 1001n, durationPts: 1001n },
      { pts: 2002n, durationPts: 1001n },
    ])
    expect(video.durationUs).toBe(50_050n)
  })
})
