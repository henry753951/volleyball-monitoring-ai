
# Implementation and usage audit — corrected v3.0 baseline

This audit records the defects that were corrected before implementation begins.

1. `?` is an explicit `unknown` decision and **may be submitted**. Only `pending` is blocked. Unknown submissions do not create a `PointAward` and are excluded from win/loss metrics until corrected.
2. `CLOSE_RALLY` carries `target_key_point_id` plus a strict rally-level outcome. The server validates that the target is still the last effective key point at `base_revision`, then atomically terminalizes it and stores the outcome without creating a timestamp, score frame or score event.
3. Browser frame/time is observational. A playback-window mapping plus the server sample index produces authoritative epoch, PTS, capture time and frame.
4. Source PTS can reset or be negative. `CaptureEpoch` scopes raw PTS and keeps `capture_time_us` / `capture_frame_index` monotonic across reconnects.
5. Live and archive manifests have independent player-time origins. Every `PlaybackWindowDescriptor` carries `presentation_origin_capture_us`; the client never treats `video.currentTime` as whole-match time.
6. Full capture is stored server-side; HLS segments and overlay chunks are lazy-loaded around the playhead. Client memory must not grow linearly with match duration.
7. Enter creates an immutable `RallySubmission` that snapshots side assignment, score resolution, nullable score fields, clip policy and key points. Clip/AI jobs reference this snapshot, not mutable draft rows.
8. GraphQL `Int` is not used for PTS, microseconds, frames, revisions or byte sizes. Wire values are decimal strings; PostgreSQL uses `BIGINT`.
9. GraphQL Yoga + Pothos/Prisma owns structured domain APIs. Media, cursor resolve, callbacks and binary artifacts use REST; annotation commands use a dedicated WebSocket.
10. The AI job contains only canonical clip metadata, clip-local key points, human outcome and callback target. It does not contain court definitions, storage upload locations, model requirements, thresholds or database configuration.
11. AI passthrough identifiers are immutable. Every input key point produces exactly one contact event in the same order.
12. AI association separates resolved single, resolved multiple, ambiguous candidates, unresolved and no-player. High IoU alone never proves multiple participation.
13. `court_pos` is court-normalized but not clamped, so servers and defensive saves outside court remain representable.
14. Track IDs remain analysis-run local. Optional identity assignments map them to roster entries; the UI must never display a track ID as a jersey number.
15. Action labels, confidence and group phase are optional extensions until the AI team supplies real output examples and semantics.
16. Callback metadata uses `kind` consistently. `clip.download_url` is an independently signed, short-lived URL; `callback.token` is job-scoped, TTL-bound, retryable with `callback_id` idempotency, and may be sent only to the central callback endpoint. Neither secret is exposed to the browser.
17. The SDK-bundled FlatBuffers schema is synchronized with the repository canonical schema.
18. The old VolleyTrace MVP is consulted only for Nuxt/Vant/Motion interaction patterns and server-confirmed command/revision ideas. Its memory store, manual event flow, domain enums and statistics are not reused.
