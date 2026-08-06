# volleyball-monitoring-ai v3.2 delivery manifest

This archive is a contract-first implementation starter, not a finished application and not an AI-model repository.

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
- Local Docker Compose, Traefik, MediaMTX and MinIO baseline: `infra/`
- Fake AI provider for integration development: `examples/fake_ai_provider/`

## Product invariants

- Annotation command semantics are fixed: service, contact, terminal, side score, explicit unknown and immutable submission. Z, Space, X, `<`, `>`, `?` and Enter are the defaults and may be remapped with conflict detection and Restore Defaults; terminal still marks the existing last key point without creating a new timestamp.
- Gray mask is editable/unsubmitted. Green mask means submitted, not AI completed.
- Server stores the full DVR. The iPad PWA lazy-loads bounded playback windows.
- Browser playback time is observational. The backend resolves authoritative source time/PTS/frame.
- External AI owns all court projection and normalization. Central/frontend consume `court_pos` without projecting or clamping it.
- This repository implements only AI interfaces and the Python SDK, not AI models.
