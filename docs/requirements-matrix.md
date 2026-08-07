# Requirements matrix

`scaffolded`只代表目錄、contract或UI shell存在，不代表vertical slice完成。

| Flow | Contract/DB | Server/Worker | Web/PWA | Tests | Status | Exit evidence required |
|---|---|---|---|---|---|---|
| Local Traefik + PWA shell | paths/manifest defined | healthy Compose runtime; same-origin GraphQL live | installable shell/routes present | CI + Docker + headed Chrome | runtime baseline | iPad install + real WS/HLS flows |
| Match setup and membership domain | first migration + deterministic seed | strict Pothos reads/setup/swap; DB-backed membership | real list/setup/detail route and auth boundary | 19 server + 21 Web; PostgreSQL/CI/HTTP/browser E2E | verified | complete Phase 1B evidence recorded in `docs/progress.md` |
| Full-session DVR | OpenAPI 1.2.0, strict media/error schemas, TS/Python SDK, playback-window migration and internal sample-index v1 active | GraphQL timeline + exact bigint sample/epoch/ffprobe/artifact ingest kernels verified; concrete ingest adapters and REST completion active | canonical REST adapter, bigint timeline/gap helpers and bounded 3-window cache verified; real player pending | 6 contracts + 2 DB + 55 media + 21 server + 63 worker + 43 Web + 12 SDK; required feature CI green | persistence and authority kernels verified | concrete Prisma/MinIO/pg-boss + authenticated REST/HLS + PWA player + Docker discontinuity/restart smoke + 2h arbitrary lazy seek/bounded memory |
| Annotation commands (default Z/Space/</>/?/Enter; close includes outcome) | strict WS v2.0 schema + Prisma model | WS echo only | six controls/mask shell; PC-first editor planned, touch parity retained; coach iPad PWA remains separate | state + contract unit tests | scaffolded | authoritative two-client transport, close-target conflict/reconnect, immutable submit, PC editor workflow and coach-only iPad validation |
| Customizable keyboard bindings | ADR 0003; no wire change | command semantics remain server-validated | TanStack Vue adapter/settings implemented | recorder/conflict/reset/display/input/scope tests + headed Chrome | client verified | durable command transport must preserve configured-key/touch semantic parity |
| Clip and fake AI | AI Job/Result/callback + SDK | role/provider skeletons | processing badge shell | fixtures/SDK tests | scaffolded | Enter→clip→fake provider→callback→persist |
| Coach replay/overlay | FlatBuffers/manifest defined | ingest role skeleton | route/Canvas shell | fixture validation | scaffolded | seek-synced overlay and 2D court path |
