import { describe, expect, it } from 'vitest';
import { buildAvailabilityRanges, buildSampleIndex, parseFfprobePayload, rescalePtsToUs, type FfprobeFrame } from '../src/media/sample-index';
import { frameStep, frameStepAcrossSegments, resolveCanonicalTime, ResolverError } from '../src/media/resolver';
const origin = { epochId: 'epoch-1', sourcePtsOrigin: 9_000_000_000_000_000n, captureTimeOriginUs: 8_000_000_000_000_000n, captureFrameOrigin: 9_000_000_000_000_000n, timeBase: { num: 1n, den: 30n } };
const frames: FfprobeFrame[] = [0, 1, 2, 3].map((i) => ({ media_type: 'video', pts: (origin.sourcePtsOrigin + BigInt(i)).toString(), pkt_duration: '1', key_frame: i === 0 ? 1 : 0 }));
describe('sample index resolver', () => {
  it('uses exact bigint rational rescaling', () => { expect(rescalePtsToUs(1n, { num: 1n, den: 30n })).toBe(33333n); expect(rescalePtsToUs(-1n, { num: 1n, den: 30n })).toBe(-33333n); expect(buildSampleIndex(frames, origin).samples[3].captureFrameIndex).toBe(9000000000000003n); });
  it('parses strict ffprobe payload and 60000/1001', async () => { const payload = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/ffprobe-vfr.json', import.meta.url), 'utf8')); const parsed = parseFfprobePayload(payload); expect(parsed.timeBase).toEqual({ num: 1n, den: 90000n }); expect(parsed.frames.length).toBe(3); const idx = buildSampleIndex([{ media_type: 'video', pts: '0', pkt_duration: '1001' }, { media_type: 'video', pts: '1001', pkt_duration: '1001' }], { ...origin, sourcePtsOrigin: 0n, captureTimeOriginUs: 0n, captureFrameOrigin: 0n, timeBase: { num: 1n, den: 60000n } }); expect(idx.samples[1]!.captureTimeUs).toBe(16_683n); });
  it('coalesces adjacent ranges and preserves gaps/discontinuities', () => { const a = buildSampleIndex([{ media_type: 'video', pts: '0', pkt_duration: '1' }], { ...origin, sourcePtsOrigin: 0n, captureTimeOriginUs: 0n, captureFrameOrigin: 0n, timeBase: { num: 1n, den: 1n } }); const b = buildSampleIndex([{ media_type: 'video', pts: '1', pkt_duration: '1' }], { ...origin, sourcePtsOrigin: 1n, captureTimeOriginUs: 1_000_000n, captureFrameOrigin: 1n, timeBase: { num: 1n, den: 1n } }); const c = buildSampleIndex([{ media_type: 'video', pts: '5', pkt_duration: '1' }], { ...origin, epochId: 'epoch-2', sourcePtsOrigin: 5n, captureTimeOriginUs: 5_000_000n, captureFrameOrigin: 2n, timeBase: { num: 1n, den: 1n } }); const ranges = buildAvailabilityRanges([{ segmentId: 'a', index: a, discontinuity: 0 }, { segmentId: 'b', index: b, discontinuity: 0 }, { segmentId: 'c', index: c, discontinuity: 1 }]); expect(ranges[0]!.segmentIds).toEqual(['a', 'b']); expect(ranges).toHaveLength(2); });
  it('rounds half away from zero', () => { expect(rescalePtsToUs(1n, { num: 1n, den: 2_000_000n })).toBe(1n); expect(rescalePtsToUs(-1n, { num: 1n, den: 2_000_000n })).toBe(-1n); });
  it('supports VFR and deterministic earlier tie', () => { const idx = buildSampleIndex([{ media_type: 'video', pts: '0', pkt_duration: '2' }, { media_type: 'video', pts: '2', pkt_duration: '3' }, { media_type: 'video', pts: '5', pkt_duration: '1' }], { ...origin, sourcePtsOrigin: 0n, captureTimeOriginUs: 0n, captureFrameOrigin: 0n, timeBase: { num: 1n, den: 1n } }); expect(resolveCanonicalTime(idx, 's', 1_000_000n).sample.captureTimeUs).toBe('0'); });
  it('rejects malformed or non-monotonic samples', () => { expect(() => buildSampleIndex([{ media_type: 'video', pts: '2', pkt_duration: '1' }, { media_type: 'video', pts: '1', pkt_duration: '1' }], origin)).toThrow('overlap'); expect(() => buildSampleIndex([{ media_type: 'audio', pts: '1', pkt_duration: '1' }], origin)).toThrow('no video'); });
  it('steps one real adjacent sample and reports boundaries', () => { const idx = buildSampleIndex(frames, origin); const start = idx.samples[0].captureFrameIndex; expect(frameStep(idx, 's', start, 'next').sample.captureFrameIndex).toBe((start + 1n).toString()); expect(() => frameStep(idx, 's', start, 'previous')).toThrowError(new ResolverError('SAMPLE_NOT_FOUND', 'no adjacent sample')); expect(() => resolveCanonicalTime(idx, 's', idx.availableStartUs - 1n)).toThrowError(new ResolverError('CAPTURE_GAP', 'target is outside ready contiguous range')); });
  it('steps across contiguous segments but not windows or discontinuities', () => {
    const a = buildSampleIndex(frames.slice(0, 2), origin)
    const b = buildSampleIndex(frames.slice(2), {
      ...origin,
      sourcePtsOrigin: BigInt(frames[2]!.pts!),
      captureTimeOriginUs: a.availableEndUs,
      captureFrameOrigin: a.samples[1]!.captureFrameIndex + 1n,
    })
    const segments = [{ segmentId: 'a', index: a }, { segmentId: 'b', index: b }]
    const firstB = b.samples[0]!
    const lastA = a.samples[1]!

    expect(firstB.captureTimeUs).toBeGreaterThan(lastA.captureTimeUs)
    expect(frameStepAcrossSegments(segments, lastA.captureFrameIndex, 'next', a.availableStartUs, b.availableEndUs).segmentId).toBe('b')
    expect(frameStepAcrossSegments(segments, firstB.captureFrameIndex, 'previous', a.availableStartUs, b.availableEndUs).segmentId).toBe('a')
    expect(() => frameStepAcrossSegments(segments, lastA.captureFrameIndex, 'next', a.availableStartUs, firstB.captureTimeUs - 1n)).toThrow('outside playback window')
    expect(() => frameStepAcrossSegments([{ segmentId: 'a', index: a, discontinuity: 0 }, { segmentId: 'b', index: b, discontinuity: 1 }], lastA.captureFrameIndex, 'next', a.availableStartUs, b.availableEndUs)).toThrow('no adjacent')
  });
});
