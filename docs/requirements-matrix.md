# Requirements matrix

`scaffolded`只代表目錄、contract或UI shell存在，不代表vertical slice完成。

| Flow | Contract/DB | Server/Worker | Web/PWA | Tests | Status | Exit evidence required |
|---|---|---|---|---|---|---|
| Local Traefik + PWA shell | paths/manifest defined | healthy Compose runtime; same-origin GraphQL live | installable shell/routes present | CI + Docker + headed Chrome | runtime baseline | iPad install + real WS/HLS flows |
| Match setup and membership domain | first migration + deterministic seed | strict Pothos reads/setup/swap; DB-backed membership | real list/setup/detail route and auth boundary | 19 server + 21 Web; PostgreSQL/CI/HTTP/browser E2E | verified | complete Phase 1B evidence recorded in `docs/progress.md` |
| Full-session DVR | media schemas defined | role skeletons only | composables only | fixtures | scaffolded | 2h record + arbitrary lazy seek + bounded memory |
| Annotation commands (default Z/Space/</>/?/Enter; close includes outcome) | strict WS v2.0 schema + Prisma model | WS echo only | six UI controls/mask shell | state + contract unit tests | scaffolded | two clients, close-target conflict/reconnect, immutable submit |
| Customizable keyboard bindings | ADR 0003; no wire change | command semantics remain server-validated | TanStack Vue adapter/settings implemented | recorder/conflict/reset/display/input/scope tests + headed Chrome | client verified | durable command transport must preserve configured-key/touch semantic parity |
| Clip and fake AI | AI Job/Result/callback + SDK | role/provider skeletons | processing badge shell | fixtures/SDK tests | scaffolded | Enter→clip→fake provider→callback→persist |
| Coach replay/overlay | FlatBuffers/manifest defined | ingest role skeleton | route/Canvas shell | fixture validation | scaffolded | seek-synced overlay and 2D court path |
