# ADR 0005: Phase 2A media truth, bounded DVR and sample authority

- Status: Accepted
- Date: 2026-08-07
- Decision owner: Main PM / Tech Lead

## Context

Phase 1B established an authenticated match domain and the first live PostgreSQL migration. Phase 2 must now prove that the server retains the complete recording while the browser loads bounded playback windows and sends observations that the server resolves through a real sample index. This slice stops before mutable annotation persistence, immutable submissions, clips and AI.

`docs/SYSTEM_SPEC_V3_2.md` is authoritative. Its REST catalog uses `/v1` while its descriptor example and the deployed same-origin client use `/api/v1`; it also describes Phase 3 key-point editing in the frame-step prose while the frozen Phase 2 media schema deliberately has no key-point dependency. This ADR resolves those integration ambiguities without changing the media JSON payload versions.

## Phase boundary

Phase 2A owns:

- one deterministic single-rendition capture source and a reconnect/PTS-reset discontinuity;
- MediaMTX finalized fMP4 recording discovery;
- durable `pg-boss` ingest claims, ffprobe sample extraction, MinIO artifacts and transactional `CaptureEpoch`, `DvrProgram`, `DvrSegment` and `MediaAsset` persistence;
- GraphQL capture-session metadata and full availability ranges;
- persisted bounded playback-window mappings;
- authenticated REST descriptor, HLS manifest/segments, cursor resolve and canonical frame-step;
- PWA full timeline/gap/live edge, archive lazy seek, return-to-live, RVFC observation and one-frame step.

Phase 2A must not write `Rally`, `KeyPoint`, `AnnotationOperation`, `RallySubmission`, `ClipJob` or `AiJob`. Phase 3 consumes `ResolvedMediaAnchor` when it creates or edits markers.

## Time and storage authority

- Source PTS is meaningful only within `CaptureEpoch`. A reconnect or PTS reset creates a new epoch.
- `capture_time_us` and `capture_frame_index` remain monotonic session-wide PostgreSQL `BIGINT` values and decimal strings on the wire.
- The worker extracts the real ffprobe sample table. Neither server nor browser derives canonical frames from `currentTime * FPS`.
- Each ready `DvrSegment` references its init/media/sample-index `MediaAsset` records. The per-segment internal sample index is versioned and stores real source PTS/time base, capture time/frame, keyframe state and media timing needed by the resolver.
- `MINIO_DVR_BUCKET` is the configurable implementation of the specification's logical playback bucket. Object keys never become database identities and the literal bucket name is not a public contract.

## GraphQL boundary

GraphQL carries metadata only. It adds authenticated, membership-filtered capture discovery plus the exact timeline shape below; media bytes and full segment/sample lists remain outside GraphQL.

```graphql
type CaptureSession {
  id: ID!
  matchId: ID!
  sourceLabel: String
  status: CaptureStatus!
  health: SourceHealth!
  startedAt: DateTime
  endedAt: DateTime
  timeline: CaptureTimeline
}

type CaptureTimeline {
  captureSessionId: ID!
  timelineVersion: BigInt!
  captureStartTimeUs: BigInt!
  liveEdgeCaptureTimeUs: BigInt
  availableRanges: [CaptureTimelineRange!]!
}

type CaptureTimelineRange {
  startUs: BigInt!
  endUs: BigInt!
  discontinuity: Int!
}
```

`Match.captureSessions: [CaptureSession!]!` is ordered newest first. `captureSession(id: ID!): CaptureSession` returns null for missing or inaccessible sessions. Any match member may read media; `ADMIN` may read all. GraphQL `BigInt` continues to serialize as a decimal string.

## REST and HLS boundary

The external same-origin prefix is `/api/v1`. OpenAPI advances additively from `1.1.0` to `1.2.0`. The canonical Phase 2 routes are:

```text
POST /api/v1/media/playback-windows
GET  /api/v1/media/playback-windows/{windowId}
GET  /api/v1/media/playback-windows/{windowId}/manifest.m3u8
GET  /api/v1/media/playback-windows/{windowId}/segments/{segmentId}
GET  /api/v1/media/playback-windows/{windowId}/media.mp4
POST /api/v1/media/resolve-cursor
POST /api/v1/media/frame-step
```

The pre-implementation `/playback-cursors/resolve` OpenAPI path is replaced by the specification's `resolve-cursor` path. The six media JSON Schemas remain `1.0.0`; representative fixtures and typed validators are additive.

Production media authorization uses a same-site HTTP-only session cookie so native iPad HLS can authenticate manifest and segment requests without custom per-segment headers. The explicit local development identity fallback remains available only when development auth is enabled and is never trusted in production. Unknown or cross-match resources are non-disclosing.

All non-success JSON responses use a versioned media error envelope and stable codes:

