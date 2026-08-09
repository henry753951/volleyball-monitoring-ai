# volleyball-monitoring-ai v3.2 delivery manifest

This repository is a contract-first monitoring application with working local vertical slices. It is not an AI-model repository.

## Start here

1. `START_HERE.txt`
2. `CODEX_SOL_PROMPT.txt`
3. `docs/SYSTEM_SPEC_V3_2.pdf`
4. `docs/SYSTEM_SPEC_V3_2.md`
5. `docs/MAIN_AGENT_PROMPT.md`
6. `AGENTS.md`
7. `docs/VALIDATION_REPORT.md`

## Requested deliverables included

- Full specification PDF: `docs/SYSTEM_SPEC_V3_2.pdf`
- LaTeX source: `docs/SYSTEM_SPEC_V3_2.tex`
- Searchable Markdown source: `docs/SYSTEM_SPEC_V3_2.md`
- Short plain-text Codex SOL prompt: `CODEX_SOL_PROMPT.txt`
- Detailed primary-agent prompt: `docs/MAIN_AGENT_PROMPT.md`
- Project agent definitions: `.codex/agents/*.toml`
- Worker ownership summary: `WORKER_DEFINITIONS.md`
- Luna setup/verification prompt: `docs/LUNA_WORKER_SETUP_PROMPT.md`
- Nuxt iPad PWA scaffold: `web/`
- Fastify/GraphQL Yoga/Pothos scaffold: `server/`
- Prisma/PostgreSQL model: `packages/db/`
- REST/WebSocket/AI/FlatBuffers contracts: `packages/contracts/`
- GitHub-installable Python SDK: `sdk/`
- Media/job worker scaffold: `worker/`
- Local Docker Compose, Traefik, OvenMediaEngine and MinIO baseline: `infra/`

## Product invariants

- Annotation command semantics are fixed: Z creates service, X creates contact, Space toggles playback, and `<`/`>`/`?` each send one `CLOSE_RALLY` that terminalizes the server-confirmed last key point and stores the rally-level resolved-left/resolved-right/unknown outcome without a new timestamp or score event; Enter creates the immutable submission. Z, X, Space, `<`, `>`, `?` and Enter are the remappable keyboard defaults with conflict detection and Restore Defaults. The compact touch strip exposes Z, X, `<`, `>`, `?` and shortcut settings, with no standalone end-rally control.
- Gray mask is editable/unsubmitted. Green mask means submitted, not AI completed.
- Server stores the full DVR. The iPad PWA lazy-loads bounded playback windows.
- Browser playback time is observational. The backend resolves authoritative source time/PTS/frame.
- External AI owns all court projection and normalization. Central/frontend consume `court_pos` without projecting or clamping it.
- This repository implements AI interfaces, the Python SDK and a provenance-labelled replay of saved external inference output, not AI models.
