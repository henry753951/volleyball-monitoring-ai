# ADR 0049: OME is the Live media plane

## Status

Accepted for staged implementation.

## Context

The Live annotation path currently records two-second MP4 files from OvenMediaEngine, indexes each
file into `DvrSegment` and `MediaAsset`, creates viewer-specific `PlaybackWindow` mappings, and then
serves a second HLS representation through the Node server. OME already publishes LL-HLS with DVR
and records the same stream, so this duplicates the Live media plane and couples playback readiness
to archive indexing.

Browser media time is still observational. Existing annotation commands resolve a playback-window
cursor through a sample index before persisting canonical capture time and frame. Direct OME playback
must not weaken that invariant.

## Decision

Introduce `LIVE_MEDIA_BACKEND=legacy|ome_experiment`. In `ome_experiment`, active Live video bytes
are loaded directly from the OME LL-HLS publisher. The existing PlaybackWindow path remains the
fallback and continues serving VOD and historical sessions.

The first stage is deliberately playback-only. Each OME publisher generation is identified by its
stream instance plus the first LL-HLS `EXT-X-PROGRAM-DATE-TIME`. The worker records a provisional
`LivePresentationAnchor`, then validates it against a finalized OME recording extent and its durable
`CaptureEpoch`. Only validated anchors are exposed to the workstation. hls.js `playingDate` maps the
presented frame through that anchor to canonical capture time; the old live-edge-minus-seekable-end
estimate is not authoritative.

This is an additive GraphQL field on `CaptureSession`; existing consumers and wire versions remain
compatible. It does not change the annotation command contract. Direct OME playback still must not
persist time-based commands until a later contract adds a discontinuity-aware authoritative cursor
that the server can resolve to a durable sample/frame. An OME load failure falls back to legacy once
for that capture; the player never oscillates between backends.

`CaptureSession.ingestPath` is exposed to the authorized GraphQL consumer so it can construct the
same-origin OME playlist URL. This is not authorization by itself; production cutover requires OME
playback access control or short-lived signed URLs before the experiment flag becomes the default.

## Consequences

- Live media requests bypass Node, PostgreSQL, MinIO, PlaybackWindow, and DvrSegment serving.
- PostgreSQL and Redis remain control-plane dependencies only.
- Existing schema is retained during migration.
- `LivePresentationAnchor` makes direct playback position observable in canonical capture time after
  durable validation, normally after the first recording extent finalizes.
- A later ADR/contract revision will define the discontinuity-aware authoritative annotation cursor;
  playback mapping alone does not permit annotation persistence.
- OME FILE recording interval and catalog-worker changes are separate follow-up work.
