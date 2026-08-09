# ADR 0026: Token-routed AI Worker endpoint

## Status

Superseded by ADR 0027 — 2026-08-09

## Context

`volleyball-analysis-engine` previously needed both a bearer token and the internal
`AiIntegration.id` query parameter to open the provider WebSocket. The UUID is central persistence
metadata, duplicates information already represented by the credential, and makes setup error-prone.
The product has one external analysis service which may run many concurrent Worker instances; users
do not manage separate Worker Pools.

## Decision

- The public Worker endpoint is fixed at `/api/v1/ai/providers/ws`.
- A managed Worker Token is globally unique. The plaintext token is never stored; lookup uses its
  SHA-256 hash and records `lastUsedAt`.
- Environment credentials remain a bootstrap path for `volleyball-analysis-engine`.
- No public request accepts or returns an integration UUID. The Worker WebSocket uses only the fixed
  endpoint and bearer Token; the control API creates credentials for the single canonical
  `volleyball-analysis-engine` integration from `{ name }` alone.
- Least-busy scheduling across connected instances is unchanged. ADR 0027 removes the obsolete
  persistence integration boundary entirely.

## Contract boundary

This deliberately removes the short-lived legacy query compatibility. Provider Realtime message
schemas, job payloads, callbacks and SDK types do not change, so no schema-version bump is required.
Old clients that construct the integration query are not a supported migration target.

## Consequences

Operators copy one stable endpoint and one Token. Rotating a Token preserves the same service and
global durable job queue.
