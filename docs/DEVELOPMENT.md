# Development workflow

## Prerequisites

- Bun version declared by root `packageManager`.
- Python 3.11+ with `uv` for the SDK and Python validation tools.
- Node.js for the existing GraphQL operation validator.
- Docker Desktop/Compose for PostgreSQL, Redis, MinIO, OME, Traefik, and full-stack smoke tests.

## Install

```powershell
bun install
uv sync --project sdk --extra test
```

Do not commit `.env`; start from `.env.example`. Local managed media roots are configured through the documented `DEV_DATA_ROOT`, `MINIO_DATA_HOST_PATH`, `MEDIA_SPOOL_HOST_PATH`, and `MEDIA_IMPORT_HOST_PATH` variables.

## Daily commands

| Command                | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `bun run dev`          | Start the host-oriented development lifecycle                       |
| `bun run dev:web`      | Nuxt only                                                           |
| `bun run dev:server`   | Fastify/API only                                                    |
| `bun run dev:worker`   | Media and workflow workers                                          |
| `bun run format`       | Oxfmt for JS/TS/Vue/config/docs plus Ruff formatter for Python      |
| `bun run format:check` | Verify formatting without writes                                    |
| `bun run lint`         | Oxlint for JS/TS/Vue scripts plus Ruff checks                       |
| `bun run lint:fix`     | Apply safe Oxlint/Ruff fixes                                        |
| `bun run typecheck`    | TypeScript/Nuxt type checks across workspaces                       |
| `bun run test`         | Full Bun/Vitest and SDK pytest suite                                |
| `bun run build`        | Production builds for contracts, DB, media, server, worker, and web |

Run `format` and `lint:fix` serially. Review their diff before mixing them with functional changes.

Oxlint checks JavaScript, TypeScript, and the `<script>` blocks in Vue SFCs. It does not replace
Nuxt/Vue template compilation, so every web change must still pass `bun --cwd web typecheck` and a
production build.

## Contract and persistence commands

```powershell
bun run graphql:schema
bun run graphql:schema:check
bun run graphql:codegen
bun run db:generate
bun run db:validate
bun run validate:contracts
bun run validate:prisma-structure
bun run checksums:refresh
```

For a public contract change, update the ADR/version decision, fixtures, source schema, generated snapshot, SDK/server, and every consumer in the same migration series.

## Local stack

```powershell
bun run compose:up
bun run compose:down
```

The Compose stack is routed through Traefik. Verify GraphQL response bodies even when HTTP status is 200, and verify database/container schema versions when web and server behavior disagree.

## Validation order

1. Focused tests nearest the edit.
2. `bun run format` and inspect the formatting diff.
3. `bun run lint`.
4. `bun run typecheck`.
5. Relevant package tests, then `bun run test`.
6. `bun run build` and contract/scaffold checks.
7. Real browser/runtime smoke for media, annotation, coach replay, delayed data, reload, or HMR changes.
