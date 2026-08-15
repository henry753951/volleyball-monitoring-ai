# Web agent rules

Follow the root `AGENTS.md` and `docs/ARCHITECTURE.md` first.

- Nuxt 4 routes live under `app/pages`; reusable behavior belongs in composables or utilities, not large page-local helpers.
- Visible strings must use the existing i18n approach where that surface is localized; do not introduce a second translation mechanism.
- Treat playback cursors as observations and request authoritative frame/time resolution from the backend.
- Annotation drafts may be edited only when owned by the current client session. Submitted masks and points remain immutable visual history.
- Coach/replay overlays must align to the rendered video rectangle and preserve canonical `court_pos` without clamping.
- Keep coach/viewer surfaces landscape-first and installable as an iPad PWA. The annotation editor remains PC-first.
- Add Vitest coverage for composables/utilities and use real browser/runtime validation for media timing, HMR/reload, delayed data, and replay rendering.

Run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build` from this directory while iterating; run root release checks before integration.
