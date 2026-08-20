# ADR 0057: Use hybrid OME DVR and durable archive playback

## Status

Accepted.

## Context

OME is the lowest-latency source for an active Live program, but its DVR is a bounded cache rather
than the permanent recording authority. In the current deployment the OME DVR volume is 5 GiB, so
the configured six-hour retention cannot be guaranteed at real match bitrates. Annotation operators
must still be able to seek any finalized part of a long match without making Node, PostgreSQL, or
MinIO the near-Live media path.

The annotation page also requested the complete coach match-state projection. That response includes
AI summaries and resolved contact-point timelines which the annotation workstation does not consume.
Repeated full responses increase Cloudflare latency and compete with media reads on weak links.

## Decision

For Live programs, OME LL-HLS remains the active and near-Live playback source. Permanent recording
uses coarse extents (60 seconds by default). `LIVE_ARCHIVE_BACKEND=dual_projection` catalogs each
finalized extent as a `MediaExtent` and also publishes one coarse legacy playback segment so the
existing bounded archive player can read finalized history. This is a transitional projection of the
same physical extent, not a return to two-second files or per-viewer playback mappings.

When a canonical `captureTimeUs` is outside the current OME seekable range but inside durable
timeline coverage, the annotation player opens a bounded archive window at that same canonical time.
It does not silently oscillate between backends. The operator returns to direct OME through the Live
control. Source switching never derives annotation time from `video.currentTime`.

The `coachMatchState` GraphQL field accepts an optional `profile`. The default remains `full` for
backward compatibility. The annotation workstation requests `annotation`, which omits unused
analysis `summary` and `contact_points` while retaining rally boundaries, key points, processing,
coverage, and capability metadata.

## Consequences

- Near-Live browsers continue to receive video bytes directly from OME.
- Finalized history remains seekable after the OME DVR cache evicts it.
- Archive availability can lag Live by one recording extent; it is not part of the Live-ready
  condition.
- Canonical PTS/capture-time mapping remains shared across OME and archive playback.
- The temporary dual projection creates one coarse playback row per extent, not one row every two
  seconds. A future extent-native archive player can remove this compatibility projection.
- ADR 0053 remains the preferred pure extent authority where bounded DVR history is sufficient. This
  ADR supersedes that deployment choice only where arbitrary finalized Live history is required.
- Coach and analytics clients remain on the full GraphQL projection; only annotation traffic is
  reduced.
