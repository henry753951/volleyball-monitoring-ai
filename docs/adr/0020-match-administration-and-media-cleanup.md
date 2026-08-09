# ADR 0020: Match administration and media cleanup

## Status

Accepted — 2026-08-09

## Context

The operations console needs complete match CRUD. Deleting only the `Match` row leaves server-side DVR segments, clip artifacts, analysis overlays, object-store data, and capture spool/import directories behind. Match storage usage also cannot be inferred safely in the browser.

## Decision

- Keep match administration in the code-first GraphQL domain API.
- Add the backward-compatible `updateMatch` and `deleteMatch` mutations without changing existing mutation semantics or schema version.
- `deleteMatch` authorizes the operator, stops managed sources, removes match-owned durable graph rows in dependency order, and then performs bounded object-store and local-path cleanup.
- Local path removal is restricted to resolved descendants of the configured recording and import roots. Repository or volume roots are never deletion targets.
- Cleanup returns a receipt with removed asset count, decimal-string byte count, and warnings for any post-commit physical cleanup failure.
- Host capacity and per-match media usage are exposed only through the authenticated operations REST snapshot. They are operational measurements, not public match-domain fields.
- The GraphQL change is additive and is recorded in the exported SDL and stored operation documents. The Nuxt control console is migrated in the same slice; AI wire schemas and the Python worker SDK are unaffected, so their schema versions do not change.

## Consequences

- Existing GraphQL consumers remain compatible; new clients may opt into the two additive mutations.
- A deleted match cannot be restored. The control UI requires an explicit typed confirmation and reports partial physical cleanup warnings.
- Physical cleanup is idempotent for already-missing objects and directories.
- Media byte values remain decimal strings on the wire to preserve 64-bit correctness.
- Shared media objects are retained until no database relation references them; object-store cleanup runs only for assets actually removed from the database.
