import { describe, expect, it } from 'vitest'
import {
  MediaHttpError,
  assertRollingPlaybackSelection,
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

const initFingerprints = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
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
  it('keeps an explicit live continuation target instead of jumping to a newer edge', () => {
    const candidates = [
      segment(ids.first, 0n, 1_000_000n),
      segment(ids.second, 1_000_000n, 2_000_000n),
      segment(ids.third, 2_000_000n, 3_000_000n),
      segment(ids.later, 3_000_000n, 4_000_000n),
    ]
    const selection = selectPlaybackWindow({
      candidates,
      limits,
      liveEdgeUs: 4_000_000n,
      mode: 'live',
      requestedBackUs: 500_000n,
      requestedForwardUs: 1_500_000n,
      requestedTargetUs: 1_500_000n,
    })

    expect(selection.targetUs).toBe(1_500_000n)
    expect(selection.segments.map(value => value.id)).toEqual([ids.second, ids.third])
  })

  it('crosses capture epochs inside one window but still stops at real gaps', () => {
    const candidates = [
      segment(ids.first, 0n, 1_000_000n),
      segment(ids.second, 1_000_000n, 2_000_000n),
      segment(ids.third, 2_000_000n, 3_000_000n, { discontinuity: 1 }),
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
      requestedForwardUs: 1_500_000n,
      requestedTargetUs: 1_500_000n,
    })

    expect(selection.segments.map(value => value.id)).toEqual([ids.first, ids.second, ids.third])
    expect(selection.windowStartUs).toBe(0n)
    expect(selection.windowEndUs).toBe(3_000_000n)
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

    expect(() =>
      selectPlaybackWindow({
        candidates,
        limits,
        liveEdgeUs: 1_000_000n,
        mode: 'archive',
        requestedTargetUs: 1_000_000n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CAPTURE_GAP', status: 422 }))
    expect(() =>
      selectPlaybackWindow({
        candidates,
        limits,
        liveEdgeUs: 1_000_000n,
        mode: 'archive',
        requestedTargetUs: 2_000_000n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_READY', status: 409 }))
  })

  it('fails closed on overlap, duplicate identity, and invalid duration', () => {
    expect(() =>
      buildReadyPlaybackRuns([
        segment(ids.first, 0n, 2_000_000n),
        segment(ids.second, 1_000_000n, 3_000_000n),
      ]),
    ).toThrow('overlap')
    expect(() =>
      buildReadyPlaybackRuns([
        segment(ids.first, 0n, 1_000_000n),
        segment(ids.first, 1_000_000n, 2_000_000n),
      ]),
    ).toThrow('Duplicate')
    expect(() =>
      buildReadyPlaybackRuns([segment(ids.first, 0n, 1_000_000n, { durationUs: 999_999n })]),
    ).toThrow('timing')
  })

  it('uses only an authoritative snapped sample to derive presentation origin', () => {
    const selection = selectPlaybackWindow({
      candidates: [segment(ids.first, 9_007_199_254_740_992n, 9_007_199_255_740_992n)],
      limits,
      liveEdgeUs: 9_007_199_255_740_992n,
      mode: 'archive',
      requestedTargetUs: 9_007_199_255_000_000n,
    })
    expect(
      presentationOriginForSnap(selection, {
        captureUs: 9_007_199_255_000_001n,
        playerUs: 259_009n,
      }),
    ).toBe(9_007_199_254_740_992n)
    expect(() =>
      presentationOriginForSnap(selection, {
        captureUs: selection.windowEndUs,
        playerUs: 0n,
      }),
    ).toThrow('outside the window')
  })
})

describe('playback manifest and wire views', () => {
  it('accepts an append-only rolling selection and rejects rewritten overlap', () => {
    const current = [
      segment(ids.first, 0n, 1_000_000n),
      segment(ids.second, 1_000_000n, 2_000_000n),
    ]
    expect(() =>
      assertRollingPlaybackSelection(current, [
        current[1]!,
        segment(ids.third, 2_000_000n, 3_000_000n),
      ]),
    ).not.toThrow()
    expect(assertRollingPlaybackSelection(current, current)).toBe(false)
    expect(assertRollingPlaybackSelection(current, [current[1]!])).toBe(false)
    expect(() =>
      assertRollingPlaybackSelection(current, [
        segment(ids.third, 1_000_000n, 2_000_000n),
        segment(ids.later, 2_000_000n, 3_000_000n),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'MAPPING_STALE' }))
    expect(() =>
      assertRollingPlaybackSelection(current, [segment(ids.third, 2_000_000n, 3_000_000n)]),
    ).toThrowError(expect.objectContaining({ code: 'MAPPING_STALE' }))
  })

  it('emits deterministic authorized init/media tokens and exact durations', () => {
    const manifest = formatManifest(
      ids.window,
      [
        {
          discontinuity: 0,
          durationUs: 1_001_001n,
          id: ids.first,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 41n,
        },
        {
          discontinuity: 0,
          durationUs: 16_683n,
          id: ids.second,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 42n,
        },
        {
          discontinuity: 1,
          durationUs: 2_000_000n,
          id: ids.third,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 43n,
        },
      ],
      { endList: false },
    )

    expect(manifest).toContain('#EXT-X-TARGETDURATION:2')
    expect(manifest).toContain('#EXT-X-MEDIA-SEQUENCE:41')
    expect(manifest).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0')
    expect(manifest).not.toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(manifest).not.toContain('#EXT-X-ENDLIST')
    expect(manifest).toContain('#EXTINF:1.001001,')
    expect(manifest).toContain('#EXTINF:0.016683,')
    expect(manifest.match(/#EXT-X-MAP/g)).toHaveLength(1)
    expect(manifest.match(/^#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1)
    expect(manifest).toContain(`/segments/init-${ids.first}`)
    expect(manifest).toContain(`/segments/media-${ids.second}`)
    expect(manifest).not.toMatch(/objectKey|minio|https?:\/\//i)
    expect(parsePlaybackResourceToken(`media-${ids.second}`)).toEqual({
      dvrSegmentId: ids.second,
      kind: 'media',
    })
  })

  it('re-emits initialization media only when its content changes', () => {
    const manifest = formatManifest(
      ids.window,
      [
        {
          discontinuity: 0,
          durationUs: 1_000_000n,
          id: ids.first,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 41n,
        },
        {
          discontinuity: 0,
          durationUs: 1_000_000n,
          id: ids.second,
          initFingerprint: initFingerprints.b,
          sequenceNumber: 42n,
        },
      ],
      { endList: false },
    )

    expect(manifest.match(/#EXT-X-MAP/g)).toHaveLength(2)
    expect(manifest).toContain(`/segments/init-${ids.first}`)
    expect(manifest).toContain(`/segments/init-${ids.second}`)
  })

  it('emits short byte-range fragments without duplicating the physical media object', () => {
    const manifest = formatManifest(
      ids.window,
      [
        {
          discontinuity: 0,
          durationUs: 2_000_000n,
          id: ids.first,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 100n,
          byteRange: { offset: 512n, length: 800_000n },
        },
        {
          discontinuity: 0,
          durationUs: 2_000_000n,
          id: ids.first,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 101n,
          byteRange: { offset: 800_512n, length: 780_000n },
        },
      ],
      { endList: false },
    )

    expect(manifest).toContain('#EXT-X-TARGETDURATION:2')
    expect(manifest).toContain('#EXT-X-MEDIA-SEQUENCE:100')
    expect(manifest).toContain('#EXT-X-BYTERANGE:800000@512')
    expect(manifest).toContain('#EXT-X-BYTERANGE:780000@800512')
    expect(manifest.match(new RegExp(`/segments/media-${ids.first}`, 'g'))).toHaveLength(2)
  })

  it('preserves the absolute discontinuity sequence after a rolling prefix is dropped', () => {
    const manifest = formatManifest(
      ids.window,
      [
        {
          discontinuity: 4,
          durationUs: 1_000_000n,
          id: ids.second,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 42n,
        },
        {
          discontinuity: 5,
          durationUs: 1_000_000n,
          id: ids.third,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 43n,
        },
      ],
      { endList: false },
    )

    expect(manifest).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:4')
    expect(manifest.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(1)
    expect(() =>
      formatManifest(
        ids.window,
        [
          {
            discontinuity: 4,
            durationUs: 1_000_000n,
            id: ids.second,
            initFingerprint: initFingerprints.a,
            sequenceNumber: 42n,
          },
          {
            discontinuity: 6,
            durationUs: 1_000_000n,
            id: ids.third,
            initFingerprint: initFingerprints.b,
            sequenceNumber: 43n,
          },
        ],
        { endList: false },
      ),
    ).toThrow('discontinuity sequence')
  })

  it('seals a completed finite source playlist with ENDLIST', () => {
    const manifest = formatManifest(
      ids.window,
      [
        {
          discontinuity: 0,
          durationUs: 1_000_000n,
          id: ids.first,
          initFingerprint: initFingerprints.a,
          sequenceNumber: 0n,
        },
      ],
      { endList: true },
    )

    expect(manifest).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(manifest).toContain('#EXT-X-ENDLIST')
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
