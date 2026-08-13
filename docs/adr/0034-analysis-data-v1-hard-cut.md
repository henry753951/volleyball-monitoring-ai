# ADR 0034: AnalysisData v1 hard cut

## Status

Accepted — 2026-08-14.

## Context

The AI boundary previously treated domain JSON, a binary overlay, and browser chunks as separate result formats. That naming made a rendering concern look authoritative, duplicated checksums and lifecycle rules, and made selective reruns and human corrections difficult to explain.

## Decision

1. AI Job `3.0.0`, callback `2.0.0`, provider capabilities `2.0.0`, and AnalysisData `1.0.0` replace the earlier public AI contracts. There is no legacy negotiation path.
2. A completed callback contains exactly one `analysis_data` multipart file with media type `application/vnd.volleyball.analysis-data+flatbuffers;version=1`. VAD1 carries the complete domain JSON plus per-frame players, ball, court keypoints, actions, and optional ReID feature bank.
3. Central validates and stores the immutable VAD1 asset, normalizes queryable rows, and derives VFC1 `AnalysisFrameChunk` files for bounded browser playback. VFC1 is a delivery projection, not a second AI result.
4. Human edits remain a sparse revisioned layer keyed by AnalysisRun plus canonical frame, track, or contact identity. They cover ball position/visibility, player bbox, action, contact CRUD/time/actor, and roster/ReID assignment.
5. A full or selective rerun creates a new immutable AnalysisRun. When `preserve_manual_corrections` is true, compatible sparse corrections and identity assignments are copied from the previous run or the superseded correction submission; review returns to `EDITING` and must be recalculated and approved again.
6. Z boundaries remain clip START/END only. AnalysisData contact events are non-terminal `contact` events; service and landing semantics are not inferred from the boundaries.
7. The downloadable ML bundle includes the untouched canonical clip, source/cut/video/timing metadata, authoritative VAD1, normalized database view, sparse human corrections, ReID evidence, checksums, and separate JSONL tables for frames, players, ball, court keypoints, actions, contacts, and ball paths.

## Compatibility

This is an intentional hard cut. Old result JSON, VOV1 overlay assets, legacy callback parts, old job schema versions, and their compatibility branches are removed. Historical migration and progress documents may retain the old names solely as audit history.

## Consequences

- “Overlay” remains valid only as a visual UI/rendering term.
- Raw AI output is never edited in place; the effective reviewed result is AnalysisData plus the sparse correction revision.
- Export does not transcode the canonical clip and does not rewrite frame ordering, PTS, time base, or capture/clip time mappings.
- ML tools can consume one authoritative binary or independent JSONL tables without scraping frontend data.
