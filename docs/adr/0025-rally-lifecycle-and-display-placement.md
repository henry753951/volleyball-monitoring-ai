# ADR 0025: Rally lifecycle deletion and mutable display placement

## Status

Accepted — 2026-08-09

## Context

Operators must be able to remove an erroneous segment regardless of whether it is a draft, queued,
processing or AI-complete. They must also be able to correct the set and rally labels shown in the
annotation and coach applications. A submitted `RallySubmission` remains immutable evidence, so its
captured key points, score snapshot and media timing cannot be rewritten to implement presentation
edits.

## Decision

- Rally deletion is an explicit privileged lifecycle operation. Active clip and AI work is cancelled,
  AI abort events are emitted, dependent analysis and submission rows are removed transactionally,
  and unreferenced clip/analysis objects are removed from S3-compatible storage after commit.
- The authoritative set score is recalculated from the remaining active point awards. Score revision
  remains monotonic; deletion never rewrites an immutable submission snapshot.
- `Rally.displaySetNumber` and `Rally.displayOrdinal` are mutable presentation metadata. Editing them
  never changes `RallySubmission`, clip timing, key-point PTS, court-side assignment or AI artifacts.
- New rallies receive the next display ordinal in the current set while the internal `setId` and
  `ordinal` allocation remains the concurrency-safe domain identity.
- Coach and annotation lists derive per-rally running scores from active outcomes ordered by display
  placement. Presentation changes and deletion are delivered as lightweight match-state invalidations;
  consumers refetch the authoritative compact coach state rather than moving media through WebSocket.

## Contract boundary

This is an additive GraphQL contract change. It adds rally deletion and display-placement mutations
plus additive coach-state fields. Existing annotation command semantics and the external AI SDK are
unchanged.

## Consequences

Submitted evidence stays immutable while the product can correct organization mistakes and fully
purge unwanted media. Historical score snapshots remain evidence of their original submission; the
current scoreboard and list projection are computed from the remaining active rallies.
