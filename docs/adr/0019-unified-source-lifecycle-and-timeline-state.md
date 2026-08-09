# ADR 0019: Unified media source lifecycle and truthful timeline state

Status: Accepted — 2026-08-09

## Context

ADR 0017 established OvenMediaEngine as the only live ingest runtime and hls.js
as the browser buffer engine. The application still conflated source brand,
source liveness, server DVR availability, bounded playback-window coverage and
browser-buffered bytes. Finite YouTube and uploaded sources also had no durable
success transition, so their manifests remained non-terminal at canonical end.

## Decision

Every capture uses one persisted lifecycle independent of transport:

- `STARTING` covers connection, download or import setup;
- `LIVE` means verified canonical media is available and may still grow;
- `STOPPING` means the producer supplied a sealed segment-count watermark and
  the indexer is draining media at or before that watermark;
- `FINISHED` is written only after every expected segment is READY, the final
  capture epoch is closed and the canonical end is known;
- `FAILED` is terminal and closes any partial program consistently.

The YouTube relay persists its probe classification as `youtube_live` or
`youtube_vod`. A previously-live recording is imported progressively as VOD,
then finalized as `youtube_live` so the finished UI retains its source history.
Local MP4 and YouTube VOD publish closed two-second files atomically while
segmentation is still running rather than waiting for the entire source.

`CaptureSession.sourceDurationUs` is optional source metadata, never timeline
authority. GraphQL exposes additive timeline state:

- `availableRanges`: READY canonical server media;
- `gapRanges`: explicit persisted capture gaps only;
- `ingestFrontierCaptureTimeUs`: furthest segment known to the indexer;
- `sourceEndCaptureTimeUs`: known finite source end, when available;
- `availabilityComplete`: terminal drain completion.

The browser keeps the current playback-window descriptor and `video.buffered`
as separate ephemeral layers. Active live shows `LIVE`; finished live and
complete finite media show `END`; progressive finite sources show an indexing
frontier and an unavailable tail without labelling it a gap.

## Compatibility

The GraphQL fields are additive. All 64-bit values remain decimal strings on
the wire. The relay status callback is internal and gains idempotent
`classified` and `completed` variants; public AI contracts are unchanged.

## Consequences

- HLS emits `ENDLIST` only after the sealed watermark drains.
- Browser buffer starvation cannot be interpreted as missing server media.
- Source duration may size a finite timeline but never creates seekable media.
- Completion retries are safe because the persisted watermark cannot change.

## Required verification

- active live, ended live, progressive YouTube VOD and local MP4 lifecycle;
- success callback before and after final segment indexing;
- terminal manifest and no-progress rolling-window behavior;
- explicit gap, pending tail and browser-buffer layers remain distinct.
