# ADR 0008: Coach replay read and media boundary

Status: Accepted — 2026-08-07

Coach replay uses an authorization-filtered additive GraphQL JSON read model, `coachRallyReplay(rallyId)`, for immutable submission, normalized analysis events and A/B court paths. Canonical MP4 bytes remain outside GraphQL and are streamed through the same-origin REST route `/api/v1/analysis/rallies/:rallyId/clip`, including single-range HTTP 206 support.

Completed callbacks normalize tracks, contact events, candidates, representative court positions and path endpoints inside the same transaction that activates the AnalysisRun. Track IDs remain analysis-run local. Optional action/confidence remains nullable/provider-defined. `court_pos` is copied from validated external AI output without projection or clamping; the Coach SVG deliberately keeps an out-of-court margin so negative and greater-than-one coordinates remain visible.

The replay page derives clip frame from canonical clip FPS, seeks contact events by clip-local microseconds, draws event-local frame overlays on Canvas and renders normalized court paths separately. It does not load the full DVR, expose MinIO identity, treat browser time as authoritative annotation data or infer missing court positions as `(0,0)`.

This is an additive GraphQL/REST consumer contract. External Job/Result/Callback/SDK versions are unchanged.
