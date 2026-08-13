import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ClipTimingManifestError,
  readClipTimingCoverage,
  readClipFrameTimeline,
  resolveClipFrameTimeline,
  resolveClipTimingCoverage,
  timingManifestIdentity,
} from '../src/media/clip-timing-coverage.js'

const manifest = {
  schema_version: '1.1.0',
  clip_job_id: 'clip-job-1',
  actual_start_capture_us: '1000000',
  actual_end_capture_us: '1100000',
  video: { duration_us: '100000' },
  frame_map: [
    { capture_epoch_id: 'epoch', capture_frame_index: '100', source_pts: '300', clip_frame_index: '0', capture_time_us: '1000000', clip_time_us: '0' },
    { capture_epoch_id: 'epoch', capture_frame_index: '101', source_pts: '301', clip_frame_index: '1', capture_time_us: '1016683', clip_time_us: '16683' },
    { capture_epoch_id: 'epoch', capture_frame_index: '102', source_pts: '302', clip_frame_index: '2', capture_time_us: '1050050', clip_time_us: '50050' },
  ],
}

describe('clip timing coverage', () => {
  it('uses the immutable source clip identity when a correction reuses media', () => {
    const sourceClipJobId = '2da4e35c-3249-408c-9aa7-e9b4fe7fd817'
    expect(timingManifestIdentity(
      '909fc2f8-8ec8-4ca2-ad8f-9bca684bbb3f',
      `rally-submission:submission-id:reuse:${sourceClipJobId}`,
      `clips/submission-id/${sourceClipJobId}.timing.json`,
    )).toBe(sourceClipJobId)
    expect(timingManifestIdentity(
      'current-clip-job',
      `rally-submission:submission-id:reuse:${sourceClipJobId}`,
      'clips/submission-id/timing.json',
    )).toBe(sourceClipJobId)
    expect(timingManifestIdentity(
      'current-clip-job',
      'rally-submission:submission-id',
      'clips/submission-id/timing.json',
    )).toBe('current-clip-job')
  })

  it('accepts the boundary-aware v2 timing manifest without changing frame timing', () => {
    expect(resolveClipFrameTimeline({ ...manifest, schema_version: '2.0.0', boundaries: [] }, 'clip-job-1')).toEqual({
      captureEpochId: ['epoch', 'epoch', 'epoch'],
      captureFrameIndex: [100n, 101n, 102n],
      captureTimeUs: [1_000_000n, 1_016_683n, 1_050_050n],
      captureEndUs: 1_100_000n,
      clipTimeUs: [0n, 16_683n, 50_050n],
      clipEndUs: 100_000n,
      sourcePts: [300n, 301n, 302n],
    })
  })

  it('preserves the exact capture and clip PTS timelines', () => {
    expect(resolveClipFrameTimeline(manifest, 'clip-job-1')).toEqual({
      captureEpochId: ['epoch', 'epoch', 'epoch'],
      captureFrameIndex: [100n, 101n, 102n],
      captureTimeUs: [1_000_000n, 1_016_683n, 1_050_050n],
      captureEndUs: 1_100_000n,
      clipTimeUs: [0n, 16_683n, 50_050n],
      clipEndUs: 100_000n,
      sourcePts: [300n, 301n, 302n],
    })
  })
  it('maps VFR analysis frames through the immutable frame map', () => {
    expect(resolveClipTimingCoverage(manifest, 'clip-job-1', 1n, 2n)).toEqual({
      startUs: 1_016_683n,
      endUs: 1_100_000n,
    })
    expect(resolveClipTimingCoverage(manifest, 'clip-job-1', 0n, 1n)).toEqual({
      startUs: 1_000_000n,
      endUs: 1_050_050n,
    })
  })

  it('uses the manifest range only when no track frame range exists', () => {
    expect(resolveClipTimingCoverage(manifest, 'clip-job-1', null, null)).toEqual({
      startUs: 1_000_000n,
      endUs: 1_100_000n,
    })
  })

  it.each([
    [{ ...manifest, clip_job_id: 'other' }, 0n, 0n],
    [{ ...manifest, frame_map: [manifest.frame_map[0], manifest.frame_map[2]] }, 0n, 1n],
    [{ ...manifest, frame_map: [manifest.frame_map[1], manifest.frame_map[0]] }, 0n, 1n],
    [manifest, 0n, 3n],
  ] as const)('fails closed on malformed or unmapped frame data', (value, first, last) => {
    expect(() => resolveClipTimingCoverage(value, 'clip-job-1', first, last))
      .toThrowError(ClipTimingManifestError)
  })

  it('reads a checksum-bound 1.1.0 timing asset', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(manifest))
    const reader = vi.fn(async () => bytes)
    await expect(readClipTimingCoverage(reader, {
      bucket: 'rally-media',
      objectKey: 'clips/submission/clip.timing.json',
      contentType: 'application/json',
      byteLength: BigInt(bytes.byteLength),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      internalSchemaVersion: '1.1.0',
    }, 'clip-job-1', 0n, 1n)).resolves.toEqual({
      startUs: 1_000_000n,
      endUs: 1_050_050n,
    })
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({
      expectedKind: 'TIMING_MANIFEST',
      expectedInternalSchemaVersion: '1.1.0',
    }))
    await expect(readClipFrameTimeline(reader, {
      bucket: 'rally-media',
      objectKey: 'clips/submission/clip.timing.json',
      contentType: 'application/json',
      byteLength: BigInt(bytes.byteLength),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      internalSchemaVersion: '1.1.0',
    }, 'clip-job-1')).resolves.toEqual(expect.objectContaining({
      clipTimeUs: [0n, 16_683n, 50_050n],
    }))
  })
})
