# ADR 0050: Decouple OME recording extents from LL-HLS segments

## Status

Accepted for staged implementation.

## Context

OME publishes 0.5-second LL-HLS parts and two-second playback segments for interactive Live DVR.
The FILE publisher previously reused a two-second interval for permanent MP4 recording. That created
roughly 1,800 physical files per hour and drove the media indexer, ffprobe, hashing, object storage,
and PostgreSQL artifact publication at playback-segment frequency even though Live playback now
bypasses that pipeline.

OME 0.20.5 was tested with a synthetic H.264/AAC RTMP source. A 72-second source with a 60,000 ms
recording interval produced two finalized MP4 files (approximately 62.0 and 10.0 seconds) while the
LL-HLS playlist continued to expose 0.5-second parts and two-second segments. OME may finalize at the
next suitable media boundary, so the interval is a target rather than an exact file duration.

OME's automatic `record_map.xml` does not expand `${env:...}` values in `SegmentInterval`; the same
syntax that works in `Server.xml` was parsed as interval zero in the tested image. A runtime-looking
configuration that silently disables splitting is worse than an explicit reviewed value.

## Decision

- Keep LL-HLS `ChunkDuration=0.5` and `SegmentDuration=2`.
- Set the automatic FILE publisher `SegmentInterval` to 60,000 ms with timestamp continuity.
- Treat `recording.xml` as the primary finalized-extent metadata.
- Poll only DB-known active capture directories every 500 ms; this is bounded by active captures and
  does not recursively walk historical spool data.
- Use recursive filesystem events as an opportunistic faster path for finalized media and recording
  metadata.
- Run a full spool reconciliation every 30 seconds for startup, missed events, and crash recovery.
- Keep two unchanged observations plus a 500 ms age gate before queueing any finalized file.
- Add an additive `MediaExtent` catalog. New worker publications dual-write one extent row at the
  same transaction boundary that marks the legacy segment and archived media object READY.
- Key catalog publication by both the finalized-file job ID and the transitional `DvrSegment` ID.
  Redelivery must converge on one row, preserve the first catalog/archive timestamps, and reject
  conflicting immutable source, timeline, or object metadata.

Docker Desktop bind-mount verification found that recursive inotify watchers can start successfully
yet receive no event when another container writes the mounted directory. The bounded active-capture
poll is therefore required for correctness; `fs.watch` is not treated as a health or delivery signal.

An end-to-end 68-second smoke capture produced 62.000-second and 5.967-second catalog segments. The
bounded poll queued each finalized extent within about one second, and the worker published two
continuous READY segments (`0..62,000,000 us` and `62,000,000..67,967,000 us`) with media and sample
index objects. This verifies the transitional catalog path with coarse physical files; it does not
make that catalog part of Live playback readiness.

The smoke also exposed a pre-existing strict-FIFO quarantine defect. A failed capture key retained
1,004 CREATED successors, and pg-boss repeatedly selected the oldest successor only to conflict with
the failed-key sentinel. That head-of-line loop starved unrelated captures. Permanent failure now
cancels queued successors for that capture, startup repairs existing blocked keys, and active/root
scans exclude capture sessions with a recorded ingest failure. The failed source sentinel and audit
record remain intact, so media is never silently skipped.

Thirty- and 120-second alternatives remain deployment experiments. Changing the interval requires an
explicit configuration change and an OME restart until recording ownership moves to the OME Recording
REST API, whose request contract can carry an interval per recording task.

The catalog migration intentionally does not backfill existing `DvrSegment` rows. Most historical
rows represent two-second logical playback segments; copying them one-for-one would manufacture a
fine-grained catalog, increase migration lock/runtime risk, and defeat the physical-extent model. New
publications populate `MediaExtent`; a future reconciliation job may import actual finalized
recording files from OME metadata when historical coarse extents are needed.

## Canonical timeline finding

The LL-HLS media playlists contain `EXT-X-PROGRAM-DATE-TIME` for each segment. `recording.xml`
contains extent start and finish wall-clock values, but each finalized MP4 resets local PTS to zero.
The observed recording start time and first LL-HLS program date time also differed by hundreds of
milliseconds. Therefore neither MP4 `currentTime` nor recording metadata wall-clock alone is a
frame-accurate annotation clock. Direct OME annotation remains gated until a persisted LL-HLS
presentation anchor maps media time to canonical `captureTimeUs` across reconnect discontinuities.

## Consequences

- Normal Live recording produces about 60 physical extents per hour instead of about 1,800.
- Live playback latency and DVR granularity are unchanged.
- Existing DvrSegment/MediaAsset publication remains a transitional VOD/archive consumer, but runs at
  extent frequency rather than LL-HLS frequency.
- New archive-verified publications are discoverable through `MediaExtent` without making either the
  catalog or PostgreSQL part of the Live video-byte path.
- A deployment does not depend on recursive watch delivery; the bounded active-capture poll is the
  normal fallback and root reconciliation repairs missed or orphaned state.
- One quarantined capture cannot stall catalog publication for other capture keys.
- OME REST recording ownership and removal of the legacy per-extent DvrSegment/MediaAsset dual-write
  remain follow-up migrations.
