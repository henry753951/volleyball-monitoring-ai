# Repository agent rules

This repository implements the Nuxt iPad PWA, central GraphQL/REST/WebSocket server, media/clip workers, persistence, AI wire contracts and Python SDK. It does not implement AI models.

Before work, read `docs/SYSTEM_SPEC_V3_2.md`, `docs/MAIN_AGENT_PROMPT.md`, `packages/contracts/README.md`, fixtures and nearest tests.

Hard invariants:
- Annotation/touch command semantics are fixed, while physical keyboard bindings are user-configurable. Defaults are Z service, Space contact, < atomically closes with resolved/left, > atomically closes with resolved/right, ? atomically closes with explicit unknown, and Enter immutable submit; arrow keys default to frame/player controls. Remapping never changes command meaning: `CLOSE_RALLY` targets the server-confirmed last key point, marks it terminal, records the rally-level outcome and creates no new time or score event. The settings UI must provide conflict-safe recording and Restore Defaults, and the six touch actions remain available with no standalone end-rally control.
- Gray rally mask is editable/unsubmitted; green means an immutable submission exists, not that AI is complete.
- Browser cursor values are observations; backend playback-window/sample-index resolution creates authoritative capture epoch, PTS, capture time and frame.
- Full DVR remains server-side and the PWA lazy-loads bounded playback windows.
- `RallySubmission` is immutable. Clip/AI/analysis reference the submission, never mutable draft rows.
- GraphQL Yoga + Pothos code-first is the domain API source. REST serves media/AI callback/binary. A dedicated WebSocket carries annotation commands/revisions.
- 64-bit time/PTS/byte values are PostgreSQL BIGINT, TypeScript bigint and decimal strings on wire.
- `frame_pos`/`frame_bbox` are video coordinates. `court_pos` is produced by the external AI subsystem in the fixed canonical court model, may be outside 0..1 and must not be projected or clamped by central/frontend code.
- Track IDs are analysis-run local. Action/confidence/group phase are optional and not hard-coded.
- Do not send media or full overlays through GraphQL/subscriptions.
- Local deployment uses Bun and Docker Compose behind Traefik. The iPad client is an installable landscape-first PWA.

A public contract change requires main-agent approval, ADR/version decision, fixture, SDK/server update and consumer migration. Do not claim validation that was not run.
