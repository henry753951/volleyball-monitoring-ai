# Requirements matrix

`scaffolded`只代表目錄、contract或UI shell存在，不代表vertical slice完成。

| Flow | Contract/DB | Server/Worker | Web/PWA | Tests | Status | Exit evidence required |
|---|---|---|---|---|---|---|
| Local Traefik + PWA shell | paths/manifest defined | Compose labels present | installable shell/routes present | syntax/scaffold | scaffolded | iPad install + same-origin GraphQL/WS/HLS |
| Full-session DVR | media schemas defined | role skeletons only | composables only | fixtures | scaffolded | 2h record + arbitrary lazy seek + bounded memory |
| Annotation commands (default Z/Space/X/</>/?/Enter) | strict WS schema + Prisma model | WS echo only | UI controls/mask shell | state unit test | scaffolded | two clients, conflict/reconnect, immutable submit |
| Customizable keyboard bindings | ADR 0003; no wire change | command semantics remain server-validated | TanStack Vue adapter/settings not started | recorder/conflict/reset/display tests required | specified | remap every command, Restore All Defaults, `formatForDisplay` badges, input/scope safety, touch parity |
| Clip and fake AI | AI Job/Result/callback + SDK | role/provider skeletons | processing badge shell | fixtures/SDK tests | scaffolded | Enter→clip→fake provider→callback→persist |
| Coach replay/overlay | FlatBuffers/manifest defined | ingest role skeleton | route/Canvas shell | fixture validation | scaffolded | seek-synced overlay and 2D court path |
