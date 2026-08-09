# ADR 0023: Frame analysis review and revision-delta synchronization

## Status

Accepted — 2026-08-09

## Context

Completed external-AI artifacts are immutable evidence, but operators need to correct a ball position
or an action label at a specific analysis frame. Sending a complete overlay after every pointer click
would be wasteful and would make concurrent editors overwrite unrelated corrections.

## Decision

- The imported AI result and overlay manifest remain immutable.
- Central storage keeps sparse ball and action corrections keyed by analysis run and frame; action
  corrections additionally include the analysis-run-local track ID.
- Clients apply corrections optimistically and debounce entity-keyed operations into patches of at
  most 32 operations. A client patch UUID makes retries idempotent.
- One monotonically increasing BIGINT review revision is assigned atomically to every accepted patch.
- The dedicated analysis-review WebSocket carries only revision invalidations. Clients fetch only
  rows newer than their local revision and merge them by entity key, so media and full overlays never
  travel through WebSocket or GraphQL.
- Last accepted write wins only for the same corrected entity. A stale base revision is reported as
  rebased; it does not discard unrelated edits.
- Ball coordinates remain video-frame coordinates. This workflow does not create, project or clamp
  canonical `court_pos`.
- The nine review labels are Waiting, Setting, Digging, Falling, Spiking, Blocking, Jumping, Moving
  and Standing. The external heuristic engine currently emits only Waiting or Spiking; operators may
  refine the other labels without changing the imported result.

## Contract boundary

Analysis Review schema version 1.0.0 is an additive central REST/WebSocket contract consumed by the
annotation workstation. It is not part of the external AI worker SDK. JSON schemas, golden examples,
database migration, server implementation and browser consumer ship together.

## Consequences

Frame edits are fast and bandwidth-bounded, concurrent clients converge without polling the full
analysis, and the original AI result remains reproducible. Multi-process server deployments must
fan revision invalidations through the deployment's shared pub/sub layer; the database revision and
delta endpoint remain the source of truth after reconnect.
