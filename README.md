# volleyball-monitoring-ai

排球賽事即時標註、完整 DVR、外部 AI 串接與教練 iPad PWA 的 monorepo starter。

> 本 repository 不包含 AI 模型。球員／球／球場追蹤與 `court_pos` 投影由外部 AI 子系統負責；此 repo 只定義輸入、輸出、callback、FlatBuffers overlay 與 Python SDK。

## 先讀

1. `docs/SYSTEM_SPEC_V3_2.pdf`
2. `docs/SYSTEM_SPEC_V3_2.md`
3. `docs/MAIN_AGENT_PROMPT.md`
4. `CODEX_SOL_PROMPT.txt`
5. `AGENTS.md`
6. `docs/VALIDATION_REPORT.md`

## 技術基線

- Bun 1.3.14 workspaces
- Nuxt 4 / Vue 3 / TypeScript / Vant 4 / Tailwind / Motion-V / HLS.js
- `@vite-pwa/nuxt` landscape-first iPad PWA
- Fastify + GraphQL Yoga + Pothos code-first + Prisma/PostgreSQL
- REST for media/callback/binary; dedicated WebSocket for annotation; FlatBuffers for per-frame overlay
- MediaMTX + FFmpeg/ffprobe for ingest, full-session DVR, playback windows and clip processing
- PostgreSQL 17, Redis 8, MinIO S3, Traefik 3.7.9
- Python SDK installable from this GitHub repository

The specification is available as PDF, Markdown and LaTeX under `docs/SYSTEM_SPEC_V3_2.*`.

## Local Docker

```bash
cp .env.example .env
./scripts/generate-local-tls.sh volleyball.lan <DOCKER_HOST_LAN_IP>
docker compose -f infra/compose.yaml --profile app --profile dev-ai up --build
```

- PWA/Web: `https://<trusted-lan-host>/`
- GraphQL: `https://<trusted-lan-host>/graphql`
- REST: `https://<trusted-lan-host>/api/v1/...`
- Annotation WebSocket: `wss://<trusted-lan-host>/ws/annotations`
- Live HLS: `https://<trusted-lan-host>/hls/<stream>/index.m3u8`
- Traefik local dashboard: `http://<docker-host>:8080/`
- MinIO console: `http://<docker-host>:9001/`

On iPad, use a LAN hostname/IP covered by a trusted certificate, then use「加入主畫面」to run in standalone PWA mode. Pure LAN HTTP is not the PWA acceptance environment; see `infra/traefik/README.md`. Browser-facing URLs are same-origin paths, so no `localhost` is embedded in the client bundle.

## Bun development

```bash
bun install
bun run db:generate
bun run validate:all
bun run dev
```

## Python SDK

```bash
uv sync --project sdk --frozen --extra test
uv run --project sdk --frozen pytest
```

## Fixed annotation controls

`Z` service, `Space` contact, `<` close with resolved/left, `>` close with resolved/right, `?` close with explicit unknown, `Enter` submit. Each close command atomically terminalizes the server-confirmed last key point and stores the rally-level outcome without a new time or score event. Touch controls expose the same six actions; physical bindings remain configurable and Restore Defaults returns to these keys.
