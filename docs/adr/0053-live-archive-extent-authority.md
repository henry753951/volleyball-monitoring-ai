# ADR 0053: Make MediaExtent authoritative for Live recording ingest

## Status

Accepted.

## Context

OME serves active Live LL-HLS/DVR directly and writes coarse permanent recording files. The archive
worker nevertheless reserved one `DvrSegment` plus three `MediaAsset` rows for every finalized OME
recording extent. Those rows no longer served Live playback, but remained the ingest FIFO/completion
head and prevented the transitional schema from being bypassed.

## Decision

For recognized Live source kinds, `LIVE_ARCHIVE_BACKEND=media_extent` makes `MediaExtent` the ingest
reservation, canonical timing, artifact expectation, archive publication, FIFO, and completion
authority. The worker still keeps `DvrProgram` and `CaptureEpoch` because rallies and canonical PTS
mapping depend on them. It archives init, media, and sample-index objects directly through the
projection fields on `MediaExtent`; it does not create `DvrSegment` or DVR `MediaAsset` rows.

VOD and local-file import remain on the legacy ingest repository while their playback migration is
separate. `LIVE_ARCHIVE_BACKEND=legacy` is the rollback switch for a deployment that must restore the
old Live archive writer. Operations and source-drain reporting choose extent counts for Live and
legacy segment counts for VOD/import, so changing the switch does not make an incomplete recording
appear finished.

## Consequences

- A normal Live hour creates about sixty coarse `MediaExtent` catalog rows, not sixty transitional
  segments plus 180 asset rows.
- Node/PostgreSQL remain outside the active Live video-byte path.
- Exact annotation, clips, and AI retain canonical epoch/sample-index metadata.
- Existing historical and VOD playback rows remain readable; no destructive schema migration is
  included.
- If direct OME playback is unavailable during an active extent-only Live capture, the rollback is a
  deployment configuration change for subsequent ingest, not reconstruction of already omitted
  legacy rows.
