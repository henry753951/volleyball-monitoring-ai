# Progress

## 2026-08-07 — Phase 1A CI and local runtime baseline

Status: integrated and validated on `integration/phase-1-round-1`; [PR #2](https://github.com/henry753951/volleyball-monitoring-ai/pull/2) remains draft until the post-merge gate is green.

- Added stable GitHub Actions jobs `contracts-sdk`, `typescript` and `compose-config`. All three passed on PR #2, and `main` branch protection now requires a PR, strict success from all three checks, resolved review conversations, and disallows force-push/deletion.
- Adopted a frozen `uv` project workflow for the Python SDK, validators and fake AI provider image. `sdk/uv.lock` is committed and the provider has no runtime package installation.
- Repaired and cached the Bun workspace layers in the server, worker and Nuxt Dockerfiles. Nuxt container builds disable only the duplicate Vite checker after a dedicated strict typecheck; normal local/CI typecheck remains enabled.
- Added bounded PostgreSQL, Redis and MinIO readiness probes. The server and web containers expose Docker health checks, Nuxt listens on the Traefik-declared port 3000, and web waits for a healthy server.
- Added a cancellable scaffold worker lifecycle with SIGINT/SIGTERM cleanup so every configured worker remains alive without pretending pg-boss job semantics are implemented.
- Started the full `app` and `dev-ai` Compose profiles locally. PostgreSQL, Redis, MinIO, MediaMTX, Traefik, fake AI, server, web and all six worker containers are running; server/web are healthy and every app/worker restart count was zero after rebuild.
- Runtime probes passed: server readiness returned PostgreSQL/Redis/MinIO `ok`, container-internal Nuxt returned HTTP 200, and Traefik returned HTTPS 200 for `/` and `/graphql`. A headed Playwright smoke loaded the home, settings and live routes after accepting the local self-signed certificate; the browser session was then closed.
- Integrated the Annotation Realtime 2.0 insertion through reviewed [PR #3](https://github.com/henry753951/volleyball-monitoring-ai/pull/3). The feature agent did not self-merge.
- Local CI-equivalent validation passed before the Annotation insertion: Prisma generate/validate, all repository validators, workspace typecheck, 31 JavaScript/Python tests and the production build. The complete post-insertion gate is rerun below before PR #2 is marked ready.

Open limitations: the first Prisma migration and DB integration tests belong to Phase 1B; worker processes are intentionally idle lifecycle scaffolds until their vertical slices implement durable pg-boss claim/lease work. Media ingest/DVR, annotation persistence, AI dispatch and product E2E remain unimplemented and are not represented as complete.

## 2026-08-07 - Annotation Realtime 2.0 close/outcome migration

Status: implemented on `feat/annotation-close-outcome-v2`, reviewed by the main Agent and merged into `integration/phase-1-round-1` through [PR #3](https://github.com/henry753951/volleyball-monitoring-ai/pull/3).

- Replaced the v1.1 standalone terminal and score-setting sequence with breaking Annotation Realtime `2.0.0` `CLOSE_RALLY`. The command carries the server-confirmed last key-point target plus a strict resolved-left, resolved-right or unknown outcome.
- Close now terminalizes the target and saves the rally-level outcome atomically. It creates no playback anchor, timestamp, score frame or score event; stale targets require CAS/revision conflict and snapshot refetch.
- Removed the unreachable `AWAITING_SCORE` annotation state from the current Prisma enum, server state helper, web state and canonical specification. `pending` remains draft-only while open; `SUBMIT_RALLY` remains a distinct post-close command.
- Updated the PWA scaffold to six touch actions and an app-owned TanStack Hotkeys adapter. Exact-pinned `@tanstack/vue-hotkeys` `0.10.0` now owns dynamic scoped registration, recording, input suppression and cleanup; the centralized registry includes configurable `Z`, `Space`, `<`, `>`, `?`, `Enter`, `ArrowLeft` and `ArrowRight` defaults.
- Added versioned preference validation and v2 migration, portable duplicate and browser-reserved gesture rejection, atomic Restore All Defaults, modal-scope precedence, and `formatForDisplay` badges/hints in both the annotation deck and settings.
- Headed Playwright verified the integrated settings UI displays `Z`, `␣`, `<`, `>`, `?`, `↵`, `←`, `→`; remapping service to `S` persisted, assigning the same `S` to contact was rejected without mutation, Restore All Defaults restored all eight keys, and local storage contained the version 3 preference envelope. The annotation deck rendered the same formatted six command badges.
- Regenerated the searchable 41-page specification PDF from the updated TeX source. All pages were rendered; six contact sheets and detailed Annotation pages 5, 19, 20 and 21 were visually reviewed.
- Validation passed: frozen Bun install, contract validator/Vitest/typecheck/build, Prisma generate/validate/typecheck, server tests/typecheck/build, 14 web tests plus Nuxt typecheck/build, SDK tests, full scaffold validation and PDF searchable-text/render checks.
- No migration was added because this semantic enum removal is required before the repository's first migration. Docker/database/browser E2E remain future vertical-slice work.

## 2026-08-07 — Phase 0, round 1

Status: locally integrated and validated on `integration/phase-0-round-1`; GitHub integration review is recorded in [PR #1](https://github.com/henry753951/volleyball-monitoring-ai/pull/1) against `main`.

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

Subagents did not merge. The main agent reviewed their diffs, reran their tests, created the commits where requested, and locally merged the reviewed branches into the integration branch. A private remote was then created with the authenticated local GitHub CLI and all review branches were pushed before opening PR #1.

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

- Private remote: `git@github.com:henry753951/volleyball-monitoring-ai.git`. `main`, the integration branch and all three reviewed feature branches were pushed; PR #1 is the integration-to-main review record.
- The local Bun is `1.3.6`, while the repository pins `1.3.14`. Validation passed, but release/CI should use the pinned version.
- Docker Compose runtime, migrations, database integration tests, real media ingest/DVR packaging, browser/iPad E2E and external AI callback flows were not run.
- The server REST media routes, durable annotation WebSocket, queue workers and end-to-end vertical product flow remain scaffolds. Green in the UI must continue to mean an immutable submission exists, not AI completion.

### Recommended next round

1. Use PR #1 as the integration-to-main review and merge record, and preserve the feature branches for workstream auditability.
2. Implement the first small end-to-end slice around match/capture setup and an authoritative server-resolved playback window, including the first migration and DB integration tests.
3. Keep annotation submission, clip creation and external AI dispatch as subsequent vertical slices, preserving the fixed keyboard/touch semantics and immutable `RallySubmission` boundary.
