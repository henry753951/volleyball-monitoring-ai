# Progress

## 2026-08-07 — Phase 0, round 1

Status: locally integrated and validated on `integration/phase-0-round-1`; not merged to `main` and not pushed because this delivery did not contain Git metadata or a GitHub remote.

### Source-of-truth audit

- Read the delivery entrypoints, agent rules, main-agent prompts, master implementation spec, contracts, fixtures, Prisma schema, Nuxt PWA, server, workers and infrastructure scaffold.
- Rendered and visually inspected all 41 pages of `docs/SYSTEM_SPEC_V3_2.pdf`. The PDF and Markdown express the same fixed annotation, media timeline, DVR, immutable-submission, AI boundary and `court_pos` rules.
- `docs/SYSTEM_SPEC_V3_2.md` and `docs/MASTER_IMPLEMENTATION_SPEC.md` are byte-identical.
- Verified all 162 files listed by `SHA256SUMS.txt`: no missing files and no checksum mismatches before repository initialization.
- The scaffold is suitable for contract-first development after the round-1 repairs below. It is not yet a working end-to-end product.

### Git and integration strategy

- Initialized the delivered archive as Git because no `.git` directory, nested repository or upstream remote was present.
- Preserved the imported scaffold on `main` at `f851f84`.
- Used `integration/phase-0-round-1` as the local review/integration branch.
- Used independent worktrees and branches for every subagent:

| Workstream | Branch | Worktree | Reviewed source commits |
| --- | --- | --- | --- |
| Contracts / Python SDK | `feat/phase0-contract-fixtures` | `H:\Repos\volleyball-monitoring-ai-worktrees\contracts` | `b7ba9ee` |
| Prisma / server / worker | `feat/phase0-media-readiness` | `H:\Repos\volleyball-monitoring-ai-worktrees\backend-media` | `a07e1ab`, `2cd54c1`, `cc37b70` |
| Nuxt iPad PWA | `feat/phase0-web-contract-alignment` | `H:\Repos\volleyball-monitoring-ai-worktrees\web` | `27455f5` |

Subagents did not merge. The main agent reviewed their diffs, reran their tests, created the commits where requested, and locally merged the reviewed branches into the integration branch. `main` remains unchanged so the integration branch can become the PR head once a remote is supplied.

### Round-1 task contracts

#### Contracts / Python SDK

- Goal: close the required `resolved_multiple` golden-fixture gap without changing a public schema or version.
- Allowed paths: `packages/contracts/fixtures/**`, contracts tests/package metadata, and `sdk/tests/**`.
- Definition of Done: every AI fixture validates through the canonical JSON Schemas; the multiple-actor case preserves order, omits optional action/confidence, carries no candidates and proves external `court_pos` may be outside `0..1`.
- Tests: contracts Vitest suite, Python SDK pytest suite, contract validator and contracts typecheck.

#### Prisma / server / worker

- Goal: make the Phase 0 data/backend scaffold executable by Prisma 7 and add only the internal durability primitives required for claim/lease job processing.
- Allowed paths: `packages/db/prisma/schema.prisma`, `worker/**`, and follow-up compile repairs in `server/**`; no public contract changes or migrations.
- Definition of Done: preserve all 38 models and 24 enum domains, add `maxAttempts`, `availableAt`, `leasedUntil` and a status/availability index to `ClipJob` and `AiJob`, validate all configured worker roles, and compile/test the server without changing health or WebSocket scaffold behavior.
- Tests: Prisma generate/validate, database typecheck, worker build/test/typecheck, server build/test/typecheck and Compose config validation.

#### Nuxt iPad PWA

- Goal: align the handwritten playback-window type and bounded seek math with the canonical server-side DVR contract.
- Allowed paths: `web/**`; one reviewed `vue-tsc` dev dependency was allowed.
- Definition of Done: include timeline bounds, pagination flags and optional live edge; convert only the bounded BigInt delta to player seconds; reject out-of-window seeks; do not buffer the full DVR or claim browser cursor values are authoritative.
- Tests: Nuxt postinstall/typecheck/build and Vitest coverage using capture timestamps larger than JavaScript's safe-integer range.

### Integrated changes

- Repaired the Windows/repository validation gate, pinned an available `prisma-pothos-types` release and committed `bun.lock`.
- Replaced formatter-sensitive Prisma checks with semantic enum and durable-job assertions.
- Reformatted the invalid compact Prisma datasource/enums for Prisma 7 while preserving the existing domain, plus the approved internal job durability fields above.
- Added the required `resolved_multiple` contract fixture and schema-driven TypeScript/Python coverage. No public schema or schema version changed.
- Added bounded DVR playback helpers and complete playback-window descriptor fields in the PWA. Browser cursor data remains observational and full DVR remains server-side.
- Fixed server Pothos scalar/object typing and WebSocket raw-byte accounting without changing route behavior.
- Made test discovery exclude compiled `dist` files and isolated contract compiler output from `src`.

### Validation evidence

All commands below passed on the integrated branch:

- `bun run db:generate`
- `bun run db:validate` — 38 models, 24 enums
- `bun run validate:all` — contracts, scaffold, Prisma structure and syntax checks; 43 TypeScript/Vue files parsed
- `bun run typecheck` — contracts, DB, server, worker and Nuxt
- `bun run test` — contracts 3, server 3, worker 7, web 3 and Python SDK 10 tests passed; DB integration tests remain intentionally deferred until the first migration
- `bun run build` — contracts, DB, server, worker and production Nuxt/PWA build
- `docker compose --env-file .env.example -f infra/compose.yaml config --no-env-resolution --quiet`

The Nuxt build emits a dependency-level Node `DEP0155` deprecation warning but completes successfully.

### Open blockers and limitations

- No Git remote exists, although `gh auth status` is authenticated. The specification also leaves repository owner/URL open. Therefore no branch was pushed, no `gh pr create` was attempted, and nothing was merged to `main`. Supply the intended GitHub remote to complete the PR/review/merge stage.
- The local Bun is `1.3.6`, while the repository pins `1.3.14`. Validation passed, but release/CI should use the pinned version.
- Docker Compose runtime, migrations, database integration tests, real media ingest/DVR packaging, browser/iPad E2E and external AI callback flows were not run.
- The server REST media routes, durable annotation WebSocket, queue workers and end-to-end vertical product flow remain scaffolds. Green in the UI must continue to mean an immutable submission exists, not AI completion.

### Recommended next round

1. Configure the GitHub remote, push the integration and feature branches, open the integration-to-main PR, and merge only after remote CI/review.
2. Implement the first small end-to-end slice around match/capture setup and an authoritative server-resolved playback window, including the first migration and DB integration tests.
3. Keep annotation submission, clip creation and external AI dispatch as subsequent vertical slices, preserving the fixed keyboard/touch semantics and immutable `RallySubmission` boundary.
