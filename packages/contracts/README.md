
# Public contracts

This directory is owned by the main agent and the contracts/SDK worker. Consumers must not
invent fields outside these versioned files.

## Boundaries

- `media/playback-window-request.schema.json` / `playback-window-descriptor.schema.json`: bounded live/archive HLS window request and response.
- `media/playback-cursor.schema.json` / `resolved-media-anchor.schema.json`: client observation and authoritative server result.
- `media/frame-step-request.schema.json` / `canonical-frame-anchor.schema.json`: previous/next canonical sample.
- `annotation/realtime.schema.json`: strict Z/Space/X/score/edit/Enter commands and ACK/reject/snapshot messages.
- `ai/capabilities.schema.json`, `job.schema.json`, `job-accepted.schema.json`: provider handshake and immutable job submission.
- `ai/result.schema.json`: external AI provider to central result JSON.
- `ai/callback.schema.json`: progress/failure/completed callback metadata.
- `ai/overlay-manifest.schema.json`: central-to-web lazy overlay manifest.
- `flatbuffers/*.fbs`: per-frame AI/coach overlay binary.
- `openapi/*.yaml`: REST route documentation.
- `graphql/schema.graphql`: generated from Pothos; never hand-edit.
- `fixtures/**`: golden examples that must validate in both JSON Schema and the Python SDK.

## 64-bit wire rule

PTS, microseconds, frame indices, revisions, byte lengths and counters that can exceed 32-bit
are decimal strings on JSON/GraphQL wire. PostgreSQL uses `BIGINT`; TypeScript internal code
may use `bigint`. Do not use JavaScript `number` for canonical values.

## Change protocol

A public change requires main-agent approval, version/compatibility decision, updated schema,
golden fixture, SDK model/validator, producer, consumer, generated artifacts and tests. Unknown
AI action labels or confidence semantics are not a reason to hard-code an enum.

## Authentication rule

The HTTP/WebSocket connection authenticates the user; annotation commands do not carry a trusted `user_id`. `clip.download_url` is independently signed. `callback.token` is sent only to the central callback URL and never to object storage or browsers.
