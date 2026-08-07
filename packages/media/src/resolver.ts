import type { IndexedSample, SampleIndex } from './sample-index';
export type IndexedSegment = { segmentId: string; index: SampleIndex; discontinuity?: number };

export type ResolveResult = { kind: 'frame_exact' | 'pts_exact'; epochId: string; segmentId: string; sample: ReturnType<typeof serializeAnchor>; snapDistanceUs: string };
export type StepResult = { kind: 'frame_exact'; epochId: string; segmentId: string; sample: ReturnType<typeof serializeAnchor> };
export type ResolveErrorCode = 'WINDOW_BOUNDARY' | 'SAMPLE_NOT_FOUND' | 'CAPTURE_GAP';
export class ResolverError extends Error { constructor(public readonly code: ResolveErrorCode, message: string) { super(message); this.name = 'ResolverError'; } }

function serializeAnchor(s: IndexedSample) { return { sourcePts: s.sourcePts.toString(), captureTimeUs: s.captureTimeUs.toString(), captureFrameIndex: s.captureFrameIndex.toString() }; }

export function resolveCanonicalTime(index: SampleIndex, segmentId: string, canonicalTimeUs: bigint, readyStartUs = index.availableStartUs, readyEndUs = index.availableEndUs): ResolveResult {
  if (canonicalTimeUs < readyStartUs || canonicalTimeUs >= readyEndUs) throw new ResolverError('CAPTURE_GAP', 'target is outside ready contiguous range');
  let best: IndexedSample | undefined;
  let bestDistance: bigint | undefined;
  for (const sample of index.samples) {
    if (sample.captureTimeUs < readyStartUs || sample.captureTimeUs >= readyEndUs) continue;
    const d = sample.captureTimeUs >= canonicalTimeUs ? sample.captureTimeUs - canonicalTimeUs : canonicalTimeUs - sample.captureTimeUs;
    if (bestDistance === undefined || d < bestDistance || (d === bestDistance && sample.captureTimeUs < best!.captureTimeUs)) { best = sample; bestDistance = d; }
  }
  if (!best || bestDistance === undefined) throw new ResolverError('SAMPLE_NOT_FOUND', 'no sample in ready range');
  return { kind: bestDistance === 0n ? 'frame_exact' : 'pts_exact', epochId: index.epochId, segmentId, sample: serializeAnchor(best), snapDistanceUs: bestDistance.toString() };
}
export function frameStep(index: SampleIndex, segmentId: string, captureFrameIndex: bigint, direction: 'previous' | 'next', windowStartUs = index.availableStartUs, windowEndUs = index.availableEndUs): StepResult {
  const i = index.samples.findIndex(s => s.captureFrameIndex === captureFrameIndex);
  if (i < 0) throw new ResolverError('SAMPLE_NOT_FOUND', 'sample not found');
  const target = index.samples[i + (direction === 'next' ? 1 : -1)];
  if (!target) throw new ResolverError('SAMPLE_NOT_FOUND', 'no adjacent sample');
  if (target.captureTimeUs < windowStartUs || target.captureTimeUs >= windowEndUs) throw new ResolverError('WINDOW_BOUNDARY', 'adjacent sample outside playback window');
  return { kind: 'frame_exact', epochId: index.epochId, segmentId, sample: serializeAnchor(target) };
}

export function frameStepAcrossSegments(segments: readonly IndexedSegment[], captureFrameIndex: bigint, direction: 'previous' | 'next', windowStartUs: bigint, windowEndUs: bigint): StepResult {
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1]!.index.samples.at(-1)!
    const next = segments[i]!.index.samples[0]!
    if (
      next.captureTimeUs <= previous.captureTimeUs
      || next.captureFrameIndex <= previous.captureFrameIndex
    ) {
      throw new ResolverError('SAMPLE_NOT_FOUND', 'segments must be strictly ordered')
    }
  }
  const ordered = segments.flatMap(s => s.index.samples.map(sample => ({ sample, segmentId: s.segmentId, discontinuity: s.discontinuity ?? 0 })));
  const i = ordered.findIndex(x => x.sample.captureFrameIndex === captureFrameIndex); if (i < 0) throw new ResolverError('SAMPLE_NOT_FOUND', 'sample not found');
  const j = i + (direction === 'next' ? 1 : -1); if (j < 0 || j >= ordered.length || ordered[j]!.discontinuity !== ordered[i]!.discontinuity) throw new ResolverError('SAMPLE_NOT_FOUND', 'no adjacent sample');
  const target = ordered[j]!; if (target.sample.captureTimeUs < windowStartUs || target.sample.captureTimeUs >= windowEndUs) throw new ResolverError('WINDOW_BOUNDARY', 'adjacent sample outside playback window');
  return { kind: 'frame_exact', epochId: target.sample ? segments.find(s => s.segmentId === target.segmentId)!.index.epochId : '', segmentId: target.segmentId, sample: serializeAnchor(target.sample) };
}
