# ADR 0022: Stale AI worker retirement

## Status

Accepted — 2026-08-09

## Context

Outbound AI workers register durable provider-instance rows. A worker that is decommissioned or never reconnects remains visible in the operations console, but deleting a worker that has recovered or still owns queued/running work could disrupt dispatch.

## Decision

- Expose worker retirement only through the authenticated operations REST surface for ADMIN and OPERATOR users.
- Treat the dashboard `canDelete` field as a presentation hint only. The server atomically repeats both conditions when deleting: the instance is disconnected or its heartbeat is older than 30 seconds, and it owns no `QUEUED` or `RUNNING` jobs.
- Return a conflict when the worker reconnects or receives work between the dashboard snapshot and confirmation.
- Preserve completed jobs and analysis results. The existing nullable `AiJob.providerInstanceId` relation uses `onDelete: SetNull`, so historical work remains queryable after retirement.
- Version the delete receipt as `1.0.0`. This internal operations action does not change GraphQL, AI job/result schemas, or the Python SDK.

## Consequences

- Operators can remove obsolete control-plane records without deleting analysis history.
- A restarted worker may register again using its integration and instance key.
- The 30-second threshold remains shared with operations liveness classification; changing it must update both snapshot and delete eligibility together.
