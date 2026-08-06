# Validation report - v3.2 delivery

Date: 2026-08-07 (Asia/Taipei target release date)

## Passed in the delivery environment

- `python scripts/validate_contracts.py`
  - JSON Schema fixtures and cross-contract invariants passed.
- `python scripts/validate_scaffold.py`
  - Required files, annotation controls, SDK FlatBuffers synchronization and core spec invariants passed.
- `python scripts/validate_prisma_structure.py`
  - 38 models and 24 enums parsed; required database invariants passed.
- `node scripts/validate_typescript_syntax.mjs`
  - 46 TypeScript/Vue files passed syntax validation.
- `uv run --project sdk --frozen --extra test pytest`
  - 10 tests passed.
- Full JSON, TOML and YAML parse pass.
- `docs/SYSTEM_SPEC_V3_2.pdf`
  - 41 pages after the Annotation Realtime 2.0 migration, A4, searchable and openable.
  - XeLaTeX completed successfully; extracted text contains `CLOSE_RALLY`, all three strict outcomes and six controls, with old v1.1 terminal/score-flow text absent.
  - Rendered all 41 pages to PNG and visually reviewed six whole-document contact sheets plus detailed Annotation pages 5, 19, 20 and 21.
- Verified searchable text contains all six v2.0 command semantics, editable bindings, Restore Defaults, `formatForDisplay`, Traefik baseline and `court_pos` requirements.
- ZIP integrity is verified during final packaging with `unzip -t`.

## Corrected during final audit

- Updated the shortcut boundary: physical keys are configurable, command semantics and touch actions remain fixed, and Restore All Defaults plus TanStack `formatForDisplay` are required.
- Added queryable AI producer fields to `AnalysisRun`.
- Added optional `AnalysisTrack.meanConfidence`.
- Added optional `ContactEvent.resolvedFrameIndex`.
- Added required `ContactEventActor.observationFrameIndex`.
- Added explicit immutable submission service/terminal key-point foreign keys and relation ownership.
- Pinned Traefik to `v3.7.9` in the local Docker baseline.
- Corrected the stale token-boundary statement: clip signed URL and callback bearer token are separate capabilities.
- Regenerated the LaTeX/PDF with wrapped long tables, CJK fonts and no duplicate heading numbering.

## Current v2.0 migration validation

- Annotation contract: 5 Vitest tests passed, including left/right/unknown close payloads, old-command rejection, no score frame/time and close ACK anchor rules.
- Server: 6 Vitest tests passed; typecheck and build passed.
- Web: 6 Vitest tests passed; Nuxt typecheck and production PWA build passed.
- Prisma 7.9.1 generate and validate passed; DB typecheck passed with 38 models and 24 enums after removing `AWAITING_SCORE`.
- `uv run --project sdk --frozen --extra test bun run validate:all` passed.

## Not executed here

- No migration was created because the approved enum removal must precede the first migration.
- Docker Compose runtime, live database integration, browser/iPad E2E and media/AI vertical slices were not run for this contract migration.

The primary Agent must run the following before accepting Phase 0 or creating a migration:

```bash
bun install
bun run db:generate
bun run db:validate
bun run typecheck
bun run test
bun run build
docker compose -f infra/compose.yaml --profile app --profile dev-ai config
docker compose -f infra/compose.yaml --profile app --profile dev-ai up --build
```

Do not claim a vertical slice complete until the matching exit evidence in `docs/requirements-matrix.md` is collected.
