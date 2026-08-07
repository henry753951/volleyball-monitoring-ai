# ADR 0014: Complete worker runtime ownership without duplicating request truth

- Status: Accepted
- Date: 2026-08-08
- Decision owner: Main PM / architecture integration agent

## Context

The Compose topology declared `playback-packager`, `analysis-ingest`, and `outbox-publisher`, but their entrypoint previously fell through to an idle scaffold lifecycle. Meanwhile the verified product paths already build bounded HLS manifests from immutable indexed fMP4 in the authorized Server request and atomically validate/normalize AI completed callbacks with their idempotent receipt.

Moving either request-bound transaction into a second implementation would create two media/callback truth paths. Leaving the containers idle would overstate runtime completeness.

## Decision

1. `playback-packager` owns bounded `PlaybackWindow` lifecycle and deletes only mappings whose explicit `expiresAt` has passed, in bounded batches. It never deletes DVR segments or performs per-seek retranscoding.
2. The public AI callback remains the sole schema/checksum/passthrough/FlatBuffer validation and normalization transaction. `analysis-ingest` is the restart convergence worker: for a completed AnalysisRun it may repair only the active immutable submission's AiJob/Rally terminal projections. It never reactivates `SUPERSEDED` work or changes normalized provider data, including `court_pos`.
3. `outbox-publisher` CAS-claims one eligible PostgreSQL `OutboxEvent`, creates an idempotent pg-boss `domain-events-v1` job keyed by the event UUID/dedupe key, then marks the row `PUBLISHED`. A crash replay is successful when that durable job ID already exists. Failures use bounded exponential retry, a ten-attempt terminal `FAILED` state, and secret-free error classification.
4. The worker entrypoint is exhaustive. Every configured role has a concrete start/stop composition; no valid role may run the scaffold lifecycle.

## Consequences

- Full DVR remains server-side and playback memory/storage do not grow with expired client mappings.
- Callback acknowledgement never races a second normalization implementation.
- Domain events leave the transactional outbox durably and idempotently.
- PostgreSQL remains canonical; pg-boss is delivery state, Redis remains ephemeral, and worker restarts are safe.
