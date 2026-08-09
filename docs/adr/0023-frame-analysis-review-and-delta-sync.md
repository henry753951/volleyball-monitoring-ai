# ADR 0023: Analysis review current overrides and revision invalidation

## Status

Accepted — 2026-08-09

## Context

Completed external-AI artifacts are immutable evidence, but operators need to correct ball observations,
player boxes, action labels and hit ownership without replacing the binary overlay. A correction is the
current operator override for one semantic key, not a user-visible analysis version.

## Decision

- The imported AI result and overlay manifest remain immutable.
- Central storage keeps sparse current overrides for ball observations, player boxes, action labels and
  contact actors. A newer value for the same semantic key replaces the previous value. Restoring automatic
  analysis deletes that override.
- Clients apply corrections optimistically and debounce entity-keyed operations into patches of at
  most 32 operations. A client patch UUID makes retries idempotent.
- One monotonically increasing BIGINT review revision is assigned atomically to every accepted patch.
- The dedicated analysis-review WebSocket carries only revision invalidations. Because an override may
  be deleted, clients fetch the complete sparse current override set after an invalidation. Media and full
  overlays never travel through WebSocket or GraphQL.
- Last accepted write wins only for the same corrected entity. A stale base revision is reported as
  rebased; it does not discard unrelated edits.
- An explicit contact actor override, including explicit `null` for no actor, wins over automatic
  association. Without an override, the effective corrected hit position is resolved first and actor
  association is derived from that position again.
- A missing ball observation remains explicit. For next-hit visualization the last known ball position at
  or before the contact frame is used when the contact frame has no observation.
- Ball coordinates remain video-frame coordinates. This workflow does not create, project or clamp
  canonical `court_pos`.
- The nine review labels are Waiting, Setting, Digging, Falling, Spiking, Blocking, Jumping, Moving
  and Standing. The external heuristic engine currently emits only Waiting or Spiking; operators may
  refine the other labels without changing the imported result.

## Contract boundary

Analysis Review schema version 1.1.0 is a central REST/WebSocket contract consumed by the annotation
workstation. It replaces the unreleased 1.0.0 contract and is not part of the external AI worker SDK.
JSON schemas, golden examples, database migration, server implementation and browser consumer ship together.

## Consequences

Frame edits remain fast and bandwidth-bounded because only sparse override rows are re-fetched. Concurrent
clients converge after deletions as well as updates, and the original AI result remains reproducible.
Multi-process server deployments must fan revision invalidations through the deployment's shared pub/sub
layer; the database revision and current-state endpoint remain the source of truth after reconnect.
