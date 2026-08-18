# ADR 0052: Build canonical clips from archive extents

## Status

Accepted for staged implementation.

## Context

OME Live playback and exact annotation cursor resolution now bypass the legacy playback segment
model, but canonical clip generation still queries `DvrSegment` and follows three `MediaAsset`
relations. The archived media object stored on `MediaExtent` is only the fragmented MP4 media body;
it is not independently decodable without the matching initialization object.

Removing the legacy rows before preserving that object identity would make completed recordings
unclippable even though their canonical timing projection remains valid.

## Decision

Project the verified init object identity, media object checksum/schema, stable sequence number, and
discontinuity identity directly onto `MediaExtent`. Each projection tuple is all-null or complete and
is backfilled only when the archive extent, legacy segment, and READY init/media artifacts agree on
program, canonical range, object location, size, type, checksum, and schema.

The clip worker prefers a complete sequence of archive-verified extents. It verifies and appends each
extent's init and media objects, validates the projected sample index against canonical PTS/frame
metadata, and uses the existing exact frame-selection and timing-manifest pipeline unchanged. Rows
created by an older worker fall back to `DvrSegment` during the migration. While both models exist,
the worker requires one-to-one parity for segment identity, discontinuity, canonical timing, and all
three archived objects before preferring extents. Missing edge rows or parity mismatches keep the
legacy source authoritative. A partially populated row or a complete but invalid extent fails closed
rather than silently falling back. Extent-only reads additionally require the requested range to be
fully covered by one continuous, monotonically sequenced discontinuity.

This does not yet remove legacy ingest reservations or asset rows. Those writes remain until clip,
operations, and ingest-head consumers have all moved and parity has been measured.

## Consequences

- Canonical clips and downstream AI can use coarse physical extents without depending on playback
  window mappings or segment relations.
- The timing manifest contract and immutable annotation anchors do not change.
- Init bytes remain duplicated per physical extent for now. Deduplication or archiving one
  self-contained MP4 is a later storage optimization and must not precede verified clip parity.
- Overlapping, gapped, unsupported-schema, or checksum-invalid extent sequences are rejected.
