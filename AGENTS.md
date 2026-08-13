# Repository agent rules

This repository implements the PC-first Nuxt annotation workstation, the landscape-first iPad PWA coach/replay surfaces, central GraphQL/REST/WebSocket server, media/clip workers, persistence, AI wire contracts and Python SDK. It does not implement AI models.

Before work, read `docs/SYSTEM_SPEC_V3_2.md`, `docs/MAIN_AGENT_PROMPT.md`, `packages/contracts/README.md`, fixtures and nearest tests.

Hard invariants:
- Annotation/touch command semantics are fixed, while physical keyboard bindings are user-configurable. Defaults are Z segment START/END boundaries, X contact, Space play/pause, < resolved/left outcome, > resolved/right outcome, ? explicit unknown outcome, and Enter immutable submit; arrow keys default to frame controls. Z boundaries are not service/contact/landing events. Outcome commands never terminalize a contact, and READY submissions may retain `pending` outcome and zero manual contacts. The settings UI must provide conflict-safe recording and Restore Defaults. The compact touch deck remains Z, X, <, >, ?, and Settings, with no second end-rally control; Enter remains available from the keyboard registry.
- Rally mask colors are gray editable draft, yellow submitted/processing, blue AI-complete, and green identity-mapping-complete. Submission and later states remain immutable; color never changes that boundary.
- Browser cursor values are observations; backend playback-window/sample-index resolution creates authoritative capture epoch, PTS, capture time and frame.
- Full DVR remains server-side and every browser surface lazy-loads bounded playback windows.
- `RallySubmission` is immutable. Clip/AI/analysis reference the submission, never mutable draft rows.
- GraphQL Yoga + Pothos code-first is the domain API source. REST serves media/AI callback/binary. A dedicated WebSocket carries annotation commands/revisions.
- 64-bit time/PTS/byte values are PostgreSQL BIGINT, TypeScript bigint and decimal strings on wire.
- `frame_pos`/`frame_bbox` are video coordinates. `court_pos` is produced by the external AI subsystem in the fixed canonical court model, may be outside 0..1 and must not be projected or clamped by central/frontend code.
- Track IDs are analysis-run local. Action/confidence/group phase are optional and not hard-coded.
- Do not send media or full overlays through GraphQL/subscriptions.
- Local deployment uses Bun and Docker Compose behind Traefik. The annotation editor is PC-first; only coach/viewer display surfaces have an installable landscape-first iPad PWA acceptance requirement.

A public contract change requires main-agent approval, ADR/version decision, fixture, SDK/server update and consumer migration. Do not claim validation that was not run.
