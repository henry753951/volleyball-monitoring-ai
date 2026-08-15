# Repository agent guide

This monorepo implements the PC-first Nuxt annotation workstation, landscape-first iPad coach/replay PWA, central Fastify/GraphQL/WebSocket server, media and workflow workers, persistence, wire contracts, and Python provider SDK. It does not contain AI model implementations.

## Read before changing code

Read these sources in order:

1. `docs/SYSTEM_SPEC_V3_2.md` for product and domain invariants.
2. `docs/MAIN_AGENT_PROMPT.md` for delivery boundaries.
3. `docs/ARCHITECTURE.md` for package ownership and data flow.
4. The nearest nested `AGENTS.md`, relevant ADRs, fixtures, and tests.
5. `packages/contracts/README.md` before changing any wire contract.

Use `docs/DEVELOPMENT.md` for local commands and `docs/RELEASE.md` for version publishing. Record architecture decisions under `docs/adr/`; do not bury contract decisions only in implementation code.

## Repository map

- `web/`: Nuxt 4 annotation, control, coach, live, analytics, and replay surfaces.
- `server/`: Fastify host, Pothos/Yoga GraphQL API, REST media routes, and dedicated realtime sockets.
- `worker/`: durable media-indexer and workflow processing roles.
- `packages/contracts/`: wire schemas, fixtures, validators, and generated GraphQL snapshot.
- `packages/db/`: Prisma schema, migrations, generated client, and persistence helpers.
- `packages/media/`: media timing, sample-index, and playback-resolution primitives.
- `sdk/`: Python SDK for external AI providers.
- `infra/`: local Docker Compose, Traefik, OME, and supporting services.
- `scripts/`: validation, local lifecycle, checksum, and operational helpers.

## Hard invariants

- Annotation/touch semantics are fixed while physical keyboard bindings are configurable. Defaults: Z toggles segment START/END boundaries, X adds contact, Space plays/pauses, `<` resolves left, `>` resolves right, `?` records unknown, Enter immutably submits, and arrows control frames. Z boundaries are not service/contact/landing events. Outcome commands never terminalize contacts. READY may retain `pending` outcome and zero manual contacts.
- The compact touch deck remains Z, X, `<`, `>`, `?`, and Settings. Keyboard recording must be conflict-safe and offer Restore Defaults.
- Rally mask colors are gray editable draft, yellow submitted/processing, blue AI-complete, and green identity-mapping-complete. Submitted and later states are immutable.
- Browser cursor values are observations. Backend playback-window/sample-index resolution creates authoritative capture epoch, PTS, capture time, and frame.
- Full DVR stays server-side; browser surfaces lazy-load bounded playback windows.
- `RallySubmission` is immutable. Clip, AI, and analysis records reference submissions, never mutable draft rows.
- GraphQL Yoga + Pothos code-first is the domain API authority. REST serves media, AI callbacks, and binary payloads. Dedicated WebSockets carry annotation and review commands/revisions.
- PostgreSQL BIGINT maps to TypeScript `bigint` and decimal strings on the wire.
- `frame_pos` and `frame_bbox` are video coordinates. AI-owned `court_pos` uses the fixed canonical court, may be outside 0..1, and must never be clamped or reprojected by server/web code.
- Track IDs are analysis-run-local. Action, confidence, and group phase are optional extensions.
- Never send media or full overlays through GraphQL or subscriptions.
- Local deployment uses Bun and Docker Compose behind Traefik. Only coach/viewer display surfaces carry the installable landscape-first iPad PWA requirement.

## Change workflow

- Protect dirty work and concurrent worktrees. Before integration, fetch/prune and inspect worktrees, branch ancestry, unique commits, and `origin/main...HEAD`.
- Prefer codebase knowledge-graph discovery before text search. Use text search for literals, configuration, and non-code files.
- Keep generated artifacts generated. Modify their source, run the documented generator, and commit source plus output together.
- A public contract change requires an ADR/version decision, fixture coverage, server/SDK/consumer migration, and explicit main-agent approval.
- Use Conventional Commits. Keep functional changes, formatting, generated output, and release metadata in reviewable commits.
- Run formatting before linting; never run formatter and checker concurrently on the same files.
- Do not claim a check, runtime state, deployment, or release that was not directly verified.

## Required checks

Use the smallest relevant checks while iterating, then run the release gate from `docs/RELEASE.md`. At minimum for merged source changes:

```text
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run validate:all
bun run graphql:schema:check
git diff --check
```

After checksum-tracked changes, run `bun run checksums:refresh` and verify the staged diff again.