| HTTP | Codes |
| --- | --- |
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `MAPPING_STALE`, `MEDIA_NOT_READY`, `WINDOW_BOUNDARY` |
| 410 | `WINDOW_EXPIRED` |
| 422 | `CURSOR_NOT_READY`, `CAPTURE_GAP`, `SAMPLE_NOT_FOUND` |

An expired descriptor, manifest, segment or resolve/step request returns `410`; the PWA requests a new window around its last authoritative canonical capture position. The server does not silently renew a mapping version.

## Window and gap semantics

- A playback window is persisted with its capture session, mapping version, contiguous range, presentation origin, expiry and ordered segment mapping.
- A window never spans a gap or discontinuity. Requested bounds are clamped to the one ready `available_range` containing the target, which keeps one affine presentation origin. A target inside a gap returns `422 CAPTURE_GAP`.
- Window creation is synchronous only over already indexed, ready fMP4 media and returns `200`. Missing readiness returns `409 MEDIA_NOT_READY`; Phase 2A does not add a `202/pending` descriptor.
- Manifests contain only bounded, authorized window segments and same-origin URLs. They never expose MinIO credentials or internal endpoints.
- The PWA retains current/previous/next window metadata and bounded media buffers only.

## Cursor and frame-step semantics

- Only `cursor_status=ready` is resolvable. Seeking, stale or gap observations return stable `422` errors; a foreign or stale mapping version returns `404` or `409` as applicable.
- The affine origin maps the observation into a candidate time, but the server always snaps through the persisted sample index and returns the authoritative anchor and snap distance.
- Phase 2A chooses the indexed sample with the smallest absolute canonical-time distance; an exact tie deterministically chooses the earlier sample. Candidates outside the ready contiguous range are rejected rather than snapped across a gap. With a complete ffprobe sample index this slice returns `frame_exact` or `pts_exact`, never `estimated`; the enum value remains reserved for a separately approved degraded mode.
- `frame-step-request` remains the low-level Phase 2 `1.0.0` contract: capture session, playback window, mapping version, canonical frame index and `previous|next`. One request means exactly one real adjacent sample, including VFR.
- Frame-step stays within the current bounded window. At a window boundary it returns `409 WINDOW_BOUNDARY`; the PWA recenters an archive window on the current authoritative capture time and retries. At a session/gap boundary with no adjacent sample it returns `422 SAMPLE_NOT_FOUND`.
- Phase 3 may expose a key-point editing command that looks up the key point and calls this media service. The Phase 2 REST endpoint never accepts or mutates a key-point ID.

## Durability and idempotency

- Media ingest uses `pg-boss` PostgreSQL claims/leases and a deterministic key derived from capture session plus finalized source file identity. Retrying the same finalized file cannot duplicate a segment or asset.
- Object upload enters `UPLOADING`, verifies checksum/length/content type/internal schema version, then becomes `READY` in the same durable workflow that publishes the DB segment.
- A worker crash leaves a retryable claim; a server/worker restart must preserve archive playback.
- Direct bounded-manifest mapping is not a playback packaging job. If a later rendition requires repack/transcode, that work must be a separate durable playback-package job before the descriptor becomes ready.

## Phase 2A rounds

### Round 2A-1: contract and resolver kernel

- Freeze OpenAPI/error semantics and add media fixtures/TypeScript/Python validation.
- Implement a deterministic sample-index parser/resolver with 30 fps, 59.94 fps, VFR, segment-boundary and discontinuity fixtures.
- Implement/test the PWA REST/timeline model, expiry/gap/window-boundary state and bounded window cache against fixtures; no fake claim that real ingest exists.

### Round 2A-2: persisted ingest and server APIs

- Add the migration and durable worker flow into MinIO/PostgreSQL.
- Add GraphQL timeline and authenticated REST window/manifest/segment/resolve/step services.
- Integrate the PWA player/timeline against the live server.

### Round 2A-3: runtime and soak exit

- Run deterministic Docker feed with a discontinuity, restart recovery and HTTPS playback smoke.
- Prove arbitrary saved-frame resolution and exact previous/next samples.
- Run the requirements-matrix two-hour capture/remote-seek soak and show browser retained windows/buffer do not grow linearly.

## Required evidence

- All PTS/time/frame fixtures exceed JavaScript's safe-integer range and numeric JSON alternatives fail.
- 30 fps, 59.94 fps and VFR sample resolution is exact and repeatable.
- A reconnect produces a second epoch and visible gap while canonical capture time remains monotonic.
- Expired, stale, foreign, gap and window-boundary requests return the approved HTTP/code pair.
- Manifest and every segment enforce identical capture membership and contain no object-store credential.
- Duplicate ingest is idempotent and a worker/server restart replays archived media.
- Headed iPad-sized browser verification covers live, remote seek, gap, expiry renewal, return-to-live, RVFC cursor and frame step. Per the project workflow, Luna owns frontend/browser test execution and the main Agent reviews the evidence.
- The final two-hour soak satisfies `docs/requirements-matrix.md`; shorter fixture smoke tests do not mark Phase 2 complete.
