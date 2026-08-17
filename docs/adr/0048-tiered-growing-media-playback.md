# ADR 0048: Tiered publication for growing VOD and live playback

## Status

Accepted — 2026-08-17

## Context

YouTube VOD, completed-live recordings and active live captures are all growing
media from the workstation's point of view. Operators must be able to play and
annotate the first canonical seconds while later source bytes are still being
acquired. Waiting for a complete MP4, rewriting it with `faststart`, or waiting
for every small object to be synchronously committed to MinIO puts source and
object-storage latency on the first-play path. Replacing the HLS pipeline when
new segments appear then loses the browser buffer and can move the cursor back
to the beginning.

The canonical sample-index, READY integrity and bounded playback-window rules
from ADR 0005 remain required. The stable rolling manifest and single MSE
pipeline rules from ADR 0017 also remain required. This ADR changes which
durable tier must complete before a DVR artifact can become READY.

## Decision

### Direct growing capture

- YouTube VOD is resolved to fresh video/audio URLs and streamed directly into
  the checkpointed two-second fMP4 segmenter. It is never fully downloaded and
  then rewritten with `-movflags +faststart` before publication.
- A finalized segment is atomically published as soon as its timing entry is
  durable. Retry re-resolves expiring source URLs and resumes from the persisted
  segment/capture-time checkpoint defined by ADR 0021.
- YouTube live continues through OME. OME finalizes the same two-second recording
  units, so live and VOD enter one canonical indexing and publication path.

### Hot publication and archive

- On a single-node deployment, a shared persistent filesystem is the hot media
  tier for server, media worker and workflow worker. An artifact is eligible for
  READY only after an atomic local write and verification of its immutable byte
  length and SHA-256 metadata.
- MinIO remains the object archive and disaster-recovery tier. The media worker
  mirrors READY hot artifacts to MinIO asynchronously through the cluster-local
  service endpoint. Cloudflare, public DNS and NodePort are never used for this
  internal transfer.
- Every not-yet-verified archive copy has a durable sidecar receipt beside the
  hot object. Worker restart scans these receipts, retries idempotently and
  removes a receipt only after the MinIO object passes verification.
- Playback and workflow reads use the verified hot object first and fall back to
  MinIO when the local object is absent. Both paths verify database length and
  checksum metadata. Database object keys and public media contracts do not
  change.
- `MEDIA_HOT_ROOT` enables the tier, `MEDIA_ARCHIVE_CONCURRENCY` bounds archive
  pressure, and `MEDIA_INDEXER_SCAN_INTERVAL_MS` controls discovery latency.
  Without `MEDIA_HOT_ROOT`, the existing synchronous MinIO publication remains
  available as a conservative deployment mode.

### Stable browser continuation

- A growing live or VOD playback window keeps one ID, presentation origin and
  manifest URL. Extending `mapping_version` appends authorized READY media; it
  does not replace the `<video>` source, destroy hls.js, call `loadSource`, seek,
  or reset the cursor.
- Growing manifests stay open. `#EXT-X-ENDLIST` is emitted only after canonical
  capture completion and only for a window that reaches that completed end.
- hls.js owns playlist reload, fragment prefetch, retry and bounded MSE eviction.
  Server-window extension remains bounded and is requested near the mapped
  frontier; full DVR is never copied into the browser.

## Deployment constraints

- The hot root must be persistent and mounted at the identical container path in
  server, media worker and workflow worker. The current single-node k3s target
  uses one hostPath volume.
- A multi-node deployment must replace hostPath with a suitable RWX/locality
  design or disable the hot tier. Scheduling components on nodes that cannot see
  the same hot root is invalid.
- Hot-tier retention must never delete an object with an archive receipt. A
  later retention policy may evict only archive-verified objects and must retain
  MinIO fallback correctness.
- Archive backlog and last archive failure are non-critical health signals for
  immediate playback, but must be monitored because they reduce durability.

## Consequences

- First canonical playback is bounded by source resolution, one segment
  finalization and canonical indexing, not by full-source duration or per-object
  MinIO latency.
- Slow MinIO no longer stalls capture indexing or live continuation, while the
  archive remains recoverable across worker restarts.
- Local disk capacity becomes an explicit operational concern until verified
  hot-object eviction is implemented.
- Literal zero-second annotation is not claimed: browser-visible markers still
  require a finalized, indexed segment so capture time/frame remain authoritative.

## Required verification

- A VOD longer than the first segment becomes playable before source download
  completion and resumes from a checkpoint after an interrupted source URL.
- A live source grows its timeline and HLS playlist while one player instance,
  current time and existing MSE buffer remain attached.
- Blocking MinIO does not block local publish, READY playback or workflow reads;
  restart later drains the durable archive receipts.
- Hot and archived reads reject byte-length or checksum mismatch.
- k3s mounts the same persistent hot root into all three consumers and uses the
  internal MinIO service URL.
