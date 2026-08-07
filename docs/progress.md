# Progress

## 2026-08-07 — Phase 2A round 2 persistence and ingest truth

Status: persistence/timeline [PR #12](https://github.com/henry753951/volleyball-monitoring-ai/pull/12) and media ingest/sample-truth [PR #13](https://github.com/henry753951/volleyball-monitoring-ai/pull/13) were main-Agent-reviewed, passed the required `contracts-sdk`, `typescript` and `compose-config` checks, and were merged into `integration/phase-2a-media-truth`. The integration-to-main [PR #8](https://github.com/henry753951/volleyball-monitoring-ai/pull/8) remains draft until the complete Phase 2A runtime exit is satisfied.

- Added the `PlaybackWindow`/ordered `PlaybackWindowSegment` persistence domain, artifact internal schema version, named range/readiness constraints and the second production migration. Prisma validate/generate, migration deploy, DB structural tests and live PostgreSQL server integration all passed.
- Added membership-filtered `CaptureSession`/`CaptureTimeline` GraphQL reads. They choose the newest program deterministically, expose decimal-string bigint timeline/range metadata only, coalesce touching ready ranges only within one discontinuity, and never expose segment/object/sample-index details.
- Added the shared `@volleyball-monitoring/media` authority package. Its strict v1 sample-index codec rejects numeric 64-bit values, extra/malformed fields, empty tables, holes, overlaps, frame discontinuities and invalid epoch/time-base context; serialization round-trips stably without changing the stored document shape.
- Fixed endpoint rounding to rescale the absolute epoch-relative sample end once. Exact adjacent 30 fps and true 60000/1001 segments no longer acquire a fabricated 1 microsecond gap. Realistic VFR, negative PTS, values beyond `2^53`, earlier-on-tie resolution and exact previous/next window/discontinuity boundaries are covered in the shared package.
- Added the pure capture epoch/discontinuity planner. PTS reset, timestamp jump, source restart/identity/time-base change and explicit gaps open deterministic epochs while canonical capture time/frame stay monotonic; unavailable intervals remain explicit half-open gaps with no fabricated samples.
- Added shell-free, bounded and cancellable ffprobe execution plus finalized-recording path validation. The ingest orchestrator produces exactly init/media/sample-index artifacts, verifies SHA-256/length/content type/internal schema version, uses deterministic content-aware idempotency, records stable retry stages and publishes readiness transactionally through typed ports.
- Full integrated local gate passed after rebasing onto the persistence migration: contracts 6, DB 2, media 55, server 21, worker 63, Web 43 and frozen-`uv` SDK 12 tests, plus all workspace typechecks, lint and production builds.
- Applied `20260807120000_playback_windows` to the local Docker PostgreSQL database and rebuilt the integration server/Web images. MinIO runs on the repo-configured `9100/9101`, server/Web are healthy, and a Traefik HTTPS GraphQL probe returned `health=ok`; PostgreSQL, Redis, MediaMTX, fake AI and all six workers remained running.
- Audited `H:\Repos\volleyball-ai-contract-lab` as a read-only reference. Phase 3 may adapt its PC three-region editor, two-lane timeline, selected-point inspector and immutable-submission correction-draft workflow. The project must not copy its `X`/Space bindings, `awaiting_score`, client `time × fps`, localStorage business state, clip-roll green masks or client-selected clip roll. The coach surface remains iPad/landscape PWA-first; only the annotator becomes PC-first.
- The reference `.data/exports` contains approximately 87.2 MB including real match imagery, local filenames/URLs and credential-shaped callback data. Nothing is copied directly. Phase 4 may derive compact sanitized fixtures for long rallies, unresolved/resolved results, optional action/confidence, analysis-run-local tracks and external `court_pos` outside `0..1`.

Open limitations: concrete Prisma/MinIO/pg-boss adapters, typed playback-window HTTP completion, resolve-cursor/frame-step, real PWA player/timeline integration, deterministic Docker discontinuity/restart smoke and the two-hour bounded-memory soak remain active. No Rally, KeyPoint, AnnotationOperation, RallySubmission, ClipJob or AiJob write path was added.

## 2026-08-07 — Phase 2A round 1 media contract and authority kernel

Status: integrated on `integration/phase-2a-media-truth` through main-Agent-reviewed [PR #9](https://github.com/henry753951/volleyball-monitoring-ai/pull/9), [PR #10](https://github.com/henry753951/volleyball-monitoring-ai/pull/10) and [PR #11](https://github.com/henry753951/volleyball-monitoring-ai/pull/11). Every PR passed the required `contracts-sdk`, `typescript` and `compose-config` checks before merge.

- Accepted ADR 0005 as the Phase 2A integration boundary: full DVR remains server-side; the PWA consumes bounded contiguous windows; browser cursors remain observations; persisted sample indexes resolve authoritative epoch/PTS/capture time/frame; windows never cross a gap or discontinuity.
- Advanced the central REST document additively to OpenAPI 1.2.0 with authenticated create/get window, bounded manifest/segment/media, canonical `/api/v1/media/resolve-cursor` and exact one-sample frame-step routes. Media authorization uses a same-site session cookie while the external AI callback retains its bearer boundary.
- Added the strict Media API Error 1.0.0 envelope and all approved HTTP/code classes. The six existing media payloads remain 1.0.0; TypeScript runtime parsers and Python SDK models reject numeric 64-bit wire values, malformed signed PTS, extra fields and invalid shapes.
- Added live/archive, RVFC/fallback, negative source PTS, frame-step, canonical anchor and error fixtures beyond JavaScript's safe-integer range. Contracts tests passed 6 cases and the frozen `uv` SDK suite passed 12 cases.
- Added the pure worker sample-index/resolver kernel with exact bigint rational rescaling, half-away-from-zero rounding, strict ffprobe-shaped parsing, deterministic earlier tie-breaking, presentation-end availability ranges and one-sample stepping across normal segment boundaries without crossing playback windows or discontinuities. Worker tests passed 17 cases plus typecheck/build.
- Added the canonical PWA media adapter, bigint-safe timeline/gap helpers, bounded current/previous/next window cache, reference-aware cleanup and explicit error recovery states. `WINDOW_EXPIRED`/`MAPPING_STALE` recreate around the last authoritative position, `WINDOW_BOUNDARY` recenters and retries, gaps never fall back across missing media, and malformed envelopes are fatal. Luna executed the frontend package gate: 43 tests, Nuxt typecheck and production build passed.
- The PWA now consumes `@volleyball-monitoring/contracts` directly and validates every successful media response at runtime. `target_player_media_time_us` remains bounded player-local time; canonical capture values never pass through JavaScript `Number`.
- Local Compose stayed operational throughout the round: PostgreSQL, Redis, server, web and fake AI remained healthy; MinIO, MediaMTX, Traefik and all six worker containers remained up. The workers are still honest scaffolds until the persisted ingest adapters below land.

Open limitations: this round verifies contracts and pure authority/client kernels only. Playback-window migration/GraphQL timeline, production pg-boss/ffprobe/MinIO ingest adapters, authenticated REST media serving, real PWA player/timeline integration, discontinuity Docker smoke and the two-hour bounded-memory soak remain active Phase 2A-2/2A-3 work. No Rally, KeyPoint, AnnotationOperation, RallySubmission, ClipJob or AiJob path was added.

## 2026-08-07 — Phase 1B core-domain vertical slice

Status: integrated on `integration/phase-1b-core-domain` through main-Agent-reviewed [PR #7](https://github.com/henry753951/volleyball-monitoring-ai/pull/7), [PR #5](https://github.com/henry753951/volleyball-monitoring-ai/pull/5) and [PR #6](https://github.com/henry753951/volleyball-monitoring-ai/pull/6), then merged to `main` through green integration [PR #4](https://github.com/henry753951/volleyball-monitoring-ai/pull/4).

- Added the repository's first Prisma migration from the approved 38-model/24-enum schema. Fresh-database `migrate deploy` passed twice, and the deterministic development seed passed twice without increasing its graph: one user, one match, two teams, two players, two roster entries and one initial side assignment.
- Added explicit local development identity resolution. It is enabled only by `DEV_AUTH_ENABLED=true`, validates UUID and role, upserts the user server-side and is forcibly disabled in production. The local Compose example uses the deterministic seeded `OPERATOR`; no browser database or service credentials are exposed.
- Added strict, modular Pothos code-first `Viewer`, `Match`, `Team`, `Player`, `MatchRosterEntry`, `MatchSet` and `CourtSideAssignment` objects with the exact ADR 0004 names/nullability. Authenticated match reads are membership-filtered and inaccessible details do not disclose existence.
- Added the transactional `createMatchSetup` write for the match, both teams and players, roster snapshots, set 1, ordinal-1 court assignment and creator `OPERATOR` membership. Normalized duplicate/empty input is rejected before the transaction and rollback counts are covered by a live PostgreSQL test.
- Added transaction-scoped PostgreSQL advisory locking for `swapCourtSides`. Concurrent same-ordinal requests produce exactly one success and one `BAD_USER_INPUT`; history remains ordered and non-overlapping, with the prior assignment ending at the new ordinal minus one.
- Added 10 live PostgreSQL integration cases within the 19-test server suite. Every run creates and drops a unique temporary database; the final audit found no temporary database or generated test user left behind. Strict source/test TypeScript and schema-export reproducibility pass without `ts-nocheck`, `ts-ignore` or `any` shortcuts.
- CI now runs for feature PRs targeting `integration/**`, starts PostgreSQL 17, deploys migrations, checks generated SDL and stored operations, runs DB/server tests and preserves the stable `contracts-sdk`, `typescript` and `compose-config` job names. Checksum reproducibility remains mandatory for main-targeted PRs/pushes and is intentionally main-Agent-owned for integration feature PRs.
- Replaced Nuxt demo IDs with a real same-origin GraphQL adapter, authenticated route boundary, match list/detail and a landscape match setup form. Loading, empty, auth-unavailable, API error, not-found, retained-input, pending and duplicate-submit states are covered; successful setup navigates to the returned UUID.
- PR #5 passed all three CI jobs (`typescript` included migration, schema, 19 server tests and builds); PR #6 passed all three again with the final Web consumer. Main-Agent local gates passed Prisma validate/typecheck/build, server 19 tests/typecheck/build, Web 21 tests/typecheck/build and SDL export/diff.
- Rebuilt the local Bun 1.3.14 server and Nuxt images. PostgreSQL/Redis/MinIO readiness stayed `ok`; server and Web are healthy. Through Traefik HTTPS, the main Agent read the seeded identity/match, created a real two-team/four-player match, swapped sides at ordinal 3 and read the resulting `1..2` plus `3..open` history.
- Headed Chrome then exercised the real UI: duplicate team name/short-name validation retained every field, corrected input created another match and navigated to its real UUID live route, and the home list showed the created record. A review-found empty `/matches//history` header link was removed outside match context. The browser was closed and generated Playwright artifacts were deleted; the only console error was the expected local self-signed TLS warning.

Open limitations: media ingest/full DVR, authoritative playback-window/sample-index services, durable annotation WebSocket persistence/immutable submissions, clip/AI processing and coach overlays remain future Phase 2–5 slices. The six workers still run an honest idle lifecycle and do not yet claim pg-boss processing semantics.

## 2026-08-07 — Phase 1A CI and local runtime baseline

Status: integrated and validated on `integration/phase-1-round-1`; [PR #2](https://github.com/henry753951/volleyball-monitoring-ai/pull/2) passed its post-merge gate and was merged to `main`.

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
