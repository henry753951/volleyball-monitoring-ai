import { describe, expect, it } from 'vitest'
import {
  MediaHttpError,
  buildPlaybackDescriptor,
  buildReadyPlaybackRuns,
  formatManifest,
  mediaErrorEnvelope,
  parsePlaybackResourceToken,
  presentationOriginForSnap,
  selectPlaybackWindow,
  type PlaybackSegmentCandidate,
} from '../src/media/playback-domain.js'

const ids = {
  window: '10000000-0000-4000-8000-000000000001',
  first: '10000000-0000-4000-8000-000000000002',
  second: '10000000-0000-4000-8000-000000000003',
  third: '10000000-0000-4000-8000-000000000004',
  gap: '10000000-0000-4000-8000-000000000005',
  later: '10000000-0000-4000-8000-000000000006',
  initA: '10000000-0000-4000-8000-000000000007',
  initB: '10000000-0000-4000-8000-000000000008',
}

function segment(
  id: string,
  startUs: bigint,
  endUs: bigint,
  options: Partial<PlaybackSegmentCandidate> = {},
): PlaybackSegmentCandidate {
  return {
    captureEndUs: endUs,
    captureStartUs: startUs,
    discontinuity: 0,
    durationUs: endUs - startUs,
    id,
    initAssetId: ids.initA,
    isGap: false,
    mediaAssetId: id,
    ready: true,
    ...options,
  }
}

const limits = {
  defaultBackUs: 1_000_000n,
  defaultForwardUs: 1_000_000n,
  maxBackUs: 2_000_000n,
  maxForwardUs: 2_000_000n,
}

describe('playback window selection', () => {
  it('selects a bounded contiguous run without crossing a discontinuity', () => {
    const candidates = [
      segment(ids.first, 0n, 1_000_000n),
      segment(ids.second, 1_000_000n, 2_000_000n),
      segment(ids.third, 2_000_000n, 3_000_000n),
      segment(ids.gap, 3_000_000n, 5_000_000n, {
        discontinuity: 1,
        isGap: true,
        ready: false,
      }),
      segment(ids.later, 5_000_000n, 6_000_000n, { discontinuity: 1 }),
    ]

    const selection = selectPlaybackWindow({
      candidates,
      limits,
      liveEdgeUs: 6_000_000n,
      mode: 'archive',
      requestedBackUs: 10_000_000n,
      requestedForwardUs: 500_000n,
      requestedTargetUs: 1_500_000n,
    })

    expect(selection.segments.map((value) => value.id)).toEqual([
      ids.first,
      ids.second,
    ])
    expect(selection.windowStartUs).toBe(0n)
    expect(selection.windowEndUs).toBe(2_000_000n)
    expect(selection.timelineStartUs).toBe(0n)
    expect(selection.timelineEndUs).toBe(6_000_000n)
    expect(selection.selectedRun.discontinuity).toBe(0)
    expect(selection.hasMoreBefore).toBe(false)
    expect(selection.hasMoreAfter).toBe(true)
  })

  it('treats bounds as half-open and reports gap versus not-ready targets', () => {
    const gap = segment(ids.gap, 1_000_000n, 2_000_000n, {
      isGap: true,
      ready: false,
    })
    const notReady = segment(ids.second, 2_000_000n, 3_000_000n, {
      discontinuity: 1,
      ready: false,
    })
    const candidates = [segment(ids.first, 0n, 1_000_000n), gap, notReady]

    expect(() => selectPlaybackWindow({
      candidates,
      limits,
      liveEdgeUs: 1_000_000n,
      mode: 'archive',
      requestedTargetUs: 1_000_000n,
    })).toThrowError(expect.objectContaining({ code: 'CAPTURE_GAP', status: 422 }))
    expect(() => selectPlaybackWindow({
      candidates,
      limits,
      liveEdgeUs: 1_000_000n,
      mode: 'archive',
      requestedTargetUs: 2_000_000n,
    })).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_READY', status: 409 }))
  })

  it('fails closed on overlap, duplicate identity, and invalid duration', () => {
    expect(() => buildReadyPlaybackRuns([
      segment(ids.first, 0n, 2_000_000n),
      segment(ids.second, 1_000_000n, 3_000_000n),
    ])).toThrow('overlap')
    expect(() => buildReadyPlaybackRuns([
      segment(ids.first, 0n, 1_000_000n),
      segment(ids.first, 1_000_000n, 2_000_000n),
    ])).toThrow('Duplicate')
    expect(() => buildReadyPlaybackRuns([
      segment(ids.first, 0n, 1_000_000n, { durationUs: 999_999n }),
    ])).toThrow('timing')
  })

  it('uses only an authoritative snapped sample to derive presentation origin', () => {
    const selection = selectPlaybackWindow({
      candidates: [
        segment(ids.first, 9_007_199_254_740_992n, 9_007_199_255_740_992n),
      ],
      limits,
      liveEdgeUs: 9_007_199_255_740_992n,
      mode: 'archive',
      requestedTargetUs: 9_007_199_255_000_000n,
    })
    expect(presentationOriginForSnap(selection, {
      captureUs: 9_007_199_255_000_001n,
      playerUs: 259_009n,
    })).toBe(9_007_199_254_740_992n)
    expect(() => presentationOriginForSnap(selection, {
      captureUs: selection.windowEndUs,
      playerUs: 0n,
    })).toThrow('outside the window')
  })
})

