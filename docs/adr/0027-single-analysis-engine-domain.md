# ADR 0027: Single analysis engine domain without integration IDs

## Status

Accepted — 2026-08-09

Decision owner: Main PM / architecture integration agent

Supersedes the internal-integration portion of ADR 0026.

## Context

The product supports one external service, `volleyball-analysis-engine`, with any number of outbound
Worker processes. The remaining `AiIntegration` row did not select a different engine, contract or
queue. Its UUID was repeated on access tokens, provider instances and durable jobs even after it was
removed from every public endpoint. Keeping that relation created a hidden Pool abstraction with no
product meaning.

## Decision

- Remove `AiIntegration`, `AiTransportMode` and every `integrationId` column and foreign key.
- Rename `AiIntegrationAccessToken` to `AiWorkerAccessToken`. Token names and hashes are globally
  unique; plaintext tokens are shown only at creation or rotation.
- Make `AiProviderInstance.instanceKey` globally unique. Every authenticated process participates in
  the same least-busy scheduling set and continues to publish transport RTT and application heartbeat.
- Keep one global durable `AiJob` queue. A job is owned by its immutable submission, clip and optional
  assigned provider instance, not by a configuration row.
- Fix the accepted Job, Result and overlay contract versions in the central implementation. Wire
  messages, job payloads, callback paths and the Python SDK do not change.
- Replace the operations snapshot's integration array with one `aiWorkerAccess` object. The product
  continues to present one engine and never exposes Pool or integration selection.

## Migration

Migration `20260809234000_single_ai_engine` preserves existing token, instance and job rows while it
removes their integration foreign keys, renames the token table, adds global uniqueness constraints,
then drops the now-unreferenced integration table and transport enum. Before applying it to a database
that historically allowed multiple integrations, operators must verify Token names and instance keys
are globally unique.

## Consequences

- A Worker connects to the fixed endpoint using only its bearer Token.
- Adding or rotating credentials never creates a new scheduling Pool.
- Least-busy selection, job resume, abort, callback idempotency and immutable submission ownership are
  unchanged.
- Reintroducing multiple independently configured AI engines would require a new explicit product and
  contract decision rather than reviving this UUID indirectly.
