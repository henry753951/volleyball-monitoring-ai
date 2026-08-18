# ADR 0051: Move canonical extent timing out of the Live playback segment model

## Status

Accepted for staged implementation.

## Context

OME now serves Live LL-HLS/DVR bytes directly and permanent recordings are coarse physical extents.
The transitional ingest path still creates a `DvrSegment` and three `MediaAsset` rows per extent.
Those records are no longer needed to serve Live video, but `DvrSegment` remains the only durable
owner of capture epoch, source PTS, frame range, and sample-index identity. Removing it immediately
would make direct OME annotation cursors estimated and would break exact clip and AI time mapping.

## Decision

Add a nullable canonical timing projection to `MediaExtent`: capture epoch, source PTS range, frame
range, and verified sample-index object identity. New archive publications dual-write this projection
in the same transaction that makes the extent archive-verified. The migration backfills only existing
catalog rows that already have complete verified legacy metadata.

All fields remain nullable during the transition so the database migration can be deployed before
the worker and an older worker can continue writing. Readers must use the projection only when the
entire timing and sample-index tuple is present; otherwise they keep using the legacy segment path.
Conflicting non-null metadata is rejected on redelivery.

The database enforces that the ten projection fields are either all null or all populated. The epoch
foreign key is restrictive so deleting an epoch cannot silently turn a complete projection into a
partial one. The initial backfill accepts only archive-verified extents whose READY, non-gap segment,
epoch ownership, canonical range, and verified sample-index asset all agree. Old workers may still
create all-null rows during a rolling deployment; reconciliation is therefore repeated after they
are drained before the projection becomes authoritative.

This stage does not remove `DvrSegment`, `MediaAsset`, `PlaybackWindow`, or their schema. A later
change will make OME cursor resolution, clip extraction, and AI materialization dual-read the extent
projection. Only after those consumers are verified may OME Live stop creating legacy rows.

## Consequences

- `MediaExtent` can become the durable canonical index for coarse recordings without entering the
  Live video-byte path.
- Existing deployments can roll forward without a synchronized database/worker cutover.
- Historical catalog rows with incomplete legacy metadata remain valid but are not exact-timing
  candidates until reconciliation fills them.
- The temporary dual-write duplicates a small amount of metadata at extent frequency; it avoids a
  risky big-bang migration and preserves exact annotation semantics.
