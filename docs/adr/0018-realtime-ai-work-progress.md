# ADR 0018: Realtime AI work progress and least-loaded assignment

Status: Accepted — 2026-08-09

## Context

The outbound AI provider contract supports multiple worker instances and small
progress messages, but annotation clients previously learned processing state
only by re-fetching a complete GraphQL snapshot. That polling duplicates domain
reads, hides the assigned worker and makes short inference stages invisible.

## Decision

- The central provider gateway selects the available worker with the lowest
  active-delivery/capacity ratio before each durable `AiJob` claim. PostgreSQL
  remains the assignment authority; a connected worker cannot self-select work.
- Provider progress remains a small control-plane message. The server persists
  job progress/stage, then publishes an ephemeral Redis room event to authorized
  annotation WebSockets. Media, clips, full results and overlays remain outside
  this channel.
- Annotation Realtime keeps its `2.1.0` registry. The existing
  `rally_processing_update` 2.0 envelope gains only optional worker, job,
  progress, stage and update-time fields, so existing consumers remain valid.
- Completion still becomes authoritative only after the immutable callback and
  artifact transaction commits. A missed ephemeral event is recovered from the
  normal Rally snapshot and operations dashboard; Redis is never canonical.

## Consequences

Multiple AI computers can connect through the same SDK without polling for
work, annotations receive immediate observable stages, and operations can show
capacity and utilization. This does not change AI Job/Result/Callback schema
versions or the ownership of `court_pos`.
