# ADR 0007: Phase 4 canonical clip and external AI runtime

Status: Accepted — 2026-08-07

## Decision

`ClipJob` and `AiJob` are durable PostgreSQL state machines. The dedicated workers claim one eligible row with `FOR UPDATE SKIP LOCKED`, attach a bounded lease and retry without creating duplicate immutable outputs. They do not treat an in-memory queue as source of truth.

The clip worker uses the immutable `RallySubmission` and its submission key points, selects the contiguous DVR discontinuity containing the service anchor, clamps pre/post roll to that boundary, verifies every MinIO source object, produces one canonical H.264/AAC MP4 with FFmpeg and persists an exact timing manifest plus `ClipKeyPointMapping` rows. No mutable draft ID enters the AI request.

The AI dispatcher verifies provider capabilities, creates a short-lived independently signed clip URL and submits AI Job `1.1.0`. The callback bearer is a job-scoped HMAC-derived opaque token; PostgreSQL stores only its SHA-256 hash. The signed clip URL and callback token are never sent to the browser and the persisted request audit copy redacts the token.

The server owns `/api/v1/ai/callback/:aiJobId`. It authenticates before reading payloads, validates callback/result schemas and immutable passthrough fields, streams the bounded overlay to disk, verifies lengths/checksums and the `VOV1` identifier, uploads raw artifacts, records an idempotent callback receipt and activates one `AnalysisRun` transactionally. JSON/progress/failure and completed multipart remain REST, not GraphQL.

The development fake provider deliberately returns valid unresolved/no-player fixture output without pretending to run an AI model. It produces one event for every immutable input key point, preserves every passthrough ID and returns an empty valid `VOV1` FlatBuffer table.

## Compatibility

No public AI schema version changes. Existing Job `1.1.0`, Result/Callback `1.0.0` and `flatbuffers_v1` remain authoritative. `court_pos` remains external-AI-owned, may be outside `0..1`, and is never projected or clamped by these services.

## Runtime evidence

The local d003 real-DVR smoke produced a 1280×720, 60-frame canonical clip bounded to capture `0..2000333` µs, two immutable timing mappings, one accepted fake-provider job, one completed callback receipt and one completed AnalysisRun with raw JSON/overlay assets. The first run also proved that pre/post roll crossing a DVR discontinuity fails closed; the final implementation clamps to the service anchor's contiguous discontinuity.
