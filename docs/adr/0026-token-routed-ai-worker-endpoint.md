# ADR 0026: Token-routed AI Worker endpoint

## Status

Accepted — 2026-08-09

## Context

`volleyball-analysis-engine` previously needed both a bearer token and the internal
`AiIntegration.id` query parameter to open the provider WebSocket. The UUID is central persistence
metadata, duplicates information already represented by the credential, and makes setup error-prone.
The product has one external analysis service which may run many concurrent Worker instances; users
do not manage separate Worker Pools.

## Decision

- The public Worker endpoint is fixed at `/api/v1/ai/providers/ws`.
- A managed Worker Token is globally unique and resolves its enabled `WS_AGENT` integration on the
  server. The plaintext token is never stored; lookup uses its SHA-256 hash and records `lastUsedAt`.
- Environment credentials remain a compatibility path for the canonical
  `volleyball-analysis-engine` integration.
- No public request accepts or returns an integration UUID. The Worker WebSocket uses only the fixed
  endpoint and bearer Token; the control API creates credentials for the single canonical
  `volleyball-analysis-engine` integration from `{ name }` alone.
- Least-busy scheduling across connected instances is unchanged. The persistence relation remains an
  internal scheduling boundary and is not exposed as a Pool concept in the control interface.

## Contract boundary

This deliberately removes the short-lived legacy query compatibility. Provider Realtime message
schemas, job payloads, callbacks and SDK types do not change, so no schema-version bump is required.
Old clients that construct the integration query are not a supported migration target.

## Consequences

Operators copy one stable endpoint and one Token. Rotating a Token preserves the same service and job
queue. The internal persistence foreign key remains private because it is still required for Token,
Worker-instance and durable-job ownership plus least-busy scheduling.
