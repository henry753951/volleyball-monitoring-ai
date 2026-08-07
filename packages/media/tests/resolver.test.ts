import { describe, expect, it } from 'vitest'
import { buildSampleIndex, type CaptureEpochOrigin } from '../src/sample-index'
import {
  frameStep,
  frameStepAcrossSegments,
  resolveCanonicalTime,
  ResolverError,
} from '../src/resolver'

const origin: CaptureEpochOrigin = {
  epochId: 'epoch-0',
  sourcePtsOrigin: 0n,
  captureTimeOriginUs: 0n,
  captureFrameOrigin: 0n,
  timeBase: { num: 1n, den: 1_000n },
}

describe('shared canonical resolver', () => {
  it('chooses the earlier real VFR sample on an exact nearest tie', () => {
    const index = buildSampleIndex(
      [
        { media_type: 'video', pts: '0', pkt_duration: '20' },
        { media_type: 'video', pts: '20', pkt_duration: '40' },
        { media_type: 'video', pts: '60', pkt_duration: '10' },
      ],
      origin,
    )

    expect(resolveCanonicalTime(index, 'segment', 10_000n).sample).toMatchObject({
      sourcePts: '0',
      captureTimeUs: '0',
    })
    expect(resolveCanonicalTime(index, 'segment', 40_000n).sample).toMatchObject({
      sourcePts: '20',
      captureTimeUs: '20000',
    })
  })

  it('enforces start-inclusive/end-exclusive and explicit ready-gap bounds', () => {
    const index = buildSampleIndex(
      [
        { media_type: 'video', pts: '0', pkt_duration: '20' },
        { media_type: 'video', pts: '20', pkt_duration: '20' },
      ],
      origin,
    )

    expect(resolveCanonicalTime(index, 'segment', index.availableStartUs).kind)
      .toBe('frame_exact')
    expect(() =>
      resolveCanonicalTime(index, 'segment', index.availableEndUs),
    ).toThrowError(
      new ResolverError('CAPTURE_GAP', 'target is outside ready contiguous range'),
    )
    expect(() =>
      resolveCanonicalTime(index, 'segment', 19_000n, 20_000n, 40_000n),
    ).toThrowError(ResolverError)
  })

  it('steps exactly one sample and reports start/end boundaries', () => {
    const index = buildSampleIndex(
      [
        { media_type: 'video', pts: '0', pkt_duration: '20' },
        { media_type: 'video', pts: '20', pkt_duration: '40' },
        { media_type: 'video', pts: '60', pkt_duration: '10' },
      ],
      origin,
    )

    expect(frameStep(index, 'segment', 0n, 'next').sample.captureFrameIndex)
      .toBe('1')
    expect(frameStep(index, 'segment', 2n, 'previous').sample.captureFrameIndex)
      .toBe('1')
    expect(() => frameStep(index, 'segment', 0n, 'previous')).toThrow(
      'no adjacent sample',
    )
    expect(() => frameStep(index, 'segment', 2n, 'next')).toThrow(
      'no adjacent sample',
    )
    expect(() => frameStep(index, 'segment', 0n, 'next', 0n, 20_000n))
      .toThrow('outside playback window')
  })

  it('steps across exact touching segments but never across a discontinuity', () => {
    const first = buildSampleIndex(
      [
        { media_type: 'video', pts: '0', pkt_duration: '20' },
        { media_type: 'video', pts: '20', pkt_duration: '20' },
      ],
      origin,
    )
    const second = buildSampleIndex(
      [{ media_type: 'video', pts: '40', pkt_duration: '20' }],
      { ...origin, captureFrameOrigin: 2n },
    )
    const segments = [
      { segmentId: 'first', index: first, discontinuity: 0 },
      { segmentId: 'second', index: second, discontinuity: 0 },
    ]

    expect(
      frameStepAcrossSegments(
        segments,
        1n,
        'next',
        first.availableStartUs,
        second.availableEndUs,
      ).segmentId,
    ).toBe('second')
    expect(() =>
      frameStepAcrossSegments(
        [segments[0]!, { ...segments[1]!, discontinuity: 1 }],
        1n,
        'next',
        first.availableStartUs,
        second.availableEndUs,
      ),
    ).toThrow('no adjacent sample')
  })
})