describe('playback manifest and wire views', () => {
  it('emits deterministic authorized init/media tokens and exact durations', () => {
    const manifest = formatManifest(ids.window, [
      { durationUs: 1_001_001n, id: ids.first, initAssetId: ids.initA },
      { durationUs: 16_683n, id: ids.second, initAssetId: ids.initA },
      { durationUs: 2_000_000n, id: ids.third, initAssetId: ids.initB },
    ])

    expect(manifest).toContain('#EXT-X-TARGETDURATION:2')
    expect(manifest).toContain('#EXTINF:1.001001,')
    expect(manifest).toContain('#EXTINF:0.016683,')
    expect(manifest.match(/#EXT-X-MAP/g)).toHaveLength(2)
    expect(manifest).toContain(`/segments/init-${ids.first}`)
    expect(manifest).toContain(`/segments/media-${ids.second}`)
    expect(manifest).not.toMatch(/objectKey|minio|https?:\/\//i)
    expect(parsePlaybackResourceToken(`media-${ids.second}`)).toEqual({
      dvrSegmentId: ids.second,
      kind: 'media',
    })
  })

  it('serializes bigint descriptor fields as decimal strings', () => {
    const base = 9_007_199_254_740_992n
    const descriptor = buildPlaybackDescriptor({
      captureEndUs: base + 2_000_000n,
      captureSessionId: ids.first,
      captureStartUs: base + 1_000_000n,
      expiresAt: new Date('2026-08-07T12:00:00.000Z'),
      id: ids.window,
      liveEdgeUs: base + 3_000_000n,
      mappingVersion: 1,
      mode: 'ARCHIVE',
      presentationOriginCaptureUs: base + 1_000_001n,
      targetPlayerMediaTimeUs: 999_999n,
      timelineEndUs: base + 3_000_000n,
      timelineStartUs: base,
    })
    expect(descriptor.timeline_capture_start_us).toBe(base.toString())
    expect(descriptor.window_capture_end_us).toBe((base + 2_000_000n).toString())
    expect(descriptor.live_edge_capture_time_us).toBe((base + 3_000_000n).toString())
    expect(descriptor.has_more_before).toBe(true)
    expect(descriptor.has_more_after).toBe(true)
  })

  it('creates strict canonical error envelopes', () => {
    const envelope = mediaErrorEnvelope(
      new MediaHttpError(410, 'WINDOW_EXPIRED', 'Playback window expired'),
      'request-1',
    )
    expect(envelope).toEqual({
      schema_version: '1.0.0',
      code: 'WINDOW_EXPIRED',
      message: 'Playback window expired',
      request_id: 'request-1',
    })
  })
})
