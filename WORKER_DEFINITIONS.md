# Codex worker definitions

The primary Agent may use at most three subagents. Project-level definitions are already installed in `.codex/agents/` and concurrency is capped in `.codex/config.toml`.

| Agent | Owned paths | Purpose |
|---|---|---|
| `contracts_sdk_worker` | `packages/contracts/**`, `sdk/**` | AI Job/Result/callback schemas, FlatBuffers, fixtures and Python SDK |
| `backend_worker` | `server/**`, `worker/**`, `packages/db/**`, `infra/**` | GraphQL/REST/WebSocket, Prisma, media/DVR/clip jobs and local Docker infrastructure |
| `luna_worker` | `web/**` | Nuxt iPad PWA, live/archive playback, annotation timeline, coach dashboard and Canvas overlay |

`luna_worker` is explicitly instructed to use the enabled Animation Vocabulary, Apple Design and Find Animation Opportunities skills when relevant, while preserving annotation speed, frame accuracy and the fixed product semantics.

To create the same Luna definition at the personal Codex level, use `docs/LUNA_WORKER_SETUP_PROMPT.md`. The project copy remains the authoritative definition for this repository.
