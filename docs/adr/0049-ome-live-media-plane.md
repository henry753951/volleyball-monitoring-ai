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

The first stage is deliberately playback-only. Until an OME presentation-time to canonical program
time mapping is validated, the workstation may play and seek the OME DVR but must not persist
time-based annotation commands. An OME load failure falls back to legacy once for that capture; the
player never oscillates between backends.

`CaptureSession.ingestPath` is exposed to the authorized GraphQL consumer so it can construct the
same-origin OME playlist URL. This is not authorization by itself; production cutover requires OME
playback access control or short-lived signed URLs before the experiment flag becomes the default.

## Consequences

- Live media requests bypass Node, PostgreSQL, MinIO, PlaybackWindow, and DvrSegment serving.
- PostgreSQL and Redis remain control-plane dependencies only.
- Existing schema is retained during migration.
- A later ADR/contract revision will define discontinuity-aware canonical program timeline epochs.
- OME FILE recording interval and catalog-worker changes are separate follow-up work.
