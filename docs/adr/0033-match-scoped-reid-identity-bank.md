# ADR 0033: Match-scoped ReID identities and clip feature banks

## Status

Accepted — 2026-08-13.

## Context

Analysis `track_id` values are local to one `AnalysisRun`. The current manual roster assignment cannot safely identify a player across rallies, cannot preserve ReID evidence, and deletes a prior non-overlapping track when the same roster player is selected again. Research code in `volley-reid` also includes a fixed-six physical-side roster that is incompatible with substitutions and side swaps.

The product needs imperfect ReID assistance: each clip must contribute features, later clips should reuse a previously confirmed player, earlier unlabelled clips must remain unchanged, and a human correction must improve future association without mutating immutable submissions or raw AI results.

## Decision

1. `track_id` remains analysis-run local. It is never a cross-run join key.
2. A GID is an opaque identity cluster scoped by `(match, team, embedding model namespace)`. It is not a `Player` or roster-entry ID, and there is no six-person cap.
3. The Worker is stateless across jobs. It emits the versioned optional `extensions.reid_feature_bank` payload defined by `ai/reid-feature-bank-v1.schema.json`: one clip-local feature bank for each physical court side, a normalized 512-D Sports OSNet prototype per track, frame bounds, quality, and co-visibility cannot-link evidence.
4. Central maps physical `left`/`right` through the immutable `RallySubmission` side snapshot to a real team, performs incremental GID association, and persists lineage and human decisions. Unknown-side features remain unresolved until sufficient evidence exists.
5. Embedding model name, checkpoint SHA-256, preprocessing version, dimension, normalization, and distance metric form the model namespace. Vectors from different namespaces are never silently mixed.
6. A roster binding is append-only and effective from a canonical rally/submission position. Human assignment defaults to forward-only propagation: it may preselect later clips but does not backfill earlier unlabelled clips.
7. A correction distinguishes changing the player binding from this clip forward, fixing only the current clip, splitting a contaminated GID, and merging duplicate GIDs while preserving lineage.
8. Side swap and substitution do not redefine a GID. Every active roster entry, including bench players, remains selectable. Only observations that coexist in time are hard cannot-link candidates.
9. Raw `AnalysisData`, immutable submission, canonical frame ordering, PTS, and timecode remain unchanged. Identity is an additive derived layer with its own revision.
10. The ML dataset export includes the exact feature bank, model/checksum metadata, GID observations, lineage, bindings, and correction history needed to reproduce identity experiments.

## Compatibility

`reid_feature_bank` is optional within AnalysisData 1.0. Core analysis correctness never depends on the extension, and Central rejects a malformed feature bank.

## Consequences

- Workers can move between RTX 5070, H100, or restart without losing match identity history.
- Human corrections benefit later clips while approved historical data remains reproducible.
- Feature prototypes are bounded by track count times 512 floats. They are excluded from GraphQL and WebSocket payloads and included only in raw result and dataset artifacts.
- A future embedding provider creates a new namespace and calibration; DINO or KPR features cannot be mixed into the Sports OSNet bank.
