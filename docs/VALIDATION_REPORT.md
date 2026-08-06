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
  - 38 TypeScript/Vue files passed syntax validation.
- `python -m pytest -q sdk/tests`
  - 8 tests passed.
- Full JSON, TOML and YAML parse pass.
- `docs/SYSTEM_SPEC_V3_2.pdf`
  - 41 pages, A4, searchable and openable.
  - `pdf_preflight.py` passed basic preflight.
  - Rendered every page to PNG and visually reviewed contact sheets plus detailed pages for Annotation UI and wide audit tables.
  - Verified searchable text contains all seven fixed controls, Traefik baseline and `court_pos` requirements.
- ZIP integrity is verified during final packaging with `unzip -t`.

## Corrected during final audit

- Added queryable AI producer fields to `AnalysisRun`.
- Added optional `AnalysisTrack.meanConfidence`.
- Added optional `ContactEvent.resolvedFrameIndex`.
- Added required `ContactEventActor.observationFrameIndex`.
- Added explicit immutable submission service/terminal key-point foreign keys and relation ownership.
- Pinned Traefik to `v3.7.9` in the local Docker baseline.
- Corrected the stale token-boundary statement: clip signed URL and callback bearer token are separate capabilities.
- Regenerated the LaTeX/PDF with wrapped long tables, CJK fonts and no duplicate heading numbering.

## Not executed here

- `bun install`, Bun build/typecheck, Prisma CLI generation/validation/migration, and Docker Compose runtime E2E were not executed because Bun and Docker are unavailable in this artifact environment.
- An attempted `npx prisma@7.9.1 validate` could not retrieve Prisma from the environment's package registry. This is not presented as a successful Prisma CLI validation.

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
