# Server agent rules

Follow the root `AGENTS.md`, relevant ADRs, and `packages/contracts/README.md` first.

- Pothos/Yoga code is the GraphQL source of truth. Export the schema after API changes.
- REST owns media, callback, binary, and export payloads; dedicated WebSockets own annotation/review revision streams.
- Enforce membership/role authorization in every query and mutation path.
- Resolve browser observations to canonical media anchors before persistence.
- Never mutate `RallySubmission`. Corrections create a new draft/submission lineage.
- Keep completed provider analysis visible to authorized coach/replay consumers; review state is optional curation, not analysis existence.
- Use PostgreSQL BIGINT/TypeScript `bigint` internally and decimal strings on the wire.
- Add transaction-focused tests for domain changes and inspect GraphQL bodies even when HTTP status is 200.

Run server lint, typecheck, focused Vitest files, GraphQL schema checks, and database-backed integration tests as appropriate.
